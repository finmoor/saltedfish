import test from 'node:test';
import assert from 'node:assert/strict';
import { PACE, TYPE_LIMIT, aimRatio, keyGap, mousePath, pause, snap, startPoint, wheelSteps } from '../extension/human-input.js';
import { modifierKeys } from '../extension/keyboard.js';

// 拟人输入只算数：轨迹、落点、时长都在这里核对范围和形状。页面看到的事件序列由 interaction-human.integration.ts 在真实 Chrome 里核对。
function seeded(seed = 1) { let state = seed >>> 0; return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; }; }

test('轨迹：从起点出发、最后一点就是目标，中间点对齐设备像素，越走越近', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const random = seeded(seed), from = { x: 40, y: 500 }, to = { x: 612.4, y: 133.7 };
    const path = mousePath(from, to, { grid: 1.5, random });
    assert.ok(path.length >= 8, `一屏远的移动应有好几个点，实际 ${path.length}`);
    assert.deepEqual({ x: path.at(-1)!.x, y: path.at(-1)!.y }, to);
    for (const step of path.slice(0, -1)) {
      assert.ok(Math.abs(step.x * 1.5 - Math.round(step.x * 1.5)) < 1e-9 && Math.abs(step.y * 1.5 - Math.round(step.y * 1.5)) < 1e-9, `中间点对齐 1/1.5：${step.x},${step.y}`);
    }
    for (let i = 1; i < path.length; i++) assert.ok(path[i]!.x !== path[i - 1]!.x || path[i]!.y !== path[i - 1]!.y, '没有原地不动的点');
    const distance = (point: { x: number; y: number }) => Math.hypot(point.x - to.x, point.y - to.y);
    assert.ok(distance(path[Math.floor(path.length / 2)]!) < distance(from) * .75, '走到一半时已经明显靠近');
    const total = path.reduce((sum, step) => sum + step.delayMs, 0);
    assert.ok(total >= 250 && total <= 1300, `七百像素左右的移动约半秒，实际 ${total}ms`);
    for (const step of path) assert.ok(step.delayMs >= 1 && step.delayMs <= 120, `点之间的间隔 ${step.delayMs}ms`);
  }
});

test('轨迹：两头慢中间快；不是直线；近的移动快、点少', () => {
  const random = seeded(7), from = { x: 0, y: 0 }, to = { x: 600, y: 0 };
  const path = mousePath(from, to, { grid: 1, random, count: 30, durationMs: 600 });
  const moves = path.map((step, i) => Math.hypot(step.x - (i ? path[i - 1]!.x : from.x), step.y - (i ? path[i - 1]!.y : from.y)));
  const middle = moves.slice(10, 20).reduce((a, b) => a + b) / 10, ends = (moves.slice(0, 3).reduce((a, b) => a + b) + moves.slice(-3).reduce((a, b) => a + b)) / 6;
  assert.ok(middle > ends * 3, `中间每步 ${middle.toFixed(1)}，两头 ${ends.toFixed(1)}`);
  let bent = 0;
  for (let seed = 1; seed <= 20; seed++) if (mousePath(from, to, { grid: 1, random: seeded(seed) }).some(step => Math.abs(step.y) >= 2)) bent++;
  assert.ok(bent >= 15, `多数轨迹偏离直线，实际 ${bent}/20`);
  const near = mousePath({ x: 100, y: 100 }, { x: 130, y: 110 }, { grid: 1, random: seeded(3) });
  assert.ok(near.length >= 2 && near.length <= 14, `三十像素的移动点数 ${near.length}`);
  assert.ok(near.reduce((sum, step) => sum + step.delayMs, 0) <= 300);
  assert.deepEqual(mousePath({ x: 5, y: 5 }, { x: 5.2, y: 5 }, { grid: 1 }), [], '已经在目标上就不动');
});

test('给了段数和时长就按给的', () => {
  const path = mousePath({ x: 0, y: 0 }, { x: 100, y: 100 }, { grid: 1, random: seeded(2), count: 12, durationMs: 300 });
  assert.ok(path.length <= 12 && path.length >= 8);
  const total = path.reduce((sum, step) => sum + step.delayMs, 0);
  assert.ok(total >= 200 && total <= 400, `总时长 ${total}`);
});

test('落点比例在 -0.8..0.8，多数靠近中心；起点在视口里偏下', () => {
  const random = seeded(11), ratios = Array.from({ length: 400 }, () => aimRatio(random));
  for (const [x, y] of ratios) assert.ok(Math.abs(x) <= .8 && Math.abs(y) <= .8);
  assert.ok(ratios.filter(([x, y]) => Math.abs(x) < .4 && Math.abs(y) < .4).length > 250, '多数靠中心');
  assert.ok(ratios.filter(([x]) => Math.abs(x) > .05).length > 300, '多数不在正中心');
  for (let i = 0; i < 50; i++) {
    const point = startPoint({ width: 1000, height: 600 }, 1.25, random);
    assert.ok(point.x >= 250 && point.x <= 850 && point.y >= 210 && point.y <= 540);
    assert.ok(Math.abs(point.x * 1.25 - Math.round(point.x * 1.25)) < 1e-9);
  }
  assert.equal(snap(10.4, 1), 10);
  assert.equal(snap(10.4, 1.5), 32 / 3 - 0, '10.4×1.5=15.6 → 16 → 10.667');
});

test('各段时长都在 PACE 的范围里，键间偶尔停顿久一点', () => {
  const random = seeded(5);
  for (const kind of Object.keys(PACE) as (keyof typeof PACE)[]) {
    for (let i = 0; i < 100; i++) { const value = pause(kind, random); assert.ok(value >= PACE[kind][0] && value <= PACE[kind][1], `${kind} ${value}`); }
  }
  const gaps = Array.from({ length: 2000 }, () => keyGap(random));
  const long = gaps.filter(gap => gap >= PACE.keyPauseMs[0]).length;
  assert.ok(long > 40 && long < 250, `长停顿 ${long}/2000`);
  assert.ok(TYPE_LIMIT >= 32 && TYPE_LIMIT <= 128);
});

test('滚轮按一格 100 拆开，余数单独一格，方向保持', () => {
  assert.deepEqual(wheelSteps(0, 600).map(step => step.deltaY), [100, 100, 100, 100, 100, 100]);
  assert.deepEqual(wheelSteps(0, -250), [{ deltaX: 0, deltaY: -100 }, { deltaX: 0, deltaY: -100 }, { deltaX: 0, deltaY: -50 }]);
  assert.deepEqual(wheelSteps(150, 0), [{ deltaX: 100, deltaY: 0 }, { deltaX: 50, deltaY: 0 }]);
  assert.deepEqual(wheelSteps(0, 0), []);
});

test('组合键：修饰键按 Ctrl、Alt、Shift、Meta 的顺序按下，按到哪个就带上已按住的修饰位；主键本身是修饰键时不重复', () => {
  assert.deepEqual(modifierKeys(0), []);
  assert.deepEqual(modifierKeys(8).map(key => [key.key, key.code, key.windowsVirtualKeyCode, key.modifiers, key.location]), [['Shift', 'ShiftLeft', 16, 8, 1]]);
  assert.deepEqual(modifierKeys(2 | 8).map(key => [key.key, key.modifiers]), [['Control', 2], ['Shift', 10]]);
  assert.deepEqual(modifierKeys(15).map(key => key.key), ['Control', 'Alt', 'Shift', 'Meta']);
  assert.deepEqual(modifierKeys(8, 'Shift'), []);
  assert.deepEqual(modifierKeys(2 | 8, 'Shift').map(key => key.key), ['Control']);
});
