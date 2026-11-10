/// <reference path="../extension/page-runtime-source.d.ts" />
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { register } from 'node:module';
import { ADMIN_GUARD_MARKER, adminGuardPrefix, adminOrigins, errorInfo, type JsonObject } from '../src/shared.js';

// 扩展里的 virtual:page-runtime 由打包器提供；测试用占位源码代替，这里只验证管理页保护逻辑，不运行页面运行时。
register('data:text/javascript;base64,' + Buffer.from(`
export async function resolve(specifier, context, nextResolve) { if (specifier === 'virtual:page-runtime') return { url: 'virtual:page-runtime', shortCircuit: true }; return nextResolve(specifier, context); }
export async function load(url, context, nextLoad) { if (url === 'virtual:page-runtime') return { format: 'module', source: 'export default "";', shortCircuit: true }; return nextLoad(url, context); }
`).toString('base64'));

// ---- 模拟 Chrome：标签页、调试器、页面里实际运行的文档 ----
interface Tab { id: number; windowId: number; url: string; pendingUrl?: string; active: boolean }
const PORT = 41234, ADMIN = adminOrigins(PORT) as [string, string], EXTENSION = `chrome-extension://${'e'.repeat(32)}`;
const tabs = new Map<number, Tab>();
// 页面里实际运行的文档 origin；与 tabs.get 读到的 URL 分开，才能模拟“检查之后页面才跳转到管理页”的竞态。
const pageOrigin = new Map<number, string>();
const sent: { tabId: number; method: string; params: any }[] = [];
const removed: number[] = [];
const eventListeners: ((source: any, method: string, params?: any) => void)[] = [];
const tabUpdated: ((tabId: number, change: any, tab: any) => void)[] = [];
const leaked: string[] = [];
let afterGet: ((tabId: number) => void) | undefined;
let duringCommand: ((tabId: number, method: string) => Promise<void> | void) | undefined;

function runInPage(tabId: number, expression: string) {
  const origin = pageOrigin.get(tabId) ?? new URL(tabs.get(tabId)!.url).origin;
  const page = { location: { origin }, innerWidth: 1000, innerHeight: 800, sessionStorage: { getItem: (key: string) => { leaked.push(`${origin}:${key}`); return 'SECRET-SESSION'; } } };
  try { return { result: { value: vm.runInNewContext(expression, page) } }; }
  catch (thrown) { return { exceptionDetails: { text: 'Uncaught', exception: typeof thrown === 'string' ? { type: 'string', value: thrown } : { type: 'object', description: String((thrown as Error).message) } } }; }
}
const list = <T>(target: T[]) => ({ addListener: (listener: T) => { target.push(listener); }, removeListener: () => {} });
(globalThis as any).chrome = {
  runtime: { getURL: (path: string) => `${EXTENSION}/${path.replace(/^\//, '')}` },
  debugger: {
    onDetach: list<any>([]), onEvent: list(eventListeners),
    attach: async () => {}, detach: async () => {},
    async sendCommand(target: { tabId: number }, method: string, params: any = {}) {
      sent.push({ tabId: target.tabId, method, params });
      const reply = method === 'Runtime.evaluate' ? runInPage(target.tabId, params.expression)
        : method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main' } } } : method === 'Page.captureScreenshot' ? { data: 'AAAA' }
        : method === 'Accessibility.getFullAXTree' ? { nodes: [] } : method === 'Network.getResponseBody' ? { body: 'x' }
        : method === 'Page.navigate' ? { frameId: 'main', loaderId: 'next' } : {};
      await duringCommand?.(target.tabId, method); // 命令已经在页面里完成之后才发生的变化
      return reply;
    },
  },
  tabs: {
    onRemoved: list<any>([]), onActivated: list<any>([]), onCreated: list<any>([]), onUpdated: list(tabUpdated),
    async get(id: number) { const tab = tabs.get(id); const copy = tab && { ...tab }; afterGet?.(id); if (!copy) throw new Error('No tab with id'); return copy; },
    async query(filter: { windowId?: number; active?: boolean } = {}) { return [...tabs.values()].filter(tab => (filter.windowId === undefined || tab.windowId === filter.windowId) && (filter.active === undefined || tab.active === filter.active)); },
    async update(id: number) { return { ...tabs.get(id) }; },
    async remove(id: number) { removed.push(id); tabs.delete(id); },
  },
  windows: { get: async () => ({ state: 'normal', focused: true }), update: async () => ({}), getAll: async () => [] },
  downloads: { onChanged: list<any>([]), onCreated: list<any>([]) },
};

const executor = await import('../extension/executor.js');
const emitted: { method: string; params: JsonObject; tabId?: number }[] = [];
executor.attachEvents((method, params, tabId) => { emitted.push({ method, params, tabId }); });
executor.setAdminOrigins(ADMIN);

let nextTab = 100;
function openTab(url: string, pending?: string) { const id = nextTab++; tabs.set(id, { id, windowId: 1, url, ...(pending ? { pendingUrl: pending } : {}), active: true }); return id; }
const deadline = () => Date.now() + 5000;
const guard = { adminGuard: ADMIN };
const fire = (tabId: number, method: string, params: any, sessionId?: string) => eventListeners.forEach(listener => listener({ tabId, sessionId }, method, params));
async function refused(promise: Promise<unknown>, outcome: 'not_dispatched' | 'unknown' = 'not_dispatched', code = 'ADMIN_PAGE_PROTECTED') {
  await assert.rejects(promise, (error: unknown) => { const info = errorInfo(error); assert.equal(info.code, code); assert.equal(info.outcome, outcome); return true; });
}

test('非管理员命令遇到管理页（各种地址形式）：读取、操作、批次和弹窗响应一律拒绝，调试器收不到任何命令', async () => {
  const urls: [string, string?][] = [
    [`${ADMIN[0]}/#overview`], [`${ADMIN[1]}/?onboarding=1#${'a'.repeat(64)}`], ['about:blank', `${ADMIN[0]}/`],
    [`blob:${ADMIN[0]}/0f0b9e5a-0000-4000-8000-000000000000`], [`${EXTENSION}/options.html`],
  ];
  const operations: [string, JsonObject][] = [
    ['page.evaluate', { expression: 'sessionStorage.getItem("x")' }], ['page.wait', { expression: 'true' }], ['page.snapshot', {}], ['page.screenshot', {}],
    ['contexts.list', {}], ['network.start', {}], ['network.stop', {}], ['network.body', { requestId: 'r1' }], ['page.cdp', { method: 'DOM.getDocument', params: {} }],
    ['page.navigate', { url: 'https://example.com/', wait: false }], ['page.upload', { selector: '#f', paths: ['/x'] }], ['page.action', { action: 'click', selector: '#b' }],
    ['page.inspect', {}], ['page.find', { text: 'x' }], ['page.batch', { steps: [{ operation: 'page.evaluate', args: { expression: '1' } }] }],
    ['tabs.focus', {}], ['tabs.close', {}], ['page.dialog', { accept: false }],
  ];
  for (const [url, pending] of urls) {
    const tabId = openTab(url, pending);
    for (const [operation, args] of operations) {
      const before = sent.length;
      await refused(executor.execute(operation, { tabId, ...guard, ...args }, deadline()));
      assert.equal(sent.length, before, `${operation} 不应向调试器发送命令（${url}）`);
    }
    assert.deepEqual(removed, [], '管理页标签不能被非管理员关闭');
  }
  // 释放调试器只是归还资源，不读取页面，允许。
  assert.deepEqual(await executor.execute('tabs.detach', { tabId: openTab(`${ADMIN[0]}/`), ...guard }, deadline()), { detached: true });
});

test('不是管理页的相近地址不误伤：其他端口、带管理页字样的外部域名', async () => {
  for (const url of [`http://127.0.0.1:${PORT + 1}/`, `http://127.0.0.1.evil.example:${PORT}/`, `https://example.com/?next=${ADMIN[0]}`, 'about:blank']) {
    const tabId = openTab(url);
    assert.equal(await executor.execute('page.evaluate', { tabId, expression: '40+2', ...guard }, deadline()), 42, url);
  }
});

test('管理员主体（无保护标记）不受限制，表达式也不加前缀', async () => {
  const tabId = openTab(`${ADMIN[0]}/#overview`), before = sent.length;
  assert.equal(await executor.execute('page.evaluate', { tabId, expression: '40+2' }, deadline()), 42);
  const evaluation = sent.slice(before).find(command => command.method === 'Runtime.evaluate')!;
  assert.equal(evaluation.params.expression, '40+2');
  assert.equal(await executor.execute('page.navigate', { tabId, url: `${ADMIN[0]}/x`, wait: false }, deadline()).then(() => 'ok'), 'ok');
});

test('页内前缀与脚本在同一任务里核对 origin：用户代码在管理页里不会运行，其余页面完成值不变', () => {
  const prefix = adminGuardPrefix(ADMIN);
  const run = (origin: string, code: string) => { const page = { location: { origin }, hits: 0 }; try { return { value: vm.runInNewContext(prefix + code, page), hits: page.hits }; } catch (thrown) { return { thrown, hits: page.hits }; } };
  assert.deepEqual(run('https://example.com', '1 + 1'), { value: 2, hits: 0 });
  assert.deepEqual(run('https://example.com', 'var a = 3; a * 2'), { value: 6, hits: 0 });
  assert.deepEqual(run('https://example.com', '({ ok: true }).ok'), { value: true, hits: 0 });
  for (const origin of ADMIN) assert.deepEqual(run(origin, 'hits = 1; 42'), { thrown: ADMIN_GUARD_MARKER, hits: 0 });
  assert.equal(prefix.includes('\n'), false, '前缀不能改变用户脚本的行号');
});

test('TOCTOU：读到的 URL 还不是管理页，但执行时页面已经跳过去 → 页内前缀拦截，用户代码没有读到任何存储', async () => {
  const tabId = openTab('https://example.com/start');
  // 模拟检查（tabs.get）返回后页面立刻跳转到管理页。
  afterGet = id => { if (id === tabId) pageOrigin.set(id, ADMIN[0]); };
  leaked.length = 0;
  try {
    await refused(executor.execute('page.evaluate', { tabId, expression: 'sessionStorage.getItem("chrome-mcp-session")', ...guard }, deadline()));
    assert.deepEqual(leaked, [], '保护生效时用户代码根本没有运行');
    // 对照：没有保护标记时同样的竞态确实会读到存储，说明这个模拟能发现缺失的保护。
    pageOrigin.delete(tabId); pageOrigin.set(tabId, ADMIN[0]);
    const exposed = await executor.execute('page.evaluate', { tabId, expression: 'sessionStorage.getItem("chrome-mcp-session")' }, deadline());
    assert.equal(exposed, 'SECRET-SESSION'); assert.deepEqual(leaked, [`${ADMIN[0]}:chrome-mcp-session`]);
  } finally { afterGet = undefined; pageOrigin.delete(tabId); }
  // 原始 Runtime.evaluate 走同一个前缀
  const other = openTab('https://example.com/other'); pageOrigin.set(other, ADMIN[1]); leaked.length = 0;
  await refused(executor.execute('page.cdp', { tabId: other, method: 'Runtime.evaluate', params: { expression: 'sessionStorage.getItem("k")' }, ...guard }, deadline()));
  assert.deepEqual(leaked, []);
});

test('批次逐步核对：中途标签页变成管理页，后续步骤不再执行，已完成步骤保留', async () => {
  const tabId = openTab('https://example.com/batch'); leaked.length = 0;
  let evaluations = 0;
  duringCommand = (id, method) => { if (id === tabId && method === 'Runtime.evaluate' && ++evaluations === 1) tabs.get(id)!.url = `${ADMIN[0]}/#overview`; };
  try {
    const result = await executor.execute('page.batch', { tabId, ...guard, steps: [
      { operation: 'page.evaluate', args: { expression: '1' } },
      { operation: 'page.evaluate', args: { expression: 'sessionStorage.getItem("chrome-mcp-session")' } },
      { operation: 'page.evaluate', args: { expression: '3' } },
    ] }, deadline()) as { completed: boolean; failedIndex: number; results: unknown[]; error: { code: string } };
    assert.equal(result.completed, false); assert.equal(result.failedIndex, 1); assert.equal(result.results.length, 1); assert.equal(result.error.code, 'ADMIN_PAGE_PROTECTED');
    assert.deepEqual(leaked, []); assert.equal(evaluations, 1);
  } finally { duringCommand = undefined; }
});

test('不经页面脚本的读取（截图、无障碍树、响应体、原始 CDP）：期间访问过管理页（哪怕又离开）则丢弃结果', async () => {
  const adminDocument = { frame: { id: 'main', url: `${ADMIN[0]}/` } }, elsewhere = { frame: { id: 'main', url: 'https://example.com/' } };
  const cases: [string, JsonObject, string, 'not_dispatched' | 'unknown'][] = [
    ['page.screenshot', {}, 'Page.captureScreenshot', 'not_dispatched'], ['page.snapshot', {}, 'Accessibility.getFullAXTree', 'not_dispatched'],
    ['network.body', { requestId: 'r' }, 'Network.getResponseBody', 'not_dispatched'], ['page.cdp', { method: 'DOM.getDocument', params: {} }, 'DOM.getDocument', 'unknown'],
  ];
  for (const [operation, args, method, outcome] of cases) {
    const tabId = openTab('https://example.com/read');
    // 读取期间一直停在管理页
    duringCommand = (id, command) => { if (id === tabId && command === method) { fire(id, 'Page.frameNavigated', adminDocument); tabs.get(id)!.url = `${ADMIN[0]}/`; } };
    await refused(executor.execute(operation, { tabId, ...guard, ...args }, deadline()), outcome);
    // 瞬时访问：命令返回前又离开，仍然丢弃
    tabs.get(tabId)!.url = 'https://example.com/read';
    duringCommand = (id, command) => { if (id === tabId && command === method) { fire(id, 'Page.frameNavigated', adminDocument); fire(id, 'Page.frameNavigated', elsewhere); } };
    await refused(executor.execute(operation, { tabId, ...guard, ...args }, deadline()), outcome);
    // 调试器事件还没送到、只是标签页地址变了：事后再读一次地址，同样丢弃
    tabs.get(tabId)!.url = 'https://example.com/read';
    duringCommand = (id, command) => { if (id === tabId && command === method) tabs.get(id)!.url = `${ADMIN[0]}/`; };
    await refused(executor.execute(operation, { tabId, ...guard, ...args }, deadline()), outcome);
    tabs.get(tabId)!.url = 'https://example.com/read';
    // 没有访问过管理页：正常返回
    duringCommand = undefined;
    await executor.execute(operation, { tabId, ...guard, ...args }, deadline());
    // 管理员主体不受影响
    duringCommand = (id, command) => { if (id === tabId && command === method) { fire(id, 'Page.frameNavigated', adminDocument); } };
    await executor.execute(operation, { tabId, ...args }, deadline());
    duringCommand = undefined;
  }
});

test('原始 CDP：新文档脚本和 callFunctionOn 带页内保护，Debugger 域与引用管理页 origin 的参数被拒绝，普通调用不受影响', async () => {
  const tabId = openTab('https://example.com/cdp'), cdp = (method: string, params: JsonObject, extra: JsonObject = guard) => executor.execute('page.cdp', { tabId, method, params, ...extra }, deadline());
  // 新文档脚本：套进一层函数，按 self.origin 判断，在管理页文档里整段不运行，在其他页面照常运行。
  // 顶层函数声明留在函数里，不会被提升进管理页的全局；about:blank iframe 的 location.origin 是 "null"，self.origin 继承管理页的，同样不运行。
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: 'function fetch() { return "hooked"; }\nglobalThis.injected = (globalThis.injected || 0) + 1;' });
  const script = sent.at(-1)!.params.source as string;
  const inject = (origin: string, locationOrigin = origin) => { const page: any = { origin, location: { origin: locationOrigin } }; page.globalThis = page; page.self = page; vm.runInNewContext(script, page); return { injected: page.injected, fetch: typeof page.fetch }; };
  assert.deepEqual(inject('https://example.com'), { injected: 1, fetch: 'undefined' });
  assert.deepEqual(inject(ADMIN[0]), { injected: undefined, fetch: 'undefined' });
  assert.deepEqual(inject(ADMIN[0], 'null'), { injected: undefined, fetch: 'undefined' }, '管理页里的 about:blank iframe');
  // callFunctionOn：末尾带 sourceURL 注释的函数也能正常包装
  await cdp('Runtime.callFunctionOn', { objectId: 'o1', functionDeclaration: 'function(a) { return a + 41; }\n//# sourceURL=probe', arguments: [{ value: 1 }] });
  const declaration = sent.at(-1)!.params.functionDeclaration as string;
  assert.equal(vm.runInNewContext(`(${declaration})`, { location: { origin: 'https://example.com' } }).call({}, 1), 42);
  assert.throws(() => vm.runInNewContext(`(${declaration})`, { location: { origin: ADMIN[1] } }).call({}, 1), (thrown: unknown) => thrown === ADMIN_GUARD_MARKER);
  // Debugger 域：不派发
  let before = sent.length;
  await refused(cdp('Debugger.enable', {}), 'not_dispatched', 'CDP_METHOD_RESTRICTED'); assert.equal(sent.length, before);
  // 参数直接引用管理页（导航、存储）：不派发
  for (const [method, params] of [['Page.navigate', { url: `${ADMIN[0]}/` }], ['DOMStorage.getDOMStorageItems', { storageId: { securityOrigin: ADMIN[1], isLocalStorage: false } }], ['Storage.clearDataForOrigin', { origin: ADMIN[0].toUpperCase(), storageTypes: 'all' }]] as [string, JsonObject][]) {
    before = sent.length; await refused(cdp(method, params)); assert.equal(sent.length, before, method);
  }
  // 普通调用和管理员调用不受影响
  await cdp('Network.getCookies', { urls: ['https://example.com/'] });
  await cdp('Debugger.enable', {}, {});
  assert.equal(sent.at(-1)!.method, 'Debugger.enable');
});

test('page.navigate：非管理员不能把标签页导航到管理页或扩展页，不发送 Page.navigate', async () => {
  const tabId = openTab('https://example.com/nav');
  for (const url of [`${ADMIN[0]}/`, `${ADMIN[1]}/?x=1#code`, `${EXTENSION}/options.html`]) {
    const before = sent.length;
    await refused(executor.execute('page.navigate', { tabId, url, wait: false, ...guard }, deadline()));
    assert.equal(sent.length, before, url);
  }
  await executor.execute('page.navigate', { tabId, url: 'https://example.org/', wait: false, ...guard }, deadline());
  assert.equal(sent.at(-1)!.method, 'Page.navigate');
});

test('管理页的控制台和网络事件（含 Authorization 请求头）不转发内容，离开后恢复；弹窗事件照常转发', () => {
  const tabId = openTab('https://example.com/events');
  const request = { request: { url: `${ADMIN[0]}/dashboard`, headers: { authorization: 'Bearer secret-session' } } };
  emitted.length = 0;
  fire(tabId, 'Network.requestWillBeSent', request);
  assert.deepEqual(emitted.at(-1)!.params, { ...request, sessionId: undefined });
  fire(tabId, 'Page.frameNavigated', { frame: { id: 'main', url: `${ADMIN[0]}/#overview` } });
  fire(tabId, 'Network.requestWillBeSent', request); fire(tabId, 'Runtime.consoleAPICalled', { args: [{ value: 'secret-session' }] }); fire(tabId, 'Network.responseReceived', { response: { url: `${ADMIN[0]}/clients` } });
  for (const event of emitted.slice(1)) assert.deepEqual(event.params, { adminPage: true, sessionId: undefined }, event.method);
  assert.equal(emitted.length, 4);
  fire(tabId, 'Page.javascriptDialogOpening', { type: 'confirm', message: '确定吗？' });
  assert.equal(emitted.at(-1)!.params.message, '确定吗？');
  fire(tabId, 'Page.frameNavigated', { frame: { id: 'main', url: 'https://example.com/' } });
  fire(tabId, 'Network.requestWillBeSent', request);
  assert.deepEqual(emitted.at(-1)!.params, { ...request, sessionId: undefined });
  // 只靠 tabs.onUpdated 也能识别（调试器事件还没到之前）
  const second = openTab('https://example.com/other');
  tabUpdated.forEach(listener => listener(second, { url: `${ADMIN[1]}/` }, tabs.get(second)));
  fire(second, 'Network.requestWillBeSent', request);
  assert.deepEqual(emitted.at(-1)!.params, { adminPage: true, sessionId: undefined });
});
