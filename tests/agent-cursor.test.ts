import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentCursor, arrowQuad, boxQuad, overlayScale } from '../extension/agent-cursor.js';
import type { JsonObject } from '../src/shared.js';

// 光标只是显示：这里核对它发了哪些 Overlay 命令、坐标怎么换算、失败时不抛也不反复重试。页面看不到这件事由 interaction-cursor.integration.ts 在真实 Chrome 里核对。
const timing = { frameMs: 4, glideMs: 40, followMs: 10, pressMs: 30, boxMs: 40, idleMs: 150, callTimeoutMs: 200 };
const metrics = (device = 1500, css = 1000, zoom = 1) => ({ layoutViewport: { clientWidth: device }, cssLayoutViewport: { clientWidth: css }, cssVisualViewport: { zoom } });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function fake(reply: (method: string) => unknown = method => method === 'Page.getLayoutMetrics' ? metrics() : {}, overrides: Partial<typeof timing> = {}) {
  const calls: { tabId: number; method: string; params: JsonObject; sessionId?: string; at: number }[] = [];
  const send = async (tabId: number, method: string, params: JsonObject = {}, sessionId?: string) => { calls.push({ tabId, method, params, sessionId, at: Date.now() }); const value = reply(method); if (value instanceof Error) throw value; return value as JsonObject; };
  const cursor = new AgentCursor(send, { ...timing, ...overrides }); cursor.setEnabled(true);
  const quads = () => calls.filter(call => call.method === 'Overlay.highlightQuad');
  const tip = (call: { params: JsonObject }) => (call.params.quad as number[]).slice(0, 2);
  return { calls, cursor, quads, tip };
}

test('Overlay 坐标换算：系统缩放乘了两次、网页缩放不算在内（正式版 156 实测值）', () => {
  const close = (actual: number | undefined, expected: number) => assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-3, `${actual} ≠ ${expected}`);
  close(overlayScale(metrics(1500, 1000, 1))?.css, 1 / 1.5);
  close(overlayScale(metrics(1500, 1000, 1))?.dip, 1 / 1.5);
  close(overlayScale(metrics(1875, 1000, 1.25))?.css, 1.25 * 1.25 / 1.875);
  close(overlayScale(metrics(1875, 1000, 1.25))?.dip, 1 / 1.5);
  close(overlayScale(metrics(1200, 1000, .8))?.css, .8 * .8 / 1.2);
  close(overlayScale(metrics(1250, 1000, 1.25))?.css, 1.25);
  close(overlayScale(metrics(1000, 1000, 1))?.css, 1);
  assert.equal(overlayScale({}), undefined);
  assert.equal(overlayScale(metrics(0, 1000)), undefined);
  assert.equal(overlayScale(metrics(1500, 1000, 0)), undefined);
});

test('箭头尖端落在换算后的点上，大小按屏幕 DIP；输入框外框四周留 3 DIP', () => {
  const scale = { css: .5, dip: 2 };
  const arrow = arrowQuad({ x: 100, y: 40 }, scale);
  assert.deepEqual(arrow.slice(0, 2), [50, 20]);
  assert.deepEqual(arrow.slice(6), [50, 20 + 21.5 * 2]);
  assert.deepEqual(boxQuad({ x: 10, y: 20, width: 100, height: 30 }, scale), [-1, 4, 61, 4, 61, 31, -1, 31]);
});

test('关着时什么命令都不发，截图照常执行', async () => {
  const { calls, cursor } = fake(); cursor.setEnabled(false);
  cursor.aim(1, undefined, { x: 10, y: 10 }); cursor.press(1, undefined, { x: 10, y: 10 }); cursor.release(1, undefined); cursor.frame(1, undefined, { x: 0, y: 0, width: 5, height: 5 });
  assert.equal(await cursor.hidden(1, async () => 'shot'), 'shot');
  await sleep(30);
  assert.deepEqual(calls, []);
});

test('第一次出现：先开 DOM、Overlay，读一次比例，箭头直接画在目标上；同一会话只开一次', async () => {
  const { calls, cursor, quads, tip } = fake();
  cursor.aim(7, undefined, { x: 300, y: 150 });
  await sleep(20);
  assert.deepEqual(calls.slice(0, 4).map(call => call.method), ['DOM.enable', 'Overlay.enable', 'Page.getLayoutMetrics', 'Overlay.highlightQuad']);
  assert.deepEqual(tip(quads()[0]!), [200, 100]);
  assert.equal(quads().length, 1, '第一次出现不滑，只画一次');
  cursor.aim(7, undefined, { x: 330, y: 150 }); await sleep(80);
  assert.equal(calls.filter(call => call.method === 'DOM.enable').length, 1);
  assert.equal(calls.filter(call => call.method === 'Overlay.enable').length, 1);
  cursor.forget(7);
});

test('换目标时从当前位置滑过去，最后停在目标上；两次之间至少隔一帧', async () => {
  // 滑得慢一点，整套测试并行跑、计时器被推迟时也能画出好几帧。
  const glide = { frameMs: 10, glideMs: 200 }, { cursor, quads, tip } = fake(undefined, glide);
  cursor.aim(1, undefined, { x: 0, y: 0 }); await sleep(20);
  const before = quads().length;
  cursor.aim(1, undefined, { x: 300, y: 0 }); await sleep(glide.glideMs);
  for (let i = 0; i < 50 && tip(quads().at(-1)!)[0] !== 200; i++) await sleep(20);
  const xs = quads().slice(before).map(call => tip(call)[0]!);
  assert.ok(xs.length >= 3, `滑动应该画了好几帧，实际 ${xs.length}`);
  assert.ok(xs.length <= glide.glideMs / glide.frameMs + 4, `两次之间至少隔一帧，实际画了 ${xs.length} 次`);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i]! >= xs[i - 1]!, '一路往目标走');
  assert.equal(xs.at(-1), 200);
  cursor.forget(1);
});

test('鼠标沿轨迹连续移动时（像真人一样操作）箭头直接跟上，不在每个点上再滑一次', async () => {
  // 滑一次要 200ms：跟着轨迹走时最后一个点之后几帧就该到了，要是又滑了，30ms 时还差得远。Windows 计时器可能一次十几毫秒，判“连续”的间隔放宽到 60ms。
  const { cursor, quads, tip } = fake(undefined, { glideMs: 200, followMs: 60 });
  cursor.aim(1, undefined, { x: 0, y: 0 }); await sleep(20);
  for (const x of [30, 60, 90]) { cursor.input(1, undefined, { type: 'mouseMoved', x, y: 0 }); await sleep(3); }
  await sleep(30);
  assert.equal(tip(quads().at(-1)!)[0], 60, `最后一个点之后几帧就到了，没有再滑 glideMs；实际 ${tip(quads().at(-1)!)[0]}`);
  cursor.forget(1);
});

test('按下换深色，松开后保留一小会儿再恢复；没有动作后自己收起，之后不再发命令', async t => {
  // 检查时间边界用可控时钟：真实的 sleep(10) 可能在 30ms 深色窗口之后才恢复，不能据此判颜色错误。
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10000 });
  const advance = async (ms: number) => { for (let i = 0; i < ms; i++) { t.mock.timers.tick(1); await new Promise<void>(resolve => setImmediate(resolve)); } };
  const { calls, cursor, quads } = fake();
  t.after(() => cursor.forget(1));
  cursor.press(1, undefined, { x: 30, y: 30 }); cursor.release(1, undefined);
  await advance(timing.pressMs - 1);
  assert.equal((quads().at(-1)!.params.color as JsonObject).r, 194, '按下的颜色');
  await advance(1);
  assert.equal((quads().at(-1)!.params.color as JsonObject).r, 255, '松开后恢复');
  await advance(timing.idleMs);
  assert.equal(calls.at(-1)!.method, 'Overlay.hideHighlight');
  const count = calls.length; await advance(60);
  assert.equal(calls.length, count);
});

test('动作不等光标：箭头还在路上时就按下，颜色等箭头到了才变', async () => {
  const { cursor, quads, tip } = fake();
  cursor.aim(1, undefined, { x: 0, y: 0 }); await sleep(15);
  cursor.press(1, undefined, { x: 300, y: 0 }); cursor.release(1, undefined);
  // 等箭头滑到再看颜色。整套单测并发跑时定时器会晚，固定等 glideMs 会偶尔扑空，所以轮询到出现深色为止（最多 1 秒）。
  const dark = () => quads().filter(call => (call.params.color as JsonObject).r === 194);
  for (const until = Date.now() + timing.glideMs + 1000; !dark().length && Date.now() < until;) await sleep(10);
  const pressed = dark();
  assert.ok(pressed.length >= 1);
  for (const call of pressed) assert.equal(tip(call)[0], 200, '深色只出现在目标上');
  cursor.forget(1);
});

test('截图前先藏起来，截完画回去', async () => {
  const { calls, cursor } = fake();
  cursor.aim(1, undefined, { x: 30, y: 30 }); await sleep(15);
  let hiddenBeforeShot = false;
  await cursor.hidden(1, async () => { hiddenBeforeShot = calls.at(-1)!.method === 'Overlay.hideHighlight'; });
  assert.equal(hiddenBeforeShot, true);
  await sleep(15);
  assert.equal(calls.at(-1)!.method, 'Overlay.highlightQuad');
  cursor.forget(1);
});

test('填值时框住目标，过一会儿换回箭头', async () => {
  const { cursor, quads } = fake();
  cursor.aim(1, undefined, { x: 30, y: 30 }); await sleep(15);
  cursor.frame(1, undefined, { x: 10, y: 20, width: 100, height: 30 }); await sleep(10);
  assert.equal((quads().at(-1)!.params.color as JsonObject).a, .1, '外框是浅色填充');
  await sleep(timing.boxMs + 20);
  assert.equal((quads().at(-1)!.params.color as JsonObject).a, .92, '换回箭头');
  cursor.forget(1);
});

test('换到跨进程 iframe 的会话画时，原来会话的光标收起来', async () => {
  const { calls, cursor } = fake();
  cursor.aim(1, undefined, { x: 30, y: 30 }); await sleep(15);
  cursor.aim(1, 'frame-1', { x: 5, y: 5 }); await sleep(20);
  assert.ok(calls.some(call => call.method === 'Overlay.hideHighlight' && call.sessionId === undefined));
  assert.ok(calls.some(call => call.method === 'Overlay.highlightQuad' && call.sessionId === 'frame-1'));
  cursor.forget(1);
});

test('Overlay 不可用时不抛、不反复重试；截图照常执行', async () => {
  const { calls, cursor } = fake(() => new Error('Overlay must be enabled before a tool can be shown'));
  cursor.aim(1, undefined, { x: 30, y: 30 }); cursor.press(1, undefined, { x: 30, y: 30 }); cursor.release(1, undefined);
  await sleep(40);
  const count = calls.length;
  assert.ok(count <= 3, `只试一次，实际发了 ${count} 条`);
  assert.equal(await cursor.hidden(1, async () => 'shot'), 'shot');
  await sleep(40);
  assert.ok(calls.length <= count + 1);
});

test('卡住的 Overlay 命令不会把截图拖住', async () => {
  let block = false;
  const { cursor } = fake(method => block && method === 'Overlay.hideHighlight' ? new Promise(() => {}) : method === 'Page.getLayoutMetrics' ? metrics() : {});
  cursor.aim(1, undefined, { x: 30, y: 30 }); await sleep(15);
  block = true;
  const start = Date.now();
  assert.equal(await cursor.hidden(1, async () => 'shot'), 'shot');
  assert.ok(Date.now() - start < timing.callTimeoutMs + 100);
  cursor.forget(1);
});

test('关掉开关时收起已经画出来的光标', async () => {
  const { calls, cursor } = fake();
  cursor.aim(1, undefined, { x: 30, y: 30 }); await sleep(15);
  cursor.setEnabled(false); await sleep(10);
  assert.equal(calls.at(-1)!.method, 'Overlay.hideHighlight');
  const count = calls.length; await sleep(40);
  assert.equal(calls.length, count);
});
