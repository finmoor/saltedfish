import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { projectDir } from '../src/config.js';

// 从真实 CSS 文件解析并按级联（媒体查询、选择器权重、!important、var()）求出元素的最终颜色/背景/字号，再按 WCAG 公式算对比度。
// 这不是浏览器的 getComputedStyle：只支持类/ID/标签/属性选择器和后代、子代组合器，遇到伪类整条规则忽略（静止状态不生效）。
// 真实 Chrome 里的计算结果仍由 tests/ui-review.integration.ts 抽查。
interface Rule { selector: string; declarations: [string, string, boolean][]; media: string; order: number }
interface Node { tag: string; id?: string; classes?: string[]; attrs?: Record<string, string> }
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const splitTop = (text: string, separator: string) => { const parts: string[] = []; let depth = 0, current = ''; for (const char of text) { if ('([{'.includes(char)) depth++; if (')]}'.includes(char)) depth--; if (char === separator && !depth) { parts.push(current); current = ''; } else current += char; } parts.push(current); return parts; };
function declarations(body: string): [string, string, boolean][] {
  const list: [string, string, boolean][] = [];
  for (const item of splitTop(body, ';')) {
    const colon = item.indexOf(':'); if (colon < 0) continue;
    const name = item.slice(0, colon).trim().toLowerCase(); let value = item.slice(colon + 1).trim(); const important = /!\s*important$/i.test(value); value = value.replace(/!\s*important$/i, '').trim();
    list.push([name, value, important]);
    if (name === 'font') { const size = /(\d+(?:\.\d+)?)px/.exec(value); if (size) list.push(['font-size', `${size[1]}px`, important]); }
    if (name === 'background' && /^(#[0-9a-f]{3,8}|var\([^)]*\)|transparent)$/i.test(value)) list.push(['background-color', value, important]);
  }
  return list;
}
function parseCss(source: string, rules: Rule[] = [], media = '', counter = { n: rules.length }): Rule[] {
  const css = stripComments(source); let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i); if (open < 0) break;
    const head = css.slice(i, open).trim(); let depth = 1, j = open + 1;
    while (j < css.length && depth) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
    const body = css.slice(open + 1, j - 1);
    if (head.startsWith('@media')) parseCss(body, rules, head.slice(6).trim(), counter);
    else if (!head.startsWith('@')) for (const selector of splitTop(head, ',')) rules.push({ selector: selector.trim(), declarations: declarations(body), media, order: counter.n++ });
    i = j;
  }
  return rules;
}
const mediaApplies = (media: string, width: number) => {
  if (!media) return true;
  const terms = [...media.matchAll(/\(\s*(min|max)-width\s*:\s*(\d+)px\s*\)/g)];
  if (!terms.length || /prefers|print|hover/.test(media)) return false;
  return terms.every(([, kind, px]) => kind === 'max' ? width <= Number(px) : width >= Number(px));
};
type Compound = { tag?: string; id?: string; classes: string[]; attrs: [string, string | undefined][] };
function compounds(selector: string): { combinator: ' ' | '>'; compound: Compound }[] | undefined {
  if (/[:*+~]/.test(selector)) return undefined; // 伪类/通配/兄弟组合器：静止状态不生效，整条忽略
  const list: { combinator: ' ' | '>'; compound: Compound }[] = []; let combinator: ' ' | '>' = ' ';
  for (const part of selector.replace(/>/g, ' > ').split(/\s+/).filter(Boolean)) {
    if (part === '>') { combinator = '>'; continue; }
    const match = /^([a-zA-Z][\w-]*)?((?:[.#][\w-]+|\[[^\]]+\])*)$/.exec(part); if (!match) return undefined;
    const compound: Compound = { tag: match[1]?.toLowerCase(), classes: [], attrs: [] };
    for (const token of match[2]!.match(/[.#][\w-]+|\[[^\]]+\]/g) ?? []) {
      if (token.startsWith('.')) compound.classes.push(token.slice(1)); else if (token.startsWith('#')) compound.id = token.slice(1);
      else { const [name, value] = token.slice(1, -1).split('='); compound.attrs.push([name!.trim(), value?.trim().replace(/^["']|["']$/g, '')]); }
    }
    list.push({ combinator, compound }); combinator = ' ';
  }
  return list;
}
const matchesCompound = (node: Node, c: Compound) => (!c.tag || node.tag === c.tag) && (c.id === undefined || node.id === c.id) && c.classes.every(name => node.classes?.includes(name))
  && c.attrs.every(([name, value]) => node.attrs !== undefined && name in node.attrs && (value === undefined || node.attrs[name] === value));
function matchesChain(chain: Node[], parts: NonNullable<ReturnType<typeof compounds>>, at = chain.length - 1, index = parts.length - 1): boolean {
  if (at < 0 || !matchesCompound(chain[at]!, parts[index]!.compound)) return false;
  if (index === 0) return true;
  if (parts[index]!.combinator === '>') return matchesChain(chain, parts, at - 1, index - 1);
  for (let parent = at - 1; parent >= 0; parent--) if (matchesChain(chain, parts, parent, index - 1)) return true;
  return false;
}
const specificity = (parts: NonNullable<ReturnType<typeof compounds>>) => parts.reduce((sum, { compound: c }) => sum + (c.id ? 10000 : 0) + (c.classes.length + c.attrs.length) * 100 + (c.tag ? 1 : 0), 0);

class Sheet {
  constructor(private rules: Rule[], private width: number) {}
  private cascade(chain: Node[], property: string): string | undefined {
    let best: { value: string; key: number[] } | undefined;
    for (const rule of this.rules) {
      if (!mediaApplies(rule.media, this.width)) continue;
      const parts = compounds(rule.selector); if (!parts || !matchesChain(chain, parts)) continue;
      for (const [name, value, important] of rule.declarations) if (name === property) {
        const key = [important ? 1 : 0, specificity(parts), rule.order];
        if (!best || key[0]! > best.key[0]! || (key[0] === best.key[0] && (key[1]! > best.key[1]! || (key[1] === best.key[1] && key[2]! > best.key[2]!)))) best = { value, key };
      }
    }
    return best?.value;
  }
  private root(property: string): string | undefined { let value: string | undefined; for (const rule of this.rules) if (rule.selector === ':root' && mediaApplies(rule.media, this.width)) for (const [name, v] of rule.declarations) if (name === property) value = v; return value; }
  private resolve(value: string | undefined): string | undefined {
    for (let guard = 0; value && guard < 5; guard++) { const match = /^var\((--[\w-]+)\)$/.exec(value.trim()); if (!match) break; value = this.root(match[1]!); }
    return value?.trim();
  }
  /** 最终文字颜色、背景（沿祖先找第一个有背景的，否则取 :root）和字号(px)。 */
  style(chain: Node[]) {
    let color: string | undefined, background: string | undefined;
    for (let end = chain.length; end > 0 && !color; end--) color = this.resolve(this.cascade(chain.slice(0, end), 'color'));
    // 透明背景（例如 .secondary / .danger 按钮）不遮住祖先：继续向上找第一个真正有底色的祖先。
    for (let end = chain.length; end > 0 && !background; end--) { const value = this.resolve(this.cascade(chain.slice(0, end), 'background-color')); if (value && value !== 'transparent') background = value; }
    background ??= this.resolve(this.root('background')) ?? this.resolve(this.root('background-color'));
    color ??= this.resolve(this.root('color')); // 没有任何规则给这段文字设色：继承页面根（:root）的文字颜色
    let size: string | undefined; for (let end = chain.length; end > 0 && !size; end--) size = this.resolve(this.cascade(chain.slice(0, end), 'font-size'));
    return { color: color ?? '', background: background ?? '', size: Number.parseFloat(size ?? '14') };
  }
}
const luminance = (hex: string) => {
  const full = hex.length === 4 ? '#' + [...hex.slice(1)].map(c => c + c).join('') : hex;
  assert.match(full, /^#[0-9a-f]{6}$/i, `无法解析颜色 ${JSON.stringify(hex)}`);
  const n = Number.parseInt(full.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }) as [number, number, number];
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
};
const contrast = (a: string, b: string) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const read = (file: string) => readFileSync(path.join(projectDir, file), 'utf8');
// 与 index.html 的 <link> 顺序一致：style.css → product.css → workspace.css
const dashboardRules = () => ['ui/style.css', 'ui/product.css', 'ui/workspace.css'].reduce<Rule[]>((rules, file) => parseCss(read(file), rules, '', { n: rules.length }), []);
const page: Node[] = [{ tag: 'html' }, { tag: 'body' }, { tag: 'div', id: 'workspace' }, { tag: 'main' }];
const card: Node[] = [...page, { tag: 'section', id: 'accounts' }, { tag: 'div', id: 'profiles' }, { tag: 'article', classes: ['profile-card'] }];
const cell: Node[] = [...page, { tag: 'section', id: 'activity' }, { tag: 'div', id: 'operations' }, { tag: 'table' }, { tag: 'tbody' }, { tag: 'tr' }];
const dialog: Node[] = [...page, { tag: 'dialog', id: 'task-detail' }];
const protectionRow: Node[] = [...page, { tag: 'section', id: 'overview' }, { tag: 'div', id: 'protection-notice', classes: ['protection-notice'] }, { tag: 'div', classes: ['protection-profile'] }];
const activityList: Node[] = [...page, { tag: 'section', id: 'activity' }, { tag: 'div', id: 'operations' }];
const recoveryDialog: Node[] = [...page, { tag: 'dialog', id: 'operation-recovery' }];
const abandonDialog: Node[] = [...page, { tag: 'dialog', id: 'profile-abandon' }];

const roles: { name: string; chain: Node[]; minSize: number }[] = [
  { name: '配置 ID（连接详情里的 .identity）', chain: [...card, { tag: 'details' }, { tag: 'p', classes: ['identity'] }], minSize: 12 },
  { name: '即使放进 .profile-heading，配置 ID 也不会被旧规则压回 10px', chain: [...card, { tag: 'div', classes: ['profile-heading'] }, { tag: 'p', classes: ['identity'] }], minSize: 12 },
  { name: '标签页 URL / 操作记录错误码（.url）', chain: [...cell, { tag: 'td' }, { tag: 'div', classes: ['url'] }], minSize: 12 },
  { name: '状态徽章：已连接（.badge）', chain: [...card, { tag: 'div', classes: ['profile-heading'] }, { tag: 'h3' }, { tag: 'span', classes: ['badge'] }], minSize: 12 },
  { name: '状态徽章：未连接 / 扩展需要刷新（.badge.offline）', chain: [...card, { tag: 'div', classes: ['profile-heading'] }, { tag: 'h3' }, { tag: 'span', classes: ['badge', 'offline'] }], minSize: 12 },
  { name: '对话框里的失败反馈', chain: [...dialog, { tag: 'div', classes: ['dialog-feedback'], attrs: { 'data-feedback': '', 'data-error': 'true' } }], minSize: 13 },
  { name: '对话框里的成功反馈', chain: [...dialog, { tag: 'div', classes: ['dialog-feedback'], attrs: { 'data-feedback': '', 'data-error': 'false' } }], minSize: 13 },
  { name: '操作状态：待确认', chain: [...cell, { tag: 'td', classes: ['state', 'unknown'] }], minSize: 0 },
  { name: '操作状态：已完成', chain: [...cell, { tag: 'td', classes: ['state', 'succeeded'] }], minSize: 0 },
  { name: '操作状态：失败', chain: [...cell, { tag: 'td', classes: ['state', 'failed'] }], minSize: 0 },
  // 放弃永不再连接的配置（server:2 的界面）：新增的说明文字、按钮和对话框内容都按真实 CSS 计算
  { name: '待核查提示里离线配置的说明（.protection-offline）', chain: [...protectionRow, { tag: 'small', classes: ['protection-offline'] }], minSize: 13 },
  { name: '待核查提示里的“放弃此配置…”按钮（.danger）', chain: [...protectionRow, { tag: 'button', classes: ['danger'] }], minSize: 12 },
  { name: '操作记录页的离线说明（.offline-note）', chain: [...activityList, { tag: 'div', classes: ['offline-note'] }, { tag: 'p' }], minSize: 13 },
  { name: '操作记录页离线说明里的“放弃此配置…”按钮', chain: [...activityList, { tag: 'div', classes: ['offline-note'] }, { tag: 'button', classes: ['danger'] }], minSize: 12 },
  { name: '逐条核查对话框里的离线说明', chain: [...recoveryDialog, { tag: 'div', id: 'operation-recovery-offline', classes: ['offline-note'] }, { tag: 'p', id: 'operation-recovery-offline-text' }], minSize: 13 },
  { name: '逐条核查对话框里的“放弃此配置…”按钮', chain: [...recoveryDialog, { tag: 'div', id: 'operation-recovery-offline', classes: ['offline-note'] }, { tag: 'button', id: 'abandon-from-recovery', classes: ['danger'] }], minSize: 12 },
  { name: '放弃配置对话框：配置概况（.recovery-context）', chain: [...abandonDialog, { tag: 'p', id: 'profile-abandon-context', classes: ['recovery-context'] }], minSize: 13 },
  { name: '放弃配置对话框：说明文字', chain: [...abandonDialog, { tag: 'p', id: 'profile-abandon-warning' }], minSize: 13 },
  { name: '放弃配置对话框：记录的次要信息（时间、错误码、操作 ID）', chain: [...abandonDialog, { tag: 'ul', id: 'profile-abandon-operations', classes: ['abandon-operations'] }, { tag: 'li' }, { tag: 'small' }], minSize: 13 },
  { name: '放弃配置对话框：记录总数说明（.muted）', chain: [...abandonDialog, { tag: 'p', id: 'profile-abandon-more', classes: ['muted'] }], minSize: 12 },
  { name: '放弃配置对话框：数量输入的说明', chain: [...abandonDialog, { tag: 'label', classes: ['abandon-count'] }, { tag: 'span', id: 'profile-abandon-count-text' }], minSize: 12 },
  { name: '放弃配置对话框：确认按钮（.danger）', chain: [...abandonDialog, { tag: 'div', classes: ['row-actions'] }, { tag: 'button', id: 'confirm-profile-abandon', classes: ['danger'] }], minSize: 12 },
  { name: '放弃配置对话框：反馈（失败与不可放弃的原因）', chain: [...abandonDialog, { tag: 'div', classes: ['dialog-feedback'], attrs: { 'data-feedback': '', 'data-error': 'true' } }], minSize: 13 },
  { name: '页脚的授权说明（footer span）', chain: [...page, { tag: 'footer' }, { tag: 'span' }], minSize: 13 },
];

for (const width of [1280, 390]) {
  test(`管理页信息文字按真实 CSS 级联计算：对比度 ≥ 4.5:1 且不小于规定字号（视口 ${width}px）`, () => {
    const sheet = new Sheet(dashboardRules(), width), failures: string[] = [];
    for (const role of roles) {
      const { color, background, size } = sheet.style(role.chain);
      if (!color || !background) { failures.push(`${role.name}：没解析到颜色（color=${color}，background=${background}）`); continue; }
      const ratio = contrast(color, background);
      if (ratio < 4.5) failures.push(`${role.name}：${color} 在 ${background} 上只有 ${ratio.toFixed(2)}:1`);
      if (size < role.minSize) failures.push(`${role.name}：字号 ${size}px 小于 ${role.minSize}px`);
    }
    assert.deepEqual(failures, []);
  });
}

test('对话框成功反馈与失败反馈使用不同的配色，成功不再套用红色错误样式', () => {
  const sheet = new Sheet(dashboardRules(), 1280);
  const failure = sheet.style(roles.find(role => role.name === '对话框里的失败反馈')!.chain), success = sheet.style(roles.find(role => role.name === '对话框里的成功反馈')!.chain);
  assert.notEqual(success.background, failure.background); assert.notEqual(success.color, failure.color);
});

test('对话框内的反馈区在滚动的长对话框里固定在可视区顶部', () => {
  const rules = dashboardRules().filter(rule => rule.selector === '.dialog-feedback' && !rule.media);
  const declared = new Map(rules.flatMap(rule => rule.declarations.map(([name, value]) => [name, value] as const)));
  assert.equal(declared.get('position'), 'sticky'); assert.equal(declared.get('top'), '0'); assert.ok(Number(declared.get('z-index')) >= 1, '要盖在滚动内容之上');
});

test('扩展弹窗里的保存结果提示：成功与失败文字都满足对比度', () => {
  const rules = parseCss(read('extension/options.css')), sheet = new Sheet(rules, 380), base: Node[] = [{ tag: 'html' }, { tag: 'body' }, { tag: 'main' }];
  assert.ok(rules.some(rule => rule.selector.includes('#save-result')), '弹窗需要专门的保存结果提示样式');
  for (const error of ['true', 'false']) {
    const { color, background, size } = sheet.style([...base, { tag: 'p', id: 'save-result', attrs: { 'data-error': error } }]);
    assert.ok(color && background, `data-error=${error} 没解析到颜色`); assert.ok(contrast(color, background) >= 4.5, `data-error=${error} 对比度 ${contrast(color, background).toFixed(2)}`); assert.ok(size >= 12, `字号 ${size}`);
  }
});

test('扩展弹窗的连接状态条：出错时换成红色系，对比度不低于 4.5:1；正常状态不套红底', () => {
  const rules = parseCss(read('extension/options.css')), sheet = new Sheet(rules, 380), base: Node[] = [{ tag: 'html' }, { tag: 'body' }, { tag: 'main' }];
  const status = (state: string) => sheet.style([...base, { tag: 'div', id: 'status', attrs: { 'data-state': state } }]);
  const failing = status('error'), normal = status('connected');
  assert.ok(failing.color && failing.background && normal.color && normal.background, '状态条的颜色没解析到');
  assert.notEqual(failing.background, normal.background, '出错状态不能和已连接长得一样');
  for (const [name, { color, background }] of [['error', failing], ['connected', normal]] as const) assert.ok(contrast(color!, background!) >= 4.5, `${name} 对比度 ${contrast(color!, background!).toFixed(2)}`);
});

test('管理页的图标和扩展图标是同一张图（管理页的内容安全策略不允许 data: 图片，所以单独放一份）', () => {
  assert.deepEqual(readFileSync(path.join(projectDir, 'ui/icon.png')), readFileSync(path.join(projectDir, 'extension/icon-128.png')));
});
