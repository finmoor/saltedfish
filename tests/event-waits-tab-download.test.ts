import test from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import { Broker } from '../src/broker.js';
import { errorInfo } from '../src/shared.js';
import { waitForTabDownload, type TabDownloadWaitSource } from '../src/event-waits.js';

const profile = 'profile-a', tab = 7;
function fixture(eventLimit = 2000) {
  const broker = new Broker(eventLimit), socket = { readyState: 1, close() {} } as unknown as WebSocket;
  broker.connect({ id: profile, instanceId: 'one', label: 'one', version: 'test', userAgent: 'test' }, socket);
  const source: TabDownloadWaitSource = {
    snapshot: (p, t, s) => broker.events(p, t, s), subscribe: listener => broker.subscribeEvents(listener),
    assertActive() {}, async assertAllowed() {},
    async queryDownload(id) { return [{ id, state: 'complete', exists: true }]; },
  };
  return { broker, source, emit: (method: string, params: Record<string, unknown>, t: number | undefined = tab) => broker.addEvent(profile, t, method, params) };
}
const failure = (promise: Promise<unknown>) => promise.then(() => assert.fail('预期失败'), errorInfo);

test('按标签页等下载：首笔下载事件被缓存淘汰时报 EVENT_HISTORY_LOST，不把第二笔当成下一次', async () => {
  const f = fixture(3);
  const since = f.broker.events(profile, tab, 0).latestSequence;
  f.emit('downloads.created', { id: 1 }); f.emit('downloads.created', { id: 2 }); f.emit('downloads.created', { id: 3 }); f.emit('downloads.created', { id: 4 });
  const error = await failure(waitForTabDownload(f.source, profile, tab, { since }, Date.now() + 500));
  assert.equal(error.code, 'EVENT_HISTORY_LOST'); assert.equal(error.outcome, 'not_dispatched');
});

test('按标签页等下载：游标超出当前序列报 EVENT_CURSOR_INVALID；游标有效时仍取第一笔', async () => {
  const f = fixture();
  assert.equal((await failure(waitForTabDownload(f.source, profile, tab, { since: 9999 }, Date.now() + 500))).code, 'EVENT_CURSOR_INVALID');
  const since = f.broker.events(profile, tab, 0).latestSequence;
  f.emit('downloads.created', { id: 11 }); f.emit('downloads.created', { id: 12 });
  const result = await waitForTabDownload(f.source, profile, tab, { since }, Date.now() + 500);
  assert.equal((result as { downloadId?: number }).downloadId, 11);
});

test('按标签页等下载：目标标签页关闭立即中止，不等到超时；debugger 断开不误中止', async () => {
  const f = fixture();
  const since = f.broker.events(profile, tab, 0).latestSequence;
  const started = Date.now();
  const waiting = failure(waitForTabDownload(f.source, profile, tab, { since }, Date.now() + 5000));
  await new Promise(resolve => setTimeout(resolve, 20));
  f.emit('debugger.detached', {});
  await new Promise(resolve => setTimeout(resolve, 20));
  f.emit('tabs.removed', {});
  const error = await waiting;
  assert.equal(error.code, 'TAB_NOT_FOUND'); assert.ok(Date.now() - started < 2000);
});
