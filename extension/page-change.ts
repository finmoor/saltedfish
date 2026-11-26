import type { JsonObject } from '../src/shared';
import { activityExpression, changesExpression, watchExpression } from './page-functions';

export const ACTION_SETTLE_MS = 300, INPUT_SETTLE_MS = 50;
// 点击后有动静却还读不出变化（只出了遮罩、loading）：请求多半还在路上，多看一会儿，最多 BUSY_WAIT_MS。
// 服务端驱动的页面点“保存”后先出遮罩、请求回来才出“保存成功”，一两秒后又消失（11-26 反馈：300～480ms 就收口，提示接不住）。
const QUIET_MS = 100, IDLE_POLL_MS = 150, MAX_WAIT_MS = 800, BUSY_WAIT_MS = 2000, READ_LIMIT_MS = 1000;
type Point = { x: number; y: number };
interface TabView { url?: string; pendingUrl?: string; title?: string; status?: string }
interface PageChangeDeps {
  evaluate: (tabId: number, expression: string, frame: JsonObject, deadline: number) => Promise<unknown>;
  tab: (tabId: number, frame: JsonObject) => Promise<TabView>;
  sleep: (ms: number) => Promise<unknown>;
}

// 动作结果里的页面变化。业务动作已经发生，这里任何失败都只是少一段信息，不能让动作失败。
export class PageChanges {
  private watching = new Map<number, JsonObject>();
  constructor(private deps: PageChangeDeps) {}
  forget(tabId: number) { this.watching.delete(tabId); }
  // 弹窗或阻塞的页面会让求值一直挂着，有自己的上限，不靠动作的期限。
  private call(tabId: number, expression: string, frame: JsonObject, deadline: number) {
    return Promise.race([this.deps.evaluate(tabId, expression, frame, Math.min(deadline, Date.now() + READ_LIMIT_MS)), this.deps.sleep(READ_LIMIT_MS).then(() => { throw new Error('page read timed out'); })]);
  }
  async start(tabId: number, frame: JsonObject, deadline: number) {
    try { await this.call(tabId, watchExpression(), frame, deadline); this.watching.set(tabId, frame); }
    catch { this.watching.delete(tabId); }
  }
  // 动作失败时不等待，只收掉页面里的观察。
  drop(tabId: number) {
    const frame = this.watching.get(tabId); if (!frame) return;
    this.watching.delete(tabId);
    void this.call(tabId, changesExpression(), frame, Date.now() + READ_LIMIT_MS).catch(() => {});
  }
  // point 是点击落点（主 frame 的视口坐标）：落点附近元素的 class 变化算读得出的变化，也写进结果。
  async read(tabId: number, settleMs: number, deadline: number, point?: Point): Promise<{ pageChange?: JsonObject }> {
    const frame = this.watching.get(tabId); if (!frame) return {};
    this.watching.delete(tabId);
    const started = Date.now(), limit = (ms: number) => Math.min(deadline - 100, started + ms), click = settleMs >= ACTION_SETTLE_MS;
    let changes: JsonObject | null | undefined;
    try {
      await this.deps.sleep(Math.max(0, Math.min(settleMs, limit(MAX_WAIT_MS) - Date.now())));
      for (;;) {
        const activity = await this.call(tabId, activityExpression(point), frame, deadline) as { quiet: number; readable: boolean } | null;
        if (activity === null) break;
        const { quiet, readable } = activity, busy = click && quiet !== -1 && !readable, left = limit(busy ? BUSY_WAIT_MS : MAX_WAIT_MS) - Date.now();
        if (left <= 0) break;
        // 点击后完全没动静：可能在等接口，继续看到上限。输入类动作没有这个问题。
        if (quiet === -1) { if (!click) break; await this.deps.sleep(Math.min(IDLE_POLL_MS, left)); continue; }
        if (quiet >= QUIET_MS && !busy) break;
        await this.deps.sleep(busy ? Math.min(IDLE_POLL_MS, left) : Math.min(QUIET_MS - quiet, left));
      }
      changes = await this.call(tabId, changesExpression(point), frame, deadline) as JsonObject | null;
    } catch { changes = undefined; } // 页面正在跳转，或暂时读不到。
    const tab = await this.deps.tab(tabId, frame).catch(() => undefined);
    const loading = tab?.status === 'loading', url = (tab?.pendingUrl || tab?.url)?.slice(0, 200);
    if (changes) return { pageChange: { ...changes, ...(loading ? { loading: true, ...(url ? { url } : {}) } : {}), ...(changes.changed === false && !loading ? { waitedMs: Date.now() - started } : {}) } };
    // null：这个文档没有在观察，说明已经换了文档。
    if (changes === null) return { pageChange: { changed: true, navigated: true, ...(url ? { url } : {}), ...(tab?.title ? { title: tab.title.slice(0, 80) } : {}), ...(loading ? { loading: true } : {}) } };
    return loading ? { pageChange: { changed: true, loading: true, ...(url ? { url } : {}) } } : {};
  }
}
