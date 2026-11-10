import { open } from 'node:fs/promises';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { serviceDashboardLoginUrl, parseDesktopUrl } from './desktop-links.js';
import {serviceInternalUrl,servicePublicUrl} from './service-network.js';
import {ConfigSchema} from './config.js';
import {NativeFileRequest,readNativeDownload,type NativeFileChunk} from './native-files.js';
import {BrowserError,CAPABILITY} from './shared.js';

const MAX_MESSAGE_BYTES = 4096;
const MAX_RESPONSE_BYTES=512*1024;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}\/(?![\s\S])/;
const messages = {
  CALLER_NOT_ALLOWED: '此扩展尚未获准打开设置，请修复 SaltedFish 安装。',
  INVALID_REQUEST: '设置请求无效，请从 SaltedFish 页面重新打开。',
  REQUEST_TIMEOUT: '打开设置超时，请重试。',
  SETTINGS_UNAVAILABLE: '暂时无法打开设置，请确认 SaltedFish 本机服务正在运行。',
  LOCAL_FILE_ACCESS_DENIED:'本机助手只读取存在的普通文件，SaltedFish 的数据目录和网络共享路径除外。',
  LOCAL_FILE_CHANGED:'下载文件在读取期间变化，请核对后重新导出。',
} as const;
type ErrorCode = keyof typeof messages;
export type NativeSettingsResponse = { ok: true; url: string } | { ok: false; error: { code: ErrorCode; message: string } };
export type NativeHelperResponse={ok:true;helper:{capabilities:string[]}}|{ok:true;file:NativeFileChunk};
class NativeSettingsError extends Error {
  constructor(readonly code: ErrorCode) { super(messages[code]); }
}
const failure = (code: ErrorCode): NativeSettingsResponse => ({ ok: false, error: { code, message: messages[code] } });

export function encodeNativeSettingsMessage(message: unknown,limit=MAX_MESSAGE_BYTES): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length < 1 || body.length > limit) throw new NativeSettingsError('INVALID_REQUEST');
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

/** Chrome 每次 sendNativeMessage 单独启动进程；只消费一条有界消息，不形成常驻控制通道。 */
export async function readNativeSettingsMessage(input: Readable, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0), length: number | undefined, settled = false;
    const finish = (error?: NativeSettingsError, value?: unknown) => {
      if (settled) return; settled = true;
      clearTimeout(timer); input.pause();
      input.off('data', onData); input.off('end', onEnd); input.off('error', onEnd); input.off('close', onEnd);
      if (error) reject(error); else resolve(value);
    };
    const onEnd = () => finish(new NativeSettingsError('INVALID_REQUEST'));
    const onData = (chunk: Buffer | string) => {
      const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (buffered.length + data.length > MAX_MESSAGE_BYTES + 4) { onEnd(); return; }
      buffered = Buffer.concat([buffered, data]);
      if (length === undefined && buffered.length >= 4) {
        length = buffered.readUInt32LE(0);
        if (length < 1 || length > MAX_MESSAGE_BYTES) { onEnd(); return; }
      }
      if (length === undefined || buffered.length < length + 4) return;
      if (buffered.length !== length + 4) { onEnd(); return; }
      try { finish(undefined, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffered.subarray(4)))); }
      catch { onEnd(); }
    };
    const timer = setTimeout(() => finish(new NativeSettingsError('REQUEST_TIMEOUT')), timeoutMs);
    input.on('data', onData); input.once('end', onEnd); input.once('error', onEnd); input.once('close', onEnd);
    if (input.destroyed || input.readableEnded) onEnd();
  });
}

async function readSmallJson(file: string): Promise<unknown> {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 65536) throw new NativeSettingsError('SETTINGS_UNAVAILABLE');
    const bytes = Buffer.alloc(65537);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break; offset += bytesRead;
    }
    if (offset > 65536) throw new NativeSettingsError('SETTINGS_UNAVAILABLE');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)));
  } finally { await handle.close(); }
}

async function readLoginCode(response: Response): Promise<string> {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new NativeSettingsError('SETTINGS_UNAVAILABLE'); }
  const reader = response.body.getReader(); let bytes = Buffer.alloc(0);
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      if (bytes.length + part.value.length > MAX_MESSAGE_BYTES) throw new NativeSettingsError('SETTINGS_UNAVAILABLE');
      bytes = Buffer.concat([bytes, part.value]);
    }
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return z.object({ code: z.string().length(64).regex(/^[a-f0-9]{64}$/) }).parse(body).code;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** 不调用 loadConfig/ensureService：缺少已有配置或服务时直接失败，不写文件、不自动启动。 */
export async function runNativeSettings(dataDir: string, argv: readonly string[], io: { input?: Readable; output?: Writable; timeoutMs?: number } = {}): Promise<void> {
  const input = io.input ?? process.stdin, output = io.output ?? process.stdout;
  let response: NativeSettingsResponse|NativeHelperResponse;
  try {
    const origin = argv[0];
    if (!origin || !EXTENSION_ORIGIN.test(origin) || argv.length > 2 || (argv[1] !== undefined && !/^--parent-window=[0-9]{1,20}(?![\s\S])/.test(argv[1]))) throw new NativeSettingsError('CALLER_NOT_ALLOWED');
    if (!path.isAbsolute(dataDir)) throw new NativeSettingsError('SETTINGS_UNAVAILABLE');
    const config = ConfigSchema.pick({port:true,token:true,network:true}).extend({token:z.string().min(32).max(4096).regex(/^[\x21-\x7e]+$/)}).parse(await readSmallJson(path.join(dataDir, 'config.json')));
    const host = z.object({ name: z.literal(`com.saltedfish.settings.p${config.port}`), type: z.literal('stdio'), allowed_origins: z.array(z.string().regex(EXTENSION_ORIGIN)).min(1).max(64) }).parse(await readSmallJson(path.join(dataDir, 'native-settings', 'host.json')));
    if (!host.allowed_origins.includes(origin)) throw new NativeSettingsError('CALLER_NOT_ALLOWED');
    const request = z.discriminatedUnion('action',[z.object({ action: z.literal('open-settings'), target: z.string().min(1).max(192) }).strict(),z.object({action:z.literal('helper-info')}).strict(),NativeFileRequest]).safeParse(await readNativeSettingsMessage(input, io.timeoutMs));
    if (!request.success) throw new NativeSettingsError('INVALID_REQUEST');
    if(request.data.action==='helper-info')response={ok:true,helper:{capabilities:[CAPABILITY.browserFileReadV1]}};
    else if(request.data.action==='read-download')response={ok:true,file:await readNativeDownload({...config,dataDir},request.data)};
    else{
    let target;
    try { target = parseDesktopUrl(`saltedfish-${config.port}://settings/${request.data.target}`, config.port).target; }
    catch { throw new NativeSettingsError('INVALID_REQUEST'); }
    const serviceUrl=serviceInternalUrl(config);
    const result = await fetch(`${serviceUrl}/session/code`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.token}` }, redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    const code = await readLoginCode(result);
    if (code === config.token) throw new NativeSettingsError('SETTINGS_UNAVAILABLE');
    response = { ok: true, url: serviceDashboardLoginUrl(servicePublicUrl(config), code, target) };
    }
  } catch (error) { response = failure(error instanceof NativeSettingsError ? error.code : error instanceof BrowserError&&Object.hasOwn(messages,error.code)?error.code as ErrorCode:'SETTINGS_UNAVAILABLE'); }
  finally { input.pause(); }
  // 任何异常信息均不进入 stdout/stderr；响应只有固定错误文案或一次性登录地址。
  const frame = encodeNativeSettingsMessage(response,MAX_RESPONSE_BYTES);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { output.off('error', onError); reject(error); };
    output.once('error', onError);
    output.write(frame, error => { output.off('error', onError); if (error) reject(error); else resolve(); });
  }).catch(() => {});
}
