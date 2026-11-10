import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, access, stat, rename } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { freePort, testDirectory, fakeProfile } from './helpers.js';
import { projectDir, type Config } from '../src/config.js';
import { VERSION } from '../src/version.js';
import { toolDefinitions, isAdvancedTool } from '../src/tools.js';

function option(name: string, fallback: string) { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]!; }
const durationMs = Number(option('--duration-ms', '120000'));
const intervalMs = Number(option('--interval-ms', '50'));
const restartEvery = Number(option('--restart-every', '40'));
const serverEntry = path.resolve(option('--server-entry', path.join(projectDir, 'dist/cli.js')));
const nodeBinary = path.resolve(option('--node', process.execPath));
assert.ok(serverEntry.startsWith(projectDir + path.sep));
assert.ok(durationMs > 0 && durationMs <= 7 * 86400000 && intervalMs >= 0 && restartEvery >= 1);
const output = path.resolve(option('--report-dir', path.join(projectDir, '.local/verification/soak-short')));
assert.ok(output.startsWith(path.join(projectDir, '.local') + path.sep));
await mkdir(output, { recursive: true });
const temp = await testDirectory();
const config: Config = { port: await freePort(), token: randomBytes(32).toString('hex'), dataDir: temp.directory, outputLimit: 1200, eventLimit: 100, eventByteLimit: 65536, resultByteLimit: 262144 };
await writeFile(path.join(config.dataDir, 'config.json'), JSON.stringify(config));
const profiles = [randomUUID(), randomUUID()];
const counters = [0, 0];
let browsers: Awaited<ReturnType<typeof fakeProfile>>[] = [];
let daemon: ChildProcess | undefined;
const clients: Client[] = [];
const started = Date.now();
let cycles = 0, restarts = 0, reconnects = 0, crashRecoveries = 0, queueChecks = 0, maxRss = 0, maxStateBytes = 0, lastTick = started, stop = false;
const gaps: number[] = [];
const latencies: number[] = [];
let resources: unknown;
let status = 'running', failure: string | undefined;
let sawCrash!: () => void;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function admin(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${config.port}${route}`, { method, headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
  assert.ok(response.ok, `${route}: ${response.status}`); return await response.json() as any;
}
async function startDaemon() {
  daemon = spawn(nodeBinary, [serverEntry, 'serve'], { env: { ...process.env, CHROME_MCP_DATA_DIR: config.dataDir }, windowsHide: true, stdio: 'ignore' });
  for (let retry = 0; retry < 100; retry++) {
    try { if ((await admin('/health')).version === VERSION) return; } catch { /* 等待本次测试服务启动。 */ }
    if (daemon.exitCode !== null) throw new Error('Test daemon exited during startup');
    await sleep(50);
  }
  throw new Error('Test daemon startup timeout');
}
async function stopDaemon(force = false) {
  if (!daemon || daemon.exitCode !== null) return;
  const exited = once(daemon, 'exit');
  if (force) daemon.kill('SIGKILL'); else await admin('/admin/shutdown', 'POST', {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => { daemon?.kill('SIGKILL'); reject(new Error('Test daemon shutdown timeout')); }, 10000); })]); }
  finally { clearTimeout(timer); }
}
async function connectProfiles() {
  browsers = await Promise.all(profiles.map((id, index) => fakeProfile(config, `soak-${index}`, async command => {
    if (command.operation === 'tabs.list') return [{ tabId: 1, windowId: 1, title: 'soak', url: 'https://fixture.invalid' }];
    if (command.args.expression === 'crash-before-effect') { sawCrash(); return await new Promise(() => {}); }
    if (command.operation === 'page.evaluate') return { index, count: ++counters[index]! };
    if (command.operation === 'page.inspect') return { text: 'soak'.repeat(10000) };
    return {};
  }, id)));
}
async function call(index: number, name: string, args: Record<string, unknown>) {
  const result = await clients[index]!.callTool({ name, arguments: args });
  return result.structuredContent as any;
}
async function checkpoint() {
  const ordered = [...latencies].sort((a, b) => a - b);
  const report = { version: VERSION, status, passed: status === 'passed', pid: process.pid, daemonPid: daemon?.pid, startedAt: new Date(started).toISOString(), updatedAt: new Date().toISOString(),
    serverEntry, targetDurationMs: durationMs, elapsedMs: Date.now() - started, intervalMs, restartEvery, cycles, restarts, reconnects, crashRecoveries, queueChecks, maxRss, maxStateBytes,
    p95RecentCycleMs: ordered[Math.floor(ordered.length * .95)] ?? null, gaps, resources, failure,
    scope: '独立服务进程 + 两个合成桥接配置 + 两个真实 SDK stdio 客户端；不代表 Chrome/操作系统休眠全矩阵', stopFile: path.join(output, 'STOP') };
  const next = path.join(output, 'report.next.json'); await writeFile(next, JSON.stringify(report, null, 2)); await rename(next, path.join(output, 'report.json'));
}
process.on('SIGINT', () => { stop = true; }); process.on('SIGTERM', () => { stop = true; });
try {
  await startDaemon(); await connectProfiles();
  for (let index = 0; index < 2; index++) {
    const grant = await admin('/clients', 'POST', { label: `soak-${index}`, profiles: [profiles[index]] });
    const client = new Client({ name: `soak-client-${index}`, version: '1' }); clients.push(client);
    await client.connect(new StdioClientTransport({ command: nodeBinary, args: [serverEntry, 'mcp'], env: { ...process.env, CHROME_MCP_DATA_DIR: config.dataDir, CHROME_MCP_TOKEN_FILE: grant.tokenFile }, stderr: 'pipe' }));
    assert.equal((await client.listTools()).tools.length, toolDefinitions.filter(tool => !isAdvancedTool(tool.name)).length);
  }
  await checkpoint();
  while (!stop && Date.now() - started < durationMs) {
    try { await access(path.join(output, 'STOP')); stop = true; break; } catch { /* 没有停止请求。 */ }
    const now = Date.now(); if (now - lastTick > Math.max(30000, intervalMs * 4) && gaps.length < 100) gaps.push(now - lastTick); lastTick = now;
    const before = [...counters];
    const results = await Promise.all(profiles.map((profileId, index) => call(index, 'chrome_evaluate', { profileId, tabId: 1, expression: 'increment' })));
    results.forEach((result, index) => { assert.equal(result.ok, true); assert.equal(result.data.index, index); assert.equal(result.data.count, before[index]! + 1); });
    cycles++;
    if (cycles % 50 === 0) {
      const jobs = await Promise.all(profiles.map((profileId, index) => call(index, 'chrome_task_submit', { profileId, tabId: 1, name: 'soak queue', captureOnFailure: false, steps: [{ operation: 'page.evaluate', args: { expression: 'increment' } }] })));
      jobs.forEach(result => assert.equal(result.ok, true));
      for (let index = 0; index < jobs.length; index++) {
        let finished = false;
        for (let retry = 0; retry < 100; retry++) {
          const task = await call(index, 'chrome_task', { profileId: profiles[index], taskId: jobs[index].data.id }); assert.ok(task.ok);
          if (task.data.status === 'succeeded') { finished = true; break; }
          assert.ok(!['failed', 'needs_review', 'interrupted'].includes(task.data.status)); await sleep(20);
        }
        assert.ok(finished, '队列任务未完成');
        queueChecks++;
      }
    }
    if (cycles % 10 === 0) {
      assert.equal((await call(0, 'chrome_tabs', { profileId: profiles[1] })).error.code, 'PROFILE_NOT_AUTHORIZED');
      for (let index = 0; index < 200; index++) browsers[0]!.socket.send(JSON.stringify({ type: 'event', method: 'Network.soak', params: { value: 'x'.repeat(4096) } }));
      const long = await call(0, 'chrome_inspect', { profileId: profiles[0], tabId: 1 }); assert.ok(long.ok && long.data.saved);
      const page = await call(0, 'chrome_read_result', { artifactId: long.data.artifactId, offset: 0, limit: 128 }); assert.ok(page.ok);
      await admin(`/results/${long.data.artifactId}`, 'DELETE'); // 仅删除本测试刚创建的结果。
    }
    if (cycles % restartEvery === 0) {
      const seen = new Promise<void>(resolve => { sawCrash = resolve; });
      const pending = call(0, 'chrome_evaluate', { profileId: profiles[0], tabId: 1, expression: 'crash-before-effect' });
      await seen; const expected = counters[0]; await stopDaemon(true); const interrupted = await pending; assert.equal(interrupted.ok, false);
      await startDaemon(); await connectProfiles(); restarts++; reconnects += 2;
      assert.equal((await call(0, 'chrome_evaluate', { profileId: profiles[0], tabId: 1, expression: 'increment' })).error.code, 'RESULT_UNKNOWN');
      assert.equal(counters[0], expected);
      const unknown = await call(0, 'chrome_operations', { profileId: profiles[0], state: 'unknown', limit: 1 });
      const record = unknown.data.items.find((item: any) => !item.acknowledgedAt); assert.ok(record);
      assert.equal((await call(0, 'chrome_recover_operation', { operationId: record.id, acknowledged: true })).ok, true); crashRecoveries++;
    }
    const diagnostic = await admin('/diagnostics'); resources = diagnostic.resources;
    assert.equal(diagnostic.resources.pendingCommands, 0); assert.equal(diagnostic.resources.locks, 0); assert.equal(diagnostic.resources.inFlight, 0);
    assert.ok(diagnostic.resources.eventCount <= 100 && diagnostic.resources.eventBytes <= 65536);
    maxRss = Math.max(maxRss, diagnostic.memory.rss); assert.ok(maxRss < 512 * 1024 * 1024, '服务 RSS 超过 512 MiB 测试预算');
    let bytes = 0; for (const file of ['state.sqlite', 'state.sqlite-wal']) bytes += await stat(path.join(config.dataDir, file)).then(s => s.size, () => 0);
    maxStateBytes = Math.max(maxStateBytes, bytes); assert.ok(bytes < 64 * 1024 * 1024, '状态数据库超过 64 MiB 测试预算');
    latencies.push(Date.now() - now); if (latencies.length > 1000) latencies.shift();
    if (cycles % 10 === 0) await checkpoint();
    await sleep(intervalMs);
  }
  status = stop ? 'stopped' : gaps.length ? 'needs-review' : 'passed';
} catch (error) { status = 'failed'; failure = String(error); process.exitCode = 1; }
finally {
  try { await checkpoint(); }
  finally {
    await Promise.allSettled(clients.map(client => client.close()));
    await stopDaemon().catch(() => daemon?.kill('SIGKILL')); browsers.forEach(browser => browser.socket.terminate()); await temp.cleanup();
  }
  console.log(JSON.stringify({ status, cycles, restarts, crashRecoveries, elapsedMs: Date.now() - started, failure, report: path.join(output, 'report.json') }));
}
