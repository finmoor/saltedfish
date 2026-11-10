// Agent 在后台标签页里点出来的新标签页（target=_blank、window.open），Chrome 默认放到前台，用户正在看的标签页就被盖住了（Chrome 154、156 实测）。
// 新标签页刚出生就被激活，同一窗口里 Agent 碰过的某个标签页刚报过 Page.windowOpen，用户当时停在别的标签页上：切回用户原来的标签页，新标签页留在后台。
// 新标签页的 openerTabId 用不上：Chrome 填的是当时的当前标签页（用户那个），不是发起打开的标签页，所以按发起方调试会话里的 Page.windowOpen 认。
// 只有挂着扩展调试器的标签页（Agent 碰过的）才会报 Page.windowOpen。用户自己停在 Agent 的标签页上时不管（那是用户在看它）；
// Agent 要给用户看，用 chrome_focus_tab。新开的是弹出窗口（另一个窗口）时不管。
type TabLike = { id?: number; windowId: number; active: boolean };
type Deps = {
  activate: (tabId: number) => Promise<unknown>;
  get: (tabId: number) => Promise<TabLike | undefined>;
  now?: () => number;
};

// Page.windowOpen、onCreated、onActivated 前后差不了多少；超过这个间隔就不算一回事。
export const POPUP_ACTIVATION_MS = 1500;

type Fresh = { at: number; created: boolean; activated: boolean; previous?: number };

export class BackgroundPopups {
  private current = new Map<number, number>();
  private fresh = new Map<number, Fresh>();
  private opens: { opener: number; at: number }[] = [];
  private readonly now: () => number;
  constructor(private deps: Deps) { this.now = deps.now ?? Date.now; }

  // 后台脚本重启后从各窗口当前的标签页接上。
  seed(tabs: TabLike[]) { for (const tab of tabs) if (tab.active && tab.id !== undefined && !this.current.has(tab.windowId)) this.current.set(tab.windowId, tab.id); }

  // 发起方调试会话里的 Page.windowOpen（链接、window.open、表单提交到新窗口）。
  windowOpen(opener: number) {
    this.prune(); this.opens.push({ opener, at: this.now() });
    return this.settle();
  }

  onCreated(tab: TabLike) {
    if (tab.id === undefined) return;
    this.prune();
    const entry = this.fresh.get(tab.id) ?? { at: this.now(), created: false, activated: false };
    entry.created = true;
    // onActivated 先到时，那时记下的才是用户原来的标签页。
    if (!entry.activated) entry.previous = this.current.get(tab.windowId);
    this.fresh.set(tab.id, entry);
    return this.settle();
  }

  onActivated(info: { tabId: number; windowId: number }) {
    const previous = this.current.get(info.windowId);
    this.current.set(info.windowId, info.tabId);
    this.prune();
    const entry = this.fresh.get(info.tabId);
    if (entry) { entry.activated = true; entry.previous ??= previous; }
    // onCreated 可能还没到：先记下来，过一会儿没等到就清掉（用户切到一个老标签页也走这里）。
    else this.fresh.set(info.tabId, { at: this.now(), created: false, activated: true, previous });
    return this.settle();
  }

  onRemoved(tabId: number, windowId?: number) {
    this.fresh.delete(tabId); this.opens = this.opens.filter(open => open.opener !== tabId);
    if (windowId !== undefined && this.current.get(windowId) === tabId) this.current.delete(windowId);
  }

  private async settle() {
    for (const [tabId, entry] of [...this.fresh]) {
      if (!entry.created || !entry.activated) continue;
      const previous = entry.previous;
      const candidates = this.opens.filter(open => open.opener !== tabId && open.opener !== previous);
      if (previous === undefined || previous === tabId || !candidates.length) continue;
      // 实时再看一遍：新标签页还在前台、和发起方在同一个窗口；用户这期间已经切走的不再动。
      const tab = await this.deps.get(tabId).catch(() => undefined);
      if (this.fresh.get(tabId) !== entry) continue; // 别的事件已经处理过
      if (!tab?.active || this.current.get(tab.windowId) !== tabId) { this.fresh.delete(tabId); continue; }
      for (const open of candidates) {
        const source = await this.deps.get(open.opener).catch(() => undefined);
        const index = this.opens.indexOf(open);
        if (source?.windowId !== tab.windowId || index < 0 || this.fresh.get(tabId) !== entry) continue;
        this.opens.splice(index, 1); this.fresh.delete(tabId);
        await this.deps.activate(previous).catch(() => {});
        break;
      }
    }
  }

  private prune() {
    const cutoff = this.now() - POPUP_ACTIVATION_MS;
    for (const [id, entry] of this.fresh) if (entry.at < cutoff) this.fresh.delete(id);
    this.opens = this.opens.filter(open => open.at >= cutoff);
  }
}
