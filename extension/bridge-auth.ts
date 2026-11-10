import { bridgeProofInput, extensionUpdateProofInput, BRIDGE_NONCE, BRIDGE_PROOF, BRIDGE_PROTOCOL, type BridgeRole, type JsonObject } from '../src/shared';

// 桥接握手 v2（扩展侧）：用 WebCrypto 的 HMAC-SHA256 与本机服务互相证明持有同一个配对密钥。
// 密钥只作 HMAC 的 key，从不出现在线上；服务端的证明先到，核对通过之后扩展才发出自己的证明和身份，
// 所以占着同一端口的其他程序既拿不到密钥，也无法冒充服务。
const encoder = new TextEncoder();
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
export const newNonce = () => hex(crypto.getRandomValues(new Uint8Array(16)));

async function hmac(token: string, input: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(input))));
}
export const bridgeProof = (token: string, role: BridgeRole, clientNonce: string, serverNonce: string, profileId = '', instanceId = ''): Promise<string> => hmac(token, bridgeProofInput(role, clientNonce, serverNonce, profileId, instanceId));
export const extensionUpdateProof = (token: string, profileId: string, nonce: string, version: string, sha256: string): Promise<string> => hmac(token, extensionUpdateProofInput(profileId, nonce, version, sha256));
// 等长字符串的常量时间比较。
export function sameProof(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

export type BridgeStep =
  | { kind: 'send'; frame: string }
  | { kind: 'ready'; capabilities: string[] }
  | { kind: 'rejected'; message: string }
  | { kind: 'fail'; message: string };

export class BridgeHandshake {
  private phase: 'hello' | 'auth' | 'ready' = 'hello';
  constructor(private token: string, private profile: JsonObject & { id: string; instanceId: string }, readonly nonce = newNonce(),private pairingId?:string) {}
  get ready() { return this.phase === 'ready'; }
  /** 第一帧只带协议版本和随机数：不含密钥，也不含身份。 */
  hello(): string { return JSON.stringify({ type: 'hello', protocol: BRIDGE_PROTOCOL, nonce: this.nonce,...(this.pairingId?{pairingId:this.pairingId}:{}) }); }
  async receive(frame: JsonObject): Promise<BridgeStep> {
    if (frame.type === 'rejected') {
      const message = String(frame.message ?? '');
      // 旧版服务不认识新握手，会在没有 challenge 的情况下直接拒绝；给出能指导恢复的说明。
      return { kind: 'rejected', message: this.phase === 'hello' && frame.code === undefined ? `服务没有按新版握手应答，通常是服务版本较旧：请把 SaltedFish 服务更新到与扩展相同的版本。服务返回：${message}` : message };
    }
    if (this.phase === 'hello' && frame.type === 'challenge') {
      const nonce = frame.nonce, proof = frame.proof;
      if (typeof nonce !== 'string' || !BRIDGE_NONCE.test(nonce) || typeof proof !== 'string' || !BRIDGE_PROOF.test(proof)) return { kind: 'fail', message: '服务的握手应答格式不正确，已断开，没有发送任何密钥。' };
      if (!sameProof(proof, await bridgeProof(this.token, 'server', this.nonce, nonce))) return { kind: 'fail', message: '服务无法证明持有配对密钥（可能是占用同一端口的其他程序，或配对文件已更换）。已断开，没有发送任何密钥。' };
      this.phase = 'auth';
      return { kind: 'send', frame: JSON.stringify({ type: 'auth', proof: await bridgeProof(this.token, 'client', this.nonce, nonce, this.profile.id, this.profile.instanceId), profile: this.profile }) };
    }
    if (this.phase === 'auth' && frame.type === 'ready') {
      this.phase = 'ready';
      return { kind: 'ready', capabilities: Array.isArray(frame.capabilities) ? frame.capabilities.filter((item): item is string => typeof item === 'string') : [] };
    }
    return { kind: 'fail', message: `握手顺序异常（${String(frame.type)}），已断开。` };
  }
}
