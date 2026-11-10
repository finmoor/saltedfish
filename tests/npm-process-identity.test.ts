import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import * as runtime from '../src/npm-runtime.js';
import { freePort, testDirectory } from './helpers.js';

const identityPlatform = ['win32', 'linux'].includes(process.platform);

async function homeFixture() {
  const temp = await testDirectory(), home = temp.directory;
  for (const folder of ['run', 'data', 'versions', 'logs']) await mkdir(path.join(home, folder));
  const version = '0.2.0-beta.20', directory = path.join(home, 'versions', version), files: Record<string, string> = {};
  for (const name of ['package.json', 'dist/npm-cli.js', 'dist/npm-worker.js', 'dist/cli.js', 'dist/gateway-cli.js', 'dist/extension/manifest.json', 'ui/index.html']) {
    const file = path.join(directory, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, '{}');
    files[name] = createHash('sha256').update('{}').digest('hex');
  }
  await writeFile(path.join(directory, 'saltedfish-release.json'), JSON.stringify({ product: 'saltedfish-npm', version, stateVersion: 1, files }));
  await runtime.saveActive(home, { product: 'saltedfish-npm', version, stateVersion: 1 });
  return temp;
}
// 真实的无关进程：只用来占住一个存活的 PID，绝不能被被测代码结束。
async function sleeper(...extra: string[]) {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', ...extra], { windowsHide: true, stdio: 'ignore' });
  await once(child, 'spawn'); return child;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };
async function reap(child: ChildProcess) { if (child.exitCode === null) { const closed = once(child, 'close'); child.kill(); await closed; } }
async function writeRun(home: string, role: 'local' | 'gateway', pid: number, startedAt: string) {
  await writeFile(path.join(home, 'run', `${role}.json`), JSON.stringify({ role, home, token: 'a'.repeat(64), instanceId: randomUUID(), pid, version: '0.2.0-beta.20', startedAt, port: await freePort() }));
}
async function withProbe<T>(probe: (pid: number) => Promise<runtime.ProcessInfo>, work: () => Promise<T>) {
  const original = runtime.hooks.inspectProcess; runtime.hooks.inspectProcess = probe;
  try { return await work(); } finally { runtime.hooks.inspectProcess = original; }
}

test('Linux /proc/<pid>/stat 解析：进程名含空格和括号时仍取对启动时刻与状态', () => {
  const stat = '4242 (node (sub) x) S 1 4242 4242 0 -1 4194560 1000 0 0 0 5 3 0 0 20 0 7 0 123456 99999 8 18446744073709551615';
  assert.deepEqual(runtime.parseProcStat(stat), { state: 'S', startTicks: 123456 });
  assert.equal(runtime.parseProcStat(stat.replace(' S ', ' Z '))?.state, 'Z');
  assert.equal(runtime.parseProcStat('garbage'), undefined);
  assert.equal(runtime.parseProcStat('1 (a) S 1'), undefined);
});

const procStat = (pid: number, state: string, ticks: number, comm = 'node') => `${pid} (${comm}) ${state} 1 ${pid} ${pid} 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 7 0 ${ticks} 99999 8`;
test('Linux：由 /proc 内容换算启动时间，僵尸进程按已退出处理，换算自检失败时放弃判断', () => {
  const now = 1_800_000_000_000, uptime = 100_000, ownUptime = 12;
  const ownTicks = (uptime - ownUptime) * 100; // 本进程启动于系统启动后 uptime-ownUptime 秒；USER_HZ=100。
  const base = { now, uptime, ownUptime, own: procStat(7, 'S', ownTicks), cmdline: 'node\0/opt/saltedfish/versions/1/dist/npm-worker.js\0local\0/home/x\0' };
  const live = runtime.linuxProcessInfo({ ...base, target: procStat(4242, 'S', 5_000_000, 'node (x)') });
  assert.ok(typeof live === 'object');
  assert.equal(Math.round((now - live.startedMs!) / 1000), 50_000, '目标启动于系统启动后 50000 秒，即距今 50000 秒');
  assert.equal(live.commandLine, 'node /opt/saltedfish/versions/1/dist/npm-worker.js local /home/x');
  assert.equal(runtime.linuxProcessInfo({ ...base, target: procStat(4242, 'Z', 5_000_000) }), 'gone');
  assert.equal(runtime.linuxProcessInfo({ ...base, target: 'garbage' }), 'unknown');
  assert.equal(runtime.linuxProcessInfo({ ...base, own: procStat(7, 'S', ownTicks + 100_000), target: procStat(4242, 'S', 5_000_000) }), 'unknown', '本进程自检偏差过大时不能据此下结论');
});

test('进程身份：已退出为 dead，启动晚于记录时间为 reused，早于或等于为 alive，缺少时间依据只报 unknown', async () => {
  assert.equal((await runtime.processOwner(2147483647, Date.now())).state, 'dead');
  assert.equal((await runtime.processOwner(process.pid, Date.now() + 60_000)).state, 'alive');
  assert.equal((await runtime.processOwner(process.pid, 1)).state, 'reused');
  assert.equal((await runtime.processOwner(process.pid, Number.NaN)).state, 'unknown');
  const original = runtime.hooks.inspectProcess;
  try {
    runtime.hooks.inspectProcess = async () => 'gone'; assert.equal((await runtime.processOwner(process.pid, Date.now())).state, 'dead');
    runtime.hooks.inspectProcess = async () => 'unknown'; assert.equal((await runtime.processOwner(process.pid, Date.now())).state, 'unknown');
    runtime.hooks.inspectProcess = async () => ({ commandLine: 'x' }); assert.equal((await runtime.processOwner(process.pid, Date.now())).state, 'unknown');
  } finally { runtime.hooks.inspectProcess = original; }
});

test('运行记录里的陈旧 PID 被无关进程复用：按 crashed 处理，start 不再被拒，stop 不触碰该进程', { skip: !identityPlatform }, async () => {
  const temp = await homeFixture(), home = temp.directory, stranger = await sleeper();
  try {
    await writeRun(home, 'local', stranger.pid!, '2020-01-01T00:00:00.000Z');
    const status = await runtime.serviceStatus(home, 'local');
    assert.equal(status.state, 'crashed', '无关进程占用了陈旧 PID 时不能判成 unreachable');
    assert.equal(status.pidReused, true);
    assert.match(status.hint, /PID/);
    await runtime.stopService(home, 'local');
    assert.ok(alive(stranger.pid!), 'stop 绝不能按陈旧 PID 结束无关进程');
    // 不再被“已有服务管理记录不可达”挡住；本夹具没有安装配置，所以停在后面的配置检查。
    await assert.rejects(runtime.startService(home, 'local'), /请先运行 saltedfish install/);
    assert.ok(alive(stranger.pid!));
  } finally { await reap(stranger); await temp.cleanup(); }
});

test('占用 PID 的进程命令行明确不是 SaltedFish 后台：即使启动时间对不上也不可能是原服务，按崩溃处理', { skip: !identityPlatform }, async () => {
  const temp = await homeFixture(), home = temp.directory, stranger = await sleeper();
  try {
    await writeRun(home, 'local', stranger.pid!, new Date().toISOString()); // 记录时间晚于该进程启动：时间上看不出复用。
    const status = await runtime.serviceStatus(home, 'local');
    assert.equal(status.state, 'crashed');
    assert.equal(status.pidReused, true);
    await runtime.stopService(home, 'local');
    assert.ok(alive(stranger.pid!));
  } finally { await reap(stranger); await temp.cleanup(); }
});

test('原服务仍存活但管理端口无响应：保持 unreachable，核对为同一服务，拒绝强杀并说明自行结束', { skip: !identityPlatform }, async () => {
  const temp = await homeFixture(), home = temp.directory, worker = await sleeper('npm-worker.js', 'local', home);
  try {
    await writeRun(home, 'local', worker.pid!, new Date().toISOString());
    const status = await runtime.serviceStatus(home, 'local');
    assert.equal(status.state, 'unreachable');
    assert.equal(status.identity, 'matches');
    assert.match(status.hint, /自行结束/);
    await assert.rejects(runtime.stopService(home, 'local'), /拒绝按 PID 强杀/);
    await assert.rejects(runtime.startService(home, 'local'), /不可达/);
    assert.ok(alive(worker.pid!));
  } finally { await reap(worker); await temp.cleanup(); }
});

test('无法核对进程身份：保持 unreachable 并提示可显式丢弃陈旧记录；诊断汇总出同一提示', async () => {
  const temp = await homeFixture(), home = temp.directory, stranger = await sleeper();
  try {
    await writeRun(home, 'local', stranger.pid!, new Date().toISOString());
    await withProbe(async () => 'unknown', async () => {
      const status = await runtime.serviceStatus(home, 'local');
      assert.equal(status.state, 'unreachable');
      assert.equal(status.identity, 'unverified');
      assert.match(status.hint, /recover-lock --forget-run local/);
      await assert.rejects(runtime.stopService(home, 'local'), /recover-lock --forget-run local/);
      await assert.rejects(runtime.startService(home, 'local'), /recover-lock --forget-run local/);
      const report = await runtime.diagnose(home);
      assert.equal(report.services[0].state, 'unreachable');
      assert.ok(report.hints.some(hint => /--forget-run local/.test(hint)));
    });
    assert.ok(alive(stranger.pid!));
  } finally { await reap(stranger); await temp.cleanup(); }
});

test('recover-lock --forget-run 只留档并丢弃运行记录，绝不结束进程；确属原服务时拒绝', async () => {
  const temp = await homeFixture(), home = temp.directory, stranger = await sleeper();
  try {
    await writeRun(home, 'local', stranger.pid!, new Date().toISOString());
    await withProbe(async () => 'unknown', async () => {
      const result = await runtime.recoverLock(home, { forgetRun: 'local' });
      assert.equal(result.recovered, true);
      assert.equal(result.runRecord?.role, 'local');
      assert.equal(result.runRecord?.pid, stranger.pid);
      assert.equal((await runtime.serviceStatus(home, 'local')).state, 'stopped');
    });
    assert.ok(alive(stranger.pid!), '丢弃记录不能结束任何进程');
    const kept = (await readdir(path.join(home, 'run'))).filter(name => name.startsWith('local.abandoned-'));
    assert.equal(kept.length, 1, '原记录应改名留档用于诊断');
    assert.equal(JSON.parse(await readFile(path.join(home, 'run', kept[0]!), 'utf8')).pid, stranger.pid);
    // 没有记录时是空操作，不报错。
    assert.equal((await runtime.recoverLock(home, { forgetRun: 'local' })).recovered, false);
  } finally { await reap(stranger); await temp.cleanup(); }
});

test('损坏或属于其他安装的运行记录会让 status/start 一直报错：--forget-run 同样可以留档丢弃', async () => {
  const temp = await homeFixture(), home = temp.directory;
  try {
    for (const content of ['{broken', JSON.stringify({ role: 'local', home: path.join(home, 'elsewhere'), token: 'a'.repeat(64), instanceId: randomUUID(), pid: 2147483647, version: '0.2.0-beta.20', startedAt: new Date().toISOString(), port: await freePort() })]) {
      await writeFile(path.join(home, 'run/local.json'), content);
      await assert.rejects(runtime.serviceStatus(home, 'local'));
      const result = await runtime.recoverLock(home, { forgetRun: 'local' });
      assert.equal(result.recovered, true);
      assert.equal(result.runRecord?.state, 'invalid');
      assert.equal((await runtime.serviceStatus(home, 'local')).state, 'stopped');
    }
  } finally { await temp.cleanup(); }
});

test('--forget-run 遇到确属原服务的存活进程时拒绝并保留记录', { skip: !identityPlatform }, async () => {
  const temp = await homeFixture(), home = temp.directory, worker = await sleeper('npm-worker.js', 'local', home);
  try {
    await writeRun(home, 'local', worker.pid!, new Date().toISOString());
    await assert.rejects(runtime.recoverLock(home, { forgetRun: 'local' }), /自行结束/);
    assert.equal(JSON.parse(await readFile(path.join(home, 'run/local.json'), 'utf8')).pid, worker.pid);
    assert.ok(alive(worker.pid!));
  } finally { await reap(worker); await temp.cleanup(); }
});

test('陈旧记录的 PID 恰好是当前进程自己（容器重启后 PID 重合）：新进程不会因此拒绝启动', async () => {
  const temp = await homeFixture(), home = temp.directory;
  try {
    await writeRun(home, 'gateway', process.pid, '2020-01-01T00:00:00.000Z');
    const status = await runtime.serviceStatus(home, 'gateway');
    assert.equal(status.state, 'crashed');
    assert.equal(status.pidReused, true);
  } finally { await temp.cleanup(); }
});
