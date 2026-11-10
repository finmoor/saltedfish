import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHmac } from 'node:crypto';
import { WebSocket } from 'ws';
import type { BrowserService, ResultEnvelope } from './service.js';
import type { Principal } from './auth.js';
import { BrowserError } from './shared.js';
import { VERSION } from './version.js';
import { REMOTE_PROTOCOL, REMOTE_FRAME_BYTES, RemoteCall, RemoteReady, RemoteSettings, RemoteAgents, pairingCredential, remoteUrl, intersectScope, type RemoteSettingsValue,type RemoteOnboardingValue } from './remote-protocol.js';

export class RemoteConnector {
  private settings: RemoteSettingsValue = { enabled: false, url: '', token: '', profiles: [], readOnly: false };
  private socket?: WebSocket;
  private retry?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private handshake?: NodeJS.Timeout;
  private generation = 0;
  private attempts = 0;
  private state = 'disconnected';
  private error?: string;
  private connectedAt?: string;
  private deviceId?: string;
  private onboarding?:RemoteOnboardingValue;
  private lastAgent?: string;
  private lastCallAt?: string;
  private active = 0;
  private principalIds = new Set<string>();
  private changing = false;
  private closed = false;
  constructor(private service: BrowserService) {}
  private get file() { return path.join(this.service.config.dataDir, 'remote.json'); }
  async start() {
    try {
      this.settings = RemoteSettings.parse(JSON.parse(await readFile(this.file, 'utf8')));
      if (this.settings.enabled) { remoteUrl(this.settings.url); pairingCredential(this.settings.token); this.connect(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.state = 'error'; this.error = '远程配置无法加载，请重新保存连接设置。'; } }
  }
  status() { const { token, ...settings } = this.settings; return { ...settings, hasToken: !!token, state: this.state, error: this.error, connectedAt: this.connectedAt, deviceId:this.deviceId,onboarding:this.onboarding, lastAgent: this.lastAgent, lastCallAt: this.lastCallAt, activeCalls: this.active }; }
  async configure(input: unknown) {
    if (this.changing || this.closed) throw new BrowserError('REMOTE_CONFIG_BUSY', '连接设置正在保存或服务正在关闭，请稍后重试。');
    this.changing = true;
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const next = RemoteSettings.parse(input);
      if (!next.token) { if (next.url !== this.settings.url && next.enabled) throw new BrowserError('REMOTE_TOKEN_REQUIRED', '更换服务器时需要重新填写 Token。'); next.token = this.settings.token; }
      if (next.enabled) { remoteUrl(next.url); pairingCredential(next.token); if (Array.isArray(next.profiles) && !next.profiles.length) throw new BrowserError('REMOTE_PROFILES_REQUIRED', '至少选择一个允许远程使用的 Chrome 账号。'); }
      await writeFile(temporary, JSON.stringify(next, null, 2), { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.file);
      this.stopConnection(); this.settings = next; this.attempts = 0; this.error = undefined;
      if (next.enabled) this.connect();
      return this.status();
    } finally { this.changing = false; await rm(temporary, { force: true }).catch(() => {}); }
  }
  private invalidatePrincipals() {
    for (const id of this.principalIds) this.service.state.remotePrincipals.delete(id);
    this.principalIds.clear();
  }
  private stopConnection() {
    this.generation++; clearTimeout(this.retry); clearTimeout(this.handshake); clearInterval(this.heartbeat);
    this.invalidatePrincipals(); this.socket?.terminate(); this.socket = undefined;
    this.state = 'disconnected'; this.connectedAt = undefined;
    this.deviceId=undefined;this.onboarding=undefined;this.service.presence.remoteDisconnected(true);
  }
  private connect() {
    if (this.closed || !this.settings.enabled) return;
    const generation = ++this.generation, instanceId = randomUUID();
    const credential = pairingCredential(this.settings.token);
    this.state = 'connecting';
    const socket = this.socket = new WebSocket(remoteUrl(this.settings.url), { headers: { authorization: `Bearer ${credential.token}` }, ...(credential.ca ? { ca: credential.ca } : {}),
      handshakeTimeout: 10000, followRedirects: false, maxPayload: REMOTE_FRAME_BYTES, perMessageDeflate: false });
    const current = () => this.generation === generation && this.socket === socket && !this.closed;
    let fatal = false, ready = false, alive = true, occupied = false, deviceId = '';
    const seen = new Set<string>();
    const agentPrincipals=new Map<string,{signature:string;principal:Principal}>();
    const effectiveSignature=(agent:{profiles:'*'|string[];readOnly:boolean;authorizationRevision?:string})=>JSON.stringify([intersectScope(this.settings.profiles,agent.profiles),this.settings.readOnly||agent.readOnly,agent.authorizationRevision??'']);
    this.handshake = setTimeout(() => { if (current() && !ready) socket.terminate(); }, 12000);
    socket.on('open', () => { if (current()) socket.send(JSON.stringify({ type: 'hello', protocol: REMOTE_PROTOCOL, version: VERSION, instanceId })); });
    socket.on('pong', () => { alive = true; });
    socket.on('message', raw => {
      if (!current()) return;
      try {
        const message = JSON.parse(raw.toString());
        if (!ready) {
          const response = RemoteReady.parse(message);
          if (response.version !== VERSION) { fatal = true; this.error = '网关与本机版本不同，请升级到同一版本。'; socket.close(1008); return; }
          deviceId = response.deviceId;
          this.deviceId=deviceId;
          this.onboarding=response.onboarding;
          ready = true; clearTimeout(this.handshake); this.state = 'connected'; this.error = undefined; this.attempts = 0; this.connectedAt = new Date().toISOString();
          this.heartbeat = setInterval(() => { if (!current()) return; if (!alive) return socket.terminate(); alive = false; socket.ping(); }, 15000); this.heartbeat.unref(); return;
        }
        if(message.type==='agents') {
          const snapshot=RemoteAgents.parse(message);
          const agents=snapshot.agents.map(agent=>({ ...agent,profiles:intersectScope(this.settings.profiles,agent.profiles),readOnly:this.settings.readOnly||agent.readOnly,scopeKey:this.scopeKey(deviceId,agent.id) }));
          for(const [id,entry] of agentPrincipals) {
            const agent=snapshot.agents.find(item=>item.id===id);
            if(!agent||entry.signature!==effectiveSignature(agent)){this.service.state.remotePrincipals.delete(entry.principal.id);this.principalIds.delete(entry.principal.id);agentPrincipals.delete(id);}
          }
          this.service.presence.remoteSnapshot(agents);return;
        }
        const call = RemoteCall.parse(message);
        // 重复帧不再次执行，满额轮换连接，永不把旧请求转交给新连接。
        if (seen.has(call.id)) { fatal = true; this.error = '收到重复请求，连接已停止；请核查操作记录。'; socket.close(1008); return; }
        if (seen.size >= 100000) { socket.close(1012, 'Rotate connection'); return; }
        seen.add(call.id);
        const send = (result: ResultEnvelope) => {
          if (!current() || socket.readyState !== WebSocket.OPEN) return;
          let wire = JSON.stringify({ type: 'reply', id: call.id, result });
          if (Buffer.byteLength(wire) > REMOTE_FRAME_BYTES || socket.bufferedAmount > REMOTE_FRAME_BYTES) wire = JSON.stringify({ type: 'reply', id: call.id, result: { ok: result.ok, operationId: result.operationId, data: result.data, warnings: [{ code: 'REMOTE_RESULT_TOO_LARGE', message: '操作已结束，结果超过远程传输容量。先检查操作记录，勿重复执行。' }] } });
          if (Buffer.byteLength(wire) > REMOTE_FRAME_BYTES) wire = JSON.stringify({ type: 'reply', id: call.id, result: { ok: false, operationId: result.operationId, error: { code: 'REMOTE_RESULT_TOO_LARGE', message: '操作已结束，但结果过大。先在本机检查结果，禁止自动重试。' } } });
          socket.send(wire, () => {});
        };
        if (Date.now() > call.deadline) { send({ ok: false, error: { code: 'REMOTE_REQUEST_EXPIRED', message: '请求已过期，未执行。请检查两端时钟。' } }); return; }
        if (this.active >= 64) { send({ ok: false, error: { code: 'REMOTE_BUSY', message: '远程并发已满，本次请求未开始。' } }); return; }
        const signature=effectiveSignature(call.agent),previous=agentPrincipals.get(call.agent.id);
        if(previous&&previous.signature!==signature){this.service.state.remotePrincipals.delete(previous.principal.id);this.principalIds.delete(previous.principal.id);agentPrincipals.delete(call.agent.id);}
        let principal = agentPrincipals.get(call.agent.id)?.principal;
        if (!principal) {
          if (this.principalIds.size >= 64) throw new Error('Agent capacity');
          const id = `remote:${instanceId}:${call.agent.id}:${randomUUID()}`;
          const submissionScope = this.scopeKey(deviceId,call.agent.id);
          principal = { id, submissionScope, remoteAgentId: call.agent.id, label: `远程 · ${call.agent.label}`, admin: false, profiles: intersectScope(this.settings.profiles, call.agent.profiles), readOnly: this.settings.readOnly || call.agent.readOnly };
          this.principalIds.add(id); this.service.state.remotePrincipals.set(id, principal);
          agentPrincipals.set(call.agent.id,{signature,principal});
        }
        this.lastAgent = call.agent.label; this.lastCallAt = new Date().toISOString(); this.active++;
        // 租约、标签页互斥使用的 owner 以跨重连稳定的 submissionScope 开头：principal.id 含本次连接的 instanceId，每次自动重连都会变，
        // 用它会让同一个 Agent 在网关会话还在的情况下被自己的租约锁在门外。不同 Agent 的 scope 不同，仍然互斥；principal.id 继续只管授权和旧任务控制。
        void this.service.invoke(call.name, call.args, `${principal.submissionScope ?? principal.id}:${call.owner}`, principal, undefined, call.deadline).then(send, () => send({ ok: false, error: { code: 'REMOTE_EXECUTION_ERROR', message: '本机执行异常，先检查操作记录，不要自动重试。' } })).finally(() => this.active--);
      } catch { fatal = true; this.error = '远程协议校验失败，连接已停止。'; socket.close(1008); }
    });
    socket.on('unexpected-response', (_request, response) => { response.resume(); occupied = response.statusCode === 409; fatal = [401, 403].includes(response.statusCode || 0); this.error = occupied ? '这个 Token 的原连接尚未释放，30 秒后重试；如果另一台电脑仍在使用，请为它生成独立接入。' : fatal ? 'Token 无效或已撤销，请检查服务器配对文件。' : '服务器拒绝连接，请检查地址与网关。'; socket.terminate(); });
    socket.on('error', error => {
      if (!current()) return;
      const code = (error as NodeJS.ErrnoException).code || '';
      if (/CERT|TLS|SELF_SIGNED/.test(code)) { fatal = true; this.error = '服务器证书校验失败。请检查地址和服务器生成的配对 Token，未发送浏览器操作。'; }
      else this.error ||= '暂时无法连接服务器，正在等待重连。';
    });
    socket.on('close', code => {
      if (!current()) return;
      if (code === 1008) { fatal = true; this.error ||= '网关拒绝协议或版本，请检查两端版本一致后重新连接。'; }
      clearTimeout(this.handshake); clearInterval(this.heartbeat); this.invalidatePrincipals(); this.connectedAt = undefined;
      this.service.presence.remoteDisconnected();
      this.state = fatal ? 'error' : 'reconnecting';
      if (!fatal) { const delay = (occupied ? 30000 : Math.min(30000, 1000 * 2 ** Math.min(this.attempts++, 5))) + Math.random() * 300; this.retry = setTimeout(() => this.connect(), delay); this.retry.unref(); }
    });
  }
  private scopeKey(deviceId:string,agentId:string){return 'remote-submission:'+createHmac('sha256',this.service.config.token).update(JSON.stringify([remoteUrl(this.settings.url).origin,deviceId,agentId])).digest('hex');}
  close() { this.closed = true; this.stopConnection(); }
}
