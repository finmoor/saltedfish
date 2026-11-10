import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { BrowserError, unknownResult, errorInfo, CAPABILITY, NOT_DISPATCHED, type BrowserEvent, type JsonObject, type ProfileInfo, type WireReply } from './shared.js';

export interface Connection { info: ProfileInfo; socket: WebSocket }
interface Pending {
  profileId: string; socket: WebSocket;
  tabId?: number; controller?: { principalId: string; owner: string };
  resolve: (value: unknown) => void; reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

// operationId、settle 由服务写入：弹窗响应成功后，settle 决定触发它的操作落到什么状态；没写就不动，继续受保护。
// byAnswer：导航、关标签页弹出的 beforeunload，答“离开”就是做成了，答“留下”就是没做。
export interface CommandController { principalId: string; owner: string; operationId?: string; settle?: 'succeeded' | 'failed' | 'byAnswer' }

export type OfflineReason = 'debugging-canceled' | 'agent' | 'user' | 'disconnected';
const OFFLINE_RECOVERY: Record<OfflineReason, string> = {
  'debugging-canceled': '有人在 Chrome 顶部“正在调试此浏览器”的提示条里点了“取消”，扩展因此暂停。请用户在这个 Chrome 配置的 SaltedFish 扩展里点“继续连接”；扩展设置里开了自动恢复的，1 分钟后会自己恢复。',
  agent: '被 chrome_pause_profile 暂停了。请用户在这个 Chrome 配置的 SaltedFish 扩展里点“继续连接”。',
  user: '用户在扩展里暂停了这个浏览器。等用户在扩展里点“继续连接”。',
  disconnected: '连接断了：Chrome 关了、扩展被停用或重载、网络或服务重启都会这样。扩展每 30 秒自动重连；Chrome 关着的话要打开这个配置。',
};

export class Broker {
  readonly profiles = new Map<string, Connection>();
  // 浏览器为什么离线：扩展暂停前发来的原因，或者只是断开。只在内存里，服务重启后不知道的就不说。
  private readonly offline = new Map<string, { reason: OfflineReason; since: string }>();
  private pending = new Map<string, Pending>();
  private history: BrowserEvent[] = [];
  private sequence = 0;
  private historyBytes = 0;
  private sizes: number[] = [];
  private eventListeners = new Set<(event: BrowserEvent) => void>();
  private locks = new Map<string, string>();
  private leases = new Map<string, { owner: string; expires: number; agentKey?: string }>();
  private quarantined = new Set<string>();
  private dialogs = new Map<string, { id: string; connection: Connection; controller?: { principalId: string; owner: string } }>();
  private dialogReplies = new Set<string>();
  private controllers = new Map<string, { profileId:string;tabId:number;socket:WebSocket;controller:{principalId:string;owner:string};dialogObserved:boolean }>();

  constructor(private eventLimit = 2000, private eventByteLimit = 8 * 1024 * 1024, private maxTabLeases = 4096) {}

  connect(info: ProfileInfo, socket: WebSocket): void {
    const existing = this.profiles.get(info.id);
    if (existing && existing.socket.readyState === 1) {
      throw new BrowserError('DUPLICATE_PROFILE', '此 profileId 已在线。若复制过 Chrome 配置，请在新配置的扩展设置中重建身份。');
    }
    this.profiles.set(info.id, { info: { ...info, connectedAt: new Date().toISOString() }, socket });
    this.offline.delete(info.id);
    // 重连不清除结果未知的写入暂停，必须检查页面后显式恢复。
    this.addEvent(info.id, undefined, 'bridge.connected', { label: info.label });
  }

  disconnect(socket: WebSocket): void {
    for (const [key, dialog] of this.dialogs) if (dialog.connection.socket === socket) this.dialogs.delete(key);
    for (const [key, controller] of this.controllers) if(controller.socket===socket)this.controllers.delete(key);
    for (const [id, entry] of this.profiles) {
      if (entry.socket !== socket) continue;
      this.profiles.delete(id);
      if (!this.offline.has(id)) this.offline.set(id, { reason: 'disconnected', since: new Date().toISOString() });
      this.addEvent(id, undefined, 'bridge.disconnected', {});
    }
    // 旧连接进入 CLOSING 后可能已被新连接替换，仍须按原 socket 清理它的请求。
    for (const [requestId, request] of this.pending) {
      if (request.socket !== socket) continue;
      clearTimeout(request.timer); this.pending.delete(requestId);
      request.reject(new BrowserError('CONNECTION_LOST', '浏览器连接中断，操作可能已执行。请先检查页面状态，不要自动重复提交。'));
    }
  }

  pruneExpiredLeases(now = Date.now()): void {
    for (const [key, lease] of this.leases) if (lease.expires <= now) this.leases.delete(key);
  }

  stats() {
    this.pruneExpiredLeases();
    return { profiles: this.profiles.size, pendingCommands: this.pending.size, locks: this.locks.size,
      trackedControllers: this.controllers.size, openDialogs: this.dialogs.size, pendingDialogResponses: this.dialogReplies.size,
      leases: this.leases.size, quarantinedTabs: this.quarantined.size, eventCount: this.history.length, eventBytes: this.historyBytes, eventWaiters: this.eventListeners.size };
  }

  leaseSnapshot() {
    this.pruneExpiredLeases();
    return [...this.leases].map(([key, lease]) => {
      const separator=key.lastIndexOf(':');
      return {profileId:key.slice(0,separator),tabId:Number(key.slice(separator+1)),owner:lease.owner,expires:lease.expires,...(lease.agentKey?{agentKey:lease.agentKey}:{})};
    });
  }

  receive(socket: WebSocket, message: WireReply): void {
    const request = this.pending.get(message.id);
    if (!request || request.socket !== socket) return;
    clearTimeout(request.timer); this.pending.delete(message.id);
    const dialogCode=message.error?.code || (message.result as any)?.error?.code;
    // 只有真正触发弹窗的输入会早返回并继续物理收尾。被它阻塞的读取/响应没有后续完成事件。
    if(!['DIALOG_OPEN','DIALOG_MISMATCH'].includes(dialogCode)||!this.controllers.get(message.id)?.dialogObserved)this.controllers.delete(message.id);
    if (message.error) request.reject(new BrowserError(message.error.code, message.error.message, {phase:message.error.phase,outcome:message.error.outcome,...(message.error.detail?{detail:message.error.detail}:{})}));
    else request.resolve(message.result);
  }

  listProfiles() { return [...this.profiles.values()].map(entry => ({ ...entry.info, online: true })); }

  capture(profileId: string): Connection {
    const connection = this.profiles.get(profileId);
    if (!connection || connection.socket.readyState !== 1) throw new BrowserError('PROFILE_OFFLINE', `配置 ${profileId} 未连接。${this.offlineReason(profileId)?.recovery ?? ''}不会改用其他账号。`);
    return connection;
  }

  notePaused(profileId: string, reason: unknown) {
    if (reason === 'debugging-canceled' || reason === 'agent' || reason === 'user') this.offline.set(profileId, { reason, since: new Date().toISOString() });
  }
  /** 离线原因和恢复办法；在线或服务启动后没见过的配置返回 undefined。 */
  offlineReason(profileId: string) {
    const entry = this.profiles.get(profileId)?.socket.readyState === 1 ? undefined : this.offline.get(profileId);
    return entry && { ...entry, recovery: OFFLINE_RECOVERY[entry.reason] };
  }

  addEvent(profileId: string, tabId: number | undefined, method: string, params: JsonObject): void {
    // 旧扩展只在“取消调试”时发 bridge.userPaused；新扩展暂停前都发 bridge.paused。
    if (method === 'bridge.userPaused' || method === 'bridge.paused') this.notePaused(profileId, method === 'bridge.userPaused' ? 'debugging-canceled' : params.reason);
    if(method==='bridge.commandFinished'){
      const controller=this.controllers.get(String(params.commandId));
      if(controller?.profileId===profileId&&controller.socket===this.profiles.get(profileId)?.socket)this.controllers.delete(String(params.commandId));
      return; // 协调生命周期不写入用户事件历史。
    }
    if(method==='group.released'){this.onGroupReleased?.(profileId,String(params.owner),(params.tabIds as number[])||[]);return;}
    if (tabId !== undefined) {
      const key = `${profileId}:${tabId}`, connection = this.profiles.get(profileId);
      if (method === 'Page.javascriptDialogOpening' && typeof params.dialogId === 'string' && connection) {
        const tracked=this.controllers.get(String(params.commandId));
        if(tracked?.socket===connection.socket&&tracked.tabId===tabId)tracked.dialogObserved=true;
        const request = this.pending.get(String(params.commandId)) || this.controllers.get(String(params.commandId));
        const controller = request?.socket === connection.socket && request.tabId === tabId ? request.controller : undefined;
        this.dialogs.set(key, { id: params.dialogId, connection, controller });
      } else if (method === 'Page.javascriptDialogClosed' || method === 'tabs.removed' || method === 'debugger.detached') this.dialogs.delete(key);
    }
    let event: BrowserEvent = { sequence: ++this.sequence, profileId, tabId, method, params, time: new Date().toISOString() };
    let bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > this.eventByteLimit / 2) {
      event = { ...event, params: { omitted: true, originalBytes: bytes, note: '单个事件超过缓存预算；响应体可通过 requestId 单独获取。', ...(typeof params.requestId === 'string' ? { requestId: params.requestId } : {}) } };
      bytes = Buffer.byteLength(JSON.stringify(event));
    }
    this.history.push(event); this.sizes.push(bytes); this.historyBytes += bytes;
    while (this.history.length > this.eventLimit || this.historyBytes > this.eventByteLimit) {
      this.history.shift(); this.historyBytes -= this.sizes.shift() || 0;
    }
    // 先保存再唤醒；等待器同步重读快照时能看见此事件。监听器故障不能破坏桥接接收链。
    for (const listener of this.eventListeners) { try { listener(event); } catch { /* 等待器自行报告错误。 */ } }
  }

  onGroupReleased?: (profileId: string, owner: string, tabIds: number[]) => void;
  subscribeEvents(listener: (event: BrowserEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }

  events(profileId: string, tabId: number | undefined, since: number, method?: string) {
    return {
      events: this.history.filter(event => event.profileId === profileId && (tabId === undefined || event.tabId === tabId)
        && event.sequence > since && (!method || event.method.startsWith(method))),
      latestSequence: this.sequence,
      droppedBefore: this.history[0]?.sequence ?? 0,
      bufferedBytes: this.historyBytes,
    };
  }

  async command(profileId: string, operation: string, args: JsonObject, timeoutMs = 30000, expectedConnection?: Connection, controller?: CommandController): Promise<unknown> {
    const connection = this.profiles.get(profileId);
    // 下面三个拒绝都发生在命令发给扩展之前：页面什么都没收到，必须明确标记，调用方才不会把它记成结果未知并隔离标签页。
    if (expectedConnection && connection !== expectedConnection) throw new BrowserError('CONNECTION_CHANGED', '浏览器在操作期间重新连接；已停止后续步骤，避免使用新会话的同号标签页。', NOT_DISPATCHED);
    if (!connection || connection.socket.readyState !== 1) {
      const offline = this.offlineReason(profileId);
      throw new BrowserError('PROFILE_OFFLINE', `配置 ${profileId} 未连接。${offline ? offline.recovery : '打开该 Chrome 配置中的扩展，确认服务地址与连接状态。'}不会改用其他账号。`, NOT_DISPATCHED);
    }
    const id = randomUUID();
    if(controller && typeof args.tabId==='number' && connection.info.capabilities?.includes(CAPABILITY.dialogControl)) {
      if(this.controllers.size>=4096)throw new BrowserError('CONTROLLER_CAPACITY','未完成的输入协调已达上限，先处理现有弹窗或连接故障。', NOT_DISPATCHED);
      this.controllers.set(id,{profileId,tabId:args.tabId,socket:connection.socket,controller,dialogObserved:false});
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // 超时后扩展可能永远不回包；没观察到弹窗的协调条目没有后续完成事件，留着只会占满 4096 上限。观察到弹窗的保留给迟到的弹窗保护。
        if (!this.controllers.get(id)?.dialogObserved) this.controllers.delete(id);
        reject(new BrowserError('COMMAND_TIMEOUT', `${operation} 超时，结果未知。先读取页面确认，禁止自动重放写操作。`));
      }, timeoutMs + 1000);
      this.pending.set(id, { profileId, socket: connection.socket, resolve, reject, timer, tabId: args.tabId as number | undefined, controller });
      connection.socket.send(JSON.stringify({ type: 'command', id, operation, args, deadline: Date.now() + timeoutMs, timeoutMs }), error => {
        if (!error) return;
        clearTimeout(timer); this.pending.delete(id); this.controllers.delete(id); reject(new BrowserError('CONNECTION_LOST', '发送期间连接失败，操作结果未知。'));
      });
    });
  }

  async respondDialog<T>(profileId: string, tabId: number, owner: string, principalId: string, requestedId: unknown, respond: (id: string, connection: Connection, trigger?: CommandController) => Promise<T>) {
    const key = `${profileId}:${tabId}`, current = this.dialogs.get(key);
    if (!current || current.connection !== this.capture(profileId)) throw new BrowserError('DIALOG_NOT_OPEN', '没有此连接已观察到的弹窗。');
    if (requestedId !== undefined && requestedId !== current.id) throw new BrowserError('DIALOG_MISMATCH', '弹窗 ID 已变化，未发送响应。');
    if (current.controller && current.controller.principalId !== principalId) throw new BrowserError('DIALOG_NOT_AUTHORIZED', '弹窗由另一个客户端的操作触发，不能代为响应。');
    const lease = this.leases.get(key), locked = this.locks.get(key);
    if (!current.controller && ((lease && lease.expires > Date.now() && lease.owner !== owner) || (locked && locked !== owner))) throw new BrowserError('TAB_CLAIMED', '该标签页仍由另一个客户端占用。');
    if (this.dialogReplies.has(key)) throw new BrowserError('DIALOG_BUSY', '此弹窗的响应仍在进行，不能重复提交。');
    this.dialogReplies.add(key);
    try { return await respond(current.id, current.connection, current.controller); }
    finally { this.dialogReplies.delete(key); }
  }

  claim(profileId: string, tabId: number, owner: string, seconds: number, agentKey?: string) {
    this.pruneExpiredLeases();
    const key = `${profileId}:${tabId}`;
    const existing = this.leases.get(key);
    const runningOwner = this.locks.get(key);
    if (runningOwner && runningOwner !== owner) throw new BrowserError('TAB_BUSY', '另一个客户端仍在操作该标签页，不能在操作中抢占。');
    if (existing && existing.expires > Date.now() && existing.owner !== owner) {
      throw new BrowserError('TAB_CLAIMED', '标签页正由另一个客户端使用。请使用另一标签页，或等待该客户端释放。');
    }
    if (!existing && this.leases.size >= this.maxTabLeases) throw new BrowserError('LEASE_CAPACITY', '标签页占用数达到上限；释放不再使用的占用，或调整 maxTabLeases。');
    // 归属由服务端鉴权身份提供，不解析不稳定的 task owner，也不接收 MCP 参数。
    const identity=agentKey??(existing?.owner===owner&&existing.expires>Date.now()?existing.agentKey:undefined);
    const lease = { owner, expires: Date.now() + seconds * 1000,...(identity?{agentKey:identity}:{}) };
    this.leases.set(key, lease);
    return { profileId, tabId, expires: new Date(lease.expires).toISOString() };
  }

  // 当前仍有效的租约持有者（已过期的不算）。
  holder(profileId: string, tabId: number): string | undefined {
    const lease = this.leases.get(`${profileId}:${tabId}`);
    return lease && lease.expires > Date.now() ? lease.owner : undefined;
  }

  // mayTakeOver：调用方有权越过某个持有者的租约时返回 true（本机管理员对远程 Agent，见 service.ts）；默认只有持有者自己能释放。
  release(profileId: string, tabId: number, owner: string, mayTakeOver?: (holder: string) => boolean) {
    const key = `${profileId}:${tabId}`;
    const existing = this.leases.get(key);
    const takenOver = !!existing && existing.owner !== owner && existing.expires > Date.now();
    if (takenOver && !mayTakeOver?.(existing.owner)) throw new BrowserError('TAB_CLAIMED', '只能释放本客户端占用的标签页。');
    this.leases.delete(key);
    return { released: true, ...(takenOver ? { takenOver: true } : {}) };
  }

  // checks.admit：写入的准入检查，排在上面三道互斥检查之后、占用标签页之前执行。它的拒绝（此前的操作仍在执行或结果待核查）不是本次动作的结果，
  // 抛在 try 之外，不会被当成“动作结果未知”而隔离标签页。checks.stillOpen：这个标签页在数据库里是否还有未确认的未知操作；
  // 隔离只是它的内存镜像，记录已被确认（例如管理员确认了无标签页的未知操作）就不再有效，自动撤销。
  async exclusive<T>(profileId: string, tabId: number, owner: string, action: () => Promise<T>, inspection = false, checks: { admit?: () => void; stillOpen?: () => boolean } = {}): Promise<T> {
    const key = `${profileId}:${tabId}`;
    if (!inspection && this.quarantined.has(key)) {
      if (checks.stillOpen && !checks.stillOpen()) this.quarantined.delete(key);
      else throw new BrowserError('RESULT_UNKNOWN', '上一次写操作的结果没有确认，标签页暂停写入。先检查页面，再调用 chrome_recover_tab，不要重复原操作。');
    }
    const lease = this.leases.get(key);
    if (lease && lease.expires > Date.now() && lease.owner !== owner) throw new BrowserError('TAB_CLAIMED', '标签页被另一个客户端占用。');
    if (this.locks.has(key)) throw new BrowserError('TAB_BUSY', '标签页正在执行另一段操作；请等待完成。');
    if (!inspection) checks.admit?.();
    this.locks.set(key, owner);
    try { return await action(); }
    catch (error) {
      if (!inspection && unknownResult(errorInfo(error))) this.quarantined.add(key);
      throw error;
    } finally { this.locks.delete(key); }
  }

  recover(profileId: string, tabId: number, owner?: string, mayTakeOver?: (holder: string) => boolean) {
    const key = `${profileId}:${tabId}`;
    const lease = this.leases.get(key);
    if (owner && lease && lease.owner !== owner && lease.expires > Date.now() && !mayTakeOver?.(lease.owner)) throw new BrowserError('TAB_CLAIMED', '不能替另一个客户端解除标签页保护。');
    if (this.locks.has(key)) throw new BrowserError('TAB_BUSY', '仍有操作正在运行。');
    this.quarantined.delete(key);
    return { recovered: true, note: '仅解除暂停，不重放任何操作。' };
  }

  // 放弃一个已经不会再连接的配置：它名下的隔离和租约不再有意义。正在运行的互斥（locks）不动，它们会随各自的命令结束。
  releaseProfile(profileId: string): void {
    const prefix = `${profileId}:`;
    for (const key of [...this.quarantined]) if (key.startsWith(prefix)) this.quarantined.delete(key);
    for (const key of [...this.leases.keys()]) if (key.startsWith(prefix)) this.leases.delete(key);
  }

  close(): void {
    for (const entry of this.profiles.values()) { this.disconnect(entry.socket); entry.socket.close(); }
    // 也覆盖已经从 profiles 中被替换的旧连接。
    for (const pending of [...this.pending.values()]) this.disconnect(pending.socket);
    this.leases.clear();
    this.eventListeners.clear();
  }
}
