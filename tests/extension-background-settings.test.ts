/// <reference path="../extension/page-runtime-source.d.ts" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';

// 真实的扩展后台（extension/background.ts，连同真实执行器）运行在假的 chrome / WebSocket 上：
// 核对 settings.save 自己校验配对密钥，不依赖弹窗先行把关——不合格时整条保存都不执行并明确报错，而不是静默丢弃或写入无效密钥。
register('data:text/javascript;base64,' + Buffer.from(`
export async function resolve(specifier, context, nextResolve) { if (specifier === 'virtual:page-runtime') return { url: 'virtual:page-runtime', shortCircuit: true }; return nextResolve(specifier, context); }
export async function load(url, context, nextLoad) { if (url === 'virtual:page-runtime') return { format: 'module', source: 'export default "";', shortCircuit: true }; return nextLoad(url, context); }
`).toString('base64'));

const noop = () => {}, noopList = { addListener: noop, removeListener: noop };
const list = <T>(target: T[]) => ({ addListener: (listener: T) => { target.push(listener); }, removeListener: noop });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(read: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) { if (read()) return; await sleep(10); }
  throw new Error(`等待超时：${what}`);
}

type Handler = (message: Record<string, unknown>, sender: { id?: string }, respond: (value: any) => void) => unknown;
const handlers: Handler[] = [], runtimeId = 'e'.repeat(32);
const pairing = randomBytes(32).toString('hex');
const store: Record<string, any> = { settings: { profileId: randomUUID(), label: '个人', port: 17422, token: pairing, enabled: true } };
const original = structuredClone(store.settings);

// 一个永远不会真正连上的 WebSocket：只记录创建和关闭，用来观察“保存后是否重连”。
const sockets: FakeSocket[] = [];
class FakeSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 0; closed = false; sent: string[] = [];
  onopen: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null; onerror: (() => void) | null = null; onclose: (() => void) | null = null;
  constructor(readonly url: string) { sockets.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; this.readyState = 3; } // 有意不触发 onclose，避免排出重连定时器
}
(globalThis as any).WebSocket = FakeSocket;
(globalThis as any).chrome = {
  runtime: { id: runtimeId, getURL: (path: string) => `chrome-extension://${runtimeId}/${path.replace(/^\//, '')}`, getManifest: () => ({ version: '0.2.10' }), onMessage: list(handlers), onStartup: noopList, onInstalled: noopList },
  storage: { local: { get: async () => ({ settings: store.settings }), set: async (value: Record<string, unknown>) => { Object.assign(store, structuredClone(value)); } } },
  alarms: { create: async () => {}, onAlarm: noopList },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
  debugger: { onDetach: noopList, onEvent: noopList, attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) },
  tabs: { onRemoved: noopList, onActivated: noopList, onCreated: noopList, onUpdated: noopList, get: async () => { throw new Error('No tab'); }, query: async () => [], update: async () => ({}), remove: async () => {} },
  windows: { get: async () => ({ state: 'normal', focused: true }), update: async () => ({}), getAll: async () => [] },
  downloads: { onChanged: noopList, onCreated: noopList },
};

await import('../extension/background.js');
const send = (message: Record<string, unknown>) => new Promise<any>(resolve => { handlers[0]!(message, { id: runtimeId }, resolve); });
const connectionCode = (serviceUrl: string, label?: string) => 'sf-connect:' + Buffer.from(JSON.stringify({ version: 1, serviceUrl, pairingId: randomUUID(), token: randomBytes(32).toString('hex'), ...(label ? { label } : {}) })).toString('base64url');
// 无论用例成败都暂停扩展，清掉握手/重连定时器，否则测试进程不会退出。
test.after(async () => { await send({ type: 'settings.save', enabled: false }); });

test('settings.save：配对密钥必须是 64 位小写十六进制，否则整条保存被拒绝并明确报错，连接与已保存的设置都不变', async () => {
  assert.equal(handlers.length, 1, '后台注册了设置消息处理器');
  await waitFor(() => sockets.length === 1, '后台用已保存的设置发起第一次连接');
  const live = sockets[0]!;
  const invalid: [string, unknown][] = [
    ['太短（旧版静默丢弃，同一条消息里的其他设置却照常保存）', 'ab12'.repeat(5)],
    ['被截断的 40 位十六进制（旧版只看长度 ≥ 32 就覆盖了有效密钥）', 'ab12'.repeat(10)],
    ['长度够但含非十六进制字符', 'g'.repeat(64)],
    ['64 位但是大写（服务端密钥恒为小写，大小写不同的字符串是另一把 HMAC 密钥）', pairing.toUpperCase()],
    ['前后带空白（弹窗负责 trim，后台不替它猜）', ` ${pairing} `],
    ['多出一位', `${pairing}0`],
    ['空字符串', ''],
    ['null', null],
    ['数字', 12345],
    ['数组', [pairing]],
  ];
  for (const [what, bad] of invalid) {
    const reply = await send({ type: 'settings.save', label: '不应保存的新名称', port: 18123, enabled: false, token: bad });
    assert.match(String(reply.error), /64 位十六进制/, what);
    assert.equal(reply.saved, undefined, `${what}：不能报告已保存`);
    assert.deepEqual(store.settings, original, `${what}：同一条消息里的名称、端口、开关和密钥都不应保存`);
    assert.equal(sockets.length, 1, `${what}：被拒绝的保存不应触发重连`);
    assert.equal(live.closed, false, `${what}：现有连接不应被关闭`);
  }
});

test('settings.save：合法密钥保存并以新密钥重连；省略 token 的保存不改密钥；settings.get 不回传密钥', async () => {
  const fresh = randomBytes(32).toString('hex');
  const before = sockets.length;
  // 明确带上 enabled:true，让本用例不依赖前一个用例留下的状态（旧实现下前一个用例会把开关改成暂停）。
  const reply = await send({ type: 'settings.save', token: fresh, label: '新名称', enabled: true });
  assert.equal(reply.saved, true); assert.equal(store.settings.token, fresh); assert.equal(store.settings.label, '新名称');
  await waitFor(() => sockets.length === before + 1, '保存后按新设置重新连接');
  assert.equal(sockets[before - 1]!.closed, true, '旧连接被关闭');

  const keep = await send({ type: 'settings.save', label: '再次改名', port: 19000 });
  assert.equal(keep.saved, true); assert.equal(store.settings.token, fresh, '没有 token 字段时保留原密钥'); assert.equal(store.settings.label, '再次改名'); assert.equal(store.settings.port, 19000);
  const read = await send({ type: 'settings.get' });
  assert.equal(read.settings.token, undefined, '设置页读取不到配对密钥'); assert.equal(read.settings.label, '再次改名');
});

test('settings.save：配对后单独改地址被拒绝；没配对时只记下地址，不发起连接', async () => {
  const lan = 'http://192.168.1.10:18445';
  assert.equal((await send({ type: 'settings.get' })).serviceKnown, false, '只有端口时不算知道服务地址');
  assert.match((await send({ type: 'settings.save', serviceUrl: lan })).error, /配对码/);
  assert.equal((await send({ type: 'settings.save', connectionCode: connectionCode(lan) })).saved, true);
  const paired = await send({ type: 'settings.get' });
  assert.equal((await send({ type: 'settings.save', resetIdentity: true, expectedProfileId: paired.settings.profileId })).saved, true, '重建身份后回到没配对的状态');
  const before = sockets.length, other = 'http://192.168.1.11:18445';
  assert.equal((await send({ type: 'settings.save', serviceUrl: other })).saved, true);
  const read = await send({ type: 'settings.get' });
  assert.equal(read.settings.serviceUrl, other); assert.equal(read.serviceKnown, true); assert.equal(read.status.state, 'unpaired'); assert.equal(sockets.length, before, '没有配对码时不连接');
});

test('settings.save：配对码带的名称只替换自动生成的名称，用户改过的不动', async () => {
  const lan = 'http://192.168.1.10:18445', { settings } = await send({ type: 'settings.get' });
  assert.equal((await send({ type: 'settings.save', label: `Chrome ${settings.profileId.slice(0, 6)}` })).saved, true);
  assert.equal((await send({ type: 'settings.save', connectionCode: connectionCode(lan, '工作 Chrome') })).saved, true);
  assert.equal(store.settings.label, '工作 Chrome');
  assert.equal((await send({ type: 'settings.save', connectionCode: connectionCode(lan, '另一个名称') })).saved, true);
  assert.equal(store.settings.label, '工作 Chrome', '已经不是自动名称，保持不变');
});

test('service.open：只能直接打开地址时先确认连得上，连不上不给出地址', async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
    assert.deepEqual(await send({ type: 'service.open', target: 'overview' }), { unreachable: true });
    globalThis.fetch = (async () => new Response('')) as typeof fetch;
    const reply = await send({ type: 'service.open', target: 'overview' });
    assert.equal(reply.ok, true); assert.equal(reply.url, 'http://192.168.1.10:18445/#overview');
  } finally { globalThis.fetch = real; }
});
