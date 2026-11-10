import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { exists } from './npm-runtime.js';

const PACKAGE = 'saltedfish';
const parseVersion = (version: string) => {
  const dash = version.indexOf('-'), core = dash < 0 ? version : version.slice(0, dash);
  return { core: core.split('.').map(Number), pre: dash < 0 ? [] : version.slice(dash + 1).split('.') };
};
// 规则和 scripts/release-evidence.mjs 的 compareVersions 相同，发行包里没有 scripts。
export function compareVersions(a: string, b: string) {
  const left = parseVersion(a), right = parseVersion(b);
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i]! < right.core[i]! ? -1 : 1;
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const numbers = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (numbers[0] && numbers[1]) return Number(x) < Number(y) ? -1 : 1;
    if (numbers[0] !== numbers[1]) return numbers[0] ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
// 从包的位置反推 npm 的全局目录，新包要装回同一个地方。开发目录和 npm link 不在 node_modules 下，不下载。
export function installPrefix(packageRoot: string, platform = process.platform) {
  const modules = path.dirname(packageRoot), parent = path.dirname(modules);
  if (path.basename(modules) !== 'node_modules') return undefined;
  return platform !== 'win32' && path.basename(parent) === 'lib' ? path.dirname(parent) : parent;
}
export async function registryVersion(registry: string, tag: string, request: typeof fetch = fetch) {
  const url = new URL(PACKAGE, registry.endsWith('/') ? registry : `${registry}/`);
  const response = await request(url, { headers: { accept: 'application/vnd.npm.install-v1+json, application/json' }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const version = (await response.json() as { 'dist-tags'?: Record<string, unknown> })['dist-tags']?.[tag];
  if (typeof version !== 'string') throw new Error(`仓库里没有 ${tag} 版本`);
  return version;
}
// PATH 上的 npm 可能属于另一个 Node，这里只用运行这个命令的 Node 自带的。
async function npmEntry() {
  const folder = path.dirname(process.execPath);
  for (const file of [path.join(folder, 'node_modules/npm/bin/npm-cli.js'), path.join(folder, '../lib/node_modules/npm/bin/npm-cli.js')]) if (await exists(file)) return file;
  throw new Error('找不到这个 Node 自带的 npm。');
}
const installed = async (packageRoot: string) => (JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as { version: string; publishConfig?: { registry?: string; tag?: string } });
async function install(packageRoot: string, prefix: string, version: string, registry: string) {
  const npm = await npmEntry();
  await new Promise<void>((resolve, reject) => execFile(process.execPath, [npm, 'install', '-g', `${PACKAGE}@${version}`, '--prefix', prefix, '--registry', registry, '--no-audit', '--no-fund'], { windowsHide: true, timeout: 300000, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => error ? reject(new Error(stderr.trim().slice(-800) || error.message)) : resolve()));
  if ((await installed(packageRoot)).version !== version) throw new Error(`npm 没有把 ${version} 装到 ${packageRoot}。`);
}
// 装了新包返回 true，由新包接着切换。连不上仓库不算失败：已经装好的包照样能切换。
export async function fetchNewerRelease(packageRoot: string, current: string, options: { registry?: string | undefined; log: (message: string) => void }) {
  const config = (await installed(packageRoot)).publishConfig, registry = options.registry ?? config?.registry, prefix = installPrefix(packageRoot);
  if (!registry || !prefix) return false;
  let version: string;
  try { version = await registryVersion(registry, config?.tag ?? 'latest'); }
  catch (error) { options.log(`没有查到新版本（${registry}：${error instanceof Error ? error.message : '请求失败'}）。`); return false; }
  if (compareVersions(version, current) <= 0) return false;
  options.log(`正在下载 ${version}…`);
  try { await install(packageRoot, prefix, version, registry); }
  catch (error) { throw new Error(`下载 ${version} 失败，运行版本没有变化。${error instanceof Error ? error.message : ''}`); }
  return true;
}
