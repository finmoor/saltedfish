import test from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import { Broker } from '../src/broker.js';
import { fixture, fakeProfile } from './helpers.js';
import { openCodeConfig } from '../src/client-config.js';

test('旧 socket 已被重连替换时仍立即拒绝旧请求，不能等到长超时', async () => {
  const broker = new Broker();
  const socket = () => ({ readyState: 1, send(_data: string, cb?: (error?: Error) => void) { cb?.(); }, close() {} });
  const old = socket(), next = socket();
  const info = { id: 'profile', label: 'A', instanceId: 'old', version: 'test', userAgent: 'test' };
  broker.connect(info, old as unknown as WebSocket);
  const pending = broker.command(info.id, 'page.evaluate', { tabId: 1 }, 300000);
  const rejected = assert.rejects(pending, { code: 'CONNECTION_LOST' });
  old.readyState = 2;
  broker.connect({ ...info, instanceId: 'new' }, next as unknown as WebSocket);
  broker.disconnect(old as unknown as WebSocket);
  assert.equal(broker.stats().pendingCommands, 0);
  await rejected;
  assert.equal(broker.capture(info.id).socket, next);
  broker.close();
});

test('过期占用被清理，活跃占用有容量保护且可续期', () => {
  const broker = new Broker(20, 65536, 2);
  broker.claim('A', 1, 'one', 60); broker.claim('A', 2, 'one', 60);
  assert.throws(() => broker.claim('A', 3, 'one', 60), { code: 'LEASE_CAPACITY' });
  assert.doesNotThrow(() => broker.claim('A', 1, 'one', 60));
  broker.pruneExpiredLeases(Date.now() + 61000);
  assert.equal(broker.stats().leases, 0);
  for (let id = 0; id < 10000; id++) broker.claim('A', id, 'one', 0);
  assert.equal(broker.stats().leases, 0);
  broker.close();
});

test('诊断只对管理员开放且不返回目标/凭据，服务拒绝超额并发后能继续工作', async t => {
  const f = await fixture(); t.after(() => f.cleanup()); f.config.maxPendingRequests = 2;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const browser = await fakeProfile(f.config, 'A', async () => { await gate; return { value: 1 }; });
  const args = { profileId: browser.id, expression: 'one' };
  const a = f.service.invoke('chrome_evaluate', { ...args, tabId: 1 }, 'A');
  const b = f.service.invoke('chrome_evaluate', { ...args, tabId: 2 }, 'B');
  assert.equal((await f.service.invoke('chrome_profiles', {}, 'C')).error?.code, 'SERVER_BUSY');
  const base = `http://127.0.0.1:${f.config.port}/diagnostics`;
  assert.equal((await fetch(base)).status, 401);
  const client = f.service.state.createClient('reader', '*', true);
  assert.equal((await fetch(base, { headers: { authorization: `Bearer ${client.token}` } })).status, 404);
  const response = await fetch(base, { headers: { authorization: `Bearer ${f.config.token}` } });
  const report = await response.json() as { resources: { inFlight: number }; memory: { rss: number } };
  assert.equal(report.resources.inFlight, 2); assert.ok(report.memory.rss > 0);
  assert.ok(!JSON.stringify(report).includes(f.config.token)); assert.ok(!JSON.stringify(report).includes(browser.id));
  finish(); assert.ok((await a).ok); assert.ok((await b).ok);
  assert.equal((await f.service.invoke('chrome_profiles', {}, 'C')).ok, true);
  assert.equal(f.service.stats().pendingCommands, 0);
});

test('OpenCode 两个大版本的生成配置使用各自格式和毫秒超时', () => {
  const entry = { command: 'C:\\中文 path\\app.exe', args: ['mcp'], env: { CHROME_MCP_TOKEN_FILE: 'token-path' } };
  const modern = openCodeConfig(entry);
  assert.ok(modern.mcp.servers);
  assert.deepEqual(modern.mcp.servers['saltedfish'].command, [entry.command, 'mcp']);
  assert.equal(modern.mcp.servers['saltedfish'].timeout.execution, 320000);
  assert.equal('enabled' in modern.mcp.servers['saltedfish'], false);
  const legacy = openCodeConfig(entry, 1);
  assert.ok(legacy.mcp['saltedfish']);
  assert.equal(legacy.mcp['saltedfish'].enabled, true);
  assert.equal(legacy.mcp['saltedfish'].timeout, 320000);
});

test('业务完成后的日志写入故障不诱导重试，未落盘的完成状态持续保护目标', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  let executions = 0;
  const profile = await fakeProfile(f.config, 'A', () => ({ executions: ++executions }));
  const target = { profileId: profile.id, tabId: 7, expression: 'submitOnce()' };
  f.service.state.finish = () => { throw new Error('simulated SQLITE_FULL'); };
  const result = await f.service.invoke('chrome_evaluate', target, 'one');
  assert.equal(result.ok, true); assert.deepEqual(result.data, { executions: 1 });
  assert.equal(result.warnings?.[0]?.code, 'OPERATION_JOURNAL_FAILED');
  assert.equal(f.service.state.get(result.operationId!)?.state, 'running');
  assert.equal((await f.service.invoke('chrome_evaluate', target, 'one')).error?.code, 'OPERATION_PENDING');
  assert.equal(executions, 1);
});
