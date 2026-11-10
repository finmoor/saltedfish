import { z } from 'zod';
import { isIP } from 'node:net';
import { BrowserError } from './shared.js';

export const REMOTE_PROTOCOL = 1;
export const REMOTE_FRAME_BYTES = 16 * 1024 * 1024;
export const RemoteScope = z.union([z.literal('*'), z.array(z.string().uuid()).max(1000)]);
export const RemoteAgent = z.object({ id: z.string().uuid(), label: z.string().min(1).max(100), profiles: RemoteScope, readOnly: z.boolean() }).strict();
const WireRemoteAgent=RemoteAgent.extend({authorizationRevision:z.string().uuid().optional()});
export const REMOTE_MACHINE_HEADER = 'x-saltedfish-client-machine';
const ipAddress=z.string().max(64).refine(value=>!value.includes('%')&&isIP(value)!==0,'需要有效 IP 地址');
export const RemoteMachineReport=z.object({
  hostname:z.string().min(1).max(128).refine(value=>!/[\u0000-\u001f\u007f-\u009f]/.test(value),'机器名不能含控制符').optional(),
  reportedAddresses:z.array(ipAddress).max(8),reportId:z.string().uuid(),reportedAt:z.iso.datetime(),
  reportSource:z.enum(['setup_report','runtime_report']),
}).strict();
export type RemoteMachineReportValue=z.infer<typeof RemoteMachineReport>;
export function encodeRemoteMachineReport(report:RemoteMachineReportValue):string {
  const encoded=Buffer.from(JSON.stringify(RemoteMachineReport.parse(report)),'utf8').toString('base64url');
  if(encoded.length>2048)throw new Error('机器来源报告超过容量');
  return encoded;
}
export function parseRemoteMachineReport(header:unknown):RemoteMachineReportValue|undefined {
  if(typeof header!=='string'||!header.length||header.length>2048||!/^[A-Za-z0-9_-]+$/.test(header))return;
  try {
    const bytes=Buffer.from(header,'base64url'),text=bytes.toString('utf8');
    if(bytes.toString('base64url')!==header||!Buffer.from(text,'utf8').equals(bytes))return;
    return RemoteMachineReport.parse(JSON.parse(text));
  }catch{return;}
}
/** 这是请求端点地址，不是 NAT/代理后机器的唯一身份。转发头不进入来源记录。 */
export function normalizePeerAddress(value:string|undefined):string|undefined {
  if(!value)return;
  const normalized=value.startsWith('::ffff:')&&isIP(value.slice(7))===4?value.slice(7):value;
  return ipAddress.safeParse(normalized).success?normalized:undefined;
}
export const RemoteAgentSource=z.object({
  id:z.string().uuid(),hostname:RemoteMachineReport.shape.hostname,reportedAddresses:z.array(ipAddress).max(8),
  reportId:z.string().uuid().optional(),reportedAt:z.iso.datetime().optional(),reportSource:z.enum(['setup_report','runtime_report']).optional(),
  peerAddress:ipAddress.optional(),observedAt:z.iso.datetime(),connected:z.boolean(),
}).strict();
export type RemoteAgentSourceValue=z.infer<typeof RemoteAgentSource>;
export const RemoteCall = z.object({ type: z.literal('call'), id: z.string().uuid(), owner: z.string().uuid(), deadline: z.number().finite(), agent: WireRemoteAgent,
  name: z.string().min(1).max(100), args: z.record(z.string(), z.unknown()) }).strict();
export const RemoteReply = z.object({ type: z.literal('reply'), id: z.string().uuid(), result: z.object({ ok: z.boolean() }).passthrough() }).strict();
const commandPart=z.string().min(1).max(4096).refine(value=>!/[\0\r\n]/.test(value),'命令参数不得包含控制换行。');
export const RemoteOnboarding=z.object({platform:z.enum(['linux','win32','darwin']),command:z.array(commandPart).min(1).max(6),suffix:z.array(commandPart).max(6)}).strict();
export type RemoteOnboardingValue=z.infer<typeof RemoteOnboarding>;
export const RemoteReady = z.object({ type: z.literal('ready'), protocol: z.literal(REMOTE_PROTOCOL), version: z.string(), deviceId: z.string().uuid(), label: z.string().max(100),onboarding:RemoteOnboarding.optional() }).strict();
export const RemoteAgents = z.object({type:z.literal('agents'),agents:z.array(WireRemoteAgent.extend({sessionCount:z.number().int().min(0).max(8),lastSeenAt:z.iso.datetime().optional(),activeOperations:z.number().int().min(0).max(128),sources:z.array(RemoteAgentSource).max(8).optional()})).max(64)}).strict();
export const RemoteHello = z.object({ type: z.literal('hello'), protocol: z.literal(REMOTE_PROTOCOL), version: z.string(), instanceId: z.string().uuid() }).strict();
export const RemoteSettings = z.object({ enabled: z.boolean(), url: z.string().max(2048), token: z.string().max(20000), profiles: RemoteScope, readOnly: z.boolean().default(false) }).strict();
export type RemoteSettingsValue = z.infer<typeof RemoteSettings>;
export function intersectScope(a: z.infer<typeof RemoteScope>, b: z.infer<typeof RemoteScope>) {
  return a === '*' ? b : b === '*' ? a : a.filter(id => b.includes(id));
}
export function remoteUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new BrowserError('REMOTE_URL_INVALID', '服务器地址需要包含协议，例如 https://服务器:18443。'); }
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new BrowserError('REMOTE_URL_INVALID', '填写服务器根地址，不能包含密码、查询参数或路径。');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!['https:', 'wss:'].includes(url.protocol) && !(loopback && ['http:', 'ws:'].includes(url.protocol))) throw new BrowserError('REMOTE_TLS_REQUIRED', '远程连接必须使用 HTTPS/WSS；明文仅限本机回环测试。');
  url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:'; url.pathname = '/connect'; return url;
}
export function pairingCredential(value: string): { token: string; ca?: string } {
  try {
    if (!value.startsWith('fc1.')) return { token: z.string().regex(/^[a-f0-9]{64}$/).parse(value) };
    return z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), ca: z.string().min(1).max(16000).optional() }).strict().parse(JSON.parse(Buffer.from(value.slice(4), 'base64url').toString('utf8')));
  } catch { throw new BrowserError('REMOTE_TOKEN_INVALID', 'Token 格式无效，请复制服务器生成的 device-pairing.token。'); }
}
