import { readFile, writeFile } from 'node:fs/promises';
import { checkServerIdentity, createSecureContext } from 'node:tls';
import { X509Certificate, randomUUID } from 'node:crypto';
import path from 'node:path';
import { BrowserError } from './shared.js';
import { GatewayConfig } from './remote-gateway.js';
import { RemoteSettings, pairingCredential } from './remote-protocol.js';
import { atomicJson } from './npm-runtime.js';

const CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]*?-----END CERTIFICATE-----/g;
const PRIVATE_KEY_MARKER = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
const certificates = (text: string) => (text.match(CERTIFICATE_BLOCK) ?? []).map(block => new X509Certificate(block));
const canonical = (certificate: X509Certificate) => `-----BEGIN CERTIFICATE-----\n${certificate.raw.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
// 按证书内容而不是文本比较：旧版把整个 --cert 文件原样写进配对，里面可能有注释或不同的换行。
const fingerprints = (text?: string) => { try { return certificates(text ?? '').map(certificate => certificate.fingerprint256); } catch { return []; } };
const sameCertificates = (a?: string, b?: string) => { const left = fingerprints(a), right = fingerprints(b); return left.length > 0 && left.length === right.length && left.every((value, index) => value === right[index]); };

// 返回写进配对 Token 的信任锚：只含规范化后的 CERTIFICATE 块。hostname 是客户端实际访问的主机（gateway init 的 --url），
// 用 tls.checkServerIdentity 做和远程连接器完全相同的主机名校验，避免首次连接才因主机名不符失败。
export async function validateGatewayTls(tls?: { cert: string; key: string }, hostname?: string): Promise<string | undefined> {
  if (!tls) return undefined;
  let cert: string, key: Buffer;
  try { [cert, key] = await Promise.all([readFile(tls.cert, 'utf8'), readFile(tls.key)]); }
  catch { throw new BrowserError('GATEWAY_TLS_UNREADABLE', '无法读取 TLS 证书或私钥；请检查路径和权限后重试，未提交网关配置。'); }
  // 配对 Token 会被复制到另一台电脑和剪贴板；--cert 夹带私钥等于把服务器私钥一并发出去。
  if (PRIVATE_KEY_MARKER.test(cert)) throw new BrowserError('GATEWAY_TLS_CERT_HAS_KEY', '--cert 文件包含私钥，私钥会随配对 Token 复制到其他电脑。请把证书（可含中间证书）和私钥拆成两个文件：--cert 只传证书，--key 传私钥；未提交网关配置。');
  let chain: X509Certificate[];
  try {
    chain = certificates(cert);
    if (!chain.length) throw new Error('No certificate');
    createSecureContext({ cert, key });
    if (Date.now() < Date.parse(chain[0]!.validFrom) || Date.now() >= Date.parse(chain[0]!.validTo)) throw new Error('Expired certificate');
  } catch { throw new BrowserError('GATEWAY_TLS_INVALID', 'TLS 证书与私钥无效、不匹配或已过期；请更正后重试，未提交网关配置。'); }
  if (hostname) {
    const name = hostname.replace(/^\[|\]$/g, ''), leaf = chain[0]!;
    if (checkServerIdentity(name, leaf.toLegacyObject())) throw new BrowserError('GATEWAY_TLS_HOST_MISMATCH', `TLS 证书不覆盖 --url 的主机 ${name}（证书：${leaf.subjectAltName ?? leaf.subject.replaceAll('\n', ', ')}）。远程电脑会因主机名校验失败而无法连接；请换用包含该地址（SAN）的证书，或把 --url 改成证书已覆盖的地址，未提交网关配置。`);
  }
  return chain.map(canonical).join('');
}

// 生成配对 Token；证书链过长时给出专门错误，而不是让下游报“Token 格式无效”。
export function gatewayPairing(deviceToken: string, ca?: string) {
  const pairing = `fc1.${Buffer.from(JSON.stringify({ token: deviceToken, ...(ca ? { ca } : {}) })).toString('base64url')}`;
  if (!ca) { pairingCredential(pairing); return pairing; }
  let fits = RemoteSettings.shape.token.safeParse(pairing).success;
  if (fits) { try { pairingCredential(pairing); } catch { fits = false; } }
  if (!fits) throw new BrowserError('GATEWAY_TLS_CERT_TOO_LARGE', `证书链过大：规范化后 ${ca.length} 字符，生成的配对 Token 达 ${pairing.length} 字符，超过本机工作台能接收的上限。--cert 只放服务器证书和必要的中间证书（不要放完整根证书库或其他内容）后重试；未提交网关配置。`);
  return pairing;
}

// 只修复已配对证书的路径/私钥，保留所有设备、Agent 身份和 Token；不是隐式证书轮换。
export async function repairGatewayTls(directory: string, paths: { cert?: string; key?: string }) {
  if (!paths.cert && !paths.key) throw new BrowserError('GATEWAY_REPAIR_OPTIONS', '提供要更正的 --cert 或 --key 路径。');
  const file = path.join(directory, 'gateway.json'), before = await readFile(file, 'utf8');
  const current = GatewayConfig.parse(JSON.parse(before));
  if (!current.tls) throw new BrowserError('GATEWAY_REPAIR_NO_TLS', '此网关未配置 TLS；repair 仅修复已有 TLS 文件路径。');
  const tls = { cert: path.resolve(paths.cert || current.tls.cert), key: path.resolve(paths.key || current.tls.key) };
  const ca = await validateGatewayTls(tls);
  const pairing = pairingCredential(await readFile(path.join(directory, 'device-pairing.token'), 'utf8'));
  if (!sameCertificates(pairing.ca, ca)) throw new BrowserError('GATEWAY_REPAIR_CERT_CHANGED', '证书与现有配对不一致；本命令只修复路径，不更换证书或 Token。');
  if (await readFile(file, 'utf8') !== before) throw new BrowserError('GATEWAY_CONFIG_CHANGED', '检查期间网关配置发生变化，未覆盖。');
  const backup = `${file}.before-repair-${randomUUID()}.json`;
  await writeFile(backup, before, { flag: 'wx', mode: 0o600 });
  await atomicJson(file, { ...current, tls });
  // 旧版 gateway init 把整份 --cert 文件写进配对；若当时传的是合并 PEM，配对里的 ca 字段已含私钥。
  const leaked = PRIVATE_KEY_MARKER.test(pairing.ca ?? '');
  return { repaired: true, backup, credentialsPreserved: true, note: 'TLS 配置已修复；运行 saltedfish gateway start。',
    ...(leaked ? { warning: '现有 device-pairing.token 的 ca 字段含私钥（旧版 init 把合并 PEM 写入配对），该私钥应视为已泄漏；请更换证书和私钥并重新初始化网关与配对。' } : {}) };
}
