import { lstat, open, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Config } from './config.js';
import type { Principal } from './auth.js';
import { BrowserError, NOT_DISPATCHED } from './shared.js';
import { checkOutputDirectory, filePolicy, remotePathRefused } from './upload-policy.js';

// 把截图、脚本结果写到调用方指定的本机文件（服务所在电脑）。写哪里由 Agent 自己的 harness 决定，只拦 SaltedFish 的数据目录（upload-policy.ts）；只写这几种扩展名，免得写出可执行文件。
export const IMAGE_OUTPUT = ['.png'];
export const TEXT_OUTPUT = ['.json', '.txt', '.csv', '.md', '.html'];

export interface OutputTarget { path: string; overwrite?: boolean }

/** 只检查不写：会改页面的工具在派发前先查一遍，免得动作做完了才发现存不下。 */
export async function resolveOutputFile(config: Config, principal: Principal, target: OutputTarget, extensions: readonly string[]) {
  if (!path.isAbsolute(target.path)) throw new BrowserError('ABSOLUTE_PATH_REQUIRED', `输出文件必须是绝对路径：${target.path}`, NOT_DISPATCHED);
  const resolved = path.resolve(target.path), extension = path.extname(resolved).toLowerCase();
  if (!extensions.includes(extension)) throw new BrowserError('OUTPUT_TYPE_NOT_ALLOWED', `这类结果只能保存为 ${extensions.join('、')} 文件。没有写入文件。`, NOT_DISPATCHED);
  if (principal.remoteAgentId) throw remotePathRefused('output');
  const directory = principal.admin ? path.dirname(resolved) : await checkOutputDirectory(path.dirname(resolved), filePolicy(config));
  if (principal.admin) { try { if (!(await stat(directory)).isDirectory()) throw new Error(); } catch { throw new BrowserError('OUTPUT_DIRECTORY_NOT_FOUND', `目录不存在：${path.dirname(resolved)}。没有写入文件。`, NOT_DISPATCHED); } }
  const file = path.join(directory, path.basename(resolved));
  const existing = await lstat(file).catch(() => undefined);
  if (existing) {
    if (!target.overwrite) throw new BrowserError('FILE_EXISTS', `文件已存在：${file}。换个文件名，或传 overwrite:true 覆盖。`, NOT_DISPATCHED);
    // 覆盖只针对普通文件；符号链接、目录一律拒绝，免得借链接写进数据目录。
    if (!existing.isFile()) throw new BrowserError('OUTPUT_PATH_NOT_ALLOWED', `${file} 不是普通文件，不能覆盖。`, NOT_DISPATCHED);
  }
  return { file, directory, existing: !!existing };
}

export async function writeOutputFile(config: Config, principal: Principal, target: OutputTarget, content: string | Buffer, extensions: readonly string[]) {
  const { file, directory, existing } = await resolveOutputFile(config, principal, target, extensions);
  const bytes = Buffer.byteLength(content);
  if (!existing) {
    // 不覆盖时用独占创建：别人刚好建了同名文件就失败，不会被这里改掉。
    let created = false;
    try { const handle = await open(file, 'wx', 0o600); created = true; try { await handle.writeFile(content); } finally { await handle.close(); } }
    catch (error) {
      if (created) await rm(file, { force: true }).catch(() => {});
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new BrowserError('FILE_EXISTS', `文件已存在：${file}。换个文件名，或传 overwrite:true 覆盖。`, NOT_DISPATCHED);
      throw error;
    }
    return { path: file, bytes };
  }
  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600); try { await handle.writeFile(content); } finally { await handle.close(); }
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, file); break; }
      catch (error) { if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; await new Promise(resolve => setTimeout(resolve, 20 * 2 ** attempt)); }
    }
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
  return { path: file, bytes, overwritten: true };
}
