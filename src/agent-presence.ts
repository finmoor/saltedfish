import { z } from 'zod';
import { BrowserError, NOT_DISPATCHED } from './shared.js';
import { allowsProfile, type Principal } from './auth.js';
import type { RemoteAgentSourceValue } from './remote-protocol.js';

export const AGENT_HEARTBEAT_MS = 10000;
export const AGENT_SESSION_TTL_MS = 35000;
const RECENT_MS = 5 * 60 * 1000;
const WORKING_MS = 30000;
const USAGE_WRITE_MS = 60000;
export const AgentSessionInput = z.object({
  sessionId: z.string().uuid(), owner: z.string().min(1).max(200),
  clientInfo: z.object({ name: z.string().min(1).max(100), version: z.string().max(100).optional() }).strict().optional(),
}).strict();
type SessionInput = z.infer<typeof AgentSessionInput>;
interface LocalSession extends SessionInput { principalId: string; touched: number; started: number; used?: number; transport?:'http';source?:RemoteAgentSourceValue;local?:boolean }
interface Recent { principal: Principal; touched: number }
export interface PresenceTab { profileId: string; tabId: number; operation?: string; claimed: boolean; leaseExpiresAt?: string }
export interface AgentSessionView { id: string; client?: string; version?: string; since: string; local: boolean }
export interface AgentUsage { list(): { agentId: string; profileId: string; lastUsedAt: string }[]; record(agentId: string, profileId: string, at: string): void }
export interface LeaseView { profileId: string; tabId: number; owner: string; expires: number; agentKey?: string }
export interface AgentSummary {
  id: string; label: string; location: 'local' | 'remote';
  connectionState: 'connected' | 'recent' | 'disconnected' | 'unavailable';
  connectionEvidence: 'heartbeat' | 'mcp_session' | 'recent_request' | 'configuration';
  sessionCount: number; lastSeenAt?: string; activeOperations: number; readOnly: boolean; advancedTools?: boolean; tabs: PresenceTab[]; sources?:RemoteAgentSourceValue[];
  sessions: AgentSessionView[]; lastUsedAt?: string; working: boolean;
}
export interface RemotePresenceAgent { id: string; label: string; profiles: '*' | string[]; readOnly: boolean; sessionCount: number; lastSeenAt?: string; activeOperations: number; scopeKey: string; sources?:RemoteAgentSourceValue[] }
interface Activity { key: string; owner: string; profileId?: string; tabId?: number; operation: string }
export const agentKey = (principal: Principal) => principal.remoteAgentId ? `remote:${principal.remoteAgentId}` : principal.id;
// stdio 会话是服务在本机拉起的进程，HTTP 会话看连接两端是不是同一台电脑。
const sessionView = (item: LocalSession): AgentSessionView => ({ id: item.sessionId.slice(0, 6), ...(item.clientInfo ? { client: item.clientInfo.name, ...(item.clientInfo.version ? { version: item.clientInfo.version } : {}) } : {}), since: new Date(item.started).toISOString(), local: !item.transport || !!item.local });
// stdio 适配器的 owner 是 mcp:<会话 ID>，服务端从调用的 owner 认出是哪个会话。
export const stdioOwner = (sessionId: string) => `mcp:${sessionId}`;
export const stdioSessionId = (owner: string) => /^mcp:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(owner)?.[1];

/** 只记录连接和协调元数据。调用参数、URL、正文、凭据都不进入此目录。 */
export class AgentPresence {
  private sessions = new Map<string, LocalSession>();
  private recent = new Map<string, Recent>();
  private activities = new Set<Activity>();
  private sourceHistory=new Map<string,RemoteAgentSourceValue[]>();
  private remotes: RemotePresenceAgent[] = [];
  private remoteAvailable = false;
  private used = new Map<string, number>();
  onEnded?: (owner: string) => void;
  constructor(private principal: (id: string) => Principal | undefined, private now = Date.now, private usage?: AgentUsage) {
    for (const row of usage?.list() ?? []) this.used.set(`${row.agentId}\n${row.profileId}`, Date.parse(row.lastUsedAt));
  }
  private prune() {
    for(const[id,sources]of this.sourceHistory){const kept=sources.filter(s=>this.now()-Date.parse(s.observedAt)<24*60*60*1000);if(!this.principal(id)||!kept.length)this.sourceHistory.delete(id);else this.sourceHistory.set(id,kept);}
    for (const [key, item] of this.sessions) if (this.now() - item.touched >= AGENT_SESSION_TTL_MS || !this.principal(item.principalId)) this.sessions.delete(key);
    for (const [key, item] of this.recent) if (this.now() - item.touched >= RECENT_MS || !item.principal.admin && !this.principal(item.principal.id)) this.recent.delete(key);
  }
  heartbeat(principal: Principal, input: SessionInput, metadata?:{transport:'http';source?:RemoteAgentSourceValue;local?:boolean}) {
    this.prune();
    if (principal.id.startsWith('remote:')) throw new BrowserError('AGENT_SESSION_SCOPE', '远程会话由网关登记，不能冒充本地会话。', NOT_DISPATCHED);
    const key = `${principal.id}:${input.sessionId}`, current = this.sessions.get(key);
    if (current && current.owner !== input.owner) throw new BrowserError('AGENT_SESSION_CONFLICT', '此会话已绑定另一条连接。', NOT_DISPATCHED);
    if (!current && (this.sessions.size >= 512 || [...this.sessions.values()].filter(item => item.principalId === principal.id).length >= 16)) throw new BrowserError('AGENT_SESSION_CAPACITY', '连接会话达到上限，请关闭不再使用的客户端。', NOT_DISPATCHED);
    this.sessions.set(key, { ...input, principalId: principal.id, touched: this.now(), started: current?.started ?? this.now(), ...(current?.used ? { used: current.used } : {}), ...metadata });
    return { registered: true, sessionId: input.sessionId, heartbeatMs: AGENT_HEARTBEAT_MS, expiresAt: new Date(this.now() + AGENT_SESSION_TTL_MS).toISOString() };
  }
  /** 调用也算一次心跳：stdio 适配器每 10 秒才登记一次，服务刚重启时调用会先到，没登记的会话开的标签页进不了组，紧接着的写又被组挡住。已登记的只续期，客户端信息不动。 */
  touch(principal: Principal, input: Pick<SessionInput, 'sessionId' | 'owner'>) {
    const clientInfo = this.sessions.get(`${principal.id}:${input.sessionId}`)?.clientInfo;
    return this.heartbeat(principal, { ...input, ...(clientInfo ? { clientInfo } : {}) });
  }
  remove(principal: Principal, input: Pick<SessionInput, 'sessionId' | 'owner'>) {
    const key = `${principal.id}:${input.sessionId}`, current = this.sessions.get(key);
    if (current && current.owner !== input.owner) throw new BrowserError('AGENT_SESSION_CONFLICT', '只能结束自己登记的连接。', NOT_DISPATCHED);
    if(current?.source&&this.principal(principal.id))this.sourceHistory.set(principal.id,[{...current.source,connected:false},...(this.sourceHistory.get(principal.id)||[]).filter(s=>s.id!==current.source!.id)].slice(0,8));
    this.sessions.delete(key);
    // 只有客户端明确结束才立刻通知；心跳超时的会话由对账判断，电脑睡眠不算结束。
    if (current) this.onEnded?.(current.owner);
    return { removed: !!current };
  }
  remoteSnapshot(agents: RemotePresenceAgent[]) { this.remotes = agents; this.remoteAvailable = true; }
  remoteDisconnected(clear = false) { this.remoteAvailable = false; if (clear) this.remotes = []; }
  // 碰了标签页才算用过：chrome_profiles、chrome_tabs 这类查询不算，客户端启动时的探测也不算。
  private noteUse(key: string, owner: string, profileId: string) {
    const id = `${key}\n${profileId}`, last = this.used.get(id) ?? 0, now = this.now();
    this.used.set(id, now);
    for (const item of this.sessions.values()) if (item.owner === owner) item.used = now;
    // 只为显示用，一分钟写一次，不给每次点击加一次 SQLite 写入；写失败也只是少一条时间。
    if (now - last >= USAGE_WRITE_MS) try { this.usage?.record(key, profileId, new Date(now).toISOString()); } catch { /* 不影响操作。 */ }
  }
  private lastUsed(key: string, profileId?: string) {
    if (profileId) return this.used.get(`${key}\n${profileId}`);
    return Math.max(0, ...[...this.used].filter(([id]) => id.startsWith(`${key}\n`)).map(([, at]) => at)) || undefined;
  }
  isSession(principal: Principal, owner: string) { this.prune(); return [...this.sessions.values()].some(item => item.principalId === principal.id && item.owner === owner); }
  liveOwners() { this.prune(); return new Set([...this.sessions.values()].map(item => item.owner)); }
  ownerView(owner: string) {
    this.prune();
    const session = [...this.sessions.values()].find(item => item.owner === owner), operations = new Map<number, string>();
    for (const activity of this.activities) if (activity.owner === owner && activity.tabId !== undefined) operations.set(activity.tabId, activity.operation);
    return { session: session && sessionView(session), usedAt: session?.used ? new Date(session.used).toISOString() : undefined, working: operations.size > 0 || !!session?.used && this.now() - session.used < WORKING_MS, operations };
  }
  observe(principal: Principal, owner: string, operation: string, profileId?: string, tabId?: number) {
    this.prune();
    const key = agentKey(principal);
    if (!principal.admin || [...this.sessions.values()].some(item => item.principalId === principal.id)) {
      // 最多 512 个最近主体；与服务并发上限相互独立，旧客户端不能无限积累目录。
      if (!this.recent.has(key) && this.recent.size >= 512) this.recent.delete(this.recent.keys().next().value!);
      this.recent.set(key, { principal, touched: this.now() });
      if (profileId && (tabId !== undefined || operation === 'chrome_new_tab')) this.noteUse(key, owner, profileId);
    }
    const item: Activity = { key, owner, operation, profileId, tabId };
    this.activities.add(item);
    return () => { this.activities.delete(item); };
  }
  snapshot(clients: { id: unknown; label: unknown; profiles: '*' | string[]; readOnly: boolean; advancedTools?: boolean; revoked: boolean }[], leases: LeaseView[], profileId?: string): AgentSummary[] {
    this.prune();
    const agents: { principal: Principal; summary: AgentSummary; ownerPrefix: string }[] = [];
    const locals = clients.filter(item => !item.revoked).map(item => ({ id: String(item.id), label: String(item.label), profiles: item.profiles, readOnly: item.readOnly, advancedTools: item.advancedTools, admin: false }));
    if ([...this.sessions.values()].some(item => item.principalId === 'admin')) locals.push({ id:'admin',label:'本机管理连接',profiles:'*',readOnly:false,advancedTools:false,admin:true });
    for (const principal of locals) {
      if (profileId && !allowsProfile(principal, profileId)) continue;
      const sessions = [...this.sessions.values()].filter(item => item.principalId === principal.id), recent = this.recent.get(principal.id);
      const touched = Math.max(0, ...sessions.map(item => item.touched), recent?.touched ?? 0);
      agents.push({ principal, ownerPrefix: principal.id, summary: { id:principal.id,label:principal.label,location:'local',connectionState:sessions.length?'connected':recent?'recent':'disconnected',connectionEvidence:sessions.length?'heartbeat':recent?'recent_request':'configuration',sessionCount:sessions.length,...(touched?{lastSeenAt:new Date(touched).toISOString()}:{}),activeOperations:0,readOnly:principal.readOnly,advancedTools:principal.advancedTools===true,tabs:[],sessions:sessions.map(sessionView),working:false } });
      const item=agents[agents.length-1]!.summary;
      if(sessions.length&&sessions.every(s=>s.transport==='http'))item.connectionEvidence='mcp_session';
      const history=(this.sourceHistory.get(principal.id)||[]).filter(s=>this.now()-Date.parse(s.observedAt)<24*60*60*1000);
      const sources=[...sessions.flatMap(s=>s.source?[s.source]:[]),...history].slice(0,8);
      if(sources.length)item.sources=sources.map(source=>({...source,reportedAddresses:[...source.reportedAddresses]}));
    }
    for (const remote of this.remotes) {
      const principal: Principal = { id:`remote:${remote.id}`,label:remote.label,profiles:remote.profiles,readOnly:remote.readOnly,admin:false };
      if (profileId && !allowsProfile(principal, profileId)) continue;
      agents.push({ principal,ownerPrefix:remote.scopeKey,summary:{ id:principal.id,label:remote.label,location:'remote',connectionState:!this.remoteAvailable?'unavailable':remote.sessionCount?'connected':'disconnected',connectionEvidence:remote.sessionCount?'mcp_session':'configuration',sessionCount:this.remoteAvailable?remote.sessionCount:0,...(remote.lastSeenAt?{lastSeenAt:remote.lastSeenAt}:{}),activeOperations:0,readOnly:remote.readOnly,tabs:[],sessions:[],working:false,sources:(remote.sources||[]).map(source=>({...source,reportedAddresses:[...source.reportedAddresses],connected:this.remoteAvailable&&source.connected})) } });
    }
    for (const item of agents) {
      const tabs = new Map<string, PresenceTab>();
      const visible = (id: string) => (!profileId || id === profileId) && allowsProfile(item.principal,id);
      for (const activity of this.activities) if (activity.key === item.summary.id && (activity.profileId ? visible(activity.profileId) : !profileId)) {
        item.summary.activeOperations++;
        if (activity.profileId && activity.tabId !== undefined) tabs.set(`${activity.profileId}:${activity.tabId}`,{profileId:activity.profileId,tabId:activity.tabId,operation:activity.operation,claimed:false});
      }
      for (const lease of leases) if (visible(lease.profileId) && (lease.agentKey!==undefined?lease.agentKey===item.summary.id:lease.owner.startsWith(item.ownerPrefix+':')) && lease.expires > this.now()) {
        const key=`${lease.profileId}:${lease.tabId}`, tab=tabs.get(key)??{profileId:lease.profileId,tabId:lease.tabId,claimed:false};
        tabs.set(key,{...tab,claimed:true,leaseExpiresAt:new Date(lease.expires).toISOString()});
      }
      item.summary.tabs = [...tabs.values()].slice(0,100);
      const used = this.lastUsed(item.summary.id, profileId);
      if (used) item.summary.lastUsedAt = new Date(used).toISOString();
      item.summary.working = item.summary.activeOperations > 0 || item.summary.tabs.some(tab => tab.claimed) || !!used && this.now() - used < WORKING_MS;
    }
    return agents.map(item=>item.summary).sort((a,b)=>b.activeOperations-a.activeOperations||a.location.localeCompare(b.location)||a.label.localeCompare(b.label));
  }
  stats() { this.prune(); return { agentSessions:this.sessions.size,agentActivities:this.activities.size }; }
}
