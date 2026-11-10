import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, fakeProfile } from './helpers.js';
import { BrowserError, NOT_DISPATCHED, type JsonObject } from '../src/shared.js';

test('service：网络捕获返回可用游标，只读客户端可等待本账号，越权账号被拒绝', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const a = await fakeProfile(f.config, 'A', command => command.operation === 'network.start' ? { capturing: true } : []);
  const b = await fakeProfile(f.config, 'B', () => []);
  const client = f.service.state.createClient('只读 A', [a.id], true), principal = f.service.state.authenticate(client.token)!;
  const start = await f.service.invoke('chrome_network_start', { profileId: a.id, tabId: 7 }, 'admin');
  assert.equal(start.ok, true); const since = (start.data as JsonObject).since; assert.equal(typeof since, 'number');
  const waitArgs = { profileId: a.id, tabId: 7, since, urlContains: '/api/save', timeoutMs: 1000 };
  assert.equal((await f.service.invoke('chrome_wait_response', { ...waitArgs, profileId: b.id }, 'reader', principal)).error?.code, 'PROFILE_NOT_AUTHORIZED');
  const waiting = f.service.invoke('chrome_wait_response', waitArgs, 'reader', principal);
  for (const [method, params] of [
    ['Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://example.test/api/save', method: 'POST' } }],
    ['Network.responseReceived', { requestId: 'r1', response: { url: 'https://example.test/api/save', status: 200 } }],
    ['Network.loadingFinished', { requestId: 'r1', encodedDataLength: 42 }],
  ] as const) f.service.broker.addEvent(a.id, 7, method, params);
  const result = await waiting;
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal((result.data as JsonObject).requestId, 'r1'); assert.equal(result.operationId, undefined);
  assert.equal(f.service.stats().eventWaiters, 0); assert.equal(f.service.stats().quarantinedTabs, 0);
});

test('service：下载等待仅查询明确下载，复查授权；超时不创建写入记录或隔离', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const commands: { operation: string; args: JsonObject }[] = [];
  const a = await fakeProfile(f.config, 'A', command => { commands.push(command); return command.operation === 'downloads.list' ? [{ id: 9, state: 'complete', exists: true, filename: 'fixture.txt' }] : []; });
  const key = f.service.state.createClient('只读 A', [a.id], true), principal = f.service.state.authenticate(key.token)!;
  const done = await f.service.invoke('chrome_wait_download', { profileId: a.id, downloadId: 9 }, 'reader', principal);
  assert.equal(done.ok, true, JSON.stringify(done)); assert.equal((done.data as JsonObject).downloadId, 9);
  assert.deepEqual(commands.filter(command => command.operation === 'downloads.list').map(command => command.args.downloadId), [9]);
  const timeout = await f.service.invoke('chrome_wait_response', { profileId: a.id, tabId: 7, urlContains: '/absent', since: f.service.broker.events(a.id, 7, 0).latestSequence, timeoutMs: 100 }, 'reader', principal);
  assert.equal(timeout.error?.code, 'RESPONSE_WAIT_TIMEOUT'); assert.equal(timeout.error?.outcome, 'not_dispatched'); assert.equal(timeout.operationId, undefined);
  assert.equal(f.service.stats().eventWaiters, 0); assert.equal(f.service.stats().quarantinedTabs, 0);
});

test('service：受保护标签拒绝网络等待；原连接丢失不在重连配置继续', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  let protectedPage = true;
  const a = await fakeProfile(f.config, 'A', command => {
    if (command.args.adminGuard && protectedPage) throw new BrowserError('ADMIN_PAGE_PROTECTED', 'protected', NOT_DISPATCHED);
    return [];
  });
  const key = f.service.state.createClient('只读 A', [a.id], true), principal = f.service.state.authenticate(key.token)!;
  const args = { profileId: a.id, tabId: 7, urlContains: '/save', since: f.service.broker.events(a.id, 7, 0).latestSequence, timeoutMs: 1000 };
  const protectedResult = await f.service.invoke('chrome_wait_response', args, 'reader', principal);
  assert.equal(protectedResult.error?.code, 'ADMIN_PAGE_PROTECTED');
  protectedPage = false;
  const waiting = f.service.invoke('chrome_wait_response', args, 'reader', principal);
  await new Promise(resolve => setTimeout(resolve, 10)); f.service.broker.disconnect(f.service.broker.capture(a.id).socket);
  const result = await waiting;
  assert.ok(['CONNECTION_CHANGED', 'PROFILE_OFFLINE'].includes(result.error?.code ?? ''), JSON.stringify(result));
  assert.equal(result.error?.outcome, 'not_dispatched'); assert.equal(f.service.stats().eventWaiters, 0);
});

test('service：停止捕获唤醒响应等待，空闲等待期间撤销授权立即拒绝', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const a = await fakeProfile(f.config, 'A', () => []);
  const key = f.service.state.createClient('只读 A', [a.id], true), principal = f.service.state.authenticate(key.token)!;
  const args = { profileId: a.id, tabId: 7, urlContains: '/save', since: f.service.broker.events(a.id, 7, 0).latestSequence, timeoutMs: 1000 };
  const waiting = f.service.invoke('chrome_wait_response', args, 'reader', principal);
  await new Promise(resolve => setTimeout(resolve, 10));
  const stopped = await f.service.invoke('chrome_network_stop', { profileId: a.id, tabId: 7 }, 'admin');
  assert.equal(stopped.ok, true);
  assert.equal((await waiting).error?.code, 'NETWORK_CAPTURE_STOPPED');
  const next = f.service.invoke('chrome_wait_response', { ...args, since: f.service.broker.events(a.id, 7, 0).latestSequence }, 'reader', principal);
  await new Promise(resolve => setTimeout(resolve, 10)); f.service.state.revokeClient(key.id);
  const revoked = await next;
  assert.equal(revoked.error?.code, 'CLIENT_AUTHORIZATION_FAILED'); assert.equal(revoked.error?.outcome, 'not_dispatched');
  assert.equal(f.service.stats().eventWaiters, 0);
});
