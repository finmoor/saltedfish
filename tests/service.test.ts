import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { request } from 'node:http';
import { fixture, fakeProfile } from './helpers.js';
import { callService } from '../src/mcp.js';

test('两个配置出现同一 tabId 时，操作仍严格路由到指定账号', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const first = await fakeProfile(f.config, '账号 A');
  const second = await fakeProfile(f.config, '账号 B');
  const a = await callService(f.config, 'chrome_evaluate', { profileId: first.id, tabId: 7, expression: '1' }, 'one');
  const b = await callService(f.config, 'chrome_evaluate', { profileId: second.id, tabId: 7, expression: '1' }, 'one');
  assert.deepEqual(a.data, { label: '账号 A' }); assert.deepEqual(b.data, { label: '账号 B' });
  const closed = once(first.socket, 'close'); first.socket.close(); await closed;
  const offline = await callService(f.config, 'chrome_evaluate', { profileId: first.id, tabId: 7, expression: '1' }, 'one');
  assert.equal(offline.error?.code, 'PROFILE_OFFLINE');
});

test('重复配置身份不替换当前连接', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const first = await fakeProfile(f.config, '原账号');
  const duplicate = await fakeProfile(f.config, '复制账号', undefined, first.id);
  assert.equal(duplicate.handshake.type, 'rejected');
  assert.equal(f.service.broker.listProfiles()[0]?.label, '原账号');
});

test('占用阻止其他客户端写入，释放后可操作', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const profile = await fakeProfile(f.config, 'A', command => command.operation === 'tabs.list' ? [{ tabId: 7 }] : { done: true });
  const target = { profileId: profile.id, tabId: 7 };
  assert.equal((await f.service.invoke('chrome_claim_tab', target, 'one')).ok, true);
  const input = { ...target, expression: '1' };
  assert.equal((await f.service.invoke('chrome_evaluate', input, 'two')).error?.code, 'TAB_CLAIMED');
  assert.equal((await f.service.invoke('chrome_release_tab', target, 'two')).error?.code, 'TAB_CLAIMED');
  assert.equal((await f.service.invoke('chrome_release_tab', target, 'one')).ok, true);
  assert.equal((await f.service.invoke('chrome_evaluate', input, 'two')).ok, true);
  assert.equal((await f.service.invoke('chrome_claim_tab', { ...target, tabId: 999 }, 'one')).error?.code, 'TAB_NOT_FOUND');
});

test('同一标签页并发写入拒绝，其他配置可并行', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  let release!: () => void;
  let started!: () => void; const began = new Promise<void>(resolve => { started = resolve; });
  const profile = await fakeProfile(f.config, 'A', async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return true; });
  const other = await fakeProfile(f.config, 'B', () => true);
  const args = { profileId: profile.id, tabId: 7, expression: '1' };
  const first = f.service.invoke('chrome_evaluate', args, 'one'); await began;
  assert.equal((await f.service.invoke('chrome_evaluate', args, 'one')).error?.code, 'TAB_BUSY');
  assert.equal((await f.service.invoke('chrome_evaluate', { ...args, profileId: other.id }, 'two')).ok, true);
  release(); assert.equal((await first).ok, true);
});

test('超时写入只执行一次，必须显式恢复', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  let count = 0;
  const profile = await fakeProfile(f.config, 'A', async command => {
    if (command.operation === 'tab.recover') return { idle: true };
    count++; await new Promise(resolve => setTimeout(resolve, 1400)); return true;
  });
  const args = { profileId: profile.id, tabId: 7, expression: 'submit()', timeoutMs: 100 };
  assert.equal((await f.service.invoke('chrome_evaluate', args, 'one')).error?.code, 'COMMAND_TIMEOUT');
  assert.equal((await f.service.invoke('chrome_evaluate', args, 'one')).error?.code, 'RESULT_UNKNOWN');
  assert.equal(count, 1);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal((await f.service.invoke('chrome_recover_tab', { profileId: profile.id, tabId: 7 }, 'one')).ok, true);
});

test('大结果完整保存，可分页；批量失败不会被大结果封装为成功', async t => {
  const f = await fixture(); t.after(() => f.cleanup()); f.config.outputLimit = 100;
  const source = { text: '界'.repeat(500) };
  const profile = await fakeProfile(f.config, 'A', command => command.operation === 'page.batch' ? { completed: false, results: source } : source);
  const result = await f.service.invoke('chrome_evaluate', { profileId: profile.id, tabId: 7, expression: '1' }, 'one');
  const data = result.data as { saved: boolean; artifactId: string }; assert.equal(data.saved, true);
  const read = await f.service.invoke('chrome_read_result', { artifactId: data.artifactId, offset: 0, limit: 1000 }, 'one');
  assert.equal((read.data as { text: string }).text, JSON.stringify(source));
  const failed = await f.service.invoke('chrome_batch', { profileId: profile.id, tabId: 7, steps: [{ operation: 'page.evaluate', args: { expression: '1' } }] }, 'one');
  assert.equal(failed.ok, false); assert.equal(failed.error?.code, 'BATCH_FAILED');
  assert.equal((await f.service.invoke('chrome_read_result', { artifactId: '../config' }, 'one')).ok, false);
});

test('无授权、外部 Origin、伪造 Host 和网页 WebSocket 被拒绝', async t => {
  const f = await fixture(); t.after(() => f.cleanup()); const base = `http://127.0.0.1:${f.config.port}`;
  assert.equal((await fetch(`${base}/rpc`, { method: 'POST' })).status, 401);
  const headers = { authorization: `Bearer ${f.config.token}` };
  assert.equal((await fetch(`${base}/rpc`, { method: 'POST', headers: { ...headers, origin: 'https://untrusted.example' } })).status, 403);
  const forgedHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(`${base}/health`, { headers: { host: `evil.example:${f.config.port}` } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(forgedHost, 403);
  const socket = new WebSocket(`ws://127.0.0.1:${f.config.port}/bridge`, { origin: 'https://untrusted.example' });
  socket.on('error', () => {});
  const [response] = await once(socket, 'unexpected-response');
  assert.ok(response); socket.terminate();
});

test('错误配对密钥不能注册 Chrome 配置', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const profile = await fakeProfile({ ...f.config, token: 'wrong'.repeat(10) }, 'A');
  assert.equal(profile.handshake.type, 'rejected'); assert.equal(f.service.broker.listProfiles().length, 0);
});

test('事件缓存隔离账号并报告丢失范围，严格校验批量参数', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  for (let i = 0; i < 120; i++) f.service.broker.addEvent(i % 2 ? 'a' : 'b', 7, 'Network.test', { i });
  const result = await f.service.invoke('chrome_events', { profileId: 'a', limit: 5 }, 'one');
  const data = result.data as { items: { profileId: string }[]; droppedBefore: number; nextOffset: number };
  assert.equal(data.items.length, 5); assert.ok(data.items.every(event => event.profileId === 'a')); assert.ok(data.droppedBefore > 1); assert.equal(data.nextOffset, 5);
  const invalid = await f.service.invoke('chrome_batch', { profileId: 'a', tabId: 7, steps: [{ operation: 'page.action', args: { action: 'click' } }] }, 'one');
  assert.equal(invalid.ok, false);
});

test('视觉动作自动启用页面焦点模拟，失败也清理，业务操作只执行一次', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const operations: unknown[] = [];
  const profile = await fakeProfile(f.config, 'A', command => {
    operations.push({ operation: command.operation, params: command.args.params });
    return command.operation === 'page.batch' ? { completed: false, failedIndex: 0, results: [] } : {};
  });
  const result = await f.service.invoke('chrome_batch', { profileId: profile.id, tabId: 7, steps: [{ operation: 'page.action', args: { action: 'click', selector: '#button' } }] }, 'one');
  assert.equal(result.ok, false);
  assert.deepEqual(operations, [
    { operation: 'page.cdp', params: { enabled: true } },
    { operation: 'page.batch', params: undefined },
    { operation: 'page.cdp', params: { enabled: false } },
  ]);
});
