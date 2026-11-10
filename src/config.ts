import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {serviceAddress,loopbackAddress,privateAddress} from './service-address.js';

export const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ConfigSchema = z.object({
  port: z.number().int().min(1024).max(65535),
  token: z.string().min(32),
  directConnections:z.boolean().optional(),
  network: z.object({
    host:z.string().min(1).max(253),
    publicUrl:z.string().max(2048).transform(serviceAddress),
    allowInsecureLan:z.boolean().optional(),
    tls:z.object({cert:z.string().min(1),key:z.string().min(1)}).strict().optional(),
    localPort:z.number().int().min(1024).max(65535).optional(),
  }).strict().superRefine((value,context)=>{
    if(!value.tls&&!loopbackAddress(value.host)&&(!value.allowInsecureLan||!privateAddress(value.host)||new URL(value.publicUrl).hostname.replace(/^\[|\]$/g,'')!==value.host))context.addIssue({code:'custom',message:'跨机器HTTP需明确启用可信内网模式，并监听服务地址对应的私网IP；其他情况需要TLS证书。'});
    if(new URL(value.publicUrl).protocol==='https:'&&!value.tls)context.addIssue({code:'custom',message:'HTTPS地址需要TLS证书。'});
    if(value.tls&&new URL(value.publicUrl).protocol!=='https:')context.addIssue({code:'custom',message:'TLS服务使用HTTPS地址。'});
  }).optional(),
  outputLimit: z.number().int().positive().default(24000),
  eventLimit: z.number().int().positive().default(2000),
  eventByteLimit: z.number().int().min(65536).default(8 * 1024 * 1024),
  resultByteLimit: z.number().int().min(65536).default(1024 * 1024 * 1024),
  maxPendingRequests: z.number().int().min(1).max(4096).default(128),
  maxTabLeases: z.number().int().min(1).max(1000000).default(4096),
  // 旧版的 uploadRoots、saveRoots（上传、保存目录白名单）不再使用：本机 Agent 读写哪些文件由它的 harness 决定，见 upload-policy.ts。
  // 已有 config.json 里的这两项解析时丢掉，文件里不改，回滚到旧版照样能用。
  // 浏览器和服务在同一台电脑时，上传直接把本机路径交给 Chrome（auto）；never 时始终由服务传文件内容。
  uploadByPath: z.enum(['auto', 'never']).default('auto'),
});
type ParsedConfig = z.infer<typeof ConfigSchema>;
type OptionalFields = 'eventByteLimit' | 'resultByteLimit' | 'maxPendingRequests' | 'maxTabLeases' | 'uploadByPath';
export type Config = Omit<ParsedConfig, OptionalFields> & Partial<Pick<ParsedConfig, OptionalFields>> & { dataDir: string };

export async function loadConfig(dataDir = process.env.CHROME_MCP_DATA_DIR || path.join(projectDir, '.local')): Promise<Config> {
  dataDir = path.resolve(dataDir);
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, 'config.json');
  try {
    return { ...ConfigSchema.parse(JSON.parse(await readFile(file, 'utf8'))), dataDir };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const config = ConfigSchema.parse({ port: Number(process.env.CHROME_MCP_PORT || 17422), token: randomBytes(32).toString('hex'),directConnections:true });
  try { await writeFile(file, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return loadConfig(dataDir);
  }
  return { ...config, dataDir };
}
