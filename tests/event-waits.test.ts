import test from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import { Broker } from '../src/broker.js';
import { BrowserError, NOT_DISPATCHED, errorInfo, type JsonObject, type BrowserEvent } from '../src/shared.js';
import { waitForResponse, waitForDownload, type EventWaitSource, type DownloadWaitSource } from '../src/event-waits.js';
import { waitResponseArgs, eventWaitToolDefinitions } from '../src/event-wait-tools.js';

const delay = (milliseconds = 0) => new Promise(resolve => setTimeout(resolve, milliseconds));
const args = (extra: JsonObject = {}) => waitResponseArgs.parse({ urlContains: '/api/save', since: 0, ...extra });
const profile = 'profile-a', tab = 7;

function fixture(eventLimit = 2000) {
  const broker = new Broker(eventLimit), socket = { readyState: 1, close() {} } as unknown as WebSocket;
  broker.connect({ id: profile, instanceId: 'one', label: 'one', version: 'test', userAgent: 'test' }, socket);
  const binding = broker.capture(profile);
  let revoked = false, blocked = false, checks = 0;
  const source: EventWaitSource = {
    snapshot: (p, t, s) => broker.events(p, t, s),
    subscribe: listener => broker.subscribeEvents(listener),
    assertActive() {
      if (revoked) throw new BrowserError('CLIENT_AUTHORIZATION_FAILED', 'revoked', NOT_DISPATCHED);
      if (broker.profiles.get(profile) !== binding || socket.readyState !== 1) throw new BrowserError('CONNECTION_CHANGED', 'changed', NOT_DISPATCHED);
    },
    async assertAllowed() { checks++; if (blocked) throw new BrowserError('ADMIN_PAGE_PROTECTED', 'protected', NOT_DISPATCHED); },
  };
  const emit = (method: string, params: JsonObject, p = profile, t: number | undefined = tab) => broker.addEvent(p, t, method, params);
  const request = (requestId = 'r1', extra: JsonObject = {}) => emit('Network.requestWillBeSent', { requestId, request: { url: 'https://example.test/api/save', method: 'POST' }, ...extra });
  const response = (requestId = 'r1', extra: JsonObject = {}) => emit('Network.responseReceived', { requestId, response: { url: 'https://example.test/api/save', status: 200, mimeType: 'application/json' }, ...extra });
  const finish = (requestId = 'r1', extra: JsonObject = {}) => emit('Network.loadingFinished', { requestId, encodedDataLength: 42, ...extra });
  return { broker, source, emit, request, response, finish, socket, since: broker.events(profile, tab, 0).latestSequence,
    revoke: () => { revoked = true; }, protect: () => { blocked = true; }, checks: () => checks };
}

async function failure(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => assert.fail('预期失败'), errorInfo);
  assert.equal(error.code, code); assert.equal(error.outcome, 'not_dispatched');
}

test('等待 schema 明确游标与匹配条件，拒绝无目标、多个目标和非法范围；两个工具均为只读', () => {
  for (const value of [{ since: 0 }, { since: 0, url: 'https://example.test', urlContains: 'example' }, { urlContains: 'save' }, { since: -1, urlContains: 'save' }, { since: 0, urlContains: 'save', status: 600 }]) assert.equal(waitResponseArgs.safeParse(value).success, false);
  assert.equal(waitResponseArgs.parse({ since: 0, requestId: 'r1' }).waitFor, 'finished');
  assert.ok(eventWaitToolDefinitions.every(tool => tool.readOnly));
});

test('动作之后调用等待仍能读到游标后的完整请求；默认等正文结束，输出不含请求头正文或敏感查询值', async () => {
  const f = fixture();
  f.request('r1', { request: { url: 'https://example.test/api/save?token=SECRET', method: 'POST', headers: { authorization: 'SECRET' }, postData: 'PRIVATE' } });
  f.response('r1', { response: { url: 'https://example.test/api/save?token=SECRET', status: 200, mimeType: 'application/json', headers: { 'set-cookie': 'SECRET' } } });
  let settled = false;
  const waiting = waitForResponse(f.source, profile, tab, args({ since: f.since }), Date.now() + 1000).then(result => { settled = true; return result; });
  await delay(10); assert.equal(settled, false);
  f.finish();
  const result = await waiting;
  assert.equal(result.requestId, 'r1'); assert.equal(result.finished, true); assert.equal(result.encodedDataLength, 42);
  assert.ok(!JSON.stringify(result).includes('SECRET')); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.equal(f.broker.stats().eventWaiters, 0); assert.ok(f.checks() >= 2);
});

test('游标前已开始的旧请求即使晚返回也不匹配；新请求到达才成功', async () => {
  const f = fixture(); f.request('old');
  const since = f.broker.events(profile, tab, 0).latestSequence;
  const waiting = waitForResponse(f.source, profile, tab, args({ since }), Date.now() + 1000);
  f.response('old'); f.finish('old'); f.request('new'); f.response('new'); f.finish('new');
  assert.equal((await waiting).requestId, 'new');
});

test('HTTP method 与 iframe sessionId 同时限定，不将不同会话的相同 requestId 拼在一起', async () => {
  const f = fixture();
  const waiting = waitForResponse(f.source, profile, tab, args({ since: f.since, method: 'post', sessionId: 'child', waitFor: 'response' }), Date.now() + 1000);
  f.request('same'); f.response('same');
  f.request('same', { sessionId: 'child', request: { url: 'https://example.test/api/save', method: 'GET' } }); f.response('same', { sessionId: 'child' });
  f.request('correct', { sessionId: 'child' }); f.response('correct', { sessionId: 'child' });
  const result = await waiting; assert.equal(result.requestId, 'correct'); assert.equal(result.sessionId, 'child'); assert.equal(result.finished, false);
});

test('匹配响应状态错误立即失败；HTTP 失败不自动发新请求', async () => {
  const f = fixture(); f.request(); f.response('r1', { response: { url: 'https://example.test/api/save', status: 500 } });
  await failure(waitForResponse(f.source, profile, tab, args({ since: f.since, status: 200 }), Date.now() + 1000), 'RESPONSE_STATUS_MISMATCH');
  assert.equal(f.broker.stats().eventWaiters, 0);
});

test('匹配请求在收到响应前或后网络失败都有明确失败，不等到超时', async () => {
  for (const headers of [false, true]) {
    const f = fixture(); f.request(); if (headers) f.response(); f.emit('Network.loadingFailed', { requestId: 'r1', errorText: 'net::ERR_FAILED' });
    await failure(waitForResponse(f.source, profile, tab, args({ since: f.since }), Date.now() + 1000), 'NETWORK_REQUEST_FAILED');
  }
});

test('游标丢失、未来游标、被截断事件和匹配量超限都拒绝猜测', async () => {
  const f = fixture(2); f.request(); f.response(); f.finish();
  await failure(waitForResponse(f.source, profile, tab, args(), Date.now() + 1000), 'EVENT_HISTORY_LOST');
  const clean = fixture();
  await failure(waitForResponse(clean.source, profile, tab, args({ since: 100 }), Date.now() + 1000), 'EVENT_CURSOR_INVALID');
  clean.emit('Network.requestWillBeSent', { omitted: true, requestId: 'large' });
  await failure(waitForResponse(clean.source, profile, tab, args({ since: clean.since }), Date.now() + 1000), 'EVENT_CONTENT_UNAVAILABLE');
  const many = fixture(3000); for (let n = 0; n < 1025; n++) many.request(String(n));
  await failure(waitForResponse(many.source, profile, tab, args({ since: many.since }), Date.now() + 1000), 'WAIT_CAPACITY');
});

test('读取游标之后的管理页标记不算匹配，返回前实时权限检查仍可拒绝', async () => {
  const f = fixture();
  f.emit('Network.requestWillBeSent', { adminPage: true, requestId: 'private', request: { url: 'https://example.test/api/save', method: 'POST' } });
  f.emit('Network.responseReceived', { adminPage: true, requestId: 'private', response: { url: 'https://example.test/api/save', status: 200 } });
  await failure(waitForResponse(f.source, profile, tab, args({ since: f.since, waitFor: 'response' }), Date.now() + 25), 'RESPONSE_WAIT_TIMEOUT');
  const blocked = fixture(); blocked.request(); blocked.response(); blocked.finish();
  const initialCheck = blocked.source.assertAllowed!;
  blocked.source.assertAllowed = async () => { await initialCheck(); if (blocked.checks() === 1) blocked.protect(); };
  await failure(waitForResponse(blocked.source, profile, tab, args({ since: blocked.since }), Date.now() + 1000), 'ADMIN_PAGE_PROTECTED');
});

test('等待期间断线、关闭标签、停止调试立即结束，空闲时撤销授权也会结束并移除监听', async () => {
  for (const method of ['bridge.disconnected', 'tabs.removed', 'debugger.detached', 'network.captureStopped']) {
    const f = fixture(), waiting = waitForResponse(f.source, profile, tab, args({ since: f.since }), Date.now() + 1000);
    f.emit(method, {}, profile, method === 'bridge.disconnected' ? undefined : tab);
    await failure(waiting, method === 'bridge.disconnected' ? 'CONNECTION_CHANGED' : method === 'tabs.removed' ? 'TAB_NOT_FOUND' : 'NETWORK_CAPTURE_STOPPED');
    assert.equal(f.broker.stats().eventWaiters, 0);
  }
  const f = fixture(), waiting = waitForResponse(f.source, profile, tab, args({ since: f.since }), Date.now() + 1000);
  f.revoke(); await failure(waiting, 'CLIENT_AUTHORIZATION_FAILED'); assert.equal(f.broker.stats().eventWaiters, 0);
});

test('停止捕获已进入历史时也立即结束，不在没有新事件的情况下空等', async () => {
  const f = fixture(); f.request(); f.emit('network.captureStopped', {});
  await failure(waitForResponse(f.source, profile, tab, args({ since: f.since }), Date.now() + 1000), 'NETWORK_CAPTURE_STOPPED');
});

test('其他账号与标签事件不影响本等待，超时清理监听', async () => {
  const f = fixture(), waiting = waitForResponse(f.source, profile, tab, args({ since: f.since }), Date.now() + 25);
  f.emit('tabs.removed', {}, 'other', tab); f.emit('tabs.removed', {}, profile, tab + 1);
  await failure(waiting, 'RESPONSE_WAIT_TIMEOUT'); assert.equal(f.broker.stats().eventWaiters, 0);
});

function downloads(query: DownloadWaitSource['queryDownload']) {
  const f = fixture(); return { ...f, source: { ...f.source, queryDownload: query } as DownloadWaitSource };
}

test('下载已完成立即返回实际文件与字节；不暴露 URL、referrer 等无关信息', async () => {
  let queries = 0;
  const f = downloads(async () => { queries++; return [{ id: 9, state: 'complete', filename: 'C:\\Downloads\\report.csv', exists: true, totalBytes: 42, url: 'https://example.test/?token=SECRET' }]; });
  const result = await waitForDownload(f.source, profile, { downloadId: 9 }, Date.now() + 1000);
  assert.equal(result.state, 'complete'); assert.equal(result.downloadId, 9); assert.equal(result.totalBytes, 42);
  assert.ok(!JSON.stringify(result).includes('SECRET')); assert.equal(queries, 1); assert.equal(f.broker.stats().eventWaiters, 0);
});

test('下载先订阅后查状态，初始查询期间完成不会漏掉；只等待明确的 downloadId', async () => {
  let queries = 0, complete = false, release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = downloads(async () => { queries++; if (queries === 1) { await gate; return [{ id: 9, state: 'in_progress' }]; } return [{ id: 9, state: complete ? 'complete' : 'in_progress', exists: true }]; });
  const waiting = waitForDownload(f.source, profile, { downloadId: 9 }, Date.now() + 1000);
  await delay(); complete = true; f.emit('downloads.changed', { id: 9, state: { current: 'complete' } }, profile, undefined); release!();
  assert.equal((await waiting).state, 'complete'); assert.equal(queries, 2); assert.equal(f.broker.stats().eventWaiters, 0);
});

test('不轮询下载 API，不相关下载事件不触发查询；相关事件触发实际状态复查', async () => {
  let queries = 0, complete = false;
  const f = downloads(async () => { queries++; return [{ id: 9, state: complete ? 'complete' : 'in_progress' }]; });
  const waiting = waitForDownload(f.source, profile, { downloadId: 9 }, Date.now() + 1000);
  await delay(120); assert.equal(queries, 1);
  f.emit('downloads.changed', { id: 8 }, profile, undefined); f.emit('downloads.changed', { id: 9 }, 'other', undefined);
  await delay(); assert.equal(queries, 1);
  complete = true; f.emit('downloads.changed', { id: 9 }, profile, undefined);
  assert.equal((await waiting).state, 'complete'); assert.equal(queries, 2);
});

test('下载不存在、中断、文件消失各自失败；查询中的连接变化不能交付旧结果', async () => {
  for (const [items, code] of [[[], 'DOWNLOAD_NOT_FOUND'], [[{ id: 9, state: 'interrupted', error: 'NETWORK_FAILED' }], 'DOWNLOAD_INTERRUPTED'], [[{ id: 9, state: 'complete', exists: false }], 'DOWNLOAD_FILE_MISSING']] as const) {
    const f = downloads(async () => items);
    await failure(waitForDownload(f.source, profile, { downloadId: 9 }, Date.now() + 1000), code);
    assert.equal(f.broker.stats().eventWaiters, 0);
  }
  const f = downloads(async () => { f.broker.disconnect(f.socket); return [{ id: 9, state: 'complete' }]; });
  await failure(waitForDownload(f.source, profile, { downloadId: 9 }, Date.now() + 1000), 'CONNECTION_CHANGED');
});

test('Broker 订阅先保存再通知，抛错监听不破坏其他订阅，close 清理所有监听', () => {
  const f = fixture(); let seen: BrowserEvent | undefined;
  f.broker.subscribeEvents(() => { throw Error('bad listener'); });
  const unsubscribe = f.broker.subscribeEvents(event => { seen = f.broker.events(profile, tab, event.sequence - 1).events[0]; });
  f.request(); assert.equal(seen?.method, 'Network.requestWillBeSent'); unsubscribe();
  assert.equal(f.broker.stats().eventWaiters, 1); f.broker.close(); assert.equal(f.broker.stats().eventWaiters, 0);
});
