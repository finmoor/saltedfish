import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { access, copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import * as runtime from '../src/npm-runtime.js';
import { withManagementMutex } from '../src/management-lock.js';
import { projectDir } from '../src/config.js';
import { freePort, testDirectory } from './helpers.js';

const OLD = '0.2.0-beta.20', NEW = '0.2.0-beta.21';
const oldActive = { product: 'saltedfish-npm' as const, version: OLD, stateVersion: 1 };
const newActive = { product: 'saltedfish-npm' as const, version: NEW, previous: OLD, stateVersion: 2 };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const exists = (file: string) => access(file).then(() => true, () => false);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };

// 假后台：只实现管理口的 /status 与 /stop，并把每次启动的版本追加到 logs/spawned-<role>.txt。
const fakeWorker = (version: string) => `const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const role=process.argv[2],home=process.argv[3],version=${JSON.stringify(version)},run=path.join(home,'run',role+'.json');
const token=crypto.randomBytes(32).toString('hex'),instanceId=crypto.randomUUID(),startedAt=new Date().toISOString();
fs.appendFileSync(path.join(home,'logs','spawned-'+role+'.txt'),version+'\\n');
const snapshot=()=>({role,home,instanceId,version,pid:process.pid,startedAt,busy:false});
const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');
 if(req.headers.authorization!=='Bearer '+token){res.writeHead(403);res.end('{}');return;}
 if(req.method==='GET'&&req.url==='/status'){res.end(JSON.stringify(snapshot()));return;}
 if(req.method==='POST'&&req.url==='/stop'){res.writeHead(202);res.end(JSON.stringify(snapshot()));setTimeout(()=>{try{fs.rmSync(run);}catch{}process.exit(0);},25);return;}
 res.writeHead(404);res.end('{}');});
server.listen(0,'127.0.0.1',()=>{fs.writeFileSync(run+'.tmp',JSON.stringify({role,home,token,instanceId,version,pid:process.pid,startedAt,port:server.address().port}));fs.renameSync(run+'.tmp',run);});
`;
async function release(home: string, version: string, stateVersion: number) {
  const directory = path.join(home, 'versions', version), files: Record<string, string> = {};
  const contents: Record<string, string> = { 'package.json': '{}', 'dist/npm-cli.js': '{}', 'dist/npm-worker.js': fakeWorker(version), 'dist/cli.js': "console.log('mcp-ok '+process.argv.slice(2).join(' '));", 'dist/gateway-cli.js': '{}', 'dist/extension/manifest.json': '{}', 'ui/index.html': '{}' };
  for (const [name, content] of Object.entries(contents)) {
    const file = path.join(directory, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content);
    files[name] = createHash('sha256').update(content).digest('hex');
  }
  await writeFile(path.join(directory, 'saltedfish-release.json'), JSON.stringify({ product: 'saltedfish-npm', version, stateVersion, files }));
}
async function lifecycleHome(options: { active?: typeof oldActive | typeof newActive; localConfig?: boolean } = {}) {
  const temp = await testDirectory(), home = await realpath(temp.directory);
  for (const folder of ['run', 'data', 'versions', 'logs', 'data/gateway', 'data/local']) await mkdir(path.join(home, folder), { recursive: true });
  await writeFile(path.join(home, 'installation.json'), JSON.stringify({ product: 'saltedfish-npm' }));
  await writeFile(path.join(home, 'data/gateway/gateway.json'), '{}');
  if (options.localConfig) await writeFile(path.join(home, 'data/local/config.json'), '{}');
  await release(home, OLD, 1); await release(home, NEW, 2);
  await runtime.saveActive(home, options.active ?? oldActive);
  return { temp, home };
}
const database = (home: string, format: number) => {
  const file = path.join(home, 'data/local/state.sqlite'), db = new DatabaseSync(file);
  db.exec(`CREATE TABLE receipts(id TEXT); INSERT INTO receipts VALUES ('keep'); PRAGMA user_version=${format}`); db.close(); return file;
};
const writeMarker = (home: string, phase: string, wasRunning: string[] = [], extra: Record<string, unknown> = {}) =>
  writeFile(path.join(home, 'maintenance'), JSON.stringify({ schemaVersion: 1, id: randomUUID(), pid: 2147483647, createdAt: new Date().toISOString(), phase, before: oldActive, after: newActive, wasRunning, ...extra }));
const spawned = async (home: string, role = 'gateway') => (await readFile(path.join(home, 'logs', `spawned-${role}.txt`), 'utf8').catch(() => '')).split('\n').filter(Boolean);
async function reapWorkers(home: string) {
  for (const role of runtime.roles) {
    const record = await runtime.runningRecord(home, role).catch(() => undefined);
    if (record && alive(record.pid)) { try { process.kill(record.pid); } catch { /* 已退出 */ } for (let i = 0; i < 50 && alive(record.pid); i++) await pause(100); }
  }
}
async function cli(args: string[]) {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(projectDir, 'src/npm-cli.ts'), ...args], { cwd: projectDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  const timer = setTimeout(() => child.kill(), 90_000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timer));
  return { code, stdout, stderr };
}

test('数据格式 2 的中断升级：向前完成并在新版本上重启原运行角色，不回退任务库', async () => {
  const { temp, home } = await lifecycleHome({ active: newActive });
  try {
    const file = database(home, 2), before = await readFile(file);
    await writeMarker(home, 'starting', ['gateway']);
    const result = await runtime.recoverLock(home);
    assert.equal(result.maintenance?.state, 'completed_forward');
    assert.equal(result.maintenance?.version, NEW);
    assert.equal((await runtime.active(home)).version, NEW);
    assert.equal(await exists(path.join(home, 'maintenance')), false, '收尾后维护标记必须清除，MCP 入口恢复');
    const status = await runtime.serviceStatus(home, 'gateway');
    assert.equal(status.state, 'running');
    assert.equal(status.version, NEW);
    assert.deepEqual(await spawned(home), [NEW]);
    assert.deepEqual(await readFile(file), before, '任务数据库字节不变');
    assert.equal((await runtime.recoverLock(home)).recovered, false, '可重复执行');
  } finally { await reapWorkers(home); await temp.cleanup(); }
});

test('旧版 recover-lock 失败后卡在 rolling_back 的现场（格式 2、服务已停）也能向前完成', async () => {
  const { temp, home } = await lifecycleHome({ active: newActive });
  try {
    database(home, 2);
    await writeMarker(home, 'rolling_back', ['gateway']);
    assert.equal((await runtime.recoverLock(home)).maintenance?.state, 'completed_forward');
    assert.equal((await runtime.serviceStatus(home, 'gateway')).version, NEW);
    assert.equal(await exists(path.join(home, 'maintenance')), false);
  } finally { await reapWorkers(home); await temp.cleanup(); }
});

test('数据格式 1 的中断升级仍回退到旧版本并在旧版本上重启（行为不变）', async () => {
  const { temp, home } = await lifecycleHome({ active: newActive });
  try {
    const file = database(home, 1), before = await readFile(file);
    await writeMarker(home, 'starting', ['gateway']);
    const result = await runtime.recoverLock(home);
    assert.equal(result.maintenance?.state, 'rolled_back');
    assert.equal((await runtime.active(home)).version, OLD);
    const status = await runtime.serviceStatus(home, 'gateway');
    assert.equal(status.state, 'running');
    assert.equal(status.version, OLD);
    assert.deepEqual(await readFile(file), before);
  } finally { await reapWorkers(home); await temp.cleanup(); }
});

test('数据库格式超出升级前后两个版本：停任何服务之前就拒绝，标记、阶段、服务与数据原样保留', async () => {
  const { temp, home } = await lifecycleHome({ active: newActive });
  try {
    const file = database(home, 3), before = await readFile(file);
    await runtime.startService(home, 'gateway');
    const running = await runtime.serviceStatus(home, 'gateway');
    await writeMarker(home, 'starting', ['gateway']);
    await assert.rejects(runtime.recoverLock(home), /数据库格式 3/);
    const after = await runtime.serviceStatus(home, 'gateway');
    assert.equal(after.state, 'running', '无法恢复时不能先把服务停掉');
    assert.equal(after.pid, running.pid);
    assert.equal(JSON.parse(await readFile(path.join(home, 'maintenance'), 'utf8')).phase, 'starting');
    assert.equal((await runtime.active(home)).version, NEW);
    assert.deepEqual(await readFile(file), before);
  } finally { await reapWorkers(home); await temp.cleanup(); }
});

test('正常升级回归：切换两个版本、重启原运行角色、标记清除', async () => {
  const { temp, home } = await lifecycleHome();
  try {
    await runtime.startService(home, 'gateway');
    const clients = await runtime.switchVersion(home, NEW);
    assert.ok(Array.isArray(clients));
    assert.equal((await runtime.active(home)).version, NEW);
    const status = await runtime.serviceStatus(home, 'gateway');
    assert.equal(status.state, 'running');
    assert.equal(status.version, NEW);
    assert.deepEqual(await spawned(home), [OLD, NEW]);
    assert.equal(await exists(path.join(home, 'maintenance')), false);
  } finally { await reapWorkers(home); await temp.cleanup(); }
});

test('版本已提交后清理维护标记失败：只给出告警，不触发整套停启，recover-lock 随后收尾', async () => {
  const { temp, home } = await lifecycleHome();
  const original = runtime.hooks.removeMarker;
  try {
    await runtime.startService(home, 'gateway');
    runtime.hooks.removeMarker = async () => { throw Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' }); };
    const clients = await runtime.switchVersion(home, NEW) as Array<{ warning?: string }>;
    assert.ok(clients.some(entry => /recover-lock/.test(entry.warning ?? '')), '应有指向 recover-lock 的独立告警');
    assert.equal((await runtime.active(home)).version, NEW, '版本其实已经切换');
    assert.equal(JSON.parse(await readFile(path.join(home, 'maintenance'), 'utf8')).phase, 'committed');
    assert.deepEqual(await spawned(home), [OLD, NEW], '提交之后不能再为清理标记整套停启一次');
    runtime.hooks.removeMarker = original;
    assert.equal((await runtime.recoverLock(home)).maintenance?.state, 'completed');
    assert.equal(await exists(path.join(home, 'maintenance')), false);
  } finally { runtime.hooks.removeMarker = original; await reapWorkers(home); await temp.cleanup(); }
});

test('recover-lock --forget-run 拒绝丢弃仍在运行的服务的记录', async () => {
  const { temp, home } = await lifecycleHome();
  try {
    await runtime.startService(home, 'gateway');
    await assert.rejects(runtime.recoverLock(home, { forgetRun: 'gateway' }), /仍在运行/);
    assert.equal((await runtime.serviceStatus(home, 'gateway')).state, 'running');
  } finally { await reapWorkers(home); await temp.cleanup(); }
});

test('升级中断又遇到被无关进程占用的陈旧运行记录：恢复被如实拒绝并指明出口，一条命令即可收尾', async () => {
  const { temp, home } = await lifecycleHome({ active: newActive });
  const stranger = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  const original = runtime.hooks.inspectProcess;
  try {
    await new Promise<void>(resolve => stranger.once('spawn', () => resolve()));
    database(home, 1);
    await writeMarker(home, 'starting');
    await writeFile(path.join(home, 'run/local.json'), JSON.stringify({ role: 'local', home, token: 'a'.repeat(64), instanceId: randomUUID(), pid: stranger.pid, version: NEW, startedAt: new Date().toISOString(), port: await freePort() }));
    runtime.hooks.inspectProcess = async () => 'unknown';
    await assert.rejects(runtime.recoverLock(home), /recover-lock --forget-run local/);
    assert.equal(JSON.parse(await readFile(path.join(home, 'maintenance'), 'utf8')).phase, 'starting', '被拒绝时现场原样保留');
    const result = await runtime.recoverLock(home, { forgetRun: 'local' });
    assert.equal(result.runRecord?.role, 'local');
    assert.equal(result.maintenance?.state, 'rolled_back');
    assert.equal(await exists(path.join(home, 'maintenance')), false);
    assert.equal((await runtime.active(home)).version, OLD);
    assert.ok(alive(stranger.pid!), '全程不能结束无关进程');
  } finally {
    runtime.hooks.inspectProcess = original;
    if (stranger.exitCode === null) { stranger.kill(); await new Promise(resolve => stranger.once('close', resolve)); }
    await temp.cleanup();
  }
});

test('自动启动：后到者在有界时间内等待先到者，而不是立即失败；并发调用只启动一个后台', async () => {
  const { temp, home } = await lifecycleHome();
  try {
    let release!: () => void;
    const holder = withManagementMutex(home, () => new Promise<void>(resolve => release = resolve));
    const begun = Date.now(), waiter = runtime.ensureService(home, 'gateway', false, 8000);
    setTimeout(() => release(), 700);
    await waiter; await holder;
    assert.ok(Date.now() - begun >= 600, '应当等到互斥释放后才启动');
    assert.equal((await runtime.serviceStatus(home, 'gateway')).state, 'running');
    assert.deepEqual(await spawned(home), [OLD]);
    await runtime.ensureService(home, 'gateway', false, 1000);
    assert.deepEqual(await spawned(home), [OLD], '已运行时是空操作');
  } finally { await reapWorkers(home); await temp.cleanup(); }
});

test('自动启动：两个调用者同时到达只会启动一个后台', async () => {
  const { temp, home } = await lifecycleHome();
  try {
    await Promise.all([runtime.ensureService(home, 'gateway', false, 10_000), runtime.ensureService(home, 'gateway', false, 10_000)]);
    assert.equal((await runtime.serviceStatus(home, 'gateway')).state, 'running');
    assert.deepEqual(await spawned(home), [OLD]);
  } finally { await reapWorkers(home); await temp.cleanup(); }
});

test('自动启动：互斥被长时间占用时等待有上限，之后仍给出原来的占用提示', async () => {
  const { temp, home } = await lifecycleHome();
  try {
    let release!: () => void;
    const holder = withManagementMutex(home, () => new Promise<void>(resolve => release = resolve));
    const begun = Date.now();
    await assert.rejects(runtime.ensureService(home, 'gateway', false, 400), (error: Error) => error instanceof runtime.LockBusyError && /另一个安装或恢复操作仍在进行/.test(error.message));
    const waited = Date.now() - begun;
    assert.ok(waited >= 350 && waited < 5000, `等待时长 ${waited}ms 应接近上限`);
    release(); await holder;
    assert.equal((await runtime.serviceStatus(home, 'gateway')).state, 'stopped');
  } finally { await reapWorkers(home); await temp.cleanup(); }
});

test('自动启动：显式停止的服务不会被 MCP 重新拉起，也不在等待中重试', async () => {
  const { temp, home } = await lifecycleHome();
  try {
    await writeFile(runtime.stopPath(home, 'gateway'), new Date().toISOString());
    const begun = Date.now();
    await assert.rejects(runtime.ensureService(home, 'gateway', true, 5000), /显式停止/);
    assert.ok(Date.now() - begun < 3000);
    assert.deepEqual(await spawned(home), []);
  } finally { await reapWorkers(home); await temp.cleanup(); }
});

test('saltedfish mcp 的后到进程等待先到进程完成启动，最终正常交给 MCP 核心', async () => {
  const { temp, home } = await lifecycleHome({ localConfig: true });
  try {
    let release!: () => void;
    const holder = withManagementMutex(home, () => new Promise<void>(resolve => release = resolve));
    setTimeout(() => release(), 3500);
    const result = await cli(['mcp', '--home', home]);
    await holder;
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /mcp-ok mcp/);
    assert.deepEqual(await spawned(home, 'local'), [OLD], '只启动一个后台');
  } finally { await reapWorkers(home); await temp.cleanup(); }
});

test('未完成的维护事务：MCP 入口给出阶段、时间并指向 recover-lock，而不是笼统的“请稍后重连”', async () => {
  const { temp, home } = await lifecycleHome();
  try {
    await writeMarker(home, 'starting');
    const result = await cli(['mcp', '--home', home]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /recover-lock/);
    assert.match(result.stderr, /阶段 starting/);
    assert.match(result.stderr, new RegExp(`${OLD} → ${NEW}`));
    assert.match(result.stderr, /管理进程已退出/);
    assert.doesNotMatch(result.stderr, /请稍后重连。$/m);
  } finally { await temp.cleanup(); }
});

test('status/doctor 能看到未完成的维护事务和遗留锁，并给出处置提示', async () => {
  const { temp, home } = await lifecycleHome();
  try {
    await writeMarker(home, 'rolling_back', ['gateway']);
    await writeFile(path.join(home, 'manage.lock'), JSON.stringify({ pid: 2147483647, id: randomUUID() }));
    for (const command of ['status', 'doctor']) {
      const result = await cli([command, '--home', home]);
      assert.equal(result.code, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.active.version, OLD);
      assert.equal(report.services.length, 2);
      assert.equal(report.management.maintenance.phase, 'rolling_back');
      assert.equal(report.management.maintenance.owner, 'dead');
      assert.equal(report.management.maintenance.from, OLD);
      assert.equal(report.management.maintenance.to, NEW);
      assert.deepEqual(report.management.maintenance.wasRunning, ['gateway']);
      assert.equal(report.management.manageLock.state, 'stale');
      assert.ok(report.hints.some((hint: string) => /recover-lock/.test(hint)));
    }
    const clean = await lifecycleHome();
    try {
      const result = await cli(['status', '--home', clean.home]);
      const report = JSON.parse(result.stdout);
      assert.equal(report.management.maintenance, null);
      assert.equal(report.management.manageLock, null);
      assert.deepEqual(report.hints, []);
    } finally { await clean.temp.cleanup(); }
  } finally { await temp.cleanup(); }
});

test('recover-lock 命令行：--forget-run 校验角色，输出里有丢弃的记录信息', async () => {
  const { temp, home } = await lifecycleHome();
  try {
    const bad = await cli(['recover-lock', '--forget-run', 'nobody', '--home', home]);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /--forget-run/);
    const good = await cli(['recover-lock', '--forget-run', 'local', '--home', home]);
    assert.equal(good.code, 0, good.stderr);
    assert.equal(JSON.parse(good.stdout).recovered, false);
  } finally { await temp.cleanup(); }
});

// 历史上（beta.16–beta.21）固定 launcher 的全文，升级时只对这份已知内容做受控替换。
const LEGACY_LAUNCHER = "import{readFile,access}from'node:fs/promises';import{spawn}from'node:child_process';import path from'node:path';import{fileURLToPath}from'node:url';\nconst home=path.dirname(fileURLToPath(import.meta.url));try{try{await access(path.join(home,'maintenance'));throw new Error('SaltedFish 正在升级，请稍后重连。');}catch(e){if(e.code!=='ENOENT')throw e;}const s=JSON.parse(await readFile(path.join(home,'active.json'),'utf8'));if(s.product!=='saltedfish-npm'||!/^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$/.test(s.version))throw new Error('SaltedFish 版本标记无效');const p=spawn(process.execPath,[path.join(home,'versions',s.version,'dist/npm-cli.js'),...process.argv.slice(2),'--home',home],{stdio:'inherit',windowsHide:true});p.on('error',e=>{console.error(e.message);process.exitCode=1;});p.on('exit',(code)=>process.exit(code??1));for(const sig of['SIGTERM','SIGINT'])process.on(sig,()=>p.kill(sig));}catch(e){console.error(e.message);process.exitCode=1;}\n";

async function runLauncher(home: string) {
  const child = spawn(process.execPath, [path.join(home, 'launcher.mjs'), 'mcp'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => stderr += chunk);
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { code, stderr };
}

test('固定 launcher：维护标记存在时说明阶段，区分进行中与已中断，并指向 recover-lock', async () => {
  const { temp, home } = await lifecycleHome();
  try {
    assert.equal(await runtime.writeLauncher(home), 'created');
    await writeMarker(home, 'starting', [], { pid: 2147483647 });
    const stale = await runLauncher(home);
    assert.equal(stale.code, 1);
    assert.match(stale.stderr, /recover-lock/);
    assert.match(stale.stderr, /阶段 starting/);
    assert.match(stale.stderr, /管理进程已退出/);
    await writeMarker(home, 'starting', [], { pid: process.pid });
    const running = await runLauncher(home);
    assert.equal(running.code, 1);
    assert.match(running.stderr, /正在升级/);
    assert.match(running.stderr, /recover-lock/);
    await writeFile(path.join(home, 'maintenance'), '2026-10-01T00:00:00.000Z');
    const legacy = await runLauncher(home);
    assert.equal(legacy.code, 1);
    assert.match(legacy.stderr, /recover-lock/);
  } finally { await temp.cleanup(); }
});

test('固定 launcher：已知旧内容受控迁移为新文案，未知内容仍拒绝静默覆盖', async () => {
  const { temp, home } = await lifecycleHome();
  try {
    assert.equal(createHash('sha256').update(LEGACY_LAUNCHER).digest('hex'), 'e0aee57ed0723b7fcd89b46b2a9bc49ca4065ec9269fa8c717615dc41e568f53', '夹具必须是真实的历史 launcher');
    const file = path.join(home, 'launcher.mjs');
    await writeFile(file, LEGACY_LAUNCHER);
    assert.equal(await runtime.writeLauncher(home), 'updated');
    const migrated = await readFile(file, 'utf8');
    assert.notEqual(migrated, LEGACY_LAUNCHER);
    assert.equal(await runtime.writeLauncher(home), 'current');
    assert.equal(await readFile(file, 'utf8'), migrated);
    await writeFile(file, '// 用户改过\n');
    await assert.rejects(runtime.writeLauncher(home), /固定 launcher 内容不同/);
    assert.equal(await readFile(file, 'utf8'), '// 用户改过\n');
  } finally { await temp.cleanup(); }
});

// Git Bash 的 PATH 里 whoami 是 msys 版本，不接受 Windows 参数；初始化数据目录必须固定调用系统程序。
test('Windows 初始化数据目录不受 PATH 里同名命令影响', { skip: process.platform !== 'win32' }, async t => {
  const temp = await testDirectory();
  t.after(() => temp.cleanup());
  const fake = path.join(temp.directory, 'fake'), system = path.join(process.env.SystemRoot!, 'System32');
  await mkdir(fake);
  // hostname.exe 不输出用户 SID，也不接受这些参数：命中它就和 Git Bash 下一样初始化失败。
  for (const name of ['whoami.exe', 'icacls.exe']) await copyFile(path.join(system, 'hostname.exe'), path.join(fake, name));
  const original = process.env.PATH;
  process.env.PATH = fake + path.delimiter + original;
  t.after(() => { process.env.PATH = original; });
  const home = await runtime.ensureHome(path.join(temp.directory, 'home'));
  assert.equal(await exists(path.join(home, 'installation.json')), true);
});
