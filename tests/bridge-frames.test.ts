import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { ZodError, z } from 'zod';
import { fixture, fakeProfile } from './helpers.js';
import { BrowserError, clipMessage, errorInfo, isScriptUrl, ERROR_MESSAGE_LIMIT, type JsonObject, type WireCommand } from '../src/shared.js';
import { navigatePage } from '../extension/navigation.js';

// 2026-11-04 安全测试 F1：已鉴权的桥接上一帧不合格（错误消息超过 100000 字），服务把整条连接关了，
// 这个浏览器上所有在途命令都成了结果不明。现在一帧只影响它自己。F2：javascript: 地址在派发前拒绝。F4：校验错误写成“路径: 说明”。

type Reply = (command: WireCommand) => JsonObject | string | undefined;
// 假扩展：按 reply 原样回帧（可以是不合格的帧或任意文本），返回 undefined 时由 fakeProfile 的默认处理接手。
async function rawProfile(f: Awaited<ReturnType<typeof fixture>>, reply: Reply) {
  const profile = await fakeProfile(f.config, '帧测试', command => reply(command) === undefined ? { ok: true } : new Promise(() => {}));
  profile.socket.on('message', raw => {
    const command = JSON.parse(String(raw)) as WireCommand;
    if (command.type !== 'command') return;
    const frame = reply(command);
    // slow 的结果晚一点回，让它和后发的那条命令同时在途。
    if (frame !== undefined) setTimeout(() => profile.socket.send(typeof frame === 'string' ? frame : JSON.stringify(frame)), command.args.kind === 'slow' ? 100 : 0);
  });
  return profile;
}
const failure = (promise: Promise<unknown>) => promise.then(() => assert.fail('应当失败'), error => errorInfo(error));

test('F1：错误消息 20 万字的结果帧照常送达，截到上限并标明原长，连接不断、下一条命令照常执行', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const profile = await rawProfile(f, command => command.args.kind === 'long' ? { type: 'result', id: command.id, error: { code: 'JAVASCRIPT_ERROR', message: 'x'.repeat(200000), phase: 'execution' } } : undefined);
  const error = await failure(f.service.broker.command(profile.id, 'page.evaluate', { kind: 'long' }));
  assert.equal(error.code, 'JAVASCRIPT_ERROR'); assert.equal(error.phase, 'execution');
  assert.ok(error.message.length <= ERROR_MESSAGE_LIMIT, `消息 ${error.message.length} 字`);
  assert.match(error.message, /消息已截断，原长 200000 字/);
  assert.equal(profile.socket.readyState, profile.socket.OPEN);
  assert.deepEqual(f.service.broker.listProfiles().map(item => item.id), [profile.id]);
  assert.deepEqual(await f.service.broker.command(profile.id, 'page.evaluate', {}), { ok: true });
});

test('F1：截断后仍不合格的结果帧只让这一条命令失败（结果不明），同时在途的另一条照常拿到结果', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const profile = await rawProfile(f, command => command.args.kind === 'bad' ? { type: 'result', id: command.id, error: { code: 'C'.repeat(500), message: 'x' } } : command.args.kind === 'slow' ? { type: 'result', id: command.id, result: { slow: true } } : undefined);
  const slow = f.service.broker.command(profile.id, 'page.evaluate', { kind: 'slow' });
  const error = await failure(f.service.broker.command(profile.id, 'page.evaluate', { kind: 'bad' }));
  assert.equal(error.code, 'INVALID_RESULT_FRAME'); assert.equal(error.outcome, 'unknown');
  assert.deepEqual(await slow, { slow: true });
  assert.equal(profile.socket.readyState, profile.socket.OPEN);
  assert.equal(f.service.broker.listProfiles().length, 1);
});

test('F1：解析不了的 JSON、数组、字段不对的事件和结果帧被丢掉，连接还在，心跳和命令照常', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const profile = await fakeProfile(f.config, '帧测试');
  for (const junk of ['{not json', '[1,2,3]', 'null', JSON.stringify({ type: 'event', method: 5 }), JSON.stringify({ type: 'event', method: 'x'.repeat(500) }), JSON.stringify({ type: 'result', id: 'not-a-uuid', result: 1 }), JSON.stringify({ type: 'result' }), JSON.stringify({ type: 'unknown' })]) profile.socket.send(junk);
  const pong = once(profile.socket, 'message');
  profile.socket.send(JSON.stringify({ type: 'ping' }));
  assert.deepEqual(JSON.parse(String((await pong)[0])), { type: 'pong' });
  assert.equal(profile.socket.readyState, profile.socket.OPEN);
  assert.deepEqual(await f.service.broker.command(profile.id, 'tabs.list', {}), { label: '帧测试' });
  assert.equal(f.service.broker.listProfiles().length, 1);
});

test('F1：握手阶段的不合格帧照旧拒绝并断开', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const { WebSocket } = await import('ws');
  const socket = new WebSocket(`ws://127.0.0.1:${f.config.port}/bridge`, { origin: `chrome-extension://${'a'.repeat(32)}` }); socket.on('error', () => {});
  await once(socket, 'open');
  const closed = once(socket, 'close'), reply = once(socket, 'message');
  socket.send('{not json');
  assert.equal(JSON.parse(String((await reply)[0])).type, 'rejected');
  await closed;
});

test('F1：错误消息上限：errorInfo 统一截断，截断处不拆开代理对', () => {
  assert.equal(clipMessage('短消息'), '短消息');
  const long = errorInfo(new Error('y'.repeat(100500))).message;
  assert.ok(long.length <= ERROR_MESSAGE_LIMIT); assert.match(long, /原长 100500 字/);
  // 60 个 UTF-16 单元，标记 16 字；上限 41 时第一刀落在代理对中间，要往前退一格。
  const emoji = '😀'.repeat(30), clipped = clipMessage(emoji, 41);
  assert.equal(clipped.length, 40); assert.match(clipped, /原长 60 字/);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(clipped), '没有孤立的高位代理');
  assert.equal(errorInfo(new BrowserError('X', 'z'.repeat(9000), { outcome: 'unknown' })).outcome, 'unknown', '截断不丢 phase/outcome');
});

test('F2：navigate、new_tab、batch 里的 javascript: 地址在派发前拒绝，标签页不暂停写入', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const sent: string[] = [];
  const profile = await fakeProfile(f.config, 'A', command => { sent.push(command.operation); return { tabId: 1, status: 'complete', url: 'about:blank' }; });
  for (const url of ['javascript:alert(1)', 'JavaScript:void(0)', ' javascript:alert(1)', 'java\tscript:alert(1)']) {
    const navigate = await f.service.invoke('chrome_navigate', { profileId: profile.id, tabId: 1, url }, 'agent');
    assert.equal(navigate.error?.code, 'INVALID_ARGUMENT', url); assert.equal(navigate.error?.outcome, 'not_dispatched');
    assert.match(String(navigate.error?.message), /^url: javascript: 地址.*chrome_evaluate/);
  }
  const created = await f.service.invoke('chrome_new_tab', { profileId: profile.id, url: 'javascript:alert(1)' }, 'agent');
  assert.equal(created.error?.code, 'INVALID_ARGUMENT');
  const batch = await f.service.invoke('chrome_batch', { profileId: profile.id, tabId: 1, steps: [{ operation: 'page.navigate', args: { url: 'javascript:alert(1)' } }] }, 'agent');
  assert.equal(batch.error?.code, 'INVALID_ARGUMENT', JSON.stringify(batch.error));
  assert.deepEqual(sent, [], '一条命令也没发给浏览器');
  assert.equal(f.service.broker.stats().quarantinedTabs, 0);
  assert.equal(isScriptUrl('https://example.com/javascript:alert(1)'), false, '路径里带 javascript: 的普通网址不受影响');
});

test('F2：扩展侧的导航也拒绝 javascript: 地址，什么都不发', async () => {
  const sent: string[] = [];
  const error = await failure(navigatePage({ url: 'javascript:alert(1)', wait: true, deadline: Date.now() + 1000, send: async method => { sent.push(method); return {}; }, tab: async () => ({}), subscribe: () => () => {}, assertActive: () => {} }));
  assert.equal(error.code, 'INVALID_URL'); assert.equal(error.outcome, 'not_dispatched'); assert.deepEqual(sent, []);
});

test('F4：校验错误写成“路径: 说明”，顶层多了字段时不带冒号前缀，不回 zod 的原始结构', async t => {
  const top = z.object({ a: z.string() }).strict().safeParse({ a: 'x', extra: 1 }).error as ZodError;
  assert.equal(errorInfo(top).message, 'Unrecognized key: "extra"');
  const nested = z.object({ a: z.array(z.string()) }).safeParse({ a: [1] }).error as ZodError;
  assert.match(errorInfo(nested).message, /^a\.0: /);
  const f = await fixture(); t.after(() => f.cleanup());
  const post = (body: unknown) => fetch(`http://127.0.0.1:${f.config.port}/clients`, { method: 'POST', headers: { authorization: 'Bearer ' + f.config.token, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async response => ({ status: response.status, body: await response.json() as { error: { message: string } } }));
  const extra = await post({ label: 'x', bogus: 1 });
  assert.equal(extra.status, 400); assert.equal(extra.body.error.message, 'Unrecognized key: "bogus"');
  const wrong = await post({ label: 'x', profiles: [1] });
  assert.equal(wrong.status, 400); assert.match(wrong.body.error.message, /^profiles(\.0)?: /); assert.ok(!wrong.body.error.message.includes('"expected"'));
  const tool = await f.service.invoke('chrome_tabs', { profileId: 'p', bogus: 1 }, 'agent');
  assert.equal(tool.error?.code, 'INVALID_ARGUMENT'); assert.ok(!String(tool.error?.message).startsWith(':'), String(tool.error?.message));
});
