import test from 'node:test';
import assert from 'node:assert/strict';
import { errorInfo, unknownResult, type JsonObject } from '../src/shared.js';
import { loadExtension, FakeInput } from './extension-harness.js';

// 离线夹具：真实的执行器 + 真实的页面运行时 + 假 Chrome/假 DOM（见 extension-harness.ts）。
// 能证明扩展侧的控制流、派发时机和错误分类；Chrome 自身的事件时序仍需实机验证。
const h = await loadExtension();
const run = (tabId: number, args: JsonObject, deadline = h.deadline()) => h.executor.execute('page.action', { tabId, ...args }, deadline) as Promise<JsonObject>;
async function failure(promise: Promise<unknown>) {
  try { await promise; } catch (error) { return errorInfo(error); }
  assert.fail('预期被拒绝，但操作成功了');
}
const notDispatched = (info: ReturnType<typeof errorInfo>) => { assert.equal(info.phase, 'precondition'); assert.equal(info.outcome, 'not_dispatched'); assert.equal(unknownResult(info), false); };

// ---------- exec:1 派发之后的焦点/可编辑变化不能把已经写对的输入判成失败 ----------
test('fill：页面在 input 事件里把焦点移到下一格（验证码/分段卡号），值已正确写入 → 成功，并如实报告焦点已离开', async () => {
  const { tabId, page } = h.openTab();
  const first = page.input('d1'), second = page.input('d2');
  first.on('input', () => second.focus());
  const result = await run(tabId, { action: 'fill', selector: '#d1', text: '7' });
  assert.equal(result.filled, true); assert.equal(result.verified, true);
  assert.equal(first.value, '7'); assert.equal(page.document.activeElement, second);
  assert.equal(result.focusVerified, false, '焦点已离开原字段，应如实报告而不是判失败');
});

test('fill：提交时字段被禁用或改成只读，值已正确写入 → 成功', async () => {
  for (const [name, change] of [['禁用', (field: FakeInput) => { field.disabled = true; }], ['只读', (field: FakeInput) => { field.readOnly = true; }]] as const) {
    const { tabId, page } = h.openTab();
    const field = page.input('card');
    field.on('input', () => change(field));
    const result = await run(tabId, { action: 'fill', selector: '#card', text: '4242' });
    assert.equal(result.filled, true, name); assert.equal(field.value, '4242', name);
  }
});

test('fill：页面改写了值 → 仍报 EDIT_NOT_APPLIED 且保持 unknown（值核验没有被放松）', async () => {
  const { tabId, page } = h.openTab();
  const field = page.input('code');
  field.on('input', () => { field.value = field.value.toUpperCase(); });
  const info = await failure(run(tabId, { action: 'fill', selector: '#code', text: 'abc' }));
  assert.equal(info.code, 'EDIT_NOT_APPLIED'); assert.equal(info.outcome, 'unknown');
});

test('派发前焦点被页面抢走：fill / type / 清空 都在写入前停止，没有任何文字或按键发出（beta.21 EXEC-01 核心修复保持）', async () => {
  for (const args of [{ action: 'fill', text: 'VALUE' }, { action: 'type', text: 'VALUE' }, { action: 'fill', text: '' }]) {
    const { tabId, page } = h.openTab();
    const source = page.input('source', 'original'), other = page.input('other');
    source.on('focus', () => queueMicrotask(() => other.focus()));
    const info = await failure(run(tabId, { ...args, selector: '#source', autoWait: false }));
    assert.equal(info.code, 'FOCUS_CHANGED', JSON.stringify(args));
    assert.equal(h.commandsFor(tabId, 'Input.insertText').length, 0, '不能向另一个字段写入'); assert.equal(page.keyEvents.length, 0);
    assert.deepEqual([source.value, other.value], ['original', ''], JSON.stringify(args));
  }
});

test('type（整段插入）：写入后页面自行跳格 → 成功并报告 focusVerified:false；焦点留在原处则为 true', async () => {
  const moved = h.openTab(), first = moved.page.input('a'), second = moved.page.input('b');
  first.on('input', () => second.focus());
  const jumped = await run(moved.tabId, { action: 'type', selector: '#a', text: '5' });
  assert.equal(jumped.dispatched, true); assert.equal(first.value, '5'); assert.equal(jumped.focusVerified, false);
  assert.equal(jumped.verification, 'not_checked'); assert.equal(typeof jumped.note, 'string');
  const stayed = h.openTab(), field = stayed.page.input('c');
  const kept = await run(stayed.tabId, { action: 'type', selector: '#c', text: 'xyz' });
  assert.equal(kept.focusVerified, true); assert.equal(field.value, 'xyz'); assert.equal('note' in kept, false);
});

test('type（逐键）：第一个字符后页面跳格 → 下一个字符之前停止，第二个字符不会写进别的字段', async () => {
  const { tabId, page } = h.openTab();
  const first = page.input('a'), second = page.input('b');
  first.on('input', () => second.focus());
  const info = await failure(run(tabId, { action: 'type', selector: '#a', text: 'ab', inputMode: 'keySequence' }));
  assert.equal(info.code, 'FOCUS_CHANGED'); assert.equal(info.outcome, 'unknown');
  assert.deepEqual([first.value, second.value], ['a', '']);
  assert.equal(page.keyEvents.filter(event => event.type === 'rawKeyDown').length, 1, '第二个键没有按下');
  assert.equal(page.keyEvents.filter(event => event.type === 'keyUp').length, 1, '已按下的键必须释放');
});

// ---------- exec:2 + exec:7 修饰键与滚轮 ----------
test('click / hover / scroll 把 modifiers 转发给每一个鼠标事件；不带修饰键时事件体不变', async () => {
  const { tabId, page } = h.openTab();
  await run(tabId, { action: 'click', x: 50, y: 60, modifiers: 8 });
  assert.deepEqual(page.mouseEvents.map(event => [event.type, event.modifiers]), [['mouseMoved', 8], ['mousePressed', 8], ['mouseReleased', 8]]);
  page.mouseEvents.length = 0;
  await run(tabId, { action: 'hover', x: 5, y: 6, modifiers: 2 });
  assert.deepEqual(page.mouseEvents.map(event => [event.type, event.modifiers]), [['mouseMoved', 2]]);
  page.mouseEvents.length = 0;
  await run(tabId, { action: 'scroll', x: 1, y: 2, deltaY: 100, modifiers: 4 });
  assert.deepEqual(page.mouseEvents.map(event => [event.type, event.modifiers]), [['mouseWheel', 4]]);
  page.mouseEvents.length = 0;
  await run(tabId, { action: 'click', x: 7, y: 8 });
  assert.equal(page.mouseEvents.length, 3);
  for (const event of page.mouseEvents) assert.equal(Object.hasOwn(event, 'modifiers'), false, `${event.type} 不应多出 modifiers 字段`);
});

test('元素定位的 Ctrl+点击：悬停、按下、释放都带 modifiers，点在元素中心', async () => {
  const { tabId, page } = h.openTab();
  page.element('go', { left: 100, top: 200, right: 140, bottom: 220 });
  const result = await run(tabId, { action: 'click', selector: '#go', modifiers: 2 });
  assert.equal(result.clicked, true);
  assert.deepEqual(page.mouseEvents.map(event => [event.type, event.x, event.y, event.modifiers]), [['mouseMoved', 120, 210, 2], ['mousePressed', 120, 210, 2], ['mouseReleased', 120, 210, 2]]);
});

test('scroll 的滚动量默认值符合直觉：都没给纵向 600；只给 deltaX 时 deltaY 为 0；只给 deltaY 时 deltaX 为 0', async () => {
  for (const [args, deltaX, deltaY] of [[{}, 0, 600], [{ deltaX: 300 }, 300, 0], [{ deltaY: -40 }, 0, -40], [{ deltaX: 5, deltaY: 6 }, 5, 6], [{ deltaX: 0 }, 0, 0]] as const) {
    const { tabId, page } = h.openTab();
    const result = await run(tabId, { action: 'scroll', x: 20, y: 30, ...args });
    const wheel = page.mouseEvents.at(-1)!;
    assert.deepEqual([wheel.type, wheel.x, wheel.y, wheel.deltaX, wheel.deltaY], ['mouseWheel', 20, 30, deltaX, deltaY], JSON.stringify(args));
    assert.deepEqual(result, { scrolled: true, x: 20, y: 30, deltaX, deltaY }, '返回实际使用的位置和滚动量');
  }
});

test('scroll 带 selector：把滚轮发在该元素的中心而不是视口 (0,0)；禁用的滚动容器也可以滚动', async () => {
  const { tabId, page } = h.openTab();
  const list = page.element('list', { left: 100, top: 100, right: 300, bottom: 500 });
  const result = await run(tabId, { action: 'scroll', selector: '#list', deltaY: 300 });
  const wheel = page.mouseEvents.at(-1)!;
  assert.deepEqual([wheel.type, wheel.x, wheel.y, wheel.deltaX, wheel.deltaY], ['mouseWheel', 200, 300, 0, 300]);
  assert.deepEqual(result, { scrolled: true, x: 200, y: 300, deltaX: 0, deltaY: 300 });
  assert.equal(list.scrolled, 0, '元素完整在视口里，不滚动');
  // 视口外的元素先滚进视口再取坐标（假元素滚动后换到视口里的位置）。
  const far = page.element('far', { left: 100, top: 900, right: 300, bottom: 1000 });
  far.scrollIntoView = () => { far.scrolled++; far.rect = { left: 100, top: 350, right: 300, bottom: 450, width: 200, height: 100 }; };
  await run(tabId, { action: 'scroll', selector: '#far', deltaY: 10 });
  assert.equal(far.scrolled, 1, '视口外的先滚进来');
  assert.equal(page.mouseEvents.at(-1)!.y, 400);
  list.disabled = true;
  await run(tabId, { action: 'scroll', selector: '#list', deltaY: 10, autoWait: false });
  assert.equal(page.mouseEvents.at(-1)!.y, 300);
  // 对照：点击仍然不能点禁用的元素
  const clicked = await failure(run(tabId, { action: 'click', selector: '#list', autoWait: false }));
  assert.equal(clicked.code, 'ELEMENT_DISABLED'); notDispatched(clicked);
});

test('scroll 的目标元素不存在 → 明确未派发，不会退化成在 (0,0) 滚动', async () => {
  const { tabId, page } = h.openTab();
  const info = await failure(run(tabId, { action: 'scroll', selector: '#missing', deltaY: 100, autoWait: false }));
  assert.equal(info.code, 'ELEMENT_NOT_FOUND'); notDispatched(info);
  assert.equal(page.mouseEvents.length, 0);
});

// ---------- exec:4 只把页面类目标登记为子会话 ----------
test('Target.attachedToTarget：dedicated worker 不登记为子会话、不启用 Page/Runtime；iframe 照常登记', async () => {
  const { tabId } = h.openTab();
  h.fire(tabId, 'Target.attachedToTarget', { sessionId: 'S-worker', targetInfo: { targetId: 'T-w', type: 'worker', url: 'https://example.test/w.js' }, waitingForDebugger: false });
  h.fire(tabId, 'Target.attachedToTarget', { sessionId: 'S-frame', targetInfo: { targetId: 'T-f', type: 'iframe', url: 'https://frame.test/' }, waitingForDebugger: false });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(h.sent.filter(c => c.sessionId === 'S-worker').map(c => c.method), [], 'worker 会话上不发送任何命令');
  assert.deepEqual(h.sent.filter(c => c.sessionId === 'S-frame').map(c => c.method).sort(), ['Page.enable', 'Runtime.enable', 'Target.setAutoAttach']);
  const cdp = (sessionId: string) => h.executor.execute('page.cdp', { tabId, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId }, h.deadline());
  await cdp('S-frame');
  const refused = await failure(cdp('S-worker'));
  assert.equal(refused.code, 'UNKNOWN_FRAME'); notDispatched(refused);
});

// ---------- exec:5 派发前的拒绝必须带 not_dispatched ----------
test('TAB_BUSY：同一标签页仍有操作在执行时，新的操作被明确拒绝为未派发', async () => {
  const { tabId, page } = h.openTab();
  let release: (() => void) | undefined, blockOnce = true;
  // 只阻塞第一次点击的第一个鼠标事件，让它停在“执行中”；释放后其余事件照常。
  h.hooks.intercept = command => {
    if (!blockOnce || command.tabId !== tabId || command.method !== 'Input.dispatchMouseEvent') return undefined;
    blockOnce = false; return new Promise(resolve => { release = () => resolve({}); });
  };
  try {
    const first = run(tabId, { action: 'click', x: 1, y: 1 });
    for (let i = 0; i < 200 && !release; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(release, '第一次点击应停在第一个鼠标事件上');
    const info = await failure(run(tabId, { action: 'click', x: 2, y: 2 }));
    assert.equal(info.code, 'TAB_BUSY'); notDispatched(info);
    release!(); await first;
  } finally { h.hooks.intercept = undefined; release?.(); }
  assert.ok(page.mouseEvents.length > 0 && page.mouseEvents.every(event => event.x === 1), '被拒绝的第二次点击没有产生任何鼠标事件');
});

test('CANCELLED（控制在派发前被取消）与 DEADLINE_EXCEEDED（已过截止时间）都是明确的未派发', async () => {
  const { tabId } = h.openTab();
  const cancelled = h.executor.execute('page.evaluate', { tabId, expression: '1' }, h.deadline());
  h.executor.cancelOperations();
  const first = await failure(cancelled);
  assert.equal(first.code, 'CANCELLED'); notDispatched(first);
  const expired = await failure(h.executor.execute('page.evaluate', { tabId, expression: '1' }, Date.now() - 1));
  assert.equal(expired.code, 'DEADLINE_EXCEEDED'); notDispatched(expired);
});

test('TAB_MOVED（排队期间标签页换了窗口）与 NO_VIEWPORT（窗口没有画面区域）是明确的未派发，且没有任何鼠标事件', async () => {
  const moved = h.openTab();
  h.hooks.afterTabGet = (id, call) => { if (id === moved.tabId && call === 1) h.tabs.get(id)!.windowId = 999; };
  try {
    const info = await failure(run(moved.tabId, { action: 'click', x: 1, y: 1 }));
    assert.equal(info.code, 'TAB_MOVED'); notDispatched(info);
  } finally { h.hooks.afterTabGet = undefined; }
  assert.equal(moved.page.mouseEvents.length, 0);
  const hidden = h.openTab(); hidden.page.innerWidth = 0;
  const info = await failure(run(hidden.tabId, { action: 'click', x: 1, y: 1 }, Date.now() + 300));
  assert.equal(info.code, 'NO_VIEWPORT'); notDispatched(info);
  assert.equal(hidden.page.mouseEvents.length, 0);
});

test('页面自发弹出的弹窗挡住后续新命令：新命令是明确的未派发；已打开的弹窗不受影响', async () => {
  const { tabId, page } = h.openTab();
  h.fire(tabId, 'Page.javascriptDialogOpening', { type: 'alert', message: '自发弹窗' });
  const info = await failure(run(tabId, { action: 'click', x: 1, y: 1 }));
  assert.equal(info.code, 'DIALOG_OPEN'); notDispatched(info);
  assert.equal(page.mouseEvents.length, 0);
  h.fire(tabId, 'Page.javascriptDialogClosed', {});
  await run(tabId, { action: 'click', x: 1, y: 1 });
  assert.equal(page.mouseEvents.length, 3);
});

// ---------- 评审 U14/U15 ----------
// 假 DOM 的 value 是实例字段；补一个原型 setter，让 setValue 路径取得到原生 setter。
Object.defineProperty(FakeInput.prototype, 'value', { configurable: true, set(this: FakeInput, v: string) { Object.defineProperty(this, 'value', { value: v, writable: true, configurable: true, enumerable: true }); } });
test('fill setValue 路径：页面在 input 处理器里改写值 → EDIT_NOT_APPLIED 且 unknown；值未被改写时带 verified', async () => {
  const bad = h.openTab(), field = bad.page.input('mask');
  field.on('input', () => { field.value = field.value.slice(0, 2); });
  const info = await failure(run(bad.tabId, { action: 'fill', selector: '#mask', text: 'abcdef', fillMode: 'setValue' }));
  assert.equal(info.code, 'EDIT_NOT_APPLIED'); assert.equal(info.outcome, 'unknown');
  const good = h.openTab(); good.page.input('plain');
  const result = await run(good.tabId, { action: 'fill', selector: '#plain', text: 'abcdef', fillMode: 'setValue' });
  assert.equal(result.filled, true); assert.equal(result.verified, true);
});

test('等待隐藏：元素不存在时带 valueEquals/attribute 的组合条件不能成立，只有纯隐藏条件才成立', async () => {
  const { tabId } = h.openTab();
  const wait = (args: JsonObject) => h.executor.execute('page.wait', { tabId, selector: '#gone', state: 'hidden', ...args }, h.deadline(400)) as Promise<JsonObject>;
  assert.equal((await wait({})).matched, true);
  for (const extra of [{ valueEquals: 'x' }, { fileCount: 1 }, { attribute: { name: 'data-x', equals: '1' } }]) {
    const info = await failure(wait(extra));
    assert.equal(info.code, 'WAIT_TIMEOUT', JSON.stringify(extra));
  }
  // stableMs 也要遵守：纯隐藏条件至少持续这么久才算成立
  const started = Date.now(); const stable = await wait({ stableMs: 150 });
  assert.equal(stable.matched, true); assert.ok(Date.now() - started >= 140, 'stableMs 被绕过');
});
