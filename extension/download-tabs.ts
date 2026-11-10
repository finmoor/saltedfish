// Chrome 的下载记录不带标签页。页面触发的下载在调试连接上有 Page.downloadWillBegin（带 URL），和 chrome.downloads.onCreated 按 URL 配对就知道来源。
// 两边谁先到都行；2 秒内配不上就当来源不明照常报出。被 Chrome “下载多个文件”拦下的那次两边都不会出现，这里看不到。
export interface CreatedDownload { id: number; url?: string; finalUrl?: string; filename?: string; mime?: string; startTime?: string }
const PAIR_MS = 2000, KEEP = 1000;

export class DownloadTabs {
  private begun: { tabId: number; url: string; at: number }[] = [];
  private waiting = new Map<number, { item: CreatedDownload; timer: ReturnType<typeof setTimeout> }>();
  private tabs = new Map<number, number>();
  constructor(private publish: (item: CreatedDownload, tabId?: number) => void, private now = Date.now) {}

  willBegin(tabId: number, url: string) {
    const waiters = [...this.waiting].filter(([, entry]) => entry.item.url === url || entry.item.finalUrl === url);
    // 同 URL 已有多条等着配来源的下载：分不清哪条属于这个标签页，都按来源未知报出。
    if (waiters.length > 1) { for (const [id, entry] of waiters) { clearTimeout(entry.timer); this.waiting.delete(id); this.publish(entry.item); } return; }
    if (waiters.length === 1) { const [id, entry] = waiters[0]!; clearTimeout(entry.timer); this.waiting.delete(id); this.pair(entry.item, tabId); return; }
    this.begun = this.begun.filter(item => this.now() - item.at < PAIR_MS * 5).slice(-50);
    this.begun.push({ tabId, url, at: this.now() });
  }

  created(item: CreatedDownload) {
    const matches = this.begun.filter(entry => (entry.url === item.url || entry.url === item.finalUrl) && this.now() - entry.at < PAIR_MS * 5);
    // 同 URL 有多个来源候选时无法证明是哪个，来源保持未知（把候选都消耗掉，免得下一条被配错）；只有唯一候选才附 tabId。
    if (matches.length > 1 && new Set(matches.map(entry => entry.tabId)).size === 1) { this.begun.splice(this.begun.indexOf(matches[0]!), 1); this.pair(item, matches[0]!.tabId); return; }
    if (matches.length > 1) { this.begun = this.begun.filter(entry => !matches.includes(entry)); this.publish(item); return; }
    if (matches.length === 1) { this.begun.splice(this.begun.indexOf(matches[0]!), 1); this.pair(item, matches[0]!.tabId); return; }
    this.waiting.set(item.id, { item, timer: setTimeout(() => { if (this.waiting.delete(item.id)) this.publish(item); }, PAIR_MS) });
  }

  tabOf(downloadId: number) { return this.tabs.get(downloadId); }

  private pair(item: CreatedDownload, tabId: number) {
    this.tabs.set(item.id, tabId);
    if (this.tabs.size > KEEP) this.tabs.delete(this.tabs.keys().next().value!);
    this.publish(item, tabId);
  }
}
