import type { Broker } from './broker.js';
import { agentKey, type AgentPresence, type AgentSessionView } from './agent-presence.js';
import type { Principal } from './auth.js';
import { BrowserError, CAPABILITY, NOT_DISPATCHED, type JsonObject } from './shared.js';

const COLORS = ['blue', 'green', 'orange', 'purple', 'cyan', 'pink', 'yellow', 'red', 'grey'];
const COMMAND_MS = 3000;
const RECONCILE_MS = 60000;
/** stdio 会话 owner 形如 mcp:<id>，HTTP 会话形如 <主体>:mcp-http:<id>；任务 owner 以 :task:<id> 结尾，不匹配。 */
const SESSION_OWNER = /(^|:)mcp(-http)?:[^:]+$/;
/** 同一个 Agent 的组颜色固定，用户在标签栏上一眼认得出来。 */
export function groupColor(key: string) {
  let hash = 0;
  for (const letter of key) hash = (hash * 31 + letter.codePointAt(0)!) >>> 0;
  return COLORS[hash % COLORS.length]!;
}
/** Chrome 会保存组标题，所以这里只放 Agent 名字，不放任务内容。 */
export function groupTitle(label: string) { return [...label.trim()].slice(0, 24).join('') || 'Agent'; }

// 扩展 group.join 不进组的原因（extension/tab-groups.ts），加上扩展没回话。
const NOT_GROUPED: Record<string, string> = { pinned: '固定的标签页', other_group: '在用户自己的标签组里', popup: '所在窗口是弹窗', unreachable: '扩展没有响应' };

interface GroupTab { tabId: number; title: string; active: boolean; popup?: boolean }
interface Dissolved { owner: string; tabIds: number[] }
interface Former { owner: string; agentId: string; title: string; endedAt: string; sameOrigin: boolean; claimed: boolean; ungrouped: boolean; pinned: boolean }
interface TabState { missing?: boolean; member?: boolean; takenBack?: boolean; holder?: string; former?: Former }
const clock = (iso: string) => { const at = new Date(iso); return Number.isNaN(at.getTime()) ? iso : `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`; };
interface GroupRecord { groupId: number; windowId: number; owner: string; agentId: string; title: string; startedAt: string; color?: string; tabs: GroupTab[] }
export interface AgentGroupView {
  profileId: string; groupId: number; windowId: number; title: string; color?: string; startedAt: string;
  agentId: string; sessionId: string; online: boolean; working: boolean; session?: AgentSessionView; lastUsedAt?: string;
  tabs: (GroupTab & { operation?: string })[];
}

/** 服务端不存组状态：组的归属记在扩展里，真假以 Chrome 为准，这里只负责通知和对账。任何失败都不影响已经完成的业务动作。 */
export class AgentGroups {
  private absent = new Set<string>();
  private timer: NodeJS.Timeout;
  constructor(private broker: Broker, private presence: AgentPresence) {
    presence.onEnded = owner => { void this.dissolve(owner); };
    broker.onGroupReleased = (profileId, owner, tabIds) => this.releaseTabs(profileId, owner, tabIds);
    this.timer = setInterval(() => { void this.reconcile(); }, RECONCILE_MS);
    this.timer.unref();
  }
  private supported(profileId: string) { return this.broker.profiles.get(profileId)?.info.capabilities?.includes(CAPABILITY.tabGroupsV1) === true; }
  private releaseTabs(profileId: string, owner: string, tabIds: number[]) {
    for (const tabId of tabIds) try { this.broker.release(profileId, tabId, owner); } catch { /* 占用已经归了别人，不动。 */ }
  }
  private async send(profileId: string, operation: string, args: JsonObject) {
    if (!this.supported(profileId)) return undefined;
    try { return await this.broker.command(profileId, operation, args, COMMAND_MS); } catch { return undefined; }
  }
  private async records<T>(profileId: string, operation: string, args: JsonObject) {
    const result = await this.send(profileId, operation, args);
    return Array.isArray(result) ? result as T[] : [];
  }
  /** 只有 MCP 会话有组：任务和普通 RPC 也走 invoke，但它们没有“结束”的时刻，组会一直留着。 */
  private async forSession(principal: Principal, owner: string, profileId: string, operation: string, args: JsonObject) {
    return this.presence.isSession(principal, owner) ? this.send(profileId, operation, args) : undefined;
  }
  /** 会话已有组时新标签页开在组所在窗口；用户切了窗口也不会多出第二个组。 */
  async windowOf(principal: Principal, owner: string, profileId: string) {
    const found = await this.forSession(principal, owner, profileId, 'group.window', { owner }) as { windowId?: number } | undefined;
    return found?.windowId;
  }
  /** 不是 MCP 会话或扩展不支持标签组时没有组，返回 undefined；是会话却没进组的，返回原因。 */
  async join(principal: Principal, owner: string, profileId: string, tabId: number, claimed: boolean): Promise<{ grouped: true; group: { groupId: number; title: string } } | { grouped: false; reason: string } | undefined> {
    if (!this.supported(profileId) || !this.presence.isSession(principal, owner)) return undefined;
    const key = agentKey(principal);
    const result = await this.broker.command(profileId, 'group.join', { tabId, owner, agentId: key, title: groupTitle(principal.label), color: groupColor(key), claimed }, COMMAND_MS).catch(() => undefined) as { grouped?: boolean; groupId?: number; title?: string; reason?: string } | undefined;
    if (!result?.grouped) return { grouped: false, reason: NOT_GROUPED[result?.reason ?? 'unreachable'] ?? String(result?.reason) };
    return { grouped: true, group: { groupId: Number(result.groupId), title: String(result.title) } };
  }
  private async tabState(principal: Principal, owner: string, profileId: string, tabId: number) {
    const state = await this.forSession(principal, owner, profileId, 'group.check', { tabId, owner }) as TabState | undefined;
    // 查不到就放行，让执行层报标签页不存在：这是协调边界，不能因为一次查询失败挡住业务。
    if (!state || state.missing) return undefined;
    if (state.takenBack) throw new BrowserError('TAB_TAKEN_BACK', '用户把这个标签页拖出了标签组，算收回，未执行。不要再操作或接管它；还需要页面就用 chrome_new_tab 开新标签页，或请用户拖回组里。', NOT_DISPATCHED);
    return state;
  }
  /**
   * 写操作只能落在本会话的标签页上：它开的、接管的，或这些页面打开的。占用着的也算，固定的标签页这类不移动的只有占用。
   * 同一个 Agent（同一份客户端凭据）的客户端断线重连后换了会话，原来会话的标签页没被别人占着、还在原来的网站上，就直接接回本会话，返回说明。
   */
  async assertWritable(principal: Principal, owner: string, profileId: string, tabId: number): Promise<string | undefined> {
    const state = await this.tabState(principal, owner, profileId, tabId);
    const lease = this.broker.holder(profileId, tabId);
    if (!state || state.member || lease === owner) return undefined;
    const former = state.former, live = this.presence.liveOwners();
    if (former && !state.holder && !(lease && live.has(lease)) && former.agentId === agentKey(principal) && former.sameOrigin && former.ungrouped && !live.has(former.owner)) {
      const joined = await this.join(principal, owner, profileId, tabId, former.claimed);
      if (joined?.grouped) return `这个标签页原来属于本 Agent 已结束的会话（${clock(former.endedAt)} 结束），没有别人占用，已自动接回本会话的标签组。`;
    }
    const where = former ? (former.agentId === agentKey(principal)
      ? `这个标签页原来属于本 Agent 已结束的会话（${clock(former.endedAt)} 结束）${former.sameOrigin ? '' : '，后来页面换到了别的网站'}，没有自动接回。确认还要用它就 chrome_claim_tab 接管。`
      : `这个标签页原来属于另一个 Agent「${former.title}」的会话（${clock(former.endedAt)} 结束），现在没人占用。确认要用就 chrome_claim_tab 接管。`)
      : state.holder ? '它在另一个会话的标签组里，不能写也不能接管；用 chrome_new_tab 开新标签页。'
      : '写操作只能在本会话的标签组里：用 chrome_new_tab 开新标签页，或先 chrome_claim_tab 接管它。';
    throw new BrowserError('TAB_OUTSIDE_GROUP', `这个标签页不属于本会话，未执行。${where}只读取页面不受限，用 chrome_inspect 或 readOnly 的 chrome_evaluate。`, NOT_DISPATCHED);
  }
  /** 别的会话组里的标签页不能抢。那个会话已经结束、组还没解散的不算。 */
  async assertClaimable(principal: Principal, owner: string, profileId: string, tabId: number) {
    const state = await this.tabState(principal, owner, profileId, tabId);
    if (state?.holder && this.presence.liveOwners().has(state.holder)) throw new BrowserError('TAB_CLAIMED', '这个标签页在另一个会话的标签组里。请使用另一标签页，或等那个会话结束。', NOT_DISPATCHED);
  }
  async leave(principal: Principal, owner: string, profileId: string, tabId: number) { await this.forSession(principal, owner, profileId, 'group.leave', { tabId, owner }); }
  private async dissolve(owner: string) {
    // 没进组的占用（固定的标签页、用户自己组里的）也跟着解除，不用等到期。
    for (const lease of this.broker.leaseSnapshot()) if (lease.owner === owner) this.releaseTabs(lease.profileId, owner, [lease.tabId]);
    await Promise.all([...this.broker.profiles.keys()].map(async profileId => {
      for (const item of await this.records<Dissolved>(profileId, 'group.dissolve', { owner })) this.releaseTabs(profileId, item.owner, item.tabIds);
    }));
  }
  /** 崩溃的客户端不会说再见，浏览器也可能在会话结束时不在线，靠这里补上。连续两轮不在才解散：心跳短暂中断（电脑睡眠）不算结束。 */
  async reconcile() {
    const live = this.presence.liveOwners(), seen = new Set<string>();
    await Promise.all([...this.broker.profiles.keys()].map(async profileId => {
      for (const group of await this.records<GroupRecord>(profileId, 'group.list', {})) if (!live.has(group.owner)) seen.add(group.owner);
    }));
    // 没进组的占用（固定的标签页、用户自己组里的、弹窗）不会出现在 group.list 里，崩溃的会话也要靠租约找出来。只认 MCP 会话的 owner，任务（…:task:<id>）和普通 RPC 不混进来；数量受租约表上限约束。
    for (const lease of this.broker.leaseSnapshot()) if (SESSION_OWNER.test(lease.owner) && !live.has(lease.owner)) seen.add(lease.owner);
    for (const owner of seen) if (this.absent.has(owner)) await this.dissolve(owner);
    this.absent = seen;
  }
  async list(profileId?: string): Promise<AgentGroupView[]> {
    const lists = await Promise.all((profileId ? [profileId] : [...this.broker.profiles.keys()]).map(async id => {
      return (await this.records<GroupRecord>(id, 'group.list', {})).map(({ owner, tabs, ...group }): AgentGroupView => {
        const view = this.presence.ownerView(owner);
        return { ...group, profileId: id, sessionId: (owner.split(':').pop() ?? '').slice(0, 6), online: !!view.session, working: view.working, ...(view.session ? { session: view.session } : {}), ...(view.usedAt ? { lastUsedAt: view.usedAt } : {}),
          tabs: tabs.map(tab => { const operation = view.operations.get(tab.tabId); return operation ? { ...tab, operation } : tab; }) };
      });
    }));
    return lists.flat();
  }
  show(profileId: string, groupId: number) { return this.broker.command(profileId, 'group.show', { groupId }, COMMAND_MS); }
  async release(profileId: string, groupId: number) {
    const ended = await this.broker.command(profileId, 'group.dissolve', { groupId }, COMMAND_MS) as Dissolved[];
    for (const item of ended) this.releaseTabs(profileId, item.owner, item.tabIds);
    return { released: ended.length > 0 };
  }
  close() { clearInterval(this.timer); this.presence.onEnded = undefined; this.broker.onGroupReleased = undefined; }
}
