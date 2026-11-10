import { access, chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { VERSION, STATE_VERSION } from './version.js';
import { loadConfig } from './config.js';
import {copyExtensionFiles,extensionDefaults} from './extension-defaults.js';
import { ClientSetup } from './client-setup.js';
import { gatewayClientSetup } from './gateway-setup.js';
import { withManagementMutex } from './management-lock.js';
import { assertDatabaseReadable, databaseStateVersion } from './state-compatibility.js';

export type Role = 'local' | 'gateway';
export const roles: Role[] = ['local', 'gateway'];
const exec = promisify(execFile), versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const Version = z.string().regex(versionPattern);
const Active = z.object({ product: z.literal('saltedfish-npm'), version: Version, previous: Version.optional(), stateVersion: z.number().int().positive() }).strict();
const Maintenance = z.object({
  schemaVersion: z.literal(1), id: z.string().uuid(), pid: z.number().int().positive(), createdAt: z.string(),
  phase: z.enum(['prepared', 'stopped', 'activated', 'extension_synced', 'starting', 'committed', 'rolling_back', 'rolled_back']),
  before: Active, after: Active, wasRunning: z.array(z.enum(['local', 'gateway'])).max(2),
}).strict();
type MaintenanceRecord = z.infer<typeof Maintenance>;
const Release = z.object({ product: z.literal('saltedfish-npm'), version: Version, stateVersion: z.number().int().positive(), files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)) }).strict();
export const Running = z.object({ role: z.enum(['local','gateway']), port: z.number().int().min(1024).max(65535), token: z.string().regex(/^[a-f0-9]{64}$/), instanceId: z.string().uuid(), pid: z.number().int().positive(), version: Version, startedAt: z.string(), home: z.string() }).strict();
export const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
export async function retryFile<T>(work:()=>Promise<T>):Promise<T>{for(let attempt=0;;attempt++){try{return await work();}catch(e){if(attempt>=5||!['EPERM','EACCES','EBUSY'].includes((e as NodeJS.ErrnoException).code||''))throw e;await pause(20*2**attempt);}}}
export const removeFile = (file: string) => retryFile(()=>rm(file,{force:true}));
export const renameFile = (from: string, to: string) => retryFile(()=>rename(from,to));
export const exists = async (file: string) => { try { await retryFile(()=>access(file)); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } };
export const readJson = async (file: string) => JSON.parse((await retryFile(()=>readFile(file,'utf8'))).replace(/^\uFEFF/, ''));
export function defaultHome() { return process.env.SALTEDFISH_HOME || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(),'AppData/Local'),'SaltedFish/npm') : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(),'.local/share'),'saltedfish')); }
export function dataPath(home: string, role: Role) { return path.join(home,'data',role); }
export function runPath(home: string, role: Role) { return path.join(home,'run',`${role}.json`); }
export function stopPath(home: string, role: Role) { return path.join(home,'run',`${role}.stopped`); }
export function releasePath(home: string, version: string) { if (!versionPattern.test(version)) throw new Error('版本标记无效。'); return path.join(home,'versions',version); }
export async function atomicJson(file: string, data: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(data, null, 2)); await handle.sync(); } finally { await handle.close(); }
    await retryFile(() => rename(temp, file));
    // Windows 不支持通过 Node 打开目录 fsync；文件内容已 flush，POSIX 另外持久化目录项。
    if (process.platform !== 'win32') { const directory = await open(path.dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
  } finally { await retryFile(() => rm(temp, { force: true })); }
}
// 按裸名查找会命中 PATH 或当前目录里的同名程序，例如 Git Bash 的 whoami 不接受 Windows 参数。
const windowsSystemFile = (...segments: string[]) => path.join(process.env.SystemRoot || process.env.windir || 'C:/Windows', 'System32', ...segments);
async function privateDirectory(directory: string) {
  await mkdir(directory,{recursive:true,mode:0o700});
  if(process.platform==='win32') {
    const identity=(await exec(windowsSystemFile('whoami.exe'),['/user','/fo','csv','/nh'],{windowsHide:true})).stdout.match(/S-1-5-[0-9-]+/g)?.at(-1);
    if(!identity)throw new Error('无法确认当前 Windows 用户，未初始化数据目录。');
    await exec(windowsSystemFile('icacls.exe'),[directory,'/inheritance:r','/grant:r',`*${identity}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F'],{windowsHide:true});
  } else await chmod(directory,0o700);
}
export async function requireHome(home: string) {
  const marker=await readJson(path.join(home,'installation.json'));
  if(marker.product!=='saltedfish-npm')throw new Error('此目录不是 SaltedFish npm 安装。');
  return await realpath(home);
}
export async function ensureHome(value: string) {
  let home=path.resolve(value); if(path.dirname(home)===home)throw new Error('不能把磁盘根目录作为 SaltedFish 数据目录。');
  if(await exists(path.join(home,'installation.json')))return requireHome(home);
  if(await exists(home) && (await readdir(home)).length)throw new Error('目标目录非空且没有 SaltedFish npm 标记；请指定新的 --home，不会接管旧安装。');
  await privateDirectory(home); home=await realpath(home);
  await writeFile(path.join(home,'installation.json'),JSON.stringify({product:'saltedfish-npm',createdAt:new Date().toISOString()}),{flag:'wx',mode:0o600});
  for(const dir of ['versions','data','run','logs'])await mkdir(path.join(home,dir),{mode:0o700});
  return home;
}
export function processAlive(pid: number) { try { process.kill(pid,0); return true; } catch(e) { if((e as NodeJS.ErrnoException).code==='ESRCH')return false; return true; } }

// ---- 进程身份核对（只读，绝不结束进程）----
// PID 会被系统复用，“进程存在”不等于“还是当初记录的那个进程”。记录写入时原进程必然已经存在，
// 所以同一 PID 的进程若启动得比记录时间还晚，就只可能是 PID 复用后的无关进程。
export type ProcessInfo = { startedMs?: number; commandLine?: string } | 'gone' | 'unknown';
export type Owner = { state: 'dead' | 'reused' | 'alive' | 'unknown'; commandLine?: string };
const START_GRACE_MS = 2000; // 系统启动时间与记录时钟之间的容差（Linux 由 jiffies 换算，约有秒级误差）。
export function parseProcStat(stat: string) {
  // 进程名可能含空格和括号，所以从最后一个 ')' 起算；第 22 个字段是启动时刻（jiffies）。
  const end = stat.lastIndexOf(')'); if (end < 0) return undefined;
  const fields = stat.slice(end + 2).split(' '), startTicks = Number(fields[19]);
  return fields[0] && Number.isFinite(startTicks) ? { state: fields[0], startTicks } : undefined;
}
async function inspectWindows(pid: number): Promise<ProcessInfo> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown'; // pid 会拼进脚本文本，只接受正整数。
  const powershell = windowsSystemFile('WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$p=Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop;if($p){[pscustomobject]@{commandLine=$p.CommandLine;created=$p.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}|ConvertTo-Json -Compress}`;
  const { stdout } = await exec(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  if (!stdout.trim()) return 'gone';
  const value = JSON.parse(stdout), startedMs = Date.parse(value.created);
  return Number.isFinite(startedMs) ? { startedMs, commandLine: typeof value.commandLine === 'string' ? value.commandLine : undefined } : 'unknown';
}
// 纯函数：由 /proc 内容换算进程信息（便于在没有 Linux 的机器上用夹具验证）。uptime 单位为秒。
export function linuxProcessInfo(input: { target: string; own: string; cmdline: string; now: number; uptime: number; ownUptime: number }): ProcessInfo {
  const target = parseProcStat(input.target), own = parseProcStat(input.own); if (!target || !own) return 'unknown';
  if (target.state === 'Z' || target.state === 'X') return 'gone'; // 僵尸进程已经退出，只是父进程没有回收。
  const boot = input.now - input.uptime * 1000, toMs = (ticks: number) => boot + ticks * 1000 / 100; // USER_HZ 在 Linux 上固定为 100。
  // 自校验：用本进程已知的启动时间核对换算；偏差过大就放弃判断，按未知处理。
  if (Math.abs(toMs(own.startTicks) - (input.now - input.ownUptime * 1000)) > 5000) return 'unknown';
  return { startedMs: toMs(target.startTicks), commandLine: input.cmdline.split('\0').join(' ').trim() || undefined };
}
async function inspectLinux(pid: number): Promise<ProcessInfo> {
  let target: string;
  try { target = await readFile(`/proc/${pid}/stat`, 'utf8'); }
  catch (e) { return ['ENOENT', 'ESRCH'].includes((e as NodeJS.ErrnoException).code || '') ? 'gone' : 'unknown'; }
  const [own, cmdline] = await Promise.all([readFile('/proc/self/stat', 'utf8'), readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')]);
  return linuxProcessInfo({ target, own, cmdline, now: Date.now(), uptime: os.uptime(), ownUptime: process.uptime() });
}
async function inspectProcess(pid: number): Promise<ProcessInfo> {
  if (pid === process.pid) return { startedMs: Date.now() - process.uptime() * 1000, commandLine: process.argv.join(' ') };
  try {
    if (process.platform === 'win32') return await inspectWindows(pid);
    if (process.platform === 'linux') return await inspectLinux(pid);
  } catch { /* 探测失败不等于进程已不存在，按未知处理。 */ }
  return 'unknown';
}
// 测试替身入口：生产代码经这里读取进程信息、清理维护标记。
export const hooks: { inspectProcess: (pid: number) => Promise<ProcessInfo>; removeMarker: (file: string) => Promise<unknown> } = { inspectProcess, removeMarker: removeFile };
// since 是记录写入的时间（毫秒）。dead/reused 说明原进程已不在；alive/unknown 都按“可能仍在”处理，保持不抢占。
export async function processOwner(pid: number, since: number): Promise<Owner> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !processAlive(pid)) return { state: 'dead' };
  const info = await hooks.inspectProcess(pid);
  if (info === 'gone') return { state: 'dead' };
  if (info === 'unknown') return { state: 'unknown' };
  if (info.startedMs === undefined || !Number.isFinite(since)) return { state: 'unknown', commandLine: info.commandLine };
  return { state: info.startedMs > since + START_GRACE_MS ? 'reused' : 'alive', commandLine: info.commandLine };
}

// 另一个管理操作正在进行（互斥或 beta.20 遗留锁被活进程持有）：稍后重试通常能成功，与需要人工恢复的错误区分。
export class LockBusyError extends Error {}
export async function withLock<T>(home: string, work: ()=>Promise<T>) {
  let inside = false;
  try { return await withManagementMutex(home, () => { inside = true; return withLegacyLock(home, work); }); }
  catch (error) {
    // 取互斥阶段失败只表示另一个管理操作正在进行；进入之后的错误（包括 work 自己的）原样抛出。
    if (!inside && error instanceof Error && error.message.startsWith('另一个安装或恢复操作仍在进行')) throw new LockBusyError(error.message);
    throw error;
  }
}
type LockState =
  | { kind: 'none' }
  | { kind: 'live'; pid: number }
  | { kind: 'stale'; pid: number; reason: 'dead' | 'reused' }
  | { kind: 'damaged'; ageMs: number; fresh: boolean };
const DAMAGED_LOCK_MS = 10_000; // beta.20 管理进程创建锁文件到写入内容只隔极短时间；超过它仍不完整就是中断遗留。
// manage.lock 只剩兼容 beta.20 的作用（beta.21 起由 management-lock.sqlite 的系统互斥串行化）。
async function inspectManageLock(file: string): Promise<LockState> {
  let text: string, modified: number;
  try { text = await retryFile(() => readFile(file, 'utf8')); modified = (await stat(file)).mtimeMs; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' }; throw e; }
  let owner: { pid?: unknown } | undefined; try { owner = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { /* 空文件或被截断 */ }
  const pid = owner?.pid, age = Math.max(0, Date.now() - modified);
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return { kind: 'damaged', ageMs: age, fresh: age < DAMAGED_LOCK_MS };
  const state = (await processOwner(pid, modified)).state; // 锁写于其持有者启动之后；晚于锁文件才启动的同号进程不可能是持有者。
  return state === 'dead' || state === 'reused' ? { kind: 'stale', pid, reason: state } : { kind: 'live', pid };
}
async function withLegacyLock<T>(home: string, work: ()=>Promise<T>) {
  if(await exists(path.join(home,'recover.lock')))throw new Error('发现恢复锁 recover.lock：可能有恢复进程正在核查，或上次恢复被中断。稍后重试；仍存在时运行 saltedfish recover-lock 清理。');
  const pending=await maintenanceReport(home,false);
  if(pending)throw new Error(`有未完成维护事务${maintenanceDetail(pending)}。运行 saltedfish recover-lock 核查恢复后再继续。`);
  const file=path.join(home,'manage.lock'),held=await inspectManageLock(file);
  if(held.kind==='live')throw new LockBusyError('另一个安装/启停操作仍在进行。请稍后重试；不会抢占或杀死进程。');
  if(held.kind==='stale')throw new Error(`发现已退出管理进程的遗留锁（PID ${held.pid} ${held.reason==='reused'?'已被无关进程复用':'已退出'}）。确认没有安装/启停操作后运行 saltedfish recover-lock；不自动抢锁。`);
  if(held.kind==='damaged') {
    if(held.fresh)throw new LockBusyError('管理锁刚刚创建，内容尚不完整，可能有管理操作正在写入；请稍后重试。');
    throw new Error('管理锁文件为空或已损坏（可能上次管理进程中途退出）。确认没有安装/启停操作后运行 saltedfish recover-lock 清理。');
  }
  let lock:Awaited<ReturnType<typeof open>>;
  try { lock=await open(file,'wx',0o600); }
  catch(e) { if((e as NodeJS.ErrnoException).code==='EEXIST')throw new LockBusyError('另一个安装/启停操作仍在进行。请稍后重试；不会抢占或杀死进程。');throw e; }
  const id=randomUUID();let written=false;
  try { await lock.writeFile(JSON.stringify({pid:process.pid,id})); await lock.sync(); written=true; return await work(); }
  // 写入失败（如磁盘写满）时这个空文件就是我们刚创建的，必须清掉，否则留下无人认领的空锁。
  finally { await lock.close(); if(!written||(await readJson(file).catch(()=>({}))).id===id)await removeFile(file); }
}
export async function recoverLock(home: string, options: { forgetRun?: Role } = {}) {
  return withManagementMutex(home, async () => {
    const file = path.join(home, 'manage.lock'), gate = path.join(home, 'recover.lock');
    const hadGate = await exists(gate), hadMaintenance = await exists(path.join(home, 'maintenance'));
    // 先核对、后动手：任何一项拒绝时都不改动现场。
    const lock = await inspectManageLock(file);
    if (lock.kind === 'live') throw new Error(`管理锁所属进程 (PID ${lock.pid}) 仍存在，未清理；不会抢占或杀死进程。`);
    if (lock.kind === 'damaged' && lock.fresh) throw new Error('管理锁刚刚创建且内容尚不完整，可能有管理操作正在写入；请稍后重试 saltedfish recover-lock。');
    if (hadGate) {
      const owner = await readJson(gate).catch(() => undefined);
      const state = owner?.pid ? (await processOwner(owner.pid, Date.parse(owner.createdAt))).state : 'dead';
      if (state === 'alive' || state === 'unknown') throw new Error('恢复进程仍存在，未抢占恢复操作。');
    }
    const forget = options.forgetRun ? await checkForget(home, options.forgetRun) : undefined;
    // beta.20 的 recover.lock 没有内容；保留原文件用于诊断，不要求用户手删。
    if (hadGate) await renameFile(gate, path.join(home, `recover-abandoned-${randomUUID()}.json`));
    await atomicJson(gate, { pid: process.pid, id: randomUUID(), createdAt: new Date().toISOString() });
    try {
      const runRecord = forget ? await discardRunRecord(home, forget) : undefined;
      const maintenance = hadMaintenance ? await recoverMaintenance(home) : undefined;
      if (lock.kind !== 'none') await removeFile(file);
      return {
        recovered: lock.kind !== 'none' || hadGate || hadMaintenance || !!runRecord,
        ...(lock.kind === 'stale' ? { lock: { reason: lock.reason, pid: lock.pid } } : lock.kind === 'damaged' ? { lock: { reason: 'damaged' as const } } : {}),
        ...(runRecord ? { runRecord } : {}), ...(maintenance ? { maintenance } : {}),
      };
    } finally { await removeFile(gate); }
  });
}
// --forget-run：仅丢弃陈旧的运行记录（改名留档），绝不结束任何进程；确属原服务的存活进程只能由用户自行结束。
async function checkForget(home: string, role: Role) {
  if (!roles.includes(role)) throw new Error('--forget-run 需要 local 或 gateway。');
  let record: Awaited<ReturnType<typeof runningRecord>>;
  try { record = await runningRecord(home, role); }
  catch (e) { return { role, state: 'invalid', error: e instanceof Error ? e.message : '运行记录无法读取' }; } // 记录损坏或属于其他安装，同样没有别的清理办法。
  if (!record) return undefined;
  const status = await serviceStatus(home, role);
  if (status.state === 'running') throw new Error(`${role} 服务仍在运行，不能丢弃它的运行记录；先运行 stop。`);
  if (status.state === 'unreachable' && status.identity === 'matches') throw new Error(status.hint);
  return { role, pid: record.pid, state: status.state as string };
}
async function discardRunRecord(home: string, found: NonNullable<Awaited<ReturnType<typeof checkForget>>>) {
  const archived = path.join(home, 'run', `${found.role}.abandoned-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  await renameFile(runPath(home, found.role), archived);
  return { ...found, file: archived };
}
export async function active(home: string) { return Active.parse(await readJson(path.join(home,'active.json'))); }
export async function saveActive(home: string, value: z.infer<typeof Active>) { await atomicJson(path.join(home,'active.json'),Active.parse(value)); }
function contained(root: string, relative: string) {
  if(!relative||relative.includes('\\')||path.posix.isAbsolute(relative)||relative.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('发行文件路径无效。');
  const file=path.resolve(root,relative); if(!file.startsWith(path.resolve(root)+path.sep))throw new Error('发行文件路径越界。');return file;
}
export async function verifyRelease(root: string) {
  const manifest=Release.parse(await readJson(path.join(root,'saltedfish-release.json')));
  for(const required of ['package.json','dist/npm-cli.js','dist/npm-worker.js','dist/cli.js','dist/gateway-cli.js','dist/extension/manifest.json','ui/index.html'])if(!manifest.files[required])throw new Error(`发行包缺少 ${required}`);
  const base=await realpath(root);
  for(const[relative,expected]of Object.entries(manifest.files)) {
    const file=contained(root,relative),resolved=await realpath(file);
    if(!resolved.startsWith(base+path.sep)||(await lstat(file)).isSymbolicLink())throw new Error('发行包含越界或链接文件。');
    if(createHash('sha256').update(await readFile(file)).digest('hex')!==expected)throw new Error(`发行文件校验失败：${relative}`);
  }
  return manifest;
}
export async function stageRelease(home: string, source: string) {
  const manifest=await verifyRelease(source);
  if(manifest.version!==VERSION)throw new Error('npm 包和运行代码的版本不一致。');
  const destination=releasePath(home,manifest.version);
  if(await exists(destination)) {
    await verifyRelease(destination);
    if(JSON.stringify(await readJson(path.join(destination,'saltedfish-release.json')))!==JSON.stringify(manifest))throw new Error('同一版本内容不同，不能覆盖不可变运行版本。');
    return manifest;
  }
  const staging=path.join(home,'versions',`.stage-${randomUUID()}`);await mkdir(staging,{mode:0o700});
  try {
    for(const relative of Object.keys(manifest.files)) { const target=contained(staging,relative);await mkdir(path.dirname(target),{recursive:true});await copyFile(contained(source,relative),target); }
    await copyFile(path.join(source,'saltedfish-release.json'),path.join(staging,'saltedfish-release.json'));
    await verifyRelease(staging); await renameFile(staging,destination);
  } finally { await retryFile(()=>rm(staging,{recursive:true,force:true})); } // staging 由本函数在已校验 home 内创建。
  return manifest;
}
// 固定 launcher 是 AI 客户端配置里的稳定入口，内容升级只能经受控迁移：只替换历史上发布过的已知内容（SHA-256 白名单），用户改过的仍拒绝覆盖。
// 维护标记存在时，launcher 在委派给任何版本之前就退出，所以这里的文案必须自己说清阶段、是否仍在进行，以及唯一的出口 recover-lock。
const launcherSource=`import{readFile,access}from'node:fs/promises';import{spawn}from'node:child_process';import path from'node:path';import{fileURLToPath}from'node:url';
const home=path.dirname(fileURLToPath(import.meta.url));
async function notice(){let m;try{m=JSON.parse((await readFile(path.join(home,'maintenance'),'utf8')).replace(/^\\uFEFF/,''));}catch{}
if(!m||typeof m!=='object')return'SaltedFish 有未完成的升级/维护事务。运行 saltedfish recover-lock 核查恢复后再重连 MCP；saltedfish status 可查看详情。';
let up=false;try{process.kill(m.pid,0);up=true;}catch(e){up=e.code==='EPERM';}
const detail='阶段 '+m.phase+(m.before&&m.after?'，'+m.before.version+' → '+m.after.version:'')+(m.createdAt?'，始于 '+m.createdAt:'');
if(up&&Date.now()-Date.parse(m.createdAt)<6e5)return'SaltedFish 正在升级（'+detail+'）。请稍后重连；超过几分钟仍无变化时运行 saltedfish recover-lock 核查恢复。';
return'SaltedFish 有未完成的升级/维护事务（'+detail+'），'+(up?'已长时间没有进展':'发起它的管理进程已退出')+'。运行 saltedfish recover-lock 核查恢复后再重连 MCP。';}
try{let pending=true;try{await access(path.join(home,'maintenance'));}catch(e){if(e.code==='ENOENT')pending=false;}if(pending)throw new Error(await notice());const s=JSON.parse(await readFile(path.join(home,'active.json'),'utf8'));if(s.product!=='saltedfish-npm'||!/^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$/.test(s.version))throw new Error('SaltedFish 版本标记无效');const p=spawn(process.execPath,[path.join(home,'versions',s.version,'dist/npm-cli.js'),...process.argv.slice(2),'--home',home],{stdio:'inherit',windowsHide:true});p.on('error',e=>{console.error(e.message);process.exitCode=1;});p.on('exit',(code)=>process.exit(code??1));for(const sig of['SIGTERM','SIGINT'])process.on(sig,()=>p.kill(sig));}catch(e){console.error(e.message);process.exitCode=1;}
`;
const legacyLauncherHashes=new Set(['e0aee57ed0723b7fcd89b46b2a9bc49ca4065ec9269fa8c717615dc41e568f53']); // beta.16–beta.21 发布的 launcher。
export async function writeLauncher(home: string): Promise<'created'|'current'|'updated'> {
  const file=path.join(home,'launcher.mjs');
  if(await exists(file)) {
    const current=await readFile(file,'utf8');
    if(current===launcherSource)return 'current';
    if(!legacyLauncherHashes.has(createHash('sha256').update(current).digest('hex')))throw new Error('固定 launcher 内容不同，不能静默覆盖。');
    const temp=`${file}.${randomUUID()}.tmp`;
    try { await writeFile(temp,launcherSource,{flag:'wx',mode:0o600}); await renameFile(temp,file); } finally { await removeFile(temp); }
    return 'updated';
  }
  await writeFile(file,launcherSource,{flag:'wx',mode:0o600});return 'created';
}
export function coreEnv(home: string, role: Role): NodeJS.ProcessEnv { return {...process.env,SALTEDFISH_HOME:home,SALTEDFISH_MANAGED:'1',SALTEDFISH_ENTRY:path.join(home,'launcher.mjs'),CHROME_MCP_DATA_DIR:dataPath(home,role)}; }
export async function runCore(home: string, role: Role, args: string[], capture=false, directory=dataPath(home,role)) {
  const current=await active(home),entry=path.join(releasePath(home,current.version),'dist',role==='local'?'cli.js':'gateway-cli.js');
  const all=role==='gateway'?[...args,'--data-dir',directory]:args;
  const child=spawn(process.execPath,[entry,...all],{env:coreEnv(home,role),stdio:capture?['ignore','pipe','pipe']:'inherit',windowsHide:true});let stdout='',stderr='';
  child.stdout?.on('data',c=>stdout=(stdout+c).slice(-1024*1024));child.stderr?.on('data',c=>stderr=(stderr+c).slice(-16000));
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  if(code!==0)throw new Error(capture?stderr.trim().slice(-3000)||`命令失败 (${code})`:`命令失败 (${code})`);return stdout;
}
export async function runningRecord(home: string, role: Role) { const file=runPath(home,role);let value:unknown;try{value=await readJson(file);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}const record=Running.parse(value);if(record.home!==home||record.role!==role)throw new Error('服务管理记录属于其他安装或类型，未操作进程。');return record; }
export async function control(record: z.infer<typeof Running>, action: 'status'|'stop', force=false): Promise<any> {
  const r=await fetch(`http://127.0.0.1:${record.port}/${action}`,{method:action==='stop'?'POST':'GET',headers:{authorization:`Bearer ${record.token}`,'content-type':'application/json'},...(action==='stop'?{body:JSON.stringify({instanceId:record.instanceId,force})}:{}),signal:AbortSignal.timeout(2500)});
  const result=await r.json() as any;
  if(!r.ok)throw new Error(result.error||'服务管理请求失败。');
  if(result.instanceId!==record.instanceId||result.home!==record.home||result.role!==record.role)throw new Error('服务管理身份不匹配，未操作此进程。');
  return result;
}
export async function serviceStatus(home: string, role: Role) {
  const record=await runningRecord(home,role);const stopped=await exists(stopPath(home,role));
  if(!record)return {role,state:'stopped',stoppedExplicitly:stopped};
  try { return {...await control(record,'status'),state:'running',stoppedExplicitly:stopped}; }
  catch {
    const base={role,stoppedExplicitly:stopped,version:record.version,pid:record.pid},owner=await processOwner(record.pid,Date.parse(record.startedAt));
    if(owner.state==='dead')return {...base,state:'crashed'};
    // 同号进程比记录里的服务启动得更晚，或命令行明确不是本安装的后台：原服务早已退出，PID 被无关进程复用。
    // 按崩溃处理，start 会覆盖陈旧记录，不会触碰那个进程。命令行读不到时只凭启动时间判断，判断不了就保持 unreachable。
    if(owner.state==='reused'||owner.commandLine!==undefined&&!/npm-worker/.test(owner.commandLine))return {...base,state:'crashed',pidReused:true,hint:`${role} 的运行记录已陈旧：PID ${record.pid} 现属另一个无关进程（启动晚于记录，或命令行不是 SaltedFish 后台），原服务早已退出。运行 start 会覆盖该记录，不会触碰那个进程。`};
    const matches=owner.state==='alive';
    return {...base,state:'unreachable',identity:matches?'matches':'unverified',hint:unreachableHint(role,record.pid,matches)};
  }
}
function unreachableHint(role: Role, pid: number, matches: boolean) {
  return matches
    ? `${role} 的管理端口无响应，但记录的进程 (PID ${pid}) 仍是该服务。SaltedFish 不会按 PID 强杀；请查看 logs，自行结束该进程后再运行 start。`
    : `${role} 的管理端口无响应，且无法确认记录的进程 (PID ${pid}) 是否仍是该服务。若确认它已不是本服务（例如重启后 PID 被其他程序占用），运行 saltedfish recover-lock --forget-run ${role} 丢弃陈旧运行记录（只删记录，不结束任何进程）。`;
}
export async function stopService(home: string, role: Role, force=false, mark=true) {
  const status=await serviceStatus(home,role),record=await runningRecord(home,role);
  if(status.state==='unreachable')throw new Error(`管理端口不可达且记录的进程仍存在；拒绝按 PID 强杀。${status.hint}`);
  if(status.state==='running'&&record) {
    await control(record,'stop',force);
    for(let i=0;i<100;i++){if((await serviceStatus(home,role)).state!=='running')break;await pause(100);}
    const after=await serviceStatus(home,role);if(after.state==='running'||after.state==='unreachable')throw new Error('服务尚未完全退出，未继续切换版本。');
  }
  if(mark)await writeFile(stopPath(home,role),new Date().toISOString(),{mode:0o600});
}
export async function startService(home: string, role: Role, automatic=false) {
  if(automatic&&await exists(stopPath(home,role)))throw new Error('服务已被显式停止。运行 saltedfish start 后再连接 MCP。');
  const current=await active(home),status=await serviceStatus(home,role);
  if(status.state==='running') { if(status.version!==current.version)throw new Error('运行服务与活动版本不一致，请检查后升级。');return status; }
  if(status.state==='unreachable')throw new Error(`已有服务管理记录不可达，未重复启动或强杀进程。${status.hint}`);
  const config=path.join(dataPath(home,role),role==='local'?'config.json':'gateway.json');if(!await exists(config))throw new Error(role==='local'?'请先运行 saltedfish install。':'请先运行 saltedfish gateway init。');
  await removeFile(stopPath(home,role));
  const log=path.join(home,'logs',`${role}.log`);
  if(await exists(log)&&(await stat(log)).size>8*1024*1024)await renameFile(log,`${log}.previous`);
  const output=await open(log,'a',0o600);
  const child=spawn(process.execPath,[path.join(releasePath(home,current.version),'dist/npm-worker.js'),role,home],{cwd:home,env:coreEnv(home,role),detached:true,windowsHide:true,stdio:['ignore',output.fd,output.fd]});
  let failed: Error|undefined,exited=false;child.once('error',e=>failed=e);child.once('exit',()=>exited=true);child.unref();await output.close();
  for(let i=0;i<100;i++){const ready=await serviceStatus(home,role);if(ready.state==='running'&&ready.pid===child.pid)return ready;if(failed||exited)break;await pause(100);}
  throw new Error(`服务未就绪；检查 ${log}。未杀死其他进程或重放操作。`);
}
export async function maintenance<T>(home: string, work:()=>Promise<T>) {
  const marker = path.join(home, 'maintenance');
  await writeFile(marker, new Date().toISOString(), { flag: 'wx', mode: 0o600 });
  try { return await work(); } finally { await removeFile(marker); }
}
async function syncExtension(home:string,version:string){
  if(!await exists(path.join(dataPath(home,'local'),'config.json')))return;
  const config=await loadConfig(dataPath(home,'local')),directory=path.join(config.dataDir,'extension');
  await copyExtensionFiles(path.join(releasePath(home,version),'dist/extension'),directory);
  await writeFile(path.join(directory,'pairing.json'),JSON.stringify(extensionDefaults(config)),{mode:0o600});
}
async function checkpoint(home: string, record: MaintenanceRecord, phase: MaintenanceRecord['phase']) {
  record.phase = phase;
  await atomicJson(path.join(home, 'maintenance'), record);
}
async function recoverMaintenance(home: string) {
  const marker = path.join(home, 'maintenance'), database = path.join(dataPath(home, 'local'), 'state.sqlite');
  const text = await readFile(marker, 'utf8');
  let record: MaintenanceRecord | undefined;
  try { record = Maintenance.parse(JSON.parse(text)); }
  catch {
    // 旧版只有时间戳，不能推断原先运行的角色；只对齐现有活动版本，不自行启动停止的服务。
    if (!/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(text.trim())) throw new Error('维护记录损坏，未猜测版本或清理标记；请保留文件进行诊断。');
  }
  const current = await active(home);
  const states = await Promise.all(roles.map(role => serviceStatus(home, role)));
  if (states.some(state => state.state === 'unreachable' || state.state === 'running' && state.busy)) throw new Error(`恢复暂未执行：服务不可达或仍有任务。先核查 status/logs，维护记录已保留，不强停或重放任务。${states.flatMap(state => state.hint ? [state.hint] : []).join(' ')}`.trim());
  if (!record) {
    const release = await verifyRelease(releasePath(home, current.version));
    await assertDatabaseReadable(database, release.stateVersion);
    if (states.some(state => state.state === 'running' && state.version !== current.version)) throw new Error('旧维护记录无法解释运行版本差异，未清理；请先核查服务。');
    await syncExtension(home, current.version);
    await removeFile(marker);
    return { state: 'reconciled_legacy', version: current.version, note: '已核对活动版本和服务身份；原维护记录没有运行角色，停止的服务保持停止，可显式 start。' };
  }
  if (![record.before.version, record.after.version].includes(current.version)) throw new Error('活动版本不属于遗留事务，未更改安装。');
  // 数据库格式只增不减。提交点之前默认回到旧版本；但新版本一旦把数据库升到旧版本读不了的格式，回退会让旧版本面对不认识的数据，
  // 这时只能向前完成（绝不恢复旧任务库来降级）。方向以停稳服务后的实际数据库格式为准。
  const committed = record.phase === 'committed';
  // 预检（只读）：格式超出可用版本能读取的范围时，在停任何服务之前就拒绝，现场与服务原样保留。
  const supported = committed ? record.after.stateVersion : Math.max(record.before.stateVersion, record.after.stateVersion), format = await databaseStateVersion(database);
  if (format > supported) throw new Error(`当前任务数据库格式 ${format} 超过升级前后两个版本支持的 ${supported}；没有已知版本能安全读取它，维护记录与服务原样保留，不回滚任务数据库。请保留数据库和 maintenance 文件，联系维护者协助收尾。`);
  let forward = committed || format > record.before.stateVersion;
  let release = await verifyRelease(releasePath(home, (forward ? record.after : record.before).version));
  if (!committed) await checkpoint(home, record, forward ? 'committed' : 'rolling_back');
  for (const role of roles) await stopService(home, role, false, false);
  // 新服务在被停止前仍可能写入更高格式的持久收据；停稳后重新读实际数据库，不能仅依赖停服务前的判断。
  if (!forward && await databaseStateVersion(database) > record.before.stateVersion) {
    forward = true; release = await verifyRelease(releasePath(home, record.after.version)); await checkpoint(home, record, 'committed');
  }
  const destination = forward ? record.after : record.before;
  await assertDatabaseReadable(database, release.stateVersion);
  await saveActive(home, destination);
  await syncExtension(home, destination.version);
  for (const role of record.wasRunning) await startService(home, role);
  if (!forward) await checkpoint(home, record, 'rolled_back');
  await removeFile(marker);
  const state = committed ? 'completed' : forward ? 'completed_forward' : 'rolled_back';
  return { state, version: destination.version, restoredRoles: record.wasRunning, ...(state === 'completed_forward' ? { note: '任务数据库已升级到旧版本无法读取的格式，不能回退；已向前完成升级并清除维护标记。请在客户端重新连接 MCP。' } : {}) };
}
export async function switchVersion(home: string, version: string) {
  const old=await active(home);if(old.version===version)return;
  const next=await verifyRelease(releasePath(home,version));if(next.stateVersion<old.stateVersion)throw new Error('旧版本不能读取当前数据结构，拒绝回滚。');
  await assertDatabaseReadable(path.join(dataPath(home, 'local'), 'state.sqlite'), next.stateVersion);
  const states=await Promise.all(roles.map(role=>serviceStatus(home,role)));
  if(states.some(s=>s.state==='unreachable'||s.state==='running'&&s.busy))throw new Error('服务不可达或仍有任务在执行，未升级。先等待任务完成，或核查后显式停止服务。');
  const wasRunning=roles.filter((_,i)=>states[i]!.state==='running');
  if (await exists(path.join(home, 'maintenance'))) throw new Error('有未完成维护事务。运行 saltedfish recover-lock 核查恢复后再升级。');
  const record: MaintenanceRecord = { schemaVersion: 1, id: randomUUID(), pid: process.pid, createdAt: new Date().toISOString(), phase: 'prepared', before: old,
    after: { product: 'saltedfish-npm', version, previous: old.version, stateVersion: next.stateVersion }, wasRunning };
  const warnings: unknown[] = [];
  await checkpoint(home, record, 'prepared');
  try {
    for (const role of wasRunning) await stopService(home, role, false, false);
    await checkpoint(home, record, 'stopped');
    await saveActive(home, record.after);
    await checkpoint(home, record, 'activated');
    await syncExtension(home, version);
    await checkpoint(home, record, 'extension_synced');
    await checkpoint(home, record, 'starting');
    for (const role of wasRunning) await startService(home, role);
    await checkpoint(home, record, 'committed');
  } catch (error) {
    const cause = error instanceof Error ? error.message : '切换失败';
    let recovery: Awaited<ReturnType<typeof recoverMaintenance>>;
    try { recovery = await recoverMaintenance(home); }
    catch (recoveryError) { throw new Error(`切换未完成，已保留维护事务。核查 status/logs 后运行 saltedfish recover-lock；不会强停忙碌服务。${recoveryError instanceof Error ? recoveryError.message : ''} ${cause}`); }
    if (recovery.state === 'completed_forward') warnings.push({ warning: `升级过程中出现错误（${cause}），但任务数据库已升级到旧版本无法读取的格式，无法回退；已向前完成升级。` });
    else if (recovery.state !== 'completed') throw new Error(`切换失败，已恢复活动版本 ${recovery.version}。${cause}`);
  }
  // 提交点已过，版本其实已经切换。清理维护标记失败只告警，不再为它把服务整套停启一遍（recover-lock 随时可以收尾）。
  const marker = path.join(home, 'maintenance');
  try { if (await exists(marker)) await hooks.removeMarker(marker); }
  catch (error) { warnings.push({ warning: `版本已切换并提交，但清理维护标记失败（${error instanceof Error ? error.message : '未知错误'}）。运行 saltedfish recover-lock 完成收尾；在此之前 MCP 入口会提示有未完成事务。` }); }
  // 运行快照已切换成功。客户端更新独立报告，失败不能回退已恢复的服务。
  const clients:unknown[]=[...warnings];
  for(const role of wasRunning){
    try{
      // 使用当前管理器完成目录维护，回滚到不认识 --refresh 的旧版也能更新。
      const setup=role==='local'?new ClientSetup({dataDir:dataPath(home,role)},{catalogRevision:version}):await gatewayClientSetup(dataPath(home,role),version);
      clients.push({role,...await setup.refreshCatalogs()});
    }
    catch{clients.push({role,warning:'服务已切换；客户端目录未自动更新。运行 connect --refresh 后在客户端重连此 MCP。'});}
  }
  return clients;
}

// ---- 只读诊断：status/doctor 与 MCP 入口共用，不取互斥、不改任何文件 ----
type MaintenanceReport = { phase?: MaintenanceRecord['phase']; createdAt?: string; from?: string; to?: string; wasRunning?: Role[]; ownerPid?: number; owner?: Owner['state']; inProgress?: boolean; legacy?: boolean; damaged?: boolean };
const STALE_MAINTENANCE_MS = 10 * 60 * 1000; // 升级通常在一分钟内完成；超过它仍无进展就按中断对待。
async function maintenanceReport(home: string, probeOwner = true): Promise<MaintenanceReport | null> {
  let text: string;
  try { text = await retryFile(() => readFile(path.join(home, 'maintenance'), 'utf8')); }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : { damaged: true }; }
  let record: MaintenanceRecord;
  try { record = Maintenance.parse(JSON.parse(text.replace(/^\uFEFF/, ''))); }
  catch { return /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(text.trim()) ? { legacy: true, createdAt: text.trim() } : { damaged: true }; }
  const report: MaintenanceReport = { phase: record.phase, createdAt: record.createdAt, from: record.before.version, to: record.after.version, wasRunning: record.wasRunning, ownerPid: record.pid };
  if (!probeOwner) return report;
  const owner = await processOwner(record.pid, Date.parse(record.createdAt));
  report.owner = owner.state;
  report.inProgress = (owner.state === 'alive' || owner.state === 'unknown') && Date.now() - Date.parse(record.createdAt) < STALE_MAINTENANCE_MS;
  return report;
}
const maintenanceDetail = (m: MaintenanceReport | null) => m?.phase ? `（阶段 ${m.phase}，${m.from} → ${m.to}，始于 ${m.createdAt}）` : '';
function maintenanceMessage(m: MaintenanceReport) {
  if (m.damaged) return '维护记录 maintenance 无法解析，已原样保留；recover-lock 不会猜测清理。请保留该文件并联系维护者，saltedfish status 可查看详情。';
  if (m.legacy) return '发现 beta.20 之前遗留的维护标记（只有时间戳）。运行 saltedfish recover-lock 核对活动版本后清理，再重连 MCP。';
  if (m.inProgress) return `SaltedFish 正在升级${maintenanceDetail(m)}。请稍后重连；超过几分钟仍无变化时运行 saltedfish recover-lock 核查恢复。`;
  return `SaltedFish 有未完成的升级/维护事务${maintenanceDetail(m)}，${m.owner === 'dead' || m.owner === 'reused' ? '发起它的管理进程已退出' : '已长时间没有进展'}。运行 saltedfish recover-lock 核查恢复后再重连 MCP。`;
}
// MCP 入口在维护标记存在时用它说明阶段、是否仍在进行，以及唯一的出口。
export async function maintenanceNotice(home: string) {
  const report = await maintenanceReport(home);
  return report ? maintenanceMessage(report) : undefined;
}
export async function diagnose(home: string) {
  const services = await Promise.all(roles.map(role => serviceStatus(home, role)));
  const maintenance = await maintenanceReport(home).catch((): MaintenanceReport => ({ damaged: true }));
  const lock = await inspectManageLock(path.join(home, 'manage.lock')).catch((): LockState => ({ kind: 'none' }));
  const recoverGate = await exists(path.join(home, 'recover.lock')).catch(() => false);
  const manageLock = lock.kind === 'none' ? null : lock.kind === 'live' ? { state: 'live' as const, pid: lock.pid }
    : lock.kind === 'stale' ? { state: 'stale' as const, pid: lock.pid, reason: lock.reason } : { state: lock.fresh ? 'fresh' as const : 'damaged' as const, ageSeconds: Math.round(lock.ageMs / 1000) };
  const hints: string[] = [...services.flatMap(service => service.hint ? [service.hint as string] : [])];
  if (maintenance) hints.push(maintenanceMessage(maintenance));
  if (manageLock?.state === 'stale') hints.push(`发现已退出（或 PID 已被无关进程复用）的管理锁 manage.lock（PID ${manageLock.pid}）。确认没有安装/启停操作后运行 saltedfish recover-lock 清理。`);
  if (manageLock?.state === 'damaged') hints.push('管理锁 manage.lock 内容为空或已损坏。确认没有安装/启停操作后运行 saltedfish recover-lock 清理。');
  if (recoverGate) hints.push('发现恢复锁 recover.lock：可能有恢复进程正在核查，或上次恢复被中断。稍后重试；仍存在时运行 saltedfish recover-lock。');
  return { services, management: { maintenance, manageLock, recoverGate }, hints };
}
// MCP 自动启动：几个客户端同时拉起时，后到者在有界时间内等待先到者启动完成，而不是立即失败。
export async function ensureService(home: string, role: Role, automatic: boolean, waitMs = 15000) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if ((await serviceStatus(home, role)).state === 'running') return;
    try { await withLock(home, () => startService(home, role, automatic)); return; }
    catch (error) { if (!(error instanceof LockBusyError) || Date.now() >= deadline) throw error; }
    await pause(200);
  }
}
export { VERSION, STATE_VERSION, randomBytes, randomUUID };
