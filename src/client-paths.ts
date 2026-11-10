import { access, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { BrowserError } from './shared.js';

const exists = (file: string) => access(file).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
const directory = (folder: string) => stat(folder).then(info => info.isDirectory(), (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
export async function firstClientPath(candidates: string[]) {
  for (const file of candidates) if (await exists(file)) return file;
  return candidates[0]!;
}

// Windows 常规版在 %APPDATA%\Claude，商店版原来在包内重定向的 Roaming（Packages\Claude_<发布者标识>\LocalCache\Roaming\Claude）。
// 新版商店 Desktop 把资料搬到 %LOCALAPPDATA%\Claude-Data\claude_<发布者标识>，在搬走的旧目录里留一个空文件 .user-data-left.claude_<标识>
// （4.23118 实测，每次启动都更新它）。留了这个标记的旧目录不算；剩下的多于一个就不猜，--config 可明确选择。
export async function desktopConfigPath(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
  const file = 'claude_desktop_config.json';
  if (platform === 'darwin') return path.join(home, 'Library/Application Support/Claude', file);
  if (platform !== 'win32') return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude', file);
  const local = env.LOCALAPPDATA || path.join(home, 'AppData/Local');
  const regular = path.join(env.APPDATA || path.join(home, 'AppData/Roaming'), 'Claude');
  const packages = path.join(local, 'Packages'), migrated = path.join(local, 'Claude-Data');
  const names = (folder: string) => readdir(folder).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  const legacy = [regular, ...(await names(packages) ?? []).filter(name => /^Claude_[a-z0-9]+$/i.test(name)).map(name => path.join(packages, name, 'LocalCache/Roaming/Claude'))];
  const installed: string[] = [];
  for (const name of await names(migrated) ?? []) if (/^claude_[a-z0-9]+$/i.test(name) && await directory(path.join(migrated, name))) installed.push(path.join(migrated, name));
  for (const folder of legacy) if (await directory(folder) && !(await names(folder))!.some(name => /^\.user-data-left\./i.test(name))) installed.push(folder);
  if (installed.length > 1) throw new BrowserError('AMBIGUOUS_CONFIG', '检测到多个 Claude Desktop 数据目录，请在 Desktop 的“设置 → 开发者 → 编辑配置”确认文件，再用指定配置文件接入。');
  return path.join(installed[0] ?? regular, file);
}
