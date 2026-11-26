// 页面自己打开的新标签页（target=_blank 的链接、window.open、提交到新窗口的表单）是哪个标签页打开的：按发起方调试会话里的 Page.windowOpen 认。
// Chrome 给新标签页填的 openerTabId 靠不住：从后台标签页打开时填的是用户当时的当前标签页（background-popups.ts 的实测），之后还可能被 Chrome 清掉
// （11-26 反馈：新标签页先写了 6 次，第 7 次报不属于本会话）。只有挂着扩展调试器的标签页（Agent 碰过的）才报 Page.windowOpen。
// 前后 1.5 秒内、网址对得上、只有一对才算配上；分不清就不认，宁可让 Agent 去 claim_tab，也不把用户自己开的标签页算给它。
export const OPEN_PAIR_MS = 1500;
const MAX_REMEMBERED = 500, BEFORE_MS = 100;
type Open = { opener: number; url: string; at: number };
type Created = { tabId: number; url: string; at: number };

export class OpenedTabs {
  private opens: Open[] = [];
  private created: Created[] = [];
  private openers = new Map<number, { opener: number; at: number; url: string }>();
  constructor(private paired: (tabId: number, opener: number) => void, private now: () => number = Date.now) {}

  windowOpen(opener: number, url: unknown) {
    this.prune(); this.opens.push({ opener, url: typeof url === 'string' ? url : '', at: this.now() });
    this.match();
  }
  onCreated(tab: { id?: number; pendingUrl?: string; url?: string }) {
    if (tab.id === undefined) return;
    this.prune(); this.created.push({ tabId: tab.id, url: tab.pendingUrl || tab.url || '', at: this.now() });
    this.match();
  }
  onRemoved(tabId: number) {
    this.openers.delete(tabId);
    this.created = this.created.filter(item => item.tabId !== tabId);
    this.opens = this.opens.filter(item => item.opener !== tabId);
  }
  openerOf(tabId: number) { return this.openers.get(tabId)?.opener; }
  // opener 从 since 起打开的新标签页：动作结果里的 openedTabs。网址取 Page.windowOpen 里的（新标签页刚建出来时自己的网址还是空的）。
  openedBy(opener: number, since: number) { return [...this.openers].filter(([, entry]) => entry.opener === opener && entry.at >= since).map(([tabId, entry]) => ({ tabId, url: entry.url })); }

  // 实测 Page.windowOpen 比新标签页的 onCreated 早到 10～15ms，新标签页那时网址还是空的（Chrome for Testing 154）：主要靠先后和时间配，
  // 只认 Page.windowOpen 之后（最多早 100ms，防事件到达顺序颠倒）建出来的。用户在这之前开的空白标签页不会被算进来。
  private match() {
    for (const open of [...this.opens]) {
      const near = this.created.filter(item => item.tabId !== open.opener && sameTarget(open.url, item.url) && item.at >= open.at - BEFORE_MS && item.at <= open.at + OPEN_PAIR_MS);
      const after = near.filter(item => item.at >= open.at), before = near.filter(item => item.at < open.at);
      const pick = after.length === 1 ? after[0] : !after.length && before.length === 1 ? before[0] : undefined;
      if (!pick) continue; // 没有：新标签页还没到；多个：分不清
      // 同时另一个标签页也报了 Page.windowOpen，这个新标签页也可能是它打开的：分不清就不认。
      if (this.opens.some(other => other !== open && other.opener !== pick.tabId && sameTarget(other.url, pick.url) && pick.at >= other.at - BEFORE_MS && pick.at <= other.at + OPEN_PAIR_MS)) continue;
      this.opens.splice(this.opens.indexOf(open), 1); this.created.splice(this.created.indexOf(pick), 1);
      this.openers.set(pick.tabId, { opener: open.opener, at: open.at, url: open.url || pick.url });
      if (this.openers.size > MAX_REMEMBERED) this.openers.delete(this.openers.keys().next().value!);
      this.paired(pick.tabId, open.opener);
    }
  }
  private prune() {
    const cutoff = this.now() - OPEN_PAIR_MS;
    this.opens = this.opens.filter(item => item.at >= cutoff);
    this.created = this.created.filter(item => item.at >= cutoff);
  }
}

// 新标签页刚建出来时网址常常还是空白，这种不比；两边都有网址时去掉 # 之后要一样。
function sameTarget(a: string, b: string) {
  const blank = (url: string) => !url || url === 'about:blank';
  return blank(a) || blank(b) || a.split('#')[0] === b.split('#')[0];
}
