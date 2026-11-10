/// <reference path="../extension/page-runtime-source.d.ts" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { errorInfo, adminOrigins, type JsonObject } from '../src/shared.js';

// 调试器附加/分离/取消代际的生命周期：假 Chrome 只记录命令，不运行页面。
register('data:text/javascript;base64,' + Buffer.from(`
export async function resolve(specifier, context, nextResolve) { if (specifier === 'virtual:page-runtime') return { url: 'virtual:page-runtime', shortCircuit: true }; return nextResolve(specifier, context); }
export async function load(url, context, nextLoad) { if (url === 'virtual:page-runtime') return { format: 'module', source: 'export default "";', shortCircuit: true }; return nextLoad(url, context); }
`).toString('base64'));

const ADMIN = adminOrigins(41235) as [string, string];
const tabs = new Map<number, any>();
const sent: { tabId: number; method: string }[] = [];
const detachListeners: ((source: { tabId?: number }, reason: string) => void)[] = [];
let attachCalls = 0, detachCalls = 0, failEnable = false, blockGet: Promise<void> | undefined;
const list = <T>(target: T[]) => ({ addListener: (l: T) => { target.push(l); }, removeListener: () => {} });
(globalThis as any).chrome = {
  runtime: { getURL: (p: string) => `chrome-extension://${'e'.repeat(32)}/${p.replace(/^\//, '')}` },
  debugger: {
    onDetach: list(detachListeners), onEvent: list<any>([]),
    attach: async () => { attachCalls++; }, detach: async () => { detachCalls++; },
    async sendCommand(target: { tabId: number }, method: string) {
      sent.push({ tabId: target.tabId, method });
      if (method === 'Runtime.enable' && failEnable) throw new Error('enable failed');
      return method === 'Runtime.evaluate' ? { result: { value: 1 } } : {};
    },
  },
  tabs: {
    onRemoved: list<any>([]), onActivated: list<any>([]), onCreated: list<any>([]), onUpdated: list<any>([]),
    async get(id: number) { const pending = blockGet; if (pending) { blockGet = undefined; await pending; } const tab = tabs.get(id); if (!tab) throw new Error('No tab'); return { ...tab }; },
    async query() { return [...tabs.values()]; }, async update(id: number) { return { ...tabs.get(id) }; }, async remove() {},
  },
  windows: { get: async () => ({ state: 'normal', focused: true }), update: async () => ({}), getAll: async () => [] },
  downloads: { onChanged: list<any>([]), onCreated: list<any>([]) },
};
const executor = await import('../extension/executor.js');
const emitted: string[] = [];
executor.attachEvents(method => { emitted.push(method); });
executor.setAdminOrigins(ADMIN);
const deadline = () => Date.now() + 5000;
let nextTab = 10;
const openTab = () => { const id = nextTab++; tabs.set(id, { id, windowId: 1, url: 'https://example.com/', active: true }); return id; };
const fireDetach = (tabId: number, reason = 'canceled_by_user') => detachListeners.forEach(l => l({ tabId }, reason));

test('U10：程序发起的 detach，事件晚到超过 1 秒也不算用户取消；从未请求过的 canceled_by_user 才暂停', async () => {
  const tabId = openTab();
  await executor.execute('page.evaluate', { tabId, expression: '1' }, deadline());
  await executor.execute('tabs.detach', { tabId }, deadline());
  const realNow = Date.now; Date.now = () => realNow() + 5000;
  try { fireDetach(tabId); } finally { Date.now = realNow; }
  assert.equal(emitted.includes('bridge.userPaused'), false, '程序 detach 的迟到事件被当成了用户取消');
  assert.equal(emitted.includes('debugger.detached'), true);
  // 标记被事件消费，之后同一标签页的 canceled_by_user 是真正的用户取消
  fireDetach(tabId);
  assert.equal(emitted.filter(m => m === 'bridge.userPaused').length, 1);
  // 从未请求过 detach 的标签页
  emitted.length = 0; fireDetach(openTab());
  assert.deepEqual(emitted.filter(m => m === 'bridge.userPaused').length, 1);
});

test('U11：Runtime.enable 失败后不把标签页留在 attached 里，下一次调用重新初始化', async () => {
  const tabId = openTab(); failEnable = true; attachCalls = 0; detachCalls = 0;
  await assert.rejects(executor.execute('page.evaluate', { tabId, expression: '1' }, deadline()));
  assert.equal(detachCalls, 1, '初始化失败应分离调试器');
  failEnable = false;
  assert.equal(await executor.execute('page.evaluate', { tabId, expression: '1' }, deadline()), 1);
  assert.equal(attachCalls, 2, '第二次调用必须重新 attach 和初始化，而不是跳过');
  assert.equal(sent.filter(c => c.tabId === tabId && c.method === 'Runtime.enable').length, 2);
});

test('U12：管理页核对等待期间发生取消，旧命令不能拿新代际继续派发', async () => {
  const tabId = openTab(); let release!: () => void;
  blockGet = new Promise<void>(resolve => { release = resolve; });
  const before = sent.length, attaches = attachCalls;
  const pending = executor.execute('page.action', { tabId, action: 'click', selector: '#b', adminGuard: ADMIN } as JsonObject, deadline());
  await new Promise(r => setTimeout(r, 10));
  executor.cancelOperations(); release();
  await assert.rejects(pending, (e: unknown) => { const info = errorInfo(e); assert.equal(info.code, 'CANCELLED'); assert.equal(info.outcome, 'not_dispatched'); return true; });
  assert.equal(sent.length, before, '取消后不能有任何命令发给调试器'); assert.equal(attachCalls, attaches);
});
