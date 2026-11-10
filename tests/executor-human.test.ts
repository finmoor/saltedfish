import test from 'node:test';
import assert from 'node:assert/strict';
import type { JsonObject } from '../src/shared.js';
import { loadExtension, type Sent } from './extension-harness.js';
import { PACE, TYPE_LIMIT } from '../extension/human-input.js';

// 像真人一样操作（产品默认开）时执行器发了什么：轨迹、落点、停顿和按住、按下的 pressure、键盘全选和逐键打、滚轮分格。
// 只核对扩展发出的命令和间隔；页面那一侧看到的事件由 interaction-human.integration.ts 在真实 Chrome 里核对。
const h = await loadExtension();
h.executor.setHumanInput(true);
const run = (tabId: number, args: JsonObject) => h.executor.execute('page.action', { tabId, ...args }, h.deadline(15000)) as Promise<JsonObject>;
// 计时有几毫秒的误差（计时器、事件循环），下限放宽一点。
const SLACK = 8;
function record(tabId: number) {
  const input: (Sent & { t: number })[] = [];
  h.hooks.intercept = command => { if (command.tabId === tabId && command.method.startsWith('Input.')) input.push({ ...command, t: Date.now() }); return undefined; };
  const mouse = () => input.filter(command => command.method === 'Input.dispatchMouseEvent');
  const keys = () => input.filter(command => command.method === 'Input.dispatchKeyEvent');
  return { input, mouse, keys };
}
test.afterEach(() => { h.hooks.intercept = undefined; });

test('点击：沿轨迹移过去，停一会儿再按下；按下带 force 0.5、按住几十毫秒；落点在元素里，按下、松开在同一点', async () => {
  const { tabId, page } = h.openTab(); page.element('go', { left: 300, top: 200, right: 460, bottom: 250 });
  const { mouse } = record(tabId);
  const result = await run(tabId, { action: 'click', selector: '#go' });
  assert.equal(result.clicked, true);
  const events = mouse(), moves = events.filter(command => command.params.type === 'mouseMoved');
  const press = events.find(command => command.params.type === 'mousePressed')!, release = events.find(command => command.params.type === 'mouseReleased')!;
  assert.ok(moves.length >= 5, `应有一串移动，实际 ${moves.length}`);
  assert.equal(press.params.force, .5); assert.equal(release.params.force, undefined);
  assert.ok(press.t - moves.at(-1)!.t >= PACE.hoverMs[0] - SLACK, `停到按下 ${press.t - moves.at(-1)!.t}ms`);
  assert.ok(release.t - press.t >= PACE.holdMs[0] - SLACK, `按住 ${release.t - press.t}ms`);
  const last = moves.at(-1)!.params;
  assert.deepEqual([press.params.x, press.params.y, release.params.x, release.params.y], [last.x, last.y, last.x, last.y]);
  assert.ok(last.x > 300 && last.x < 460 && last.y > 200 && last.y < 250);
  assert.deepEqual([result.x, result.y], [last.x, last.y]);
  // 第二次点同一个元素：从上次的位置出发，不再从视口里另找起点。
  const before = mouse().length;
  await run(tabId, { action: 'click', selector: '#go' });
  const second = mouse().slice(before).filter(command => command.params.type === 'mouseMoved');
  if (second.length) assert.ok(Math.hypot(second[0]!.params.x - last.x, second[0]!.params.y - last.y) < 60, '第二次从上次的落点附近出发');
});

test('落点：多次点击不总在中心', async () => {
  const xs = new Set<number>();
  for (let i = 0; i < 6; i++) {
    const { tabId, page } = h.openTab(); page.element('go', { left: 100, top: 100, right: 300, bottom: 160 });
    xs.add(Number((await run(tabId, { action: 'click', selector: '#go' })).x));
  }
  assert.ok(xs.size >= 3, `六次点击落在 ${xs.size} 个不同的 x 上`);
});

test('双击：两次按下之间隔几十毫秒，第二次 clickCount 2，都带 force', async () => {
  const { tabId, page } = h.openTab(); page.element('go', { left: 100, top: 100, right: 200, bottom: 140 });
  const { mouse } = record(tabId);
  await run(tabId, { action: 'doubleClick', selector: '#go' });
  const presses = mouse().filter(command => command.params.type === 'mousePressed'), releases = mouse().filter(command => command.params.type === 'mouseReleased');
  assert.deepEqual(presses.map(command => [command.params.clickCount, command.params.force]), [[1, .5], [2, .5]]);
  assert.ok(presses[1]!.t - releases[0]!.t >= PACE.doubleGapMs[0] - SLACK, `两次之间 ${presses[1]!.t - releases[0]!.t}ms`);
});

test('fill：先点进字段，用 Ctrl+A 全选，再逐键打，大写字母前按 Shift；值核验通过', async () => {
  const { tabId, page } = h.openTab(); const field = page.input('name', 'old value');
  const { mouse, keys } = record(tabId);
  const result = await run(tabId, { action: 'fill', selector: '#name', text: 'Ab c' });
  assert.equal(result.filled, true); assert.equal(result.verified, true); assert.equal(field.value, 'Ab c');
  assert.ok(mouse().some(command => command.params.type === 'mousePressed'), '先点进字段');
  const sequence = keys().map(command => `${command.params.type}:${command.params.key}:${command.params.modifiers}`);
  assert.deepEqual(sequence.slice(0, 4), ['rawKeyDown:Control:2', 'rawKeyDown:a:2', 'keyUp:a:2', 'keyUp:Control:0'], 'Ctrl+A');
  assert.deepEqual(sequence.slice(4, 9), ['rawKeyDown:Shift:8', 'rawKeyDown:A:8', 'char:A:8', 'keyUp:A:8', 'keyUp:Shift:0'], '大写 A');
  assert.equal(keys().filter(command => command.params.type === 'char').map(command => command.params.text).join(''), 'Ab c');
  const downs = keys().filter(command => command.params.type === 'rawKeyDown' && !['Control', 'Shift'].includes(command.params.key));
  const ups = keys().filter(command => command.params.type === 'keyUp' && !['Control', 'Shift'].includes(command.params.key));
  for (let i = 1; i < downs.length; i++) assert.ok(downs[i]!.t - ups[i - 1]!.t >= PACE.keyGapMs[0] - SLACK, `键 ${i} 前停了 ${downs[i]!.t - ups[i - 1]!.t}ms`);
  for (let i = 0; i < ups.length; i++) assert.ok(ups[i]!.t - downs[i]!.t >= PACE.keyHoldMs[0] - SLACK, `键 ${i} 按住 ${ups[i]!.t - downs[i]!.t}ms`);
});

test('fill：中文和超过上限的长文本照旧整段插入（先 Ctrl+A），空值按 Backspace', async () => {
  for (const text of ['你好', 'x'.repeat(TYPE_LIMIT + 1)]) {
    const { tabId, page } = h.openTab(); const field = page.input('name', 'old');
    const { input } = record(tabId);
    await run(tabId, { action: 'fill', selector: '#name', text });
    assert.equal(field.value, text);
    assert.deepEqual(input.filter(command => command.method === 'Input.insertText').map(command => command.params.text), [text]);
    assert.equal(input.filter(command => command.params.type === 'char').length, 0);
  }
  const { tabId, page } = h.openTab(); const field = page.input('name', 'old');
  const { keys } = record(tabId);
  await run(tabId, { action: 'fill', selector: '#name', text: '' });
  assert.equal(field.value, '');
  assert.deepEqual(keys().map(command => `${command.params.type}:${command.params.key}`).slice(-2), ['rawKeyDown:Backspace', 'keyUp:Backspace']);
});

test('fill 字段已经有焦点时不再点一下；明确给了 inputMode:insertText 的 type 照旧整段插入', async () => {
  const { tabId, page } = h.openTab(); const field = page.input('name', ''); field.focus();
  const { mouse, input } = record(tabId);
  await run(tabId, { action: 'fill', selector: '#name', text: 'ok' });
  assert.equal(mouse().length, 0); assert.equal(field.value, 'ok');
  assert.equal(input.filter(command => command.method === 'Input.insertText').length, 0);
  const typed = await run(tabId, { action: 'type', selector: '#name', text: 'zz', inputMode: 'insertText' });
  assert.equal(typed.mode, 'insertText'); assert.equal(input.filter(command => command.method === 'Input.insertText').length, 1);
});

test('滚轮：先把鼠标移到滚轮位置，600 拆成 6 格、格间有停顿', async () => {
  const { tabId, page } = h.openTab(); page.element('list', { left: 100, top: 100, right: 400, bottom: 500 });
  const { mouse } = record(tabId);
  const result = await run(tabId, { action: 'scroll', selector: '#list' });
  assert.equal(result.scrolled, true);
  const events = mouse(), wheels = events.filter(command => command.params.type === 'mouseWheel');
  assert.ok(events.findIndex(command => command.params.type === 'mouseMoved') < events.findIndex(command => command.params.type === 'mouseWheel'));
  assert.deepEqual(wheels.map(command => command.params.deltaY), [100, 100, 100, 100, 100, 100]);
  for (let i = 1; i < wheels.length; i++) assert.ok(wheels[i]!.t - wheels[i - 1]!.t >= PACE.wheelGapMs[0] - SLACK);
});

test('press：修饰键先按下、主键松开后再松开；隐含 Shift 的字符也一样', async () => {
  const { tabId, page } = h.openTab(); page.input('name', 'abc');
  const { keys } = record(tabId);
  await run(tabId, { action: 'press', selector: '#name', key: 'z', modifiers: 2 });
  await run(tabId, { action: 'press', selector: '#name', key: '!' });
  assert.deepEqual(keys().map(command => `${command.params.type}:${command.params.key}:${command.params.modifiers}`), [
    'rawKeyDown:Control:2', 'rawKeyDown:z:2', 'keyUp:z:2', 'keyUp:Control:0',
    'rawKeyDown:Shift:8', 'rawKeyDown:!:8', 'char:!:8', 'keyUp:!:8', 'keyUp:Shift:0',
  ]);
});

test('拖拽：先移到起点，按下后停一下，按住时每一步都带 force 和按键，松开在终点', async () => {
  const { tabId, page } = h.openTab(); page.element('from', { left: 100, top: 100, right: 140, bottom: 140 }); page.element('to', { left: 500, top: 300, right: 560, bottom: 360 });
  const { mouse } = record(tabId);
  const result = await run(tabId, { action: 'drag', selector: '#from', to: { selector: '#to' } });
  assert.equal(result.dragged, true);
  const events = mouse(), pressIndex = events.findIndex(command => command.params.type === 'mousePressed'), press = events[pressIndex]!;
  const held = events.slice(pressIndex + 1, -1), release = events.at(-1)!;
  assert.equal(press.params.force, .5);
  assert.ok(held.length >= 8, `拖动 ${held.length} 步`);
  for (const step of held) { assert.equal(step.params.buttons, 1); assert.equal(step.params.force, .5); }
  assert.ok(held[0]!.t - press.t >= PACE.dragSettleMs[0] - SLACK);
  assert.equal(release.params.type, 'mouseReleased');
  assert.ok(release.params.x > 500 && release.params.x < 560 && release.params.y > 300 && release.params.y < 360);
});

test('按下样式让按钮下移两像素（:active 常见写法）不算挪走：照常释放、点击成功', async () => {
  const { tabId, page } = h.openTab(); const target = page.element('go', { left: 300, top: 200, right: 460, bottom: 250 });
  const { mouse } = record(tabId), recording = h.hooks.intercept!;
  h.hooks.intercept = command => {
    recording(command);
    if (command.tabId === tabId && command.method === 'Input.dispatchMouseEvent' && command.params.type === 'mousePressed') target.rect = { left: 300, top: 202, right: 460, bottom: 252, width: 160, height: 50 };
    return undefined;
  };
  await run(tabId, { action: 'click', selector: '#go' });
  const release = mouse().filter(command => command.params.type === 'mouseReleased');
  assert.equal(release.length, 1); assert.ok(release[0]!.params.x > 300 && release[0]!.params.x < 460, '在目标上释放');
});

test('默认拟人点击（不传 holdMs）按住期间目标挪走：释放前复核失败，在目标外释放，不报 clicked', async () => {
  const { tabId, page } = h.openTab(); const target = page.element('go', { left: 300, top: 200, right: 460, bottom: 250 });
  const { mouse } = record(tabId), recording = h.hooks.intercept!;
  h.hooks.intercept = command => {
    recording(command);
    if (command.tabId === tabId && command.method === 'Input.dispatchMouseEvent' && command.params.type === 'mousePressed') target.rect = { left: 600, top: 400, right: 760, bottom: 450, width: 160, height: 50 };
    return undefined;
  };
  await assert.rejects(run(tabId, { action: 'click', selector: '#go' }), (error: unknown) => (error as { code?: string }).code === 'ELEMENT_MOVED');
  const release = mouse().filter(command => command.params.type === 'mouseReleased');
  assert.ok(release.length >= 1 && release.every(command => command.params.x === -1 && command.params.y === -1), '必须在目标外释放，不能在旧坐标点下去');
});
