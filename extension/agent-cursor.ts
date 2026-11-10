import type { JsonObject } from '../src/shared';

// Agent 光标：用 CDP Overlay 画在页面上层，不进页面 DOM，页面脚本看不到。
// 只是给用户看的：不派发输入，动作也不等它画完，页面收到的事件和时序与关掉光标时一样。画不出来就不画，不影响动作。
// Overlay 同一时刻只有一个高亮，后画的替换前一个，所以箭头和输入框外框轮流显示。
type Send = (tabId: number, method: string, params?: JsonObject, sessionId?: string) => Promise<JsonObject>;
export interface CursorPoint { x: number; y: number }
export interface CursorBox { x: number; y: number; width: number; height: number }
export interface CursorTiming { frameMs: number; glideMs: number; followMs: number; pressMs: number; boxMs: number; idleMs: number; callTimeoutMs: number }
export interface OverlayScale { css: number; dip: number }
const TIMING: CursorTiming = { frameMs: 16, glideMs: 140, followMs: 40, pressMs: 140, boxMs: 900, idleMs: 2500, callTimeoutMs: 1000 };
const COLOR = { r: 255, g: 112, b: 26, a: 0.92 }, PRESSED = { r: 194, g: 65, b: 0, a: 0.96 }, OUTLINE = { r: 255, g: 255, b: 255, a: 1 };
const BOX = { r: 255, g: 112, b: 26, a: 0.1 }, BOX_LINE = { r: 255, g: 112, b: 26, a: 1 };
// 箭头是尖端在原点的凹四边形，单位是屏幕 DIP：和系统光标差不多大，不随网页缩放变。
const ARROW = [0, 0, 15, 15, 6, 15.6, 0, 21.5], BOX_PAD = 3;

interface LayoutMetrics { layoutViewport?: { clientWidth?: number }; cssLayoutViewport?: { clientWidth?: number }; cssVisualViewport?: { zoom?: number } }
// Chrome 会把 Overlay 坐标乘两次系统缩放比，网页缩放不算在内（正式版 156 实测，系统 1、1.5 倍，网页 80%–150%）。
// css 把网页 CSS 坐标换成 Overlay 坐标，dip 把屏幕 DIP 换过去。设备像素 ÷ CSS 像素 = 系统缩放 × 网页缩放。
export function overlayScale(metrics: LayoutMetrics): OverlayScale | undefined {
  const device = Number(metrics.layoutViewport?.clientWidth), css = Number(metrics.cssLayoutViewport?.clientWidth), zoom = Number(metrics.cssVisualViewport?.zoom ?? 1);
  if (!(device > 0 && css > 0 && zoom > 0)) return undefined;
  const perCss = device / css;
  return { css: zoom * zoom / perCss, dip: zoom / perCss };
}
export const arrowQuad = (point: CursorPoint, scale: OverlayScale) => ARROW.map((value, index) => (index % 2 ? point.y : point.x) * scale.css + value * scale.dip);
export function boxQuad(box: CursorBox, scale: OverlayScale) {
  const pad = BOX_PAD * scale.dip, x0 = box.x * scale.css - pad, y0 = box.y * scale.css - pad, x1 = (box.x + box.width) * scale.css + pad, y1 = (box.y + box.height) * scale.css + pad;
  return [x0, y0, x1, y0, x1, y1, x0, y1];
}

type Frame = { box: CursorBox } | { x: number; y: number; pressed: boolean };
interface Track {
  key: string; tabId: number; sessionId?: string;
  enabled?: Promise<void>; ready?: Promise<OverlayScale | undefined>; scaledAt: number;
  from?: CursorPoint; to?: CursorPoint; start: number; arriveAt: number;
  holding: boolean; pressFrom: number; pressUntil: number; box?: CursorBox; boxUntil: number; hideAt: number;
  drawn?: string; drawnAt: number; timer?: ReturnType<typeof setTimeout>; timerAt: number; running?: Promise<void>; paused: number; broken: boolean;
}
const ease = (k: number) => 1 - (1 - k) ** 3;
const round = (value: number) => Math.round(value * 10) / 10;
function within<T>(work: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('overlay timeout')), ms); })]).finally(() => clearTimeout(timer));
}

export class AgentCursor {
  private shown = false;
  private readonly tracks = new Map<string, Track>();
  private readonly timing: CursorTiming;
  constructor(private readonly send: Send, timing: Partial<CursorTiming> = {}) { this.timing = { ...TIMING, ...timing }; }

  get enabled() { return this.shown; }
  setEnabled(on: boolean) {
    this.shown = on; if (on) return;
    for (const track of [...this.tracks.values()]) { this.drop(track); if (track.drawn !== undefined) void this.call(track, 'Overlay.hideHighlight'); }
  }
  // 鼠标事件照原样传进来：移动、滚轮瞄准，按下、松开换颜色。x、y 为负是归还按钮时移出页面，只当松开。
  input(tabId: number, sessionId: string | undefined, params: JsonObject) {
    const point = { x: Number(params.x), y: Number(params.y) };
    if (!(point.x >= 0 && point.y >= 0)) { if (params.type === 'mouseReleased') this.release(tabId, sessionId); return; }
    if (params.type === 'mouseMoved' || params.type === 'mouseWheel') this.aim(tabId, sessionId, point);
    else if (params.type === 'mousePressed') this.press(tabId, sessionId, point);
    else if (params.type === 'mouseReleased') this.release(tabId, sessionId);
  }
  aim(tabId: number, sessionId: string | undefined, point: CursorPoint) {
    const track = this.active(tabId, sessionId); if (!track) return;
    const now = Date.now();
    if (!track.to || Math.abs(track.to.x - point.x) > .5 || Math.abs(track.to.y - point.y) > .5) {
      // 鼠标沿真实轨迹走时（像真人一样操作，每十几毫秒一个点）直接跟上，不再每个点滑一次；隔得久的新落点才滑过去。
      const following = track.to !== undefined && now - track.start < this.timing.followMs;
      track.from = this.position(track, now); track.to = { x: point.x, y: point.y }; track.start = now; track.arriveAt = track.from ? now + (following ? this.timing.frameMs : this.timing.glideMs) : now;
    }
    // 空闲从停下来之后算：滑动、按下颜色、外框都结束了才开始计时。
    track.hideAt = Math.max(track.hideAt, track.arriveAt + this.timing.idleMs);
    this.wake(track);
  }
  press(tabId: number, sessionId: string | undefined, point: CursorPoint) {
    this.aim(tabId, sessionId, point);
    const track = this.active(tabId, sessionId); if (!track) return;
    // 动作不等光标，按下常比箭头到达早：颜色从到达那一刻开始变。
    track.holding = true; track.pressFrom = Math.max(Date.now(), track.arriveAt); this.wake(track);
  }
  release(tabId: number, sessionId: string | undefined) {
    const track = this.active(tabId, sessionId); if (!track?.holding) return;
    track.holding = false; track.pressUntil = Math.max(Date.now(), track.pressFrom) + this.timing.pressMs;
    track.hideAt = Math.max(track.hideAt, track.pressUntil + this.timing.idleMs); this.wake(track);
  }
  // 填值、选择这类没有鼠标的动作，把目标框一下。
  frame(tabId: number, sessionId: string | undefined, box: CursorBox) {
    const track = this.active(tabId, sessionId); if (!track) return;
    track.box = box; track.boxUntil = Date.now() + this.timing.boxMs;
    track.hideAt = Math.max(track.hideAt, track.boxUntil + this.timing.idleMs); this.wake(track);
  }
  // 截图会把 Overlay 一起截进去：先藏起来，截完再画回去。
  async hidden<T>(tabId: number, run: () => Promise<T>): Promise<T> {
    const tracks = [...this.tracks.values()].filter(track => track.tabId === tabId);
    for (const track of tracks) { track.paused++; if (track.timer !== undefined) { clearTimeout(track.timer); track.timer = undefined; } }
    try {
      await Promise.all(tracks.map(async track => { await track.running; if (track.drawn !== undefined) await this.clear(track); }));
      return await run();
    } finally { for (const track of tracks) { track.paused--; this.wake(track); } }
  }
  forget(tabId: number, sessionId?: string) {
    for (const track of [...this.tracks.values()]) if (track.tabId === tabId && (sessionId === undefined || track.sessionId === sessionId)) this.drop(track);
  }

  private active(tabId: number, sessionId: string | undefined) {
    if (!this.shown) return undefined;
    const key = `${tabId}:${sessionId || ''}`, now = Date.now();
    let track = this.tracks.get(key);
    if (!track) { track = { key, tabId, sessionId, scaledAt: 0, start: 0, arriveAt: 0, holding: false, pressFrom: 0, pressUntil: 0, boxUntil: 0, hideAt: 0, drawnAt: 0, timerAt: 0, paused: 0, broken: false }; this.tracks.set(key, track); }
    // 跨进程 iframe 有自己的 Overlay：换到别的会话画时，原来那个收起来，同一个标签页上只留一个光标。
    for (const other of this.tracks.values()) if (other !== track && other.tabId === tabId && other.hideAt > now) { other.hideAt = now; this.wake(other); }
    track.hideAt = Math.max(track.hideAt, now + this.timing.idleMs); track.broken = false;
    return track;
  }
  private drop(track: Track) { if (track.timer !== undefined) clearTimeout(track.timer); track.timer = undefined; this.tracks.delete(track.key); }
  private position(track: Track, now: number): CursorPoint | undefined {
    if (!track.to) return undefined;
    if (!track.from || now >= track.arriveAt) return track.to;
    const k = ease(Math.min(1, (now - track.start) / Math.max(1, track.arriveAt - track.start)));
    return { x: track.from.x + (track.to.x - track.from.x) * k, y: track.from.y + (track.to.y - track.from.y) * k };
  }
  private desired(track: Track, now: number): Frame | undefined {
    if (now >= track.hideAt) return undefined;
    if (track.box && now < track.boxUntil) return { box: track.box };
    const point = this.position(track, now); if (!point) return undefined;
    return { x: round(point.x), y: round(point.y), pressed: now >= track.pressFrom && (track.holding || now < track.pressUntil) };
  }
  // 定好下一次该画的时间：要画的和已画的不同就画，但两次之间至少隔一帧（滑动时位置时时在变，不限就会连着发命令）；
  // 否则等下一帧滑动、颜色变化、外框结束或收起。已经定了更早的就不动。
  private wake(track: Track) {
    if (track.running || track.paused || track.broken || this.tracks.get(track.key) !== track) return;
    const now = Date.now(), want = this.desired(track, now);
    let next: number | undefined = (want ? JSON.stringify(want) : undefined) !== track.drawn ? Math.max(now, track.drawnAt + this.timing.frameMs) : undefined;
    if (next === undefined) {
      const times = [track.arriveAt > now ? now + this.timing.frameMs : 0, track.pressFrom, track.pressUntil, track.boxUntil, track.hideAt].filter(time => time > now);
      if (times.length) next = Math.min(...times);
    }
    if (next === undefined || track.timer !== undefined && track.timerAt <= next) return;
    if (track.timer !== undefined) clearTimeout(track.timer);
    track.timerAt = next;
    track.timer = setTimeout(() => { track.timer = undefined; track.running = this.tick(track).finally(() => { track.running = undefined; this.wake(track); }); }, Math.max(0, next - now));
  }
  private async tick(track: Track) {
    if (track.paused || this.tracks.get(track.key) !== track) return;
    const want = this.desired(track, Date.now());
    if (!want) { if (track.drawn !== undefined) await this.clear(track); return; }
    const scale = await this.prepare(track);
    if (!scale) { track.broken = true; return; }
    const frame = this.desired(track, Date.now());
    if (!frame || track.paused || this.tracks.get(track.key) !== track) return;
    const params = 'box' in frame ? { quad: boxQuad(frame.box, scale), color: BOX, outlineColor: BOX_LINE } : { quad: arrowQuad(frame, scale), color: frame.pressed ? PRESSED : COLOR, outlineColor: OUTLINE };
    track.drawnAt = Date.now();
    // 画失败多半是页面换了或域被关了，当作已经没了，等下一个动作再试，不在这里反复重试。
    if (await this.call(track, 'Overlay.highlightQuad', params)) track.drawn = JSON.stringify(frame); else { track.drawn = undefined; track.broken = true; }
  }
  // DOM、Overlay 两个域每个会话只开一次（Overlay 要求先开 DOM），比例每秒最多读一次：用户可能改了网页缩放，窗口也可能挪到别的屏幕。
  private prepare(track: Track) {
    const now = Date.now();
    if (track.ready && now - track.scaledAt < 1000) return track.ready;
    track.scaledAt = now;
    track.enabled ??= (async () => { await this.request(track, 'DOM.enable'); await this.request(track, 'Overlay.enable'); })();
    const ready = track.enabled.then(async () => overlayScale(await this.request(track, 'Page.getLayoutMetrics') as LayoutMetrics)).catch(() => { track.enabled = undefined; return undefined; });
    track.ready = ready;
    return ready;
  }
  private request(track: Track, method: string, params: JsonObject = {}) { return within(this.send(track.tabId, method, params, track.sessionId), this.timing.callTimeoutMs); }
  private async call(track: Track, method: string, params: JsonObject = {}) {
    try { await this.request(track, method, params); return true; }
    catch { track.enabled = undefined; track.ready = undefined; return false; }
  }
  private async clear(track: Track) { track.drawn = undefined; await this.call(track, 'Overlay.hideHighlight'); }
}
