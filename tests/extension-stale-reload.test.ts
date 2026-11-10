/// <reference path="../extension/page-runtime-source.d.ts" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { VERSION } from '../src/version.js';

// 真实的扩展后台跑在假的 chrome 上，manifest 比编译进去的 VERSION 新（Chrome 沿用了旧的后台脚本）：
// 第一次启动重载一次、不连服务；同一对版本第二次启动不再重载，照常连上。握手带的 codeVersion 由真 Chrome 用例核对。
register('data:text/javascript;base64,' + Buffer.from(`
export async function resolve(specifier, context, nextResolve) { if (specifier === 'virtual:page-runtime') return { url: 'virtual:page-runtime', shortCircuit: true }; return nextResolve(specifier, context); }
export async function load(url, context, nextLoad) { if (url === 'virtual:page-runtime') return { format: 'module', source: 'export default "";', shortCircuit: true }; return nextLoad(url, context); }
`).toString('base64'));

const noop = () => {}, noopList = { addListener: noop, removeListener: noop };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const manifest = VERSION.replace(/\d+$/, patch => String(Number(patch) + 1)), runtimeId = 'e'.repeat(32);
const store: Record<string, any> = { settings: { profileId: randomUUID(), label: '个人', port: 17422, token: randomBytes(32).toString('hex'), enabled: true } };
const keysOf = (keys: unknown) => keys == null ? Object.keys(store) : typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys as string[] : Object.keys(keys as object);
let reloads = 0;
type Handler = (message: Record<string, unknown>, sender: { id?: string }, respond: (value: any) => void) => unknown;
const handlers: Handler[] = [];
const sockets: FakeSocket[] = [];
class FakeSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 0; sent: string[] = [];
  onopen: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null; onerror: (() => void) | null = null; onclose: (() => void) | null = null;
  constructor(readonly url: string) { sockets.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; }
}
(globalThis as any).WebSocket = FakeSocket;
(globalThis as any).chrome = {
  runtime: { id: runtimeId, getURL: (path: string) => `chrome-extension://${runtimeId}/${path}`, getManifest: () => ({ version: manifest, version_name: manifest }), reload: () => { reloads++; },
    onMessage: { addListener: (listener: Handler) => { handlers.push(listener); }, removeListener: noop }, onStartup: noopList, onInstalled: noopList },
  storage: { local: { get: async (keys: unknown) => Object.fromEntries(keysOf(keys).filter(key => key in store).map(key => [key, structuredClone(store[key])])), set: async (value: Record<string, unknown>) => { Object.assign(store, structuredClone(value)); }, remove: async () => {} }, session: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
  alarms: { create: async () => {}, onAlarm: noopList },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
  debugger: { onDetach: noopList, onEvent: noopList, attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) },
  tabs: { onRemoved: noopList, onActivated: noopList, onCreated: noopList, onUpdated: noopList, get: async () => { throw new Error('No tab'); }, query: async () => [], update: async () => ({}), remove: async () => {} },
  tabGroups: { onUpdated: noopList, onRemoved: noopList },
  windows: { get: async () => ({ state: 'normal', focused: true }), update: async () => ({}), getAll: async () => [] },
  downloads: { onChanged: noopList, onCreated: noopList },
};
// 每次 import 都是一次 Service Worker 启动；test.after 暂停最后一个实例，清掉握手定时器。
const start = (round: string) => import(`../extension/background.js?start=${round}`);
test.after(async () => { await new Promise(resolve => handlers.at(-1)!({ type: 'settings.save', enabled: false }, { id: runtimeId }, resolve)); });

test('后台代码比 manifest 旧：启动时重载一次不连服务；同一对版本再启动不重载，照常连上', async () => {
  assert.notEqual(manifest, VERSION);
  await start('first'); await sleep(300);
  assert.equal(reloads, 1, '重载了一次');
  assert.equal(store.staleReload, `${manifest}<${VERSION}`, '记下试过的这对版本');
  assert.equal(sockets.length, 0, '要重载了就不连服务');

  await start('second');
  for (let i = 0; i < 100 && !sockets.length; i++) await sleep(10);
  assert.equal(reloads, 1, '同一对版本只试一次，不循环');
  assert.equal(sockets.length, 1, '照常连上服务');
});
