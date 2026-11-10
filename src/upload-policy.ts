import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { BrowserError } from './shared.js';

// 本机 Agent 读写哪些文件，由它自己的 harness（Claude Code 的权限、Codex 的沙箱…）决定，服务不再按目录白名单限制。
// 前提是 Agent 和服务在同一台电脑上：/mcp 只接受本机连接（mcp-http.ts 的 fromThisMachine）。服务这边只拦两样：
// - SaltedFish 自己的数据目录和安装目录：里面有管理员令牌、配对密钥和配置，受限的 Agent 读写它就能给自己提权，这是服务自己的权限边界，harness 管不到；
// - Windows 的网络共享（UNC）和设备路径：访问 \\主机\共享 时 Windows 会自动发出登录凭据，网页借 Agent 之手给个地址就能套走。
// 比对先解析 realpath：符号链接、Windows 目录联接和 8.3 短名都先还原成真实路径再判断。
export interface FilePolicy {
  /** 永远拒绝的目录：数据目录、npm 安装目录。 */
  denied: string[];
}

const gate = { phase: 'precondition', outcome: 'not_dispatched' } as const;

export function filePolicy(config: { dataDir: string }): FilePolicy {
  return { denied: [config.dataDir, ...(process.env.SALTEDFISH_HOME ? [process.env.SALTEDFISH_HOME] : [])] };
}

export const inside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const realOr = (directory: string) => realpath(directory).catch(() => path.resolve(directory));
const networkPath = (value: string) => process.platform === 'win32' && /^[\\/]{2}/.test(value);
async function deniedDirectory(real: string, policy: FilePolicy) {
  for (const directory of policy.denied) if (inside(await realOr(directory), real)) return true;
  return false;
}

/** 别的电脑经旧网关（remote-connector.ts）连进来的 Agent：它的 harness 管不到这台电脑，不能用这台电脑上的路径。 */
export const remotePathRefused = (what: 'upload' | 'output') => what === 'upload'
  ? new BrowserError('UPLOAD_PATH_NOT_ALLOWED', '从别的电脑连进来的 Agent 不能用这台电脑上的文件路径；先用 chrome_file_begin/write/commit 把文件传过来，再用 transferIds 上传。尚未向浏览器派发。', gate)
  : new BrowserError('OUTPUT_PATH_NOT_ALLOWED', '从别的电脑连进来的 Agent 不能把文件写到这台电脑上，没有写入文件；去掉 savePath，结果会直接返回。', gate);

/** 输出文件（截图、脚本结果）要写进的目录：要已存在，不能在数据目录里。返回真实路径。 */
export async function checkOutputDirectory(directory: string, policy: FilePolicy): Promise<string> {
  if (networkPath(directory)) throw new BrowserError('OUTPUT_PATH_NOT_ALLOWED', '不支持网络共享（UNC）或设备路径，请写到本机目录。没有写入文件。', gate);
  let real: string;
  try { real = await realpath(directory); } catch { throw new BrowserError('OUTPUT_DIRECTORY_NOT_FOUND', `目录不存在：${directory}。没有写入文件。`, gate); }
  // 符号链接或映射的网络盘解析后可能落在共享上，解析之后再判一次（全局评审 U66）。
  if (networkPath(real)) throw new BrowserError('OUTPUT_PATH_NOT_ALLOWED', '这个目录实际在网络共享上，请写到本机目录。没有写入文件。', gate);
  if (await deniedDirectory(real, policy)) throw new BrowserError('OUTPUT_PATH_NOT_ALLOWED', 'SaltedFish 自己的数据目录不能写，换一个目录。没有写入文件。', gate);
  return real;
}

/** 校验一个要读的本机文件（上传、导出下载）：绝对路径、不是网络共享、存在、是普通文件、不在数据目录里。返回真实路径。 */
export async function checkUploadFile(file: string, policy: FilePolicy): Promise<string> {
  if (typeof file !== 'string' || file.includes('\0')) throw new BrowserError('INVALID_ARGUMENT', '上传路径无效，尚未向浏览器派发。', gate);
  if (!path.isAbsolute(file)) throw new BrowserError('ABSOLUTE_PATH_REQUIRED', `上传必须使用绝对路径：${file}`);
  // 先于任何文件系统访问判断，免得碰一下 UNC 路径就向外发出 SMB 登录。
  if (networkPath(file)) throw new BrowserError('UPLOAD_PATH_NOT_ALLOWED', '不支持网络共享（UNC）或设备路径，请使用本机文件。尚未向浏览器派发。', gate);
  let real: string;
  try { real = await realpath(path.resolve(file)); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new BrowserError(code === 'ENOENT' || code === 'ENOTDIR' ? 'FILE_NOT_FOUND' : 'FILE_UNAVAILABLE', '上传文件不存在或无法访问，尚未向浏览器派发。', gate);
  }
  if (networkPath(real)) throw new BrowserError('UPLOAD_PATH_NOT_ALLOWED', '这个文件实际在网络共享上，请使用本机文件。尚未向浏览器派发。', gate);
  if (await deniedDirectory(real, policy)) throw new BrowserError('UPLOAD_PATH_NOT_ALLOWED', 'SaltedFish 自己的数据目录里的文件不能上传。尚未向浏览器派发。', gate);
  let info;
  try { info = await stat(real); }
  catch { throw new BrowserError('FILE_UNAVAILABLE', '上传文件不存在或无法访问，尚未向浏览器派发。', gate); }
  if (!info.isFile()) throw new BrowserError('NOT_A_FILE', file, gate);
  return real;
}

const fileList = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10000 || value.some(item => typeof item !== 'string')) throw new BrowserError('INVALID_ARGUMENT', '文件列表必须是字符串数组。', gate);
  return value as string[];
};
/** 会把本机文件交给页面的 CDP 方法；与 chrome_upload 使用同一套路径校验，避免绕开。 */
export function cdpUploadPaths(method: string, params: unknown): string[] | undefined {
  const record = params && typeof params === 'object' ? params as Record<string, unknown> : {};
  const name = method.toLowerCase();
  if (name === 'dom.setfileinputfiles') return fileList(record.files);
  if (name === 'input.dispatchdragevent') { const data = record.data; return data && typeof data === 'object' ? fileList((data as Record<string, unknown>).files) : []; }
  return undefined;
}
