// 像真人的鼠标和键盘节奏（扩展设置“像真人一样操作”，默认开）。这里只算落点、轨迹和各段时长，不发命令；随机源可以注入，测试用固定序列。
// 页面看到的 CDP 合成事件是什么样的：一个 mouseMoved 就是一个 pointermove，movementX 就是两次之间的位移，
// 按下带 force 才有 pressure。这里的数值是常见手动操作的量级，不是从某个检测方案反推出来的。
export type Random = () => number;
export interface PathPoint { x: number; y: number }
export interface Step extends PathPoint { delayMs: number }

const between = (random: Random, [low, high]: readonly [number, number]) => low + (high - low) * random();
// 近似正态：三个均匀数的和，落在 -1..1，越靠中间越多。
const bell = (random: Random) => (random() + random() + random()) / 1.5 - 1;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export const PACE = {
  frameMs: [12, 22],         // 两次 mouseMoved 之间
  hoverMs: [70, 220],        // 停到目标上到按下
  holdMs: [55, 125],         // 按下到松开
  doubleGapMs: [70, 150],    // 双击：松开到第二次按下
  keyHoldMs: [40, 100],      // 按住一个键
  keyGapMs: [35, 150],       // 松开到下一个键
  keyPauseMs: [250, 650],    // 偶尔停一下
  modifierLeadMs: [25, 70],  // 修饰键先按下多久再按主键，主键松开多久再松修饰键
  wheelGapMs: [30, 90],      // 两格滚轮之间
  dragSettleMs: [60, 150],   // 拖拽按下后、松开前各停一下
} as const satisfies Record<string, readonly [number, number]>;
// Windows 上滚轮一格是 100 CSS 像素（Chrome 每行 100/3，系统默认一格 3 行）。
export const WHEEL_NOTCH = 100;
// 逐键打字每个字符约 0.1–0.25 秒，再长就整段插入：一次 fill 不该打上十几秒。
export const TYPE_LIMIT = 64;

export function pause(kind: keyof typeof PACE, random: Random = Math.random) { return Math.round(between(random, PACE[kind])); }
// 两键之间：多数是正常间隔，约 6% 停顿久一点。
export function keyGap(random: Random = Math.random) { return random() < .06 ? pause('keyPauseMs', random) : pause('keyGapMs', random); }

// 落点：元素可见部分里偏离中心的比例（-1..1，越靠中心越多）。一次动作内固定，页面里每次按同一比例取点，稳定性核对照常有效。
export function aimRatio(random: Random = Math.random): [number, number] {
  return [Math.round(bell(random) * 800) / 1000, Math.round(bell(random) * 800) / 1000];
}

// 对齐设备像素：系统缩放 1.5 时真鼠标的坐标是 1/1.5 的倍数，CDP 原样传给页面的小数坐标不会自己对齐。
export const snap = (value: number, grid: number) => grid > 0 ? Math.round(value * grid) / grid : value;

// 不知道鼠标在哪时（这个标签页还没被 Agent 动过），从视口里偏下的一个随机位置出发。
export function startPoint(viewport: { width: number; height: number }, grid: number, random: Random = Math.random): PathPoint {
  return { x: snap(viewport.width * between(random, [.25, .85]), grid), y: snap(viewport.height * between(random, [.35, .9]), grid) };
}

// 鼠标从 from 移到 to：三次贝塞尔曲线（控制点往连线一侧偏），按最小加加速度曲线走（两头慢中间快），约 16ms 一个点，间隔有抖动。
// 时长随距离按 Fitts 定律的对数增长：几十像素约 150ms，一屏远约 600–800ms。中间点对齐设备像素，最后一点就是 to 本身。
// 给了 count、durationMs（拖拽显式指定段数、时长）就按给的。已经在 to 上时不移动。
export function mousePath(from: PathPoint, to: PathPoint, options: { grid: number; random?: Random; count?: number; durationMs?: number }): Step[] {
  const random = options.random ?? Math.random, dx = to.x - from.x, dy = to.y - from.y, distance = Math.hypot(dx, dy);
  if (distance < .5) return [];
  const duration = options.durationMs ?? clamp(between(random, [80, 130]) + between(random, [85, 125]) * Math.log2(1 + distance / 50), 90, 1100);
  const count = options.count ?? Math.max(2, Math.round(duration / 16));
  const nx = -dy / distance, ny = dx / distance, bend = Math.min(distance * .18, 90), side = bell(random);
  const c1 = { x: from.x + dx * .25 + nx * bend * side, y: from.y + dy * .25 + ny * bend * side };
  const c2 = { x: from.x + dx * .7 + nx * bend * side * .5 * (1 + bell(random) * .5), y: from.y + dy * .7 + ny * bend * side * .5 * (1 + bell(random) * .5) };
  const steps: Step[] = [];
  let last = from, carried = 0;
  for (let index = 1; index <= count; index++) {
    const t = index / count, s = t * t * t * (10 - 15 * t + 6 * t * t), u = 1 - s;
    const delay = duration / count * between(random, [.75, 1.25]) + carried;
    const point = index === count ? { x: to.x, y: to.y } : {
      x: snap(u * u * u * from.x + 3 * u * u * s * c1.x + 3 * u * s * s * c2.x + s * s * s * to.x + bell(random) * .4, options.grid),
      y: snap(u * u * u * from.y + 3 * u * u * s * c1.y + 3 * u * s * s * c2.y + s * s * s * to.y + bell(random) * .4, options.grid),
    };
    // 对齐后没动的点不发：真鼠标不动就没有 pointermove。时间并到下一点。
    if (index < count && point.x === last.x && point.y === last.y) { carried = delay; continue; }
    steps.push({ ...point, delayMs: Math.max(1, Math.round(delay)) }); last = point; carried = 0;
  }
  return steps;
}

// 滚轮：按一格 100 拆开，余数单独一格，先纵向再横向。每个方向最多 WHEEL_MAX_NOTCHES 格，滚动量更大时放大每格（总量不变），
// 非有限数不拆（调用方退回单次滚动，由 CDP 拒绝）；按格数循环，不依赖“剩余量递减”，大浮点数不会死循环。
export const WHEEL_MAX_NOTCHES = 200;
export function wheelSteps(deltaX: number, deltaY: number): { deltaX: number; deltaY: number }[] {
  const split = (total: number) => {
    if (!Number.isFinite(total) || total === 0) return [];
    const sign = Math.sign(total), abs = Math.abs(total), count = Math.min(Math.ceil(abs / WHEEL_NOTCH), WHEEL_MAX_NOTCHES);
    const notch = abs > WHEEL_NOTCH * WHEEL_MAX_NOTCHES ? abs / WHEEL_MAX_NOTCHES : WHEEL_NOTCH, out: number[] = [];
    for (let index = 0; index < count; index++) out.push(sign * (index === count - 1 && notch === WHEEL_NOTCH ? abs - WHEEL_NOTCH * (count - 1) : notch));
    return out;
  };
  return [...split(deltaY).map(value => ({ deltaX: 0, deltaY: value })), ...split(deltaX).map(value => ({ deltaX: value, deltaY: 0 }))];
}
