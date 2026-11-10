/// <reference path="../extension/page-runtime-source.d.ts" />
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { register } from 'node:module';
import { randomUUID } from 'node:crypto';
import { WebSocket as WsClient } from 'ws';
import { fixture } from './helpers.js';
import { bridgeToken, adminPrincipal } from '../src/auth.js';
import { adminOrigins, hiddenTabTitle } from '../src/shared.js';

// 真实的扩展后台（握手、事件门禁、命令路由）+ 真实的执行器 + 真实服务，只模拟 Chrome 的接口和页面本身：
// 验证扩展与服务是同一个协议，非管理员命令经过整条链路时被管理页保护拦下，管理员命令不受影响。
register('data:text/javascript;base64,' + Buffer.from(`
export async function resolve(specifier, context, nextResolve) { if (specifier === 'virtual:page-runtime') return { url: 'virtual:page-runtime', shortCircuit: true }; return nextResolve(specifier, context); }
export async function load(url, context, nextLoad) { if (url === 'virtual:page-runtime') return { format: 'module', source: 'export default "";', shortCircuit: true }; return nextLoad(url, context); }
`).toString('base64'));

const noop = () => {}, noopList = { addListener: noop, removeListener: noop };
const list = <T>(target: T[]) => ({ addListener: (listener: T) => { target.push(listener); }, removeListener: noop });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// 预算 30 秒：全量测试会并发几十个文件，握手在负载下远慢于单独运行；用例要因为断言不成立而失败，不是因为机器忙。
async function waitFor<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 1200; i++) { const value = read(); if (value) return value; await sleep(25); }
  throw new Error(`等待超时：${what}`);
}

test('真实扩展后台与服务：v2 握手完成后才发送事件，非管理员经整条链路碰不到管理页，管理员不受影响', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const origins = adminOrigins(f.config.port), profileId = randomUUID();
  const tabs = new Map([[1, { id: 1, windowId: 1, active: true, title: 'SaltedFish 管理', url: `${origins[0]}/#overview` }], [2, { id: 2, windowId: 1, active: false, title: 'Example', url: 'https://example.com/' }]]);
  const sent: { tabId: number; method: string; params: any }[] = [], store: Record<string, unknown> = {};
  const created: ((tab: unknown) => void)[] = [], detached: ((source: { tabId: number }, reason: string) => void)[] = [];
  let early = 0;

  (globalThis as any).chrome = {
    runtime: { id: 'e'.repeat(32), getURL: (path: string) => `chrome-extension://${'e'.repeat(32)}/${path.replace(/^\//, '')}`, getManifest: () => ({ version: '0.2.10' }), onMessage: noopList, onStartup: noopList, onInstalled: noopList },
    storage: { local: { get: async () => ({ settings: store.settings }), set: async (value: Record<string, unknown>) => { Object.assign(store, value); } } },
    alarms: { create: async () => {}, onAlarm: noopList },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    debugger: {
      onDetach: list(detached), onEvent: noopList, attach: async () => {}, detach: async () => {},
      async sendCommand(target: { tabId: number }, method: string, params: any = {}) {
        sent.push({ tabId: target.tabId, method, params });
        if (method === 'Runtime.evaluate') {
          const origin = new URL(tabs.get(target.tabId)!.url).origin;
          try { return { result: { value: vm.runInNewContext(params.expression, { location: { origin } }) } }; }
          catch (thrown) { return { exceptionDetails: { text: 'Uncaught', exception: { type: 'string', value: thrown } } }; }
        }
        return {};
      },
    },
    tabs: {
      onRemoved: noopList, onActivated: noopList, onCreated: list(created), onUpdated: noopList,
      async get(id: number) { const tab = tabs.get(id); if (!tab) throw new Error('No tab'); return { ...tab }; },
      async query() { return [...tabs.values()].map(tab => ({ ...tab })); }, async update(id: number) { return { ...tabs.get(id) }; }, async remove() {},
    },
    windows: { get: async () => ({ state: 'normal', focused: true }), update: async () => ({}), getAll: async () => [] },
    downloads: { onChanged: noopList, onCreated: noopList },
  };
  // 浏览器的 WebSocket：用 ws 客户端补上扩展页面会带的 Origin；在 hello 刚发出（握手还没完成）时让浏览器产生一个事件。
  class ExtensionSocket extends WsClient {
    constructor(url: string) { super(url, { origin: `chrome-extension://${'e'.repeat(32)}` }); }
    send(data: any, ...rest: any[]) {
      (super.send as any)(data, ...rest);
      try { if (JSON.parse(String(data)).type === 'hello') { early++; created.forEach(listener => listener({ id: 9, windowId: 1, active: false, url: 'https://early.example/', title: 'early' })); } } catch { /* 非 JSON 帧 */ }
    }
  }
  (globalThis as any).WebSocket = ExtensionSocket;
  store.settings = { profileId, label: 'E2E', port: f.config.port, token: bridgeToken(f.config), enabled: true };

  await import('../extension/background.js');
  // 无论用例成败都要让扩展暂停并清掉重连/心跳定时器（模拟用户在 Chrome 里点“取消调试”），否则测试进程不会退出
  t.after(async () => { detached.forEach(listener => listener({ tabId: 2 }, 'canceled_by_user')); for (let i = 0; i < 100 && f.service.broker.profiles.has(profileId); i++) await sleep(25); });
  const connection = await waitFor(() => f.service.broker.profiles.get(profileId), '扩展完成握手并登记');
  assert.equal(early, 1, '握手进行中确实产生过一个浏览器事件');
  assert.ok(connection.info.capabilities?.includes('admin-origin-v1'), '扩展公布 admin-origin-v1');
  assert.equal(connection.info.label, 'E2E');
  assert.ok(!f.service.broker.events(profileId, 9, 0).events.some(event => event.method === 'tabs.created'), '握手完成前的事件不发送（服务在鉴权前只接受握手帧）');
  // 服务端登记连接的那一刻，扩展可能还没处理完 ready，此时发出的事件会被丢弃；每轮重发，断言的是“握手完成后事件能到达”而不是“恰好第一次就赶上”。
  await waitFor(() => { created.forEach(listener => listener({ id: 9, windowId: 1, active: false, url: 'https://late.example/', title: 'late' })); return f.service.broker.events(profileId, 9, 0).events.find(event => event.method === 'tabs.created'); }, '握手完成后事件正常到达');

  const restricted = f.service.state.authenticate(f.service.state.createClient('受限').token)!;
  const call = (principal: typeof restricted, name: string, args: Record<string, unknown>) => f.service.invoke(name, args, `o-${principal.id}`, principal);
  // 标签页列表：管理页仍可见，但地址与标题被隐藏
  const listing = (await call(restricted, 'chrome_tabs', { profileId })).data as { items: Record<string, unknown>[] };
  assert.deepEqual(listing.items.map(tab => tab.tabId), [1, 2]);
  assert.equal(listing.items[0]!.url, ''); assert.equal(listing.items[0]!.title, hiddenTabTitle); assert.equal(listing.items[1]!.url, 'https://example.com/');
  const full = (await call(adminPrincipal, 'chrome_tabs', { profileId })).data as { items: Record<string, unknown>[] };
  assert.equal(full.items[0]!.url, `${origins[0]}/#overview`);
  // 对管理页标签的操作：非管理员被扩展拒绝，调试器没有收到任何 Runtime.evaluate
  const before = sent.length;
  for (const [name, args] of [['chrome_evaluate', { expression: 'sessionStorage.getItem("chrome-mcp-session")' }], ['chrome_screenshot', {}], ['chrome_accessibility', { mode: 'raw' }], ['chrome_cdp', { method: 'DOM.getDocument', params: {} }], ['chrome_close_tab', {}]] as [string, Record<string, unknown>][]) {
    const refused = await call(restricted, name, { profileId, tabId: 1, ...args });
    assert.equal(refused.error?.code, 'ADMIN_PAGE_PROTECTED', name); assert.equal(refused.error?.outcome, 'not_dispatched', name);
  }
  assert.equal(sent.length, before, '调试器没有收到任何命令');
  assert.equal(f.service.state.list(profileId, 'unknown', 0, 10).items.length, 0, '拒绝是明确的未派发，不产生未知结果');
  // 同一个主体操作别的标签页正常，表达式带着页内保护前缀；管理员对管理页不受限
  const fine = await call(restricted, 'chrome_evaluate', { profileId, tabId: 2, expression: '40 + 2' });
  assert.equal(fine.data, 42);
  assert.ok(String(sent.find(command => command.method === 'Runtime.evaluate' && command.tabId === 2)!.params.expression).startsWith('if(location.origin==='));
  assert.equal((await call(adminPrincipal, 'chrome_evaluate', { profileId, tabId: 1, expression: '1 + 1' })).data, 2);
  assert.equal((await call(restricted, 'chrome_navigate', { profileId, tabId: 2, url: `${origins[1]}/` })).error?.code, 'ADMIN_PAGE_PROTECTED');
});
