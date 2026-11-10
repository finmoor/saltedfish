// 极简 DOM：只实现管理页脚本（ui/*.js）和扩展弹窗脚本（extension/options.ts）实际用到的那部分，
// 让它们能在纯 Node 里连同真实的 index.html / options.html 一起运行，不需要启动浏览器。
// 约定：遇到没实现的选择器或伪类直接抛错，不悄悄返回空，避免“测试通过只是因为假 DOM 没查到”。
// 焦点模型刻意贴近浏览器：禁用/移除/隐藏当前焦点元素不会立刻丢焦点，而是在下一次“渲染更新”（updateRendering）时修正，
// 与 Chromium 的 focus fixup 一致；modal 的 showModal/close 也按 HTML 规范记录并还原先前焦点。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { projectDir } from '../src/config.js';

type Handler = (event: FakeEvent) => unknown;
export class FakeEvent {
  defaultPrevented = false; target: any = null; currentTarget: any = null;
  constructor(public type: string, public bubbles = false) {}
  preventDefault() { this.defaultPrevented = true; }
}

class FakeNode {
  parentNode: FakeElement | null = null;
  get textContent(): string { return ''; }
  get isConnected(): boolean { let node: FakeNode | null = this; while (node.parentNode) node = node.parentNode; return node instanceof FakeElement && node.isRoot; }
}
class FakeText extends FakeNode {
  constructor(public data: string) { super(); }
  get textContent(): string { return this.data; } set textContent(value: string) { this.data = String(value); }
}

interface Compound { tag?: string; id?: string; classes: string[]; attrs: { name: string; value?: string }[]; pseudos: string[] }
type Complex = { combinator: ' ' | '>'; compound: Compound }[];
function parseSelectorList(source: string): Complex[] {
  return source.split(',').map(part => {
    const complex: Complex = []; let rest = part.trim(), combinator: ' ' | '>' = ' ';
    while (rest) {
      if (rest.startsWith('>')) { combinator = '>'; rest = rest.slice(1).trim(); continue; }
      const compound: Compound = { classes: [], attrs: [], pseudos: [] };
      const tag = /^(\*|[a-zA-Z][\w-]*)/.exec(rest); if (tag) { if (tag[1] !== '*') compound.tag = tag[1]!.toLowerCase(); rest = rest.slice(tag[0].length); }
      for (;;) {
        let m: RegExpExecArray | null;
        if ((m = /^#([\w-]+)/.exec(rest))) compound.id = m[1];
        else if ((m = /^\.([\w-]+)/.exec(rest))) compound.classes.push(m[1]!);
        else if ((m = /^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/.exec(rest))) compound.attrs.push({ name: m[1]!, value: m[2] ?? m[3] ?? m[4] });
        else if ((m = /^:([\w-]+)/.exec(rest))) { if (!['checked', 'first-child'].includes(m[1]!)) throw new Error(`假 DOM 不支持伪类 :${m[1]}`); compound.pseudos.push(m[1]!); }
        else break;
        rest = rest.slice(m[0].length);
      }
      if (rest && !/^\s/.test(rest)) throw new Error(`假 DOM 无法解析选择器：${source}`);
      complex.push({ combinator, compound }); combinator = ' '; rest = rest.trim();
    }
    if (!complex.length) throw new Error(`空选择器：${source}`);
    return complex;
  });
}
function matchCompound(el: FakeElement, c: Compound): boolean {
  if (c.tag && el.localName !== c.tag) return false;
  if (c.id !== undefined && el.id !== c.id) return false;
  if (!c.classes.every(name => el.classList.contains(name))) return false;
  if (!c.attrs.every(a => a.value === undefined ? el.hasAttribute(a.name) : el.getAttribute(a.name) === a.value)) return false;
  return c.pseudos.every(p => p === 'checked' ? (el as any).checked === true : el.parentNode?.children[0] === el);
}
function matchComplex(el: FakeElement, complex: Complex, index = complex.length - 1): boolean {
  if (!matchCompound(el, complex[index]!.compound)) return false;
  if (index === 0) return true;
  const { combinator } = complex[index]!;
  if (combinator === '>') return !!el.parentNode && matchComplex(el.parentNode, complex, index - 1);
  for (let parent = el.parentNode; parent; parent = parent.parentNode) if (matchComplex(parent, complex, index - 1)) return true;
  return false;
}

const FOCUSABLE = new Set(['button', 'input', 'select', 'textarea', 'summary']);
export class FakeElement extends FakeNode {
  isRoot = false; childNodes: FakeNode[] = []; attrs = new Map<string, string>(); listeners = new Map<string, { fn: Handler; once: boolean }[]>();
  _value: string | undefined; _selected = false; _none = false; _checked: boolean | undefined;
  [key: string]: any;
  constructor(public tagName: string, public ownerDocument: FakeDocument) { super(); }
  get localName() { return this.tagName.toLowerCase(); }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  setAttribute(name: string, value: unknown) { this.attrs.set(name, String(value)); }
  removeAttribute(name: string) { this.attrs.delete(name); }
  hasAttribute(name: string) { return this.attrs.has(name); }
  toggleAttribute(name: string, on: boolean) { if (on) this.attrs.set(name, this.attrs.get(name) ?? ''); else this.attrs.delete(name); }
  get id() { return this.getAttribute('id') ?? ''; } set id(value: string) { this.setAttribute('id', value); }
  get className() { return this.getAttribute('class') ?? ''; } set className(value: string) { this.setAttribute('class', value); }
  get type() { return this.getAttribute('type') ?? (this.localName === 'button' ? 'submit' : 'text'); } set type(value: string) { this.setAttribute('type', value); }
  get name() { return this.getAttribute('name') ?? ''; } set name(value: string) { this.setAttribute('name', value); }
  get hidden() { return this.hasAttribute('hidden'); } set hidden(on: boolean) { this.toggleAttribute('hidden', !!on); }
  get disabled() { return this.hasAttribute('disabled'); } set disabled(on: boolean) { this.toggleAttribute('disabled', !!on); }
  get open() { return this.hasAttribute('open'); } set open(on: boolean) { this.toggleAttribute('open', !!on); }
  get classList() {
    const el = this, names = () => el.className.split(/\s+/).filter(Boolean), write = (list: string[]) => { el.className = list.join(' '); };
    return {
      add: (...add: string[]) => write([...new Set([...names(), ...add])]), remove: (...drop: string[]) => write(names().filter(n => !drop.includes(n))),
      contains: (name: string) => names().includes(name), toggle: (name: string, force?: boolean) => { const on = force ?? !names().includes(name); write(on ? [...new Set([...names(), name])] : names().filter(n => n !== name)); return on; },
    };
  }
  get dataset() {
    const el = this, key = (name: string) => 'data-' + name.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
    return new Proxy({} as Record<string, string>, {
      get: (_t, name) => typeof name === 'string' ? el.getAttribute(key(name)) ?? undefined : undefined,
      set: (_t, name, value) => { el.setAttribute(key(String(name)), value); return true; },
      deleteProperty: (_t, name) => { el.removeAttribute(key(String(name))); return true; },
      has: (_t, name) => typeof name === 'string' && el.hasAttribute(key(name)),
    });
  }
  // 子树
  get children(): FakeElement[] { return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement); }
  get firstChild() { return this.childNodes[0] ?? null; }
  get firstElementChild(): FakeElement | null { return this.children[0] ?? null; }
  get parentElement() { return this.parentNode; }
  get nextElementSibling(): FakeElement | null { const list = this.parentNode?.children ?? []; return list[list.indexOf(this) + 1] ?? null; }
  get previousElementSibling(): FakeElement | null { const list = this.parentNode?.children ?? []; return list[list.indexOf(this) - 1] ?? null; }
  get textContent(): string { return this.childNodes.map(n => n.textContent ?? '').join(''); }
  set textContent(value: string) { this.replaceChildren(...(value === '' || value == null ? [] : [String(value)])); }
  private adopt(nodes: (FakeNode | string)[]) { return nodes.map(n => typeof n === 'string' ? new FakeText(n) : n); }
  // 子节点变化会重新计算 select 的默认选中项（与浏览器一致：没有选中项时回到第一项）。
  private touch() { if (this.localName === 'select') this._none = false; }
  private detach(node: FakeNode) { const parent = node.parentNode; if (parent) { parent.childNodes.splice(parent.childNodes.indexOf(node), 1); parent.touch(); } node.parentNode = null; }
  append(...nodes: (FakeNode | string)[]) { for (const node of this.adopt(nodes)) { this.detach(node); node.parentNode = this; this.childNodes.push(node); } this.touch(); }
  appendChild(node: FakeNode) { this.append(node); return node; }
  prepend(...nodes: (FakeNode | string)[]) { const list = this.adopt(nodes); for (const node of list) this.detach(node); list.forEach(n => { n.parentNode = this; }); this.childNodes.unshift(...list); this.touch(); }
  insertBefore(node: FakeNode, reference: FakeNode | null) {
    this.detach(node); const at = reference ? this.childNodes.indexOf(reference) : -1;
    node.parentNode = this; if (at < 0) this.childNodes.push(node); else this.childNodes.splice(at, 0, node); this.touch(); return node;
  }
  before(...nodes: (FakeNode | string)[]) { const parent = this.parentNode!; for (const node of this.adopt(nodes)) parent.insertBefore(node, this); }
  after(...nodes: (FakeNode | string)[]) { const parent = this.parentNode!; let ref = this.nextSibling; for (const node of this.adopt(nodes)) parent.insertBefore(node, ref); }
  get nextSibling() { const list = this.parentNode?.childNodes ?? []; return list[list.indexOf(this) + 1] ?? null; }
  remove() { this.detach(this); }
  replaceChildren(...nodes: (FakeNode | string)[]) { for (const child of [...this.childNodes]) this.detach(child); this.append(...nodes); }
  contains(node: FakeNode | null) { for (let n: FakeNode | null = node; n; n = n.parentNode) if (n === this) return true; return false; }
  *descendants(): Generator<FakeElement> { for (const child of this.children) { yield child; yield* child.descendants(); } }
  querySelectorAll(selector: string): FakeElement[] { const list = parseSelectorList(selector); return [...this.descendants()].filter(el => list.some(c => matchComplex(el, c))); }
  querySelector<T = FakeElement>(selector: string): T | null { return (this.querySelectorAll(selector)[0] ?? null) as T | null; }
  matches(selector: string) { return parseSelectorList(selector).some(c => matchComplex(this, c)); }
  closest(selector: string) { for (let el: FakeElement | null = this; el; el = el.parentNode) if (el.matches(selector)) return el; return null; }
  // 表单控件
  get value(): string {
    if (this.localName === 'select') { const options = this.options, picked = options.find(o => o._selected); return picked ? picked.value : this._none ? '' : options[0]?.value ?? ''; }
    if (this.localName === 'option') return this.hasAttribute('value') ? this.getAttribute('value')! : this.textContent;
    return this._value ?? this.getAttribute('value') ?? '';
  }
  set value(next: string) {
    if (this.localName === 'select') { const options = this.options; this._none = !options.some(o => o.value === String(next)); for (const o of options) o._selected = !this._none && o.value === String(next); }
    else if (this.localName === 'option') { this.setAttribute('value', next); }
    else this._value = String(next);
  }
  get checked() { return this._checked ?? this.hasAttribute('checked'); } set checked(on: boolean) { this._checked = !!on; }
  get options(): FakeElement[] { return this.localName === 'select' ? [...this.descendants()].filter(el => el.localName === 'option') : []; }
  get elements(): FakeElement[] & { namedItem(name: string): FakeElement | null } {
    const list = [...this.descendants()].filter(el => ['input', 'select', 'textarea', 'button', 'fieldset'].includes(el.localName));
    return Object.assign(list, { namedItem: (name: string) => list.find(el => el.name === name || el.id === name) ?? null });
  }
  // 事件
  addEventListener(type: string, fn: Handler, options?: { once?: boolean } | boolean) { const list = this.listeners.get(type) ?? []; list.push({ fn, once: typeof options === 'object' && !!options.once }); this.listeners.set(type, list); }
  removeEventListener(type: string, fn: Handler) { const list = this.listeners.get(type); if (list) this.listeners.set(type, list.filter(item => item.fn !== fn)); }
  dispatchEvent(event: FakeEvent) {
    event.target = event.target ?? this;
    for (let node: FakeElement | null = this; node; node = event.bubbles ? node.parentNode : null) {
      event.currentTarget = node;
      const inline = node['on' + event.type]; if (typeof inline === 'function') inline.call(node, event);
      for (const item of [...(node.listeners.get(event.type) ?? [])]) { if (item.once) node.removeEventListener(event.type, item.fn); item.fn.call(node, event); }
    }
    if (event.bubbles && this.isConnected) this.ownerDocument.dispatchEvent(event);
    event.currentTarget = null; return !event.defaultPrevented;
  }
  click() {
    if (this.disabled) return;
    if (this.localName === 'input' && this.type === 'checkbox') { this.checked = !this.checked; this.dispatchEvent(new FakeEvent('click', true)); this.dispatchEvent(new FakeEvent('input', true)); this.dispatchEvent(new FakeEvent('change', true)); return; }
    this.dispatchEvent(new FakeEvent('click', true));
  }
  // 焦点与滚动
  focus() { if (this.ownerDocument.canFocus(this)) this.ownerDocument.activeEl = this; }
  blur() { if (this.ownerDocument.activeEl === this) this.ownerDocument.activeEl = null; }
  scrollIntoView(options?: unknown) { this.ownerDocument.scrolled.push({ element: this, options }); }
  // dialog
  showModal() {
    if (this.localName !== 'dialog') throw new Error('showModal 只能用于 dialog');
    if (this.open) throw new DOMException('The dialog is already open', 'InvalidStateError');
    this.open = true; this._previous = this.ownerDocument.activeEl; this.ownerDocument.modals.push(this);
    const target = [...this.descendants()].find(el => this.ownerDocument.canFocus(el)); this.ownerDocument.activeEl = target ?? null;
  }
  close() {
    if (this.localName !== 'dialog' || !this.open) return;
    this.open = false; const doc = this.ownerDocument; doc.modals = doc.modals.filter(d => d !== this);
    const previous = this._previous as FakeElement | null | undefined; this._previous = null;
    if (previous && doc.canFocus(previous)) doc.activeEl = previous;
    this.dispatchEvent(new FakeEvent('close', false));
  }
}
export class FakeDialog extends FakeElement {}
export class FakeSelect extends FakeElement {}
export class FakeButton extends FakeElement {}
export class FakeInput extends FakeElement {}
export class FakeForm extends FakeElement {}
export class FakeTextArea extends FakeElement {}
const CLASS_BY_TAG: Record<string, typeof FakeElement> = { dialog: FakeDialog, select: FakeSelect, button: FakeButton, input: FakeInput, form: FakeForm, textarea: FakeTextArea };

const VOID = new Set(['meta', 'link', 'input', 'br', 'img', 'hr', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);
export class FakeDocument {
  activeEl: FakeElement | null = null; modals: FakeElement[] = []; scrolled: { element: FakeElement; options: unknown }[] = []; hidden = false;
  documentElement: FakeElement; body: FakeElement; private listeners = new Map<string, Handler[]>();
  constructor(html: string) {
    this.documentElement = this.parse(html); this.documentElement.isRoot = true;
    this.body = this.documentElement.querySelector('body') ?? this.documentElement;
  }
  createElement(tag: string) { const name = tag.toLowerCase(); return new (CLASS_BY_TAG[name] ?? FakeElement)(name.toUpperCase(), this); }
  createTextNode(text: string) { return new FakeText(text); }
  querySelector<T = FakeElement>(selector: string): T | null { return this.documentElement.querySelector<T>(selector); }
  querySelectorAll(selector: string) { return this.documentElement.querySelectorAll(selector); }
  get activeElement() { return this.activeEl ?? this.body; }
  addEventListener(type: string, fn: Handler) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  removeEventListener(type: string, fn: Handler) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== fn)); }
  dispatchEvent(event: FakeEvent) { event.target ??= this;event.currentTarget=this;for (const fn of this.listeners.get(event.type) ?? []) fn(event);event.currentTarget=null;return !event.defaultPrevented; }
  dispatch(type: string) { this.dispatchEvent(new FakeEvent(type)); }
  // 能否获得焦点：已连接、未禁用、自身及祖先未 hidden、未处在关闭的 dialog 里，并且不在当前 modal 之外。
  canFocus(el: FakeElement): boolean {
    if (!el.isConnected || el.disabled) return false;
    if (!(FOCUSABLE.has(el.localName) || (el.localName === 'a' && el.hasAttribute('href')) || el.hasAttribute('tabindex'))) return false;
    for (let node: FakeElement | null = el; node; node = node.parentNode) { if (node.hidden) return false; if (node.localName === 'dialog' && !node.open) return false; }
    const modal = this.modals.at(-1); return !modal || modal.contains(el);
  }
  // 相当于浏览器的一帧：被禁用、被移除或被隐藏的焦点元素在这里失去焦点（focus fixup）。
  updateRendering() { if (this.activeEl && !this.canFocus(this.activeEl)) this.activeEl = null; }
  private parse(html: string): FakeElement {
    const container = new FakeElement('DIV', this), stack: FakeElement[] = [container];
    const token = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)/gi;
    for (let m: RegExpExecArray | null; (m = token.exec(html));) {
      if (m[1]) { const name = m[1].toLowerCase(); for (let i = stack.length - 1; i > 0; i--) if (stack[i]!.localName === name) { stack.length = i; break; } }
      else if (m[2]) {
        const el = this.createElement(m[2]); const attrs = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
        for (let a: RegExpExecArray | null; (a = attrs.exec(m[3] ?? ''));) el.setAttribute(a[1]!, a[2] ?? a[3] ?? a[4] ?? '');
        stack.at(-1)!.append(el); if (!VOID.has(el.localName)) stack.push(el);
      } else if (m[4] !== undefined) stack.at(-1)!.append(m[4]);
    }
    const html5 = container.querySelector('html'); if (!html5) throw new Error('假 DOM 需要完整的 html 文档');
    html5.remove(); return html5;
  }
}

export interface InstalledDom { doc: FakeDocument; windowEvent(type: string): void; uninstall(): void; }
// 把假 DOM 装成全局对象；返回的 uninstall 还原所有被覆盖的全局，保证用例之间互不影响。
export function installDom(html: string, globals: Record<string, unknown> = {}): InstalledDom {
  const doc = new FakeDocument(html), saved = new Map<string, PropertyDescriptor | undefined>();
  const windowListeners = new Map<string, Handler[]>();
  const define = (name: string, value: unknown) => { if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
  define('document', doc);
  define('HTMLElement', FakeElement); define('HTMLDialogElement', FakeDialog); define('HTMLSelectElement', FakeSelect); define('HTMLButtonElement', FakeButton);
  define('HTMLInputElement', FakeInput); define('HTMLFormElement', FakeForm); define('HTMLTextAreaElement', FakeTextArea);
  define('addEventListener', (type: string, fn: Handler) => windowListeners.set(type, [...(windowListeners.get(type) ?? []), fn]));
  define('scrollTo', () => {});
  for (const [name, value] of Object.entries(globals)) define(name, value);
  return { doc, windowEvent: (type: string) => { for (const fn of windowListeners.get(type) ?? []) fn(new FakeEvent(type)); }, uninstall() { for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; } } };
}
// node:assert 失败时会深度打印被比较的对象（并忽略自定义 inspect），而 DOM 节点互相引用，会撑爆内存。
// 比较节点一律用 same()，失败信息只写一行标签。
export const describe = (node: unknown) => node instanceof FakeElement ? `<${node.localName}${node.id ? '#' + node.id : ''}${node.className ? '.' + node.className.split(' ').join('.') : ''}>` : String(node);
export const same = (actual: unknown, expected: unknown, message = '') => { if (actual !== expected) throw new assert.AssertionError({ message: `${message} 期望 ${describe(expected)}，实际 ${describe(actual)}`.trim(), actual: describe(actual), expected: describe(expected) }); };
export const readUi = (name: string) => readFileSync(path.join(projectDir, 'ui', name), 'utf8');
export const readExtension = (name: string) => readFileSync(path.join(projectDir, 'extension', name), 'utf8');

// 等待所有挂起的 promise 链走完（fetch 假实现与组件内部的 await 都是微任务）。
export const flush = async () => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
export const type = (el: FakeElement, text: string) => { el.value = text; el.dispatchEvent(new FakeEvent('input', true)); };
export const choose = (el: FakeElement, value: string) => { el.value = value; el.dispatchEvent(new FakeEvent('input', true)); el.dispatchEvent(new FakeEvent('change', true)); };
