import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { StateStore } from '../src/state-store.js';
import { WindowLocks } from '../extension/window-lock.js';
import { startServer } from '../src/http-server.js';
import { fixture, fakeProfile, testDirectory } from './helpers.js';

test('业务返回 completed=false 是正常数据，不被误判为 MCP 批量失败', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const browser = await fakeProfile(f.config, 'A', () => ({ completed: false, business: 'draft' }));
  const result = await f.service.invoke('chrome_evaluate', { profileId: browser.id, tabId: 1, expression: 'readDraft()' }, 'one');
  assert.equal(result.ok, true); assert.deepEqual(result.data, { completed: false, business: 'draft' });
});

test('运行中操作在再次启动时变为 unknown，确认前不可写；确认不重放', async t => {
  const temp = await testDirectory();
  const original = new StateStore(temp.directory);
  const id = original.begin('account-A', 7, 'client-A', 'chrome_action');
  original.close();
  const recovered = new StateStore(temp.directory); t.after(async () => { recovered.close(); await temp.cleanup(); });
  assert.equal(recovered.get(id)?.state, 'unknown');
  assert.throws(() => recovered.assertWritable('account-A', 7), { code: 'RESULT_UNKNOWN' });
  assert.doesNotThrow(() => recovered.assertWritable('account-B', 7));
  recovered.acknowledge(id);
  assert.doesNotThrow(() => recovered.assertWritable('account-A', 7));
  assert.equal(recovered.get(id)?.state, 'unknown');
});

test('传输超时保护跨服务重启保留，并允许截图检查结果', async t => {
  const f = await fixture();
  let current = f;
  t.after(async () => { await current.close(); await f.cleanup().catch(() => {}); });
  const browser = await fakeProfile(f.config, 'A', async () => { await new Promise(resolve => setTimeout(resolve, 1300)); return {}; });
  const target = { profileId: browser.id, tabId: 7 };
  const result = await f.service.invoke('chrome_evaluate', { ...target, expression: 'submit()', timeoutMs: 100 }, 'one');
  assert.equal(result.error?.code, 'COMMAND_TIMEOUT');
  await f.close();
  const restarted = await startServer(f.config); current = { ...f, ...restarted };
  await fakeProfile(f.config, 'A', command => command.operation === 'page.screenshot' ? { mimeType: 'image/png', data: 'AA==' } : {}, browser.id);
  assert.equal((await restarted.service.invoke('chrome_evaluate', { ...target, expression: 'submit()' }, 'one')).error?.code, 'RESULT_UNKNOWN');
  assert.equal((await restarted.service.invoke('chrome_screenshot', target, 'one')).ok, true);
  assert.equal((await restarted.service.invoke('chrome_recover_operation', { operationId: result.operationId, acknowledged: true }, 'one')).ok, true);
  assert.equal((await restarted.service.invoke('chrome_evaluate', { ...target, expression: '1' }, 'one')).ok, true);
});

test('连接切换后不将后续动作发送到新会话', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const first = await fakeProfile(f.config, 'A');
  const pinned = f.service.broker.capture(first.id);
  const closed = once(first.socket, 'close'); first.socket.close(); await closed;
  let executed = false;
  await fakeProfile(f.config, 'A', () => { executed = true; return {}; }, first.id);
  await assert.rejects(f.service.broker.command(first.id, 'page.evaluate', { tabId: 1 }, 1000, pinned), { code: 'CONNECTION_CHANGED' });
  assert.equal(executed, false);
});

test('进行中的操作不能被另一个客户端中途占用', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  let release!: () => void;
  const running = f.service.broker.exclusive('profile', 1, 'owner-A', () => new Promise<void>(resolve => { release = resolve; }));
  assert.throws(() => f.service.broker.claim('profile', 1, 'owner-B', 60), { code: 'TAB_BUSY' });
  release(); await running;
});

test('同窗口视觉任务顺序执行，不同窗口并行，排队超时不会迟到执行', async () => {
  const locks = new WindowLocks(); const order: string[] = [];
  let release!: () => void;
  const first = locks.run(1, Date.now() + 2000, async () => { order.push('first'); await new Promise<void>(resolve => { release = resolve; }); });
  await new Promise(resolve => setTimeout(resolve, 0));
  const blocked = locks.run(1, Date.now() + 30, async () => { order.push('expired'); });
  const next = locks.run(1, Date.now() + 2000, async () => { order.push('next'); });
  await locks.run(2, Date.now() + 2000, async () => { order.push('parallel'); });
  await assert.rejects(blocked, { code: 'WINDOW_BUSY' });
  release(); await first; await next;
  assert.deepEqual(order, ['first', 'parallel', 'next']);
});
