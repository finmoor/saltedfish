import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import { bridgeProofInput, extensionUpdateProofInput, type BridgeRole } from './shared.js';

export interface Principal {
  id: string; label: string; admin: boolean; readOnly: boolean;
  profiles: '*' | string[];
  // 仅用于持久提交收据；权限和旧任务控制仍使用当前连接的 id。
  submissionScope?: string;
  remoteAgentId?: string;
  // 只决定工具目录列不列任务和流程工具，不是授权。
  advancedTools?: boolean;
}
export const adminPrincipal: Principal = { id: 'admin', label: '本机管理员', admin: true, readOnly: false, profiles: '*' };
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const bridgeToken = (config: Config) => createHmac('sha256', config.token).update('feng-chrome-mcp/extension-bridge/v1').digest('hex');
export function equalToken(a: string, b: string) {
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function allowsProfile(principal: Principal, profileId: string) {
  return principal.profiles === '*' || principal.profiles.includes(profileId);
}

// 扩展桥接握手 v2 的 HMAC 证明；密钥是桥接令牌，线上只传证明，不传令牌。
export const bridgeProof = (token: string, role: BridgeRole, clientNonce: string, serverNonce: string, profileId = '', instanceId = '') =>
  createHmac('sha256', token).update(bridgeProofInput(role, clientNonce, serverNonce, profileId, instanceId)).digest('hex');
export const extensionUpdateProof = (token: string, profileId: string, nonce: string, version: string, sha256: string) =>
  createHmac('sha256', token).update(extensionUpdateProofInput(profileId, nonce, version, sha256)).digest('hex');

export const SESSION_CODE_TTL_MS = 5 * 60 * 1000;
// 手敲用的短登录码，去掉长得像的 0O1IL，约 92 万种。只有最新的一个有效，输错 5 次就作废，猜中的机会约十八万分之一；没跑过 dashboard 时根本没有可猜的码。
const SHORT_CODE_LETTERS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const SHORT_CODE_ATTEMPTS = 5;
const normalizeShortCode = (value: string) => value.normalize('NFKC').replace(/\s/g, '').toUpperCase();
export const isShortCode = (value: string) => /^[2-9A-HJKMNP-Z]{4}$/.test(normalizeShortCode(value));
export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_MAX_MS = 12 * 60 * 60 * 1000;
// 管理页登录：URL 片段里只放一次性登录码，页面用它（或手工粘贴的管理员密钥）换取有期限的会话令牌。
// 长期管理员令牌因此不再进入页面可读的存储。码与会话只存内存且只留哈希，服务重启即全部失效；
// 会话空闲 30 分钟或满 12 小时失效，可单个或全部撤销。会话令牌不能再换取新的码或会话（不能自我续期成长期凭据）。
export class AdminSessions {
  private codes = new Map<string, {expires:number;issuer?:string}>();
  private shortCode:{hash:string;key:string;attempts:number}|undefined;
  private sessions = new Map<string, { created: number; touched: number;issuer?:string }>();
  private issuerValid:((issuer:string)=>boolean)|undefined;
  constructor(private now: () => number = Date.now) {}
  setIssuerValidator(validate:(issuer:string)=>boolean){this.issuerValid=validate;}
  private prune() {
    const now = this.now();
    for (const [key, entry] of this.codes) if (entry.expires <= now || entry.issuer&&!this.issuerValid?.(entry.issuer)) this.codes.delete(key);
    for (const [key, entry] of this.sessions) if (now - entry.touched > SESSION_IDLE_MS || now - entry.created > SESSION_MAX_MS) this.sessions.delete(key);
    if (this.shortCode && !this.codes.has(this.shortCode.key)) this.shortCode = undefined;
  }
  // short 同时发一个短码：它和链接是同一次登录，用掉一个，另一个也失效。
  issueCode(issuer?:string,short=false):{code:string;expiresAt:number;shortCode?:string} {
    this.prune();
    while (this.codes.size >= 16) this.codes.delete(this.codes.keys().next().value!);
    const code = randomBytes(32).toString('hex'), expiresAt = this.now() + SESSION_CODE_TTL_MS;
    const key = tokenHash(code);
    this.codes.set(key, {expires:expiresAt,...(issuer?{issuer}:{})});
    if (!short) return { code, expiresAt };
    const shortCode = Array.from({ length: 4 }, () => SHORT_CODE_LETTERS[randomInt(SHORT_CODE_LETTERS.length)]).join('');
    this.shortCode = { hash: tokenHash(shortCode), key, attempts: 0 };
    return { code, expiresAt, shortCode };
  }
  // 一次性：无论是否已过期，核对时都立即作废。
  redeem(code: string) {
    return this.consume(code)!==undefined;
  }
  consume(code:string):{issuer?:string}|undefined{ return this.take(tokenHash(code)); }
  // 输错的次数算在这个码上，作废的只是短码，链接还能用：别人乱试不会把你锁在外面。
  consumeShort(value:string):{issuer?:string}|undefined{
    const pending = this.shortCode;
    if (!pending) return undefined;
    if (equalToken(tokenHash(normalizeShortCode(value)), pending.hash)) return this.take(pending.key);
    if (++pending.attempts >= SHORT_CODE_ATTEMPTS) this.shortCode = undefined;
    return undefined;
  }
  private take(key:string):{issuer?:string}|undefined{
    const entry = this.codes.get(key);
    this.codes.delete(key); if (this.shortCode?.key === key) this.shortCode = undefined;
    return entry && entry.expires>this.now()&&(!entry.issuer||this.issuerValid?.(entry.issuer))?{...(entry.issuer?{issuer:entry.issuer}:{})}:undefined;
  }
  open(issuer?:string) {
    this.prune();
    while (this.sessions.size >= 32) this.sessions.delete(this.sessions.keys().next().value!);
    const token = randomBytes(32).toString('hex'), now = this.now();
    this.sessions.set(tokenHash(token), { created: now, touched: now,...(issuer?{issuer}:{}) });
    return { token, expiresAt: now + SESSION_MAX_MS, idleSeconds: SESSION_IDLE_MS / 1000 };
  }
  // 每次成功核对顺延空闲期限；到期的会话立即删除。
  verify(token: string) {
    if (!token) return false;
    const key = tokenHash(token), entry = this.sessions.get(key), now = this.now();
    if (!entry) return false;
    if (now - entry.touched > SESSION_IDLE_MS || now - entry.created > SESSION_MAX_MS || entry.issuer&&!this.issuerValid?.(entry.issuer)) { this.sessions.delete(key); return false; }
    entry.touched = now; return true;
  }
  revoke(token: string) { return this.sessions.delete(tokenHash(token)); }
  revokeIssuer(issuer:string){for(const[key,value]of this.codes)if(value.issuer===issuer)this.codes.delete(key);for(const[key,value]of this.sessions)if(value.issuer===issuer)this.sessions.delete(key);}
  revokeAll() { const count = this.sessions.size; this.sessions.clear(); this.codes.clear(); this.shortCode = undefined; return count; }
  stats() { this.prune(); return { sessions: this.sessions.size, pendingCodes: this.codes.size }; }
}
