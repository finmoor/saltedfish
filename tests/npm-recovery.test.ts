import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, open, readFile, utimes, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { active, recoverLock, saveActive, withLock } from '../src/npm-runtime.js';
import * as runtime from '../src/npm-runtime.js';
import { testDirectory } from './helpers.js';
import { projectDir } from '../src/config.js';
import { createServer } from 'node:http';
import { freePort } from './helpers.js';

async function homeFixture() {
  const temp = await testDirectory(), home = temp.directory;
  for (const folder of ['run', 'data', 'versions', 'logs']) await mkdir(path.join(home, folder));
  for (const version of ['0.2.0-beta.20', '0.2.0-beta.21']) {
    const directory = path.join(home, 'versions', version), files: Record<string, string> = {};
    for (const name of ['package.json', 'dist/npm-cli.js', 'dist/npm-worker.js', 'dist/cli.js', 'dist/gateway-cli.js', 'dist/extension/manifest.json', 'ui/index.html']) {
      const file = path.join(directory, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, '{}');
      files[name] = createHash('sha256').update('{}').digest('hex');
    }
    await writeFile(path.join(directory, 'saltedfish-release.json'), JSON.stringify({ product: 'saltedfish-npm', version, stateVersion: 1, files }));
  }
  await saveActive(home, { product: 'saltedfish-npm', version: '0.2.0-beta.20', stateVersion: 1 });
  return temp;
}

test('管理进程硬终止后 recover-lock 同时恢复遗留维护门禁；旧空恢复锁可留档恢复', async () => {
  const temp = await homeFixture();
  const module = pathToFileURL(path.join(projectDir, 'src/npm-runtime.ts')).href;
  const code = `const {withLock,maintenance}=await import(${JSON.stringify(module)});await withLock(${JSON.stringify(temp.directory)},()=>maintenance(${JSON.stringify(temp.directory)},async()=>{console.log('ready');await new Promise(()=>setInterval(()=>{},1000));}));`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); child.once('exit', () => reject(new Error('fixture exited before checkpoint'))); });
    child.kill(); await closed;
    assert.equal((await recoverLock(temp.directory)).recovered, true);
    await assert.rejects(access(path.join(temp.directory, 'maintenance')));
    await withLock(temp.directory, async () => undefined);
    await writeFile(path.join(temp.directory, 'recover.lock'), '');
    assert.equal((await recoverLock(temp.directory)).recovered, true);
    assert.equal((await recoverLock(temp.directory)).recovered, false);
  } finally { child.kill(); await closed; await temp.cleanup(); }
});

test('未提交事务回退、已提交事务完成；活进程与损坏记录不被抢占', async () => {
  const temp = await homeFixture();
  try {
    const before = await active(temp.directory), after = { ...before, version: '0.2.0-beta.21', previous: before.version };
    const record = { schemaVersion: 1, id: randomUUID(), pid: 2147483647, createdAt: new Date().toISOString(), phase: 'activated', before, after, wasRunning: [] };
    await saveActive(temp.directory, after);
    await writeFile(path.join(temp.directory, 'maintenance'), JSON.stringify(record));
    assert.equal((await recoverLock(temp.directory)).maintenance?.state, 'rolled_back');
    assert.equal((await active(temp.directory)).version, before.version);
    await saveActive(temp.directory, after);
    await writeFile(path.join(temp.directory, 'maintenance'), JSON.stringify({ ...record, phase: 'committed' }));
    assert.equal((await recoverLock(temp.directory)).maintenance?.state, 'completed');
    assert.equal((await active(temp.directory)).version, after.version);
    await writeFile(path.join(temp.directory, 'manage.lock'), JSON.stringify({ pid: process.pid, id: randomUUID() }));
    await assert.rejects(recoverLock(temp.directory), /仍存在/);
    assert.equal(JSON.parse(await readFile(path.join(temp.directory, 'manage.lock'), 'utf8')).pid, process.pid);
  } finally { await temp.cleanup(); }
});

test('各持久阶段可重复恢复，损坏记录和忙碌服务保持保护', async () => {
  const temp = await homeFixture();
  const marker = path.join(temp.directory, 'maintenance');
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const before = await active(temp.directory), after = { ...before, version: '0.2.0-beta.21', previous: before.version };
    const record = { schemaVersion: 1, id: randomUUID(), pid: 2147483647, createdAt: new Date().toISOString(), before, after, wasRunning: [] };
    for (const phase of ['prepared', 'stopped', 'activated', 'extension_synced', 'starting', 'rolling_back', 'rolled_back', 'committed']) {
      await saveActive(temp.directory, ['prepared', 'stopped'].includes(phase) ? before : after);
      await writeFile(marker, JSON.stringify({ ...record, phase }));
      await recoverLock(temp.directory);
      assert.equal((await active(temp.directory)).version, phase === 'committed' ? after.version : before.version);
      assert.equal((await recoverLock(temp.directory)).recovered, false);
    }
    await writeFile(marker, '{broken');
    await assert.rejects(recoverLock(temp.directory), /记录损坏/);
    assert.equal(await readFile(marker, 'utf8'), '{broken');
    const port = await freePort(), instanceId = randomUUID();
    server = createServer((request, response) => {
      assert.equal(request.url, '/status', '恢复忙碌服务时不能发出stop');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ role: 'local', home: temp.directory, instanceId, pid: process.pid, version: after.version, busy: true }));
    });
    await new Promise<void>(resolve => server!.listen(port, '127.0.0.1', resolve));
    await writeFile(path.join(temp.directory, 'run/local.json'), JSON.stringify({ role: 'local', home: temp.directory, instanceId, pid: process.pid, version: after.version, port, token: 'a'.repeat(64), startedAt: new Date().toISOString() }));
    await writeFile(marker, JSON.stringify({ ...record, phase: 'starting' }));
    await assert.rejects(recoverLock(temp.directory), /仍有任务/);
    assert.equal((await active(temp.directory)).version, after.version);
    assert.equal(JSON.parse(await readFile(marker, 'utf8')).phase, 'starting');
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await temp.cleanup();
  }
});

// 真实的无关进程：只用来占住一个存活的 PID，被测代码绝不能结束它。
async function stranger() {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  await once(child, 'spawn'); return child;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };
async function reap(child: ChildProcess) { if (child.exitCode === null) { const closed = once(child, 'close'); child.kill(); await closed; } }
const longAgo = new Date(Date.now() - 3600_000);

test('遗留 manage.lock 为空：withLock 给出指向 recover-lock 的提示而不是 JSON 解析错误，recover-lock 接管清理', async () => {
  const temp = await homeFixture(), lock = path.join(temp.directory, 'manage.lock');
  try {
    await writeFile(lock, ''); await utimes(lock, longAgo, longAgo);
    await assert.rejects(withLock(temp.directory, async () => undefined), (error: Error) => /recover-lock/.test(error.message) && !/JSON/.test(error.message));
    const result = await recoverLock(temp.directory);
    assert.equal(result.recovered, true);
    await assert.rejects(access(lock));
    await withLock(temp.directory, async () => undefined);
  } finally { await temp.cleanup(); }
});

test('损坏的 manage.lock（内容不是锁记录）同样可由 recover-lock 清理', async () => {
  const temp = await homeFixture(), lock = path.join(temp.directory, 'manage.lock');
  try {
    for (const content of ['{broken', '{"pid":"abc"}', '[]', '{"pid":-3}']) {
      await writeFile(lock, content); await utimes(lock, longAgo, longAgo);
      await assert.rejects(withLock(temp.directory, async () => undefined), /recover-lock/);
      assert.equal((await recoverLock(temp.directory)).recovered, true, content);
      await assert.rejects(access(lock));
    }
  } finally { await temp.cleanup(); }
});

test('刚创建的不完整 manage.lock 可能属于正在写入的管理进程：提示稍后重试，不抢占', async () => {
  const temp = await homeFixture(), lock = path.join(temp.directory, 'manage.lock');
  try {
    await writeFile(lock, '');
    await assert.rejects(withLock(temp.directory, async () => undefined), (error: Error) => error instanceof runtime.LockBusyError && /稍后重试/.test(error.message));
    await assert.rejects(recoverLock(temp.directory), /稍后重试/);
    await access(lock);
  } finally { await temp.cleanup(); }
});

test('manage.lock 所属 PID 被无关进程复用：recover-lock 接管且不碰该进程；锁仍属原进程时不抢占', { skip: !['win32', 'linux'].includes(process.platform) }, async () => {
  const temp = await homeFixture(), lock = path.join(temp.directory, 'manage.lock'), other = await stranger();
  try {
    // 锁文件早于该进程的启动时间：写锁的进程不可能是它。
    await writeFile(lock, JSON.stringify({ pid: other.pid, id: randomUUID() })); await utimes(lock, longAgo, longAgo);
    await assert.rejects(withLock(temp.directory, async () => undefined), (error: Error) => /遗留锁/.test(error.message) && !(error instanceof runtime.LockBusyError));
    assert.equal((await recoverLock(temp.directory)).recovered, true);
    await assert.rejects(access(lock));
    assert.ok(alive(other.pid!), 'recover-lock 不能结束无关进程');
    // 锁写于该进程启动之后：无法排除它就是写锁的管理进程，保持不抢占。
    await writeFile(lock, JSON.stringify({ pid: other.pid, id: randomUUID() }));
    await assert.rejects(recoverLock(temp.directory), /仍存在/);
    await assert.rejects(withLock(temp.directory, async () => undefined), (error: Error) => error instanceof runtime.LockBusyError);
    await access(lock);
    assert.ok(alive(other.pid!));
  } finally { await reap(other); await temp.cleanup(); }
});

test('recover.lock 的记录 PID 被无关进程复用：留档后接管；仍可能属于恢复进程时拒绝', { skip: !['win32', 'linux'].includes(process.platform) }, async () => {
  const temp = await homeFixture(), gate = path.join(temp.directory, 'recover.lock'), other = await stranger();
  try {
    await writeFile(gate, JSON.stringify({ pid: other.pid, id: randomUUID(), createdAt: longAgo.toISOString() }));
    assert.equal((await recoverLock(temp.directory)).recovered, true);
    await assert.rejects(access(gate));
    assert.ok(alive(other.pid!));
    await writeFile(gate, JSON.stringify({ pid: other.pid, id: randomUUID(), createdAt: new Date().toISOString() }));
    await assert.rejects(recoverLock(temp.directory), /恢复进程仍存在/);
    await access(gate);
  } finally { await reap(other); await temp.cleanup(); }
});

test('写入管理锁失败（磁盘写满）不留下空锁文件', async () => {
  const temp = await homeFixture(), lock = path.join(temp.directory, 'manage.lock');
  const probe = await open(path.join(temp.directory, 'probe'), 'w'), handlePrototype = Object.getPrototypeOf(probe) as { writeFile: (...args: unknown[]) => Promise<void> };
  await probe.close();
  const original = handlePrototype.writeFile; let failed = false;
  handlePrototype.writeFile = async function (this: unknown, ...args: unknown[]) {
    if (!failed) { failed = true; throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); }
    return original.apply(this, args);
  };
  try {
    await assert.rejects(withLock(temp.directory, async () => undefined), /ENOSPC/);
    await assert.rejects(access(lock), '写锁失败后不能遗留空 manage.lock');
  } finally { handlePrototype.writeFile = original; await temp.cleanup(); }
});

// Windows 上杀毒软件/索引器会短暂占住文件；PowerShell 子进程以不共享删除的方式打开文件，复现这种瞬时共享冲突。
async function holdFile(file: string, milliseconds: number) {
  const child = spawn('powershell.exe', ['-NoProfile', '-Command', `$h=[IO.File]::Open($env:SALTEDFISH_LOCK_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite); try { [Console]::WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Milliseconds ${milliseconds} } finally { $h.Dispose() }`], { windowsHide: true, env: { ...process.env, SALTEDFISH_LOCK_FILE: file }, stdio: ['ignore', 'pipe', 'pipe'] });
  const done = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); child.once('exit', code => reject(new Error(`file-lock fixture exited ${code}`))); });
  return { done };
}

test('维护标记被短暂占用：recover-lock 有限重试后收尾，而不是误报失败', { skip: process.platform !== 'win32' }, async () => {
  const temp = await homeFixture(), marker = path.join(temp.directory, 'maintenance');
  try {
    const before = await active(temp.directory), after = { ...before, version: '0.2.0-beta.21', previous: before.version };
    await saveActive(temp.directory, after);
    await writeFile(marker, JSON.stringify({ schemaVersion: 1, id: randomUUID(), pid: 2147483647, createdAt: new Date().toISOString(), phase: 'committed', before, after, wasRunning: [] }));
    const held = await holdFile(marker, 350);
    const result = await recoverLock(temp.directory);
    assert.equal(result.maintenance?.state, 'completed');
    assert.equal(await held.done, 0);
    await assert.rejects(access(marker));
  } finally { await temp.cleanup(); }
});

test('旧恢复锁被短暂占用：留档改名有限重试，而不是误报失败', { skip: process.platform !== 'win32' }, async () => {
  const temp = await homeFixture(), gate = path.join(temp.directory, 'recover.lock');
  try {
    await writeFile(gate, '');
    const held = await holdFile(gate, 350);
    assert.equal((await recoverLock(temp.directory)).recovered, true);
    assert.equal(await held.done, 0);
    await assert.rejects(access(gate));
  } finally { await temp.cleanup(); }
});

test('遗留管理锁被短暂占用：recover-lock 有限重试后清理', { skip: process.platform !== 'win32' }, async () => {
  const temp = await homeFixture(), lock = path.join(temp.directory, 'manage.lock');
  try {
    await writeFile(lock, JSON.stringify({ pid: 2147483647, id: randomUUID() }));
    const held = await holdFile(lock, 350);
    assert.equal((await recoverLock(temp.directory)).recovered, true);
    assert.equal(await held.done, 0);
    await assert.rejects(access(lock));
  } finally { await temp.cleanup(); }
});

test('诊断：遗留事务、遗留锁与恢复锁都能在不取互斥的前提下被看见', async () => {
  const temp = await homeFixture();
  try {
    const before = await active(temp.directory), after = { ...before, version: '0.2.0-beta.21', previous: before.version };
    await writeFile(path.join(temp.directory, 'maintenance'), JSON.stringify({ schemaVersion: 1, id: randomUUID(), pid: 2147483647, createdAt: '2026-10-25T01:02:03.000Z', phase: 'starting', before, after, wasRunning: ['local'] }));
    await writeFile(path.join(temp.directory, 'manage.lock'), '');
    await writeFile(path.join(temp.directory, 'recover.lock'), '');
    const report = await runtime.diagnose(temp.directory);
    assert.equal(report.management.maintenance?.phase, 'starting');
    assert.equal(report.management.maintenance?.createdAt, '2026-10-25T01:02:03.000Z');
    assert.equal(report.management.maintenance?.owner, 'dead');
    assert.equal(report.management.manageLock?.state, 'fresh');
    assert.equal(report.management.recoverGate, true);
    assert.ok(report.hints.length >= 2 && report.hints.every(hint => hint.length > 0));
    assert.ok(report.hints.some(hint => /recover-lock/.test(hint)));
    // 损坏与旧版（仅时间戳）记录要能识别，且诊断本身绝不抛错。
    await writeFile(path.join(temp.directory, 'maintenance'), '{broken');
    assert.equal((await runtime.diagnose(temp.directory)).management.maintenance?.damaged, true);
    await writeFile(path.join(temp.directory, 'maintenance'), '2026-10-01T00:00:00.000Z');
    assert.equal((await runtime.diagnose(temp.directory)).management.maintenance?.legacy, true);
  } finally { await temp.cleanup(); }
});
