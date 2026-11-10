/// <reference path="../extension/page-runtime-source.d.ts" />
import vm from 'node:vm';
import { register } from 'node:module';
import type { JsonObject } from '../src/shared.js';

// 扩展执行层的离线夹具：不启动浏览器。真实的 extension/executor.ts（含窗口队列、弹窗协调、隔离世界）原样运行，
// 只把 chrome.* 换成脚本化的假实现；页面里运行的 extension/page-runtime.ts 也是真实代码，作用在一个极小的假 DOM 上。
// 它能证明扩展侧的控制流与错误分类，不能证明 Chrome 本身的行为（焦点、事件时序、CDP 目标类型）——那部分仍需实机验证。
// executor.ts 里的 virtual:page-runtime 由打包器提供；这里用空源码占位（页面运行时直接在测试进程里被调用）。
register('data:text/javascript;base64,' + Buffer.from(`
export async function resolve(specifier, context, nextResolve) { if (specifier === 'virtual:page-runtime') return { url: 'virtual:page-runtime', shortCircuit: true }; return nextResolve(specifier, context); }
export async function load(url, context, nextLoad) { if (url === 'virtual:page-runtime') return { format: 'module', source: 'export default "";', shortCircuit: true }; return nextLoad(url, context); }
`).toString('base64'));

type Handler = (event: JsonObject) => void;
export class FakeDocument {
  activeElement: FakeElement | null = null;
  elements: FakeElement[] = [];
  querySelectorAll(_selector: string) { return this.elements.filter(element => element.isConnected); }
  // 最上层（后加入）且覆盖该点的元素；用于 framePoint 的遮挡检查。
  elementFromPoint(x: number, y: number) {
    return [...this.elements].reverse().find(e => e.isConnected && e.visible && x >= e.rect.left && x <= e.rect.right && y >= e.rect.top && y <= e.rect.bottom) ?? null;
  }
}
export class FakeElement {
  tagName = 'DIV'; type = ''; id = ''; value = ''; isConnected = true; isContentEditable = false; shadowRoot = null;
  visible = true; readOnly = false; selectionStart = 0; selectionEnd = 0; scrolled = 0;
  rect = { left: 10, top: 10, right: 210, bottom: 40, width: 200, height: 30 };
  private blocked = false;
  private handlers = new Map<string, Handler[]>();
  constructor(readonly ownerDocument: FakeDocument) {}
  // 浏览器里禁用一个有焦点的字段会让焦点回到 body。
  get disabled() { return this.blocked; }
  set disabled(value: boolean) { this.blocked = value; if (value && this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
  on(type: string, handler: Handler) { this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]); return this; }
  dispatchEvent(event: { type: string }) { this.emit(event.type); return true; }
  emit(type: string, event: JsonObject = {}) { for (const handler of this.handlers.get(type) ?? []) handler(event); }
  matches(selector: string) { return selector === `#${this.id}`; }
  focus() { if (this.blocked || !this.visible || !this.isConnected || this.ownerDocument.activeElement === this) return; this.ownerDocument.activeElement = this; this.emit('focus'); }
  select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
  getRootNode() { return this.ownerDocument; }
  contains(other: unknown) { return other === this; }
  closest(_selector: string) { return null; }
  getBoundingClientRect() { return this.rect; }
  scrollIntoView() { this.scrolled++; }
}
export class FakeInput extends FakeElement { tagName = 'INPUT'; type = 'text'; }
export class FakeTextArea extends FakeElement { tagName = 'TEXTAREA'; }
class FakeSelect extends FakeElement { tagName = 'SELECT'; }
class FakeShadowRoot {}
class FakeOptGroup {}
// page-runtime.ts 在调用时才读取这些全局名，因此这里同时是测试进程和页面沙箱的“DOM 类”。
class FakeEvent { constructor(readonly type: string, _init?: unknown) {} }
const dom = { Event: FakeEvent, HTMLElement: FakeElement, HTMLInputElement: FakeInput, HTMLTextAreaElement: FakeTextArea, HTMLSelectElement: FakeSelect, ShadowRoot: FakeShadowRoot, HTMLOptGroupElement: FakeOptGroup };
Object.assign(globalThis, dom);

export class FakePage {
  readonly document = new FakeDocument();
  readonly mouseEvents: JsonObject[] = [];
  readonly keyEvents: JsonObject[] = [];
  innerWidth = 1000; innerHeight = 800;
  input(id: string, value = '') { const element = new FakeInput(this.document); element.id = id; element.value = value; this.document.elements.push(element); return element; }
  element(id: string, rect?: Partial<FakeElement['rect']>) {
    const element = new FakeElement(this.document); element.id = id;
    if (rect) { element.rect = { ...element.rect, ...rect }; element.rect.width = element.rect.right - element.rect.left; element.rect.height = element.rect.bottom - element.rect.top; }
    this.document.elements.push(element); return element;
  }
  // Input.insertText：在当前焦点字段的选择区插入文字，然后触发页面的 input 处理（页面可在其中跳格、禁用或改写值）。
  insertText(text: string) {
    const element = this.document.activeElement;
    if (!(element instanceof FakeInput || element instanceof FakeTextArea) || element.disabled || element.readOnly) return;
    element.value = element.value.slice(0, element.selectionStart) + text + element.value.slice(element.selectionEnd);
    element.selectionStart = element.selectionEnd = element.selectionStart + text.length;
    element.emit('input');
  }
  key(params: JsonObject) {
    this.keyEvents.push({ ...params });
    const element = this.document.activeElement;
    if (params.type === 'rawKeyDown' || params.type === 'keyDown') {
      element?.emit('keydown', params);
      // Ctrl+A 全选（真实 Chrome 由编辑器按键绑定处理）。
      if (params.key === 'a' && Number(params.modifiers) & 2) element?.select();
      if (params.key === 'Backspace' && element && element.selectionEnd > element.selectionStart) {
        element.value = element.value.slice(0, element.selectionStart) + element.value.slice(element.selectionEnd); element.selectionEnd = element.selectionStart; element.emit('input');
      }
    } else if (params.type === 'char' && typeof params.text === 'string') this.insertText(params.text);
    else if (params.type === 'keyUp') element?.emit('keyup', params);
  }
}

export interface Sent { tabId: number; sessionId?: string; method: string; params: any }
export async function loadExtension() {
  const sent: Sent[] = [], pages = new Map<number, FakePage>(), tabs = new Map<number, { id: number; windowId: number; url: string; active: boolean }>();
  const listeners: ((source: { tabId: number; sessionId?: string }, method: string, params?: any) => void)[] = [];
  const isolated = new Set<number>(), emitted: { method: string; params: JsonObject; tabId?: number }[] = [];
  // intercept 返回非 undefined 时替代默认应答（可返回 Promise 来阻塞命令）；afterTabGet 在每次 chrome.tabs.get 复制出结果之后调用。
  const hooks: { intercept?: (command: Sent) => unknown; afterTabGet?: (tabId: number, call: number) => void } = {};
  const runtime = await import('../extension/page-runtime.js');
  // 页面运行时用真实实现；只有依赖排版的 elementState 换成读取假元素字段。
  const FengPage = { ...runtime, elementState: (element: FakeElement) => ({ visible: element.visible, disabled: element.disabled, readOnly: element.readOnly }) };
  let isolatedIds = 1000, tabGets = 0;
  const fire = (tabId: number, method: string, params: unknown, sessionId?: string) => listeners.forEach(listener => listener({ tabId, sessionId }, method, params));

  function evaluate(tabId: number, params: any) {
    const page = pages.get(tabId); if (!page || !params.expression) return { result: {} };
    // 页面运行时在测试进程里执行（不在沙箱里），读的是这里的全局名。
    Object.assign(globalThis, { document: page.document, innerWidth: page.innerWidth, innerHeight: page.innerHeight, devicePixelRatio: 1 });
    const sandbox = { ...dom, document: page.document, innerWidth: page.innerWidth, innerHeight: page.innerHeight, devicePixelRatio: 1, scrollX: 0, scrollY: 0, queueMicrotask, ...(isolated.has(params.contextId) ? { FengPage } : {}) };
    try {
      const value = vm.runInNewContext(params.expression, sandbox);
      return { result: value === undefined ? { type: 'undefined' } : { type: typeof value, value: JSON.parse(JSON.stringify(value)) } };
    } catch (thrown) { return { exceptionDetails: { text: 'Uncaught', exception: { type: 'object', description: String((thrown as Error)?.message ?? thrown) } } }; }
  }
  async function sendCommand(target: { tabId: number; sessionId?: string }, method: string, params: any = {}) {
    const command: Sent = { tabId: target.tabId, sessionId: target.sessionId, method, params }; sent.push(command);
    const replaced = await hooks.intercept?.(command); if (replaced !== undefined) return replaced;
    const page = pages.get(target.tabId);
    switch (method) {
      case 'Runtime.evaluate': return evaluate(target.tabId, params);
      case 'Page.getFrameTree': return { frameTree: { frame: { id: 'main', loaderId: 'loader-1', url: tabs.get(target.tabId)?.url ?? '' } } };
      case 'Page.createIsolatedWorld': {
        const id = ++isolatedIds; isolated.add(id);
        fire(target.tabId, 'Runtime.executionContextCreated', { context: { id, origin: '', name: params.worldName, auxData: { isDefault: false, type: 'isolated', frameId: params.frameId } } }, target.sessionId);
        return { executionContextId: id };
      }
      case 'Input.insertText': page?.insertText(params.text); return {};
      case 'Input.dispatchKeyEvent': page?.key(params); return {};
      case 'Input.dispatchMouseEvent': page?.mouseEvents.push({ ...params }); return {};
      default: return {};
    }
  }
  const list = <T>(target: T[]) => ({ addListener: (listener: T) => { target.push(listener); }, removeListener: () => {} });
  (globalThis as any).chrome = {
    runtime: { getURL: (path: string) => `chrome-extension://${'e'.repeat(32)}/${path.replace(/^\//, '')}` },
    debugger: { onDetach: list<any>([]), onEvent: list(listeners), attach: async () => {}, detach: async () => {}, sendCommand },
    tabs: {
      onRemoved: list<any>([]), onActivated: list<any>([]), onCreated: list<any>([]), onUpdated: list<any>([]),
      async get(id: number) { const tab = tabs.get(id); const copy = tab && { ...tab }; hooks.afterTabGet?.(id, ++tabGets); if (!copy) throw new Error('No tab with id'); return copy; },
      async query(filter: { windowId?: number; active?: boolean } = {}) { return [...tabs.values()].filter(tab => (filter.windowId === undefined || tab.windowId === filter.windowId) && (filter.active === undefined || tab.active === filter.active)).map(tab => ({ ...tab })); },
      async update(id: number) { return { ...tabs.get(id) }; }, async remove(id: number) { tabs.delete(id); },
    },
    windows: { get: async () => ({ state: 'normal', focused: true }), update: async () => ({}), getAll: async () => [] },
    downloads: { onChanged: list<any>([]), onCreated: list<any>([]) },
  };
  const executor = await import('../extension/executor.js');
  // 这些单元测试逐条核对不带停顿的事件序列；像真人一样操作（产品默认开）由 executor-human.test.ts 自己打开再测。
  executor.setHumanInput(false);
  executor.attachEvents((method, params, tabId) => { emitted.push({ method, params, tabId }); });
  let nextTab = 100;
  // 每个标签页独占一个窗口，避免窗口队列和“切换活动标签”干扰；主 frame 的默认执行上下文由事件登记，隔离世界才能创建。
  function openTab(url = 'https://example.test/') {
    const id = nextTab++, page = new FakePage(); pages.set(id, page); tabs.set(id, { id, windowId: id, url, active: true });
    fire(id, 'Runtime.executionContextCreated', { context: { id: 1, origin: url, name: '', auxData: { isDefault: true, type: 'default', frameId: 'main' } } });
    return { tabId: id, page };
  }
  const deadline = (ms = 5000) => Date.now() + ms;
  return { executor, sent, tabs, pages, hooks, emitted, openTab, fire, deadline, commandsFor: (tabId: number, method?: string) => sent.filter(command => command.tabId === tabId && (!method || command.method === method)) };
}
