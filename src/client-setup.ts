import { access, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { applyEdits, modify } from 'jsonc-parser';
import { clientDocument, parseClientJson as parsed } from './client-document.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openCodeConfig, browserPermission, legacyBrowserPermission, LEGACY_MCP_NAME, MCP_NAME, withCatalogRevision, CODEX_TOOL_SCHEMA_MAX_BYTES, type ClientEntry, type SetupEntry, type ClientTrust } from './client-config.js';
import { mergeCodex, mergeCodexHeaders, parseCodex, removeCodexServer } from './codex-config.js';
import { collectMachineIdentity, machineIdentityHeaders, preserveMachineIdentity, MACHINE_IDENTITY_HEADER } from './machine-identity.js';
import { agyExceptions, agyTrusted, claudeExceptions, claudeTrusted, codebuddyExceptions, codebuddyTrusted, mergeAgySettings, mergeClaudeSettings, mergeCodebuddySettings } from './client-permissions.js';
import { clientJsonc, clientLabels, clientLazyCredential, clientOwnApprovals, clientUserOnly, setupClients, type SetupClient } from './client-types.js';
import { desktopConfigPath, firstClientPath } from './client-paths.js';
import { savedCredential } from './client-credentials.js';
import { BrowserError } from './shared.js';
import { loadConfig, type Config } from './config.js';
import { serviceInternalUrl } from './service-network.js';
import { z } from 'zod';

export { clientLabels, setupClients, type SetupClient } from './client-types.js';
interface Verification { version?: string; tools: number; profiles: number; browserOnline?: boolean }
// credential 给按需接入的客户端建或取回独立凭据，返回令牌文件路径。
export interface SetupOptions { home?: string; platform?: NodeJS.Platform; verify?: (entry: SetupEntry) => Promise<Verification>; entries?: Partial<Record<SetupClient, SetupEntry>>; catalogRevision?: string; localTransport?: 'http' | 'stdio'; credential?: (client: SetupClient) => Promise<string> }
export interface SetupSelection { configPath?: string; projectDirectory?: string; format?: 'v1' | 'v2'; trust?: ClientTrust }
interface FileChange { target: string; before: string | undefined; after: string }
// permissions 是接入时一并改动的第二个文件：连接和审批规则分开时，备份和恢复要当成一次改动。
interface Plan extends FileChange { id: string; client: SetupClient; entry: SetupEntry; expires: number; selection: SetupSelection; metadataOnly?: boolean; permissions?: FileChange; configTarget?: string; pendingCredential?: boolean }
// 升级后、重新生成之前，数据目录里的入口文件可能还是旧名称。
const installedEntry = (servers: Record<string, any>) => servers[MCP_NAME] ?? servers[LEGACY_MCP_NAME];
const hash = (value: string | undefined) => value === undefined ? 'missing' : createHash('sha256').update(value).digest('hex');
const fileRecord = { target: z.string(), existed: z.boolean(), beforeHash: z.string().regex(/^(missing|[0-9a-f]{64})$/), afterHash: z.string().regex(/^[0-9a-f]{64}$/) };
const backupRecord = z.object({ id: z.string().uuid(), client: z.enum(setupClients), ...fileRecord, configTarget: z.string().optional(), permissions: z.object(fileRecord).optional(), selection: z.object({ trust: z.enum(['preserve','service','prompt']).optional(), format: z.enum(['v1','v2']).optional(), projectDirectory: z.string().optional(), configPath: z.string().optional() }).optional(), createdAt: z.iso.datetime() });
async function exists(file: string) { try { await access(file); return true; } catch { return false; } }
async function readConfig(file: string): Promise<string | undefined> {
  try { if ((await stat(file)).size > 4 * 1024 * 1024) throw new BrowserError('CLIENT_CONFIG_TOO_LARGE', '客户端配置超过 4 MiB，未修改。'); return await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
async function atomicConfig(target: string, value: string, expected: string, checkTarget: () => Promise<void>) {
  await checkTarget();
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.saltedfish-${randomUUID()}.tmp`;
  try {
    await writeFile(temp, value, { flag: 'wx', mode: 0o600 });
    if (hash(await readConfig(target)) !== expected) throw new BrowserError('CLIENT_CONFIG_CHANGED', '配置已被其他程序修改，请重新预览；本次未覆盖。');
    await checkTarget();
    await rename(temp, target);
  } catch (error) {
    if (['EACCES', 'EBUSY', 'EPERM'].includes((error as NodeJS.ErrnoException).code || '')) throw new BrowserError('CLIENT_CONFIG_BUSY', '配置文件被占用或无写入权限。请关闭占用文件的程序或恢复权限，再重试本次操作；备份仍保留。');
    throw error;
  } finally { await rm(temp, { force: true }); }
}
export async function verifyClientEntry(entry: SetupEntry): Promise<Verification> {
  const client = new Client({ name: 'saltedfish-setup-check', version: '1' });
  const env = Object.fromEntries(Object.entries(process.env).filter((value): value is [string, string] => typeof value[1] === 'string'));
  const transport = 'url' in entry ? new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers } }) : new StdioClientTransport({ command: entry.command, args: entry.args, env: { ...env, ...entry.env }, stderr: 'pipe' });
  try {
    await client.connect(transport, { timeout: 15000 });
    const tools = await client.listTools({}, { timeout: 10000 });
    if (!tools.tools.some(tool => tool.name === 'chrome_profiles')) throw new BrowserError('CLIENT_VERIFY_FAILED', '启动入口未提供 SaltedFish 浏览器工具。');
    const profiles = await client.callTool({ name: 'chrome_profiles', arguments: {} }, undefined, { timeout: 10000 });
    if (profiles.isError) {
      // HTTP 初始化和目录查询已验证 agent 凭据；电脑尚未接入不应阻止服务器的首次配置。
      if('url' in entry&&(profiles.structuredContent as any)?.error?.code==='REMOTE_DEVICE_OFFLINE')return {version:client.getServerVersion()?.version,tools:tools.tools.length,profiles:0,browserOnline:false};
      throw new BrowserError('CLIENT_VERIFY_FAILED', '客户端凭据无法读取 Chrome 配置，可能已被撤销。');
    }
    return { version: client.getServerVersion()?.version, tools: tools.tools.length, profiles: (profiles.structuredContent as any)?.data?.profiles?.length ?? 0 };
  } finally { if ('url' in entry) await (transport as StreamableHTTPClientTransport).terminateSession().catch(()=>{}); await client.close(); }
}

export class ClientSetup {
  private plans = new Map<string, Plan>();
  private busy = false;
  private home: string;
  constructor(private config: Pick<Config, 'dataDir'>, private options: SetupOptions = {}) { this.home = path.resolve(options.home || os.homedir()); }
  private validatePath(file: string) {
    if (!path.isAbsolute(file) || /^[\\/]{2}/.test(file) || /[\x00-\x1f]/.test(file) || !['.json', '.jsonc', '.toml'].includes(path.extname(file).toLowerCase())) throw new BrowserError('INVALID_CONFIG_PATH', '请选择本机 JSON/JSONC/TOML 配置文件的绝对路径。');
    return path.resolve(file);
  }
  private async canonicalTarget(file: string) {
    const target = this.validatePath(file);
    try { return this.validatePath(await realpath(target)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    let folder = path.dirname(target); const missing = [path.basename(target)];
    while (!await exists(folder)) { const parent = path.dirname(folder); if (parent === folder) throw new BrowserError('INVALID_CONFIG_PATH', '配置路径的磁盘或父目录不存在。'); missing.unshift(path.basename(folder)); folder = parent; }
    return this.validatePath(path.join(await realpath(folder), ...missing));
  }
  private async assertTarget(target: string) { if (await this.canonicalTarget(target) !== target) throw new BrowserError('SETUP_TARGET_CHANGED', '配置路径的实际目标已变化，未写入；请重新选择并预览。'); }
  private async readBackup(id: string) {
    try {
      const value = backupRecord.parse(JSON.parse((await readConfig(path.join(this.config.dataDir, 'setup-backups', `${id}.json`))) || 'null'));
      if (value.id !== id || [value, ...value.permissions ? [value.permissions] : []].some(file => this.validatePath(file.target) !== file.target)) throw new Error('Backup target mismatch');
      if (value.configTarget && this.validatePath(value.configTarget) !== value.configTarget) throw new Error('Backup config target mismatch');
      return value;
    } catch { throw new BrowserError('BACKUP_INVALID', '这条备份记录不完整或已损坏，未改动配置；其他有效备份仍可恢复。'); }
  }
  private async target(client: SetupClient, selection: SetupSelection = {}) {
    if (selection.configPath && selection.projectDirectory) throw new BrowserError('AMBIGUOUS_CONFIG', '指定配置文件和项目目录只能选择一个。');
    if (selection.configPath) {
      if ((path.extname(selection.configPath).toLowerCase() === '.toml') !== (client === 'codex')) throw new BrowserError('INVALID_CONFIG_PATH', 'Codex 使用 TOML；其他客户端使用 JSON 或 JSONC。');
      return this.canonicalTarget(selection.configPath);
    }
    if (selection.projectDirectory) {
      if (clientUserOnly(client)) throw new BrowserError('PROJECT_UNSUPPORTED', `${clientLabels[client]} 只读用户级配置，不支持项目配置。`);
      if (!path.isAbsolute(selection.projectDirectory) || !await stat(selection.projectDirectory).then(item => item.isDirectory(), () => false)) throw new BrowserError('INVALID_PROJECT_DIRECTORY', '请选择存在的项目目录绝对路径。');
      if (client === 'claude') return this.canonicalTarget(path.join(selection.projectDirectory, '.mcp.json'));
      if (client === 'codex') return this.canonicalTarget(path.join(selection.projectDirectory, '.codex/config.toml'));
      if (client === 'pi') return this.canonicalTarget(path.join(selection.projectDirectory, '.pi/mcp.json'));
      if (client === 'codebuddy') return this.canonicalTarget(await firstClientPath(['.mcp.json', 'mcp.json'].map(file => path.join(selection.projectDirectory!, file))));
      return this.openCodeTarget(selection.projectDirectory);
    }
    if (client === 'claude') return this.canonicalTarget(path.join(this.claudeHome() ?? this.home, '.claude.json'));
    if (client === 'codex') return this.canonicalTarget(path.join(!this.options.home && process.env.CODEX_HOME || path.join(this.home, '.codex'), 'config.toml'));
    if (client === 'pi') return this.canonicalTarget(path.join(!this.options.home && process.env.PI_CODING_AGENT_DIR || path.join(this.home, '.pi/agent'), 'mcp.json'));
    if (client === 'agy') return this.canonicalTarget(path.join(this.home, '.gemini/config/mcp_config.json'));
    if (client === 'claude-desktop') return this.canonicalTarget(await desktopConfigPath(this.home, this.options.platform ?? process.platform, this.options.home ? {} : process.env));
    if (client === 'workbuddy') return this.canonicalTarget(path.join(this.buddyHome(client), 'mcp.json'));
    if (client === 'codebuddy') {
      const base = this.buddyHome(client), legacyBase = !this.options.home && process.env.CODEBUDDY_CONFIG_DIR?.trim() || this.home;
      return this.canonicalTarget(await firstClientPath([path.join(base, '.mcp.json'), path.join(base, 'mcp.json'), path.join(legacyBase, '.codebuddy.json')]));
    }
    if (!this.options.home && process.env.OPENCODE_CONFIG) return this.canonicalTarget(process.env.OPENCODE_CONFIG);
    const base = !this.options.home && process.env.XDG_CONFIG_HOME ? process.env.XDG_CONFIG_HOME : path.join(this.home, '.config');
    return this.openCodeTarget(path.join(base, 'opencode'));
  }
  private claudeHome() { return this.options.home ? undefined : process.env.CLAUDE_CONFIG_DIR; }
  private buddyHome(client: 'codebuddy' | 'workbuddy') {
    return !this.options.home && (client === 'workbuddy' && process.env.WORKBUDDY_CONFIG_DIR?.trim() || process.env.CODEBUDDY_CONFIG_DIR?.trim()) || path.join(this.home, `.${client}`);
  }
  // Claude Code 的项目范围写个人的 settings.local.json：信任是个人决定，不该进项目共享的设置。agy 只有用户级设置。
  private permissionTarget(client: 'claude' | 'agy' | 'codebuddy', selection: SetupSelection) {
    if (client === 'agy') return this.canonicalTarget(path.join(this.home, '.gemini/antigravity-cli/settings.json'));
    if (client === 'codebuddy') return this.canonicalTarget(selection.projectDirectory ? path.join(selection.projectDirectory, '.codebuddy/settings.local.json') : path.join(this.buddyHome(client), 'settings.json'));
    return this.canonicalTarget(selection.projectDirectory ? path.join(selection.projectDirectory, '.claude/settings.local.json') : path.join(this.claudeHome() ?? path.join(this.home, '.claude'), 'settings.json'));
  }
  private async openCodeTarget(folder: string) {
    const json = path.join(folder, 'opencode.json'), jsonc = path.join(folder, 'opencode.jsonc');
    if (await exists(json) && await exists(jsonc)) throw new BrowserError('AMBIGUOUS_CONFIG', '同时存在 opencode.json 和 opencode.jsonc，请先明确实际使用的文件；向导未修改。');
    return this.canonicalTarget(await exists(jsonc) ? jsonc : json);
  }
  async inspect(client: SetupClient, selection: SetupSelection = {}) {
    const target = await this.target(client, selection), text = await readConfig(target);
    const { format, current, data, name } = clientDocument(client, text || '', selection.format);
    if (current === undefined) return { connection: 'not_configured', format, note: '尚未接入 SaltedFish' };
    if (current.enabled === false || current.disabled === true || (client === 'codebuddy' && data.disabledMcpServers?.includes?.(name))) return { connection: 'disabled', format, note: '已在 Agent 配置中停用' };
    // 还没建过独立凭据，配置里的连接就不是这次安装写的。
    if (clientLazyCredential(client) && !this.options.entries?.[client] && !await savedCredential(this.config.dataDir, client)) return { connection: 'other_config', format, note: '已有不同的 SaltedFish 连接，请预览后决定是否更新' };
    const expected = await this.entry(client, selection);
    // agy 的地址键名是 url，它自己的 mcp add 还写旧名 serverUrl，两个都认。
    const currentUrl = client === 'agy' ? current.url ?? current.serverUrl : current.url;
    // 手工改坏的配置里这些字段可能是 null 或别的类型：按“不同的连接”处理，不能让 inspect / check 抛出原始 TypeError。
    const withoutRevision = (value: Record<string, unknown> | null = {}) => Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !['saltedfish_catalog_version', 'x-saltedfish-catalog-version', MACHINE_IDENTITY_HEADER.toLowerCase()].includes(key.toLowerCase())).sort(([a], [b]) => a.localeCompare(b)));
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const commandPath = (command: unknown) => {
      if (typeof command !== 'string') return '';
      let normalized = path.isAbsolute(command) ? path.normalize(command) : command;
      if (process.platform === 'win32') normalized = normalized.toLowerCase();
      // 旧原生入口和新品牌入口共享同目录/数据；不接受来自其他安装目录的同名命令。
      return normalized.replace(/(?:fengchromemcp|saltedfish)\.exe$/i, 'saltedfish.exe');
    };
    const matchesEntry = (item: SetupEntry) => {
      if ('url' in item) return currentUrl === item.url && same(withoutRevision(client === 'codex' ? current.http_headers : current.headers), withoutRevision(item.headers));
      const parts: unknown[] | undefined = client === 'opencode' ? Array.isArray(current.command) ? current.command : [] : undefined;
      const command = parts ? parts[0] : current.command;
      const args = parts ? parts.slice(1) : current.args;
      const env = client === 'opencode' ? current.environment : current.env;
      return !currentUrl && commandPath(command) === commandPath(item.command) && same(args || [], item.args) && same(withoutRevision(env), withoutRevision(item.env));
    };
    // 升级前写的 launcher 入口还能用，也算这次安装的，下次升级或接入时换成 HTTP。
    const matches = matchesEntry(expected) || ('url' in expected && !this.options.entries?.[client] && matchesEntry(await this.stdioEntry(client)));
    if (!matches || current.env_vars?.length || current.env_http_headers || current.bearer_token_env_var || current.cwd) return { connection: 'other_config', format, note: '已有不同的 SaltedFish 连接，请预览后决定是否更新' };
    const permission = name === MCP_NAME ? browserPermission : legacyBrowserPermission;
    // pi 默认不逐次确认工具调用，接入就等于信任；pi-mcp-adapter 的 approveTools 归用户自己管。
    const trusted = client === 'codex' ? current.default_tools_approval_mode === 'approve' : client === 'opencode' && format === 'v2' ? Array.isArray(data.permissions) && data.permissions.findLast((rule:any) => rule?.action === permission && rule.resource === '*')?.effect === 'allow' : client === 'claude' || client === 'agy' || client === 'codebuddy' ? ({ claude: claudeTrusted, agy: agyTrusted, codebuddy: codebuddyTrusted }[client])(await readConfig(await this.permissionTarget(client, selection)) ?? '', name) : client === 'pi';
    return { connection: 'configured', format, trusted, note: name === MCP_NAME ? '已配置此安装；连接是否可用需另行检查' : `已配置此安装；旧连接名 ${LEGACY_MCP_NAME} 会在下次接入时改为 ${MCP_NAME}` };
  }
  async check(client: SetupClient, selection: SetupSelection = {}) {
    const target = await this.target(client, selection), before = await readConfig(target);
    const state = await this.inspect(client, selection);
    if (state.connection !== 'configured') throw new BrowserError('CLIENT_NOT_CONFIGURED', state.note);
    // 不执行磁盘上未知的命令，只验证已确认与本安装一致的生成入口。
    const verification = await (this.options.verify || verifyClientEntry)(withCatalogRevision(await this.entry(client, selection), this.options.catalogRevision));
    await this.assertTarget(target);
    if (hash(await readConfig(target)) !== hash(before)) throw new BrowserError('CLIENT_CONFIG_CHANGED', '检查期间配置发生变化，请重新检测；没有改写文件。');
    return { client, target, checkedAt: new Date().toISOString(), verification, note: '连接检查通过；这不代表 Agent 当前正在运行。' };
  }
  async detect() {
    return Promise.all(setupClients.map(async client => {
      const capabilities = { userOnly: clientUserOnly(client), ownApprovals: clientOwnApprovals(client) };
      try {
        const target = await this.target(client);
        const candidates = client === 'claude' ? [path.join(this.home, '.local/bin/claude.exe')] : client === 'opencode' ? [path.join(this.home, 'AppData/Local/Author Software/nvm/.nodejs/node_modules/@opencode/cli/bin/opencode.exe')] : client === 'codex' ? [path.join(this.home, '.local/bin/codex.exe')] : client === 'agy' ? [path.join(this.home, 'AppData/Local/agy/bin/agy.exe'), path.join(this.home, '.local/bin/agy')] : [];
        if (client === 'claude-desktop' || client === 'workbuddy') {
          const app = client === 'claude-desktop' ? 'Claude' : 'WorkBuddy';
          candidates.push(path.dirname(target), path.join(this.home, `AppData/Local/Programs/${app}/${app}.exe`), path.join(this.home, `Applications/${app}.app`));
          if (!this.options.home && process.platform === 'darwin') candidates.push(`/Applications/${app}.app`);
        }
        if (!this.options.home) for (const folder of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) for (const suffix of ['.exe','.cmd','']) candidates.push(path.join(folder, client + suffix));
        const cliPaths = [...new Set((await Promise.all(candidates.map(async file => await exists(file) ? path.resolve(file) : undefined))).filter((value): value is string => !!value))];
        let state: Awaited<ReturnType<ClientSetup['inspect']>>;
        try { state = await this.inspect(client); } catch (error) { state = { connection: 'invalid', format: 'v2', note: error instanceof BrowserError ? error.message : '暂时无法核对连接配置，请查看设置' }; }
        return { client, label: clientLabels[client], ...capabilities, target, configExists: await exists(target), cliDetected: cliPaths.length > 0, cliPaths, scope: clientUserOnly(client) ? '用户级配置；审批在客户端内管理' : '默认用户配置；项目设置可能覆盖它', ...state, error: undefined };
      } catch (error) { return { client, label: clientLabels[client], ...capabilities, error: error instanceof BrowserError ? error.message : '无法读取配置路径' }; }
    }));
  }
  async history() {
    const folder = path.join(this.config.dataDir, 'setup-backups');
    const files = await readdir(folder).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    const entries: { changeId: string; client: string; target?: string; createdAt?: string; canRestore: boolean; issue?: string }[] = [];
    for (const file of files.filter(file => /^[0-9a-f-]{36}\.json$/.test(file)).slice(-100)) {
      const id = file.slice(0, -5);
      try {
        const change = await this.readBackup(id); let canRestore = false, issue: string | undefined;
        try { await this.assertTarget(change.target); const states = [[change.target, change.beforeHash, change.afterHash], ...change.permissions ? [[change.permissions.target, change.permissions.beforeHash, change.permissions.afterHash]] : []] as [string, string, string][];
          // 双文件接入中途失败后可能只有一份已写入，restore 也认这种状态。
          const now = await Promise.all(states.map(async ([target, before, after]) => { const current = hash(await readConfig(target)); return current === after ? 'after' : current === before ? 'before' : 'other'; }));
          canRestore = now.every(state => state !== 'other') && now.includes('after'); }
        catch (error) { issue = error instanceof BrowserError ? error.message : '暂时无法读取原配置，未改动文件。'; }
        entries.push({ changeId: change.id, client: change.client, target: change.target, createdAt: change.createdAt, canRestore, ...(issue ? { issue } : {}) });
      } catch { entries.push({ changeId: id, client: '备份记录异常', canRestore: false, issue: '记录不完整或损坏，请保留文件并检查其他备份。' }); }
    }
    return entries.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }
  async refreshCatalogs() {
    const completed: unknown[] = [], skipped: {client:string;target?:string;reason:string}[] = [], seen = new Set<string>();
    for (const item of await this.history()) {
      if (!(setupClients as readonly string[]).includes(item.client) || !item.target) continue;
      try {
        const record = await this.readBackup(item.changeId), project = record.selection?.projectDirectory, configTarget = record.configTarget ?? record.target;
        if (seen.has(configTarget)) continue;
        seen.add(configTarget);
        const tracksSelection = ['claude-desktop', 'codebuddy', 'workbuddy'].includes(record.client);
        if (tracksSelection) {
          // 生效位置变了：比这条新的接入记录已经处理过新位置（比如 Desktop 搬到 Claude-Data 后用户重新接入过），旧记录不用再报。
          const current = await this.target(record.client, record.selection);
          if (current !== configTarget) { if (!seen.has(current)) skipped.push({ client: item.client, target: item.target, reason: '客户端当前生效配置位置已变化，请重新预览接入。' }); continue; }
        }
        // 新客户端的备份记有原选择；默认路径不能在首次刷新后被固化成自定义文件。
        const selection: SetupSelection = tracksSelection ? { ...record.selection, trust: 'preserve' } : {...project ? {projectDirectory:project} : {configPath:configTarget},format:record.selection?.format,trust:'preserve'};
        // Claude Code 一直在改 .claude.json，agy 会改 settings.json，pi 的 /mcp 会改 exposure，整个文件比不出来，只看连接条目还是不是这次安装写的。
        // Codex 也会自己重写 config.toml（打开新项目记信任、改设置时整个文件重排），整个文件没变，或者文件回到接入前的样子（用户恢复过）以外、连接条目还是这次安装写的，都照样刷新。
        const owned = async () => (await this.inspect(record.client, selection)).connection === 'configured';
        const refreshable = ['claude', 'pi', 'agy', 'claude-desktop', 'codebuddy', 'workbuddy'].includes(record.client) ? await owned()
          : item.canRestore || record.client === 'codex' && hash(await readConfig(record.target)) !== record.beforeHash && await owned();
        if (!refreshable) { skipped.push({client:item.client,target:item.target,reason:'接入后配置已变化或已恢复，保留用户当前文件；可显式 connect --keep-approvals 更新。'}); continue; }
        const refresh = async () => this.apply((await this.preview(record.client, selection)).planId);
        completed.push(await refresh().catch(error => { if (error instanceof BrowserError && error.code === 'CLIENT_CONFIG_CHANGED') return refresh(); throw error; }));
      } catch (error) { skipped.push({client:item.client,target:item.target,reason:error instanceof BrowserError?error.message:'客户端目录更新失败，配置未覆盖，请显式重新接入。'}); }
    }
    return {completed,skipped,note:'只更新本安装曾接入且未被用户改动的连接，保持原信任/禁用设置。客户端需重新加载该连接；已开始的模型轮次可能仍使用旧目录。'};
  }
  // npm 安装的同机接入走 HTTP，不用每个会话多开两个进程。写进项目的配置可能进仓库，令牌不能放进去，继续走 launcher。
  private async entry(client: SetupClient, selection: SetupSelection = {}, create: boolean | 'preview' = false): Promise<SetupEntry> {
    if (this.options.entries?.[client]) {
      const entry = this.options.entries[client]!;
      if (client === 'claude-desktop' && 'url' in entry) throw new BrowserError('CLIENT_TRANSPORT_UNSUPPORTED', 'Claude Desktop 本地配置只接受 stdio 启动入口。');
      return entry;
    }
    const entry = await this.stdioEntry(client, create), transport = this.options.localTransport ?? (process.platform === 'linux' ? 'http' : 'stdio');
    return client !== 'claude-desktop' && transport === 'http' && !selection.projectDirectory && path.basename(entry.args[0] ?? '') === 'launcher.mjs' ? this.httpEntry(entry) : entry;
  }
  private async httpEntry(entry: ClientEntry): Promise<SetupEntry> {
    const config = await loadConfig(this.config.dataDir);
    // 预览时凭据还没建，占位令牌只用于生成预览，apply 会换成真实凭据重新生成。
    if (entry.env.CHROME_MCP_TOKEN_FILE === this.pendingTokenFile) return { url: `${serviceInternalUrl(config)}/mcp`, headers: { Authorization: 'Bearer <接入时创建>' } };
    const token = await readFile(entry.env.CHROME_MCP_TOKEN_FILE!, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') throw new BrowserError('CLIENT_CREDENTIAL_MISSING', '接入入口的令牌文件不存在，未修改配置。运行 saltedfish install 重新生成后再接入。'); throw error; });
    return { url: `${serviceInternalUrl(config)}/mcp`, headers: { Authorization: `Bearer ${token.trim()}` } };
  }
  private get pendingTokenFile() { return path.join(this.config.dataDir, 'clients', '.pending-credential.token'); }
  private async stdioEntry(client: SetupClient, create: boolean | 'preview' = false): Promise<ClientEntry> {
    const entry = client === 'claude' || client === 'opencode' || client === 'codex' ? await this.generatedEntry(client) : await this.lazyEntry(client, create);
    // 没有令牌文件时 MCP 入口会退回管理员令牌，这样的条目不能写进客户端配置。
    if (!entry.env?.CHROME_MCP_TOKEN_FILE) throw new BrowserError('CLIENT_CREDENTIAL_MISSING', '接入入口缺少独立凭据，未修改配置。运行 saltedfish install 重新生成后再接入。');
    return entry;
  }
  // 新增客户端第一次接入时才建凭据。复用 Claude Code 的启动命令，只换令牌文件。
  // 预览（create 为 'preview'）不建凭据：已有就沿用，没有用占位，确认后由 apply 创建。
  private async lazyEntry(client: SetupClient, create: boolean | 'preview'): Promise<ClientEntry> {
    const base = await this.generatedEntry('claude'), env = { ...base.env }; delete env.CHROME_MCP_TOKEN_FILE;
    const saved = (await savedCredential(this.config.dataDir, client))?.tokenFile;
    const tokenFile = create === true && this.options.credential ? await this.options.credential(client) : saved && (create !== 'preview' || await exists(saved)) ? saved : create === 'preview' && this.options.credential ? this.pendingTokenFile : undefined;
    return { command: base.command, args: base.args, env: { ...env, ...(tokenFile ? { CHROME_MCP_TOKEN_FILE: tokenFile } : {}) } };
  }
  private async generatedEntry(client: 'claude' | 'opencode' | 'codex'): Promise<ClientEntry> {
    if (client === 'codex') {
      const servers = parseCodex(await readFile(path.join(this.config.dataDir, 'codex-config.toml'), 'utf8')).mcp_servers, item = installedEntry(servers);
      // beta.5 生成的文件把 env 子表留在了旧名称下，升级后不会重新生成。
      return { command: item.command, args: item.args, env: item.env ?? servers[LEGACY_MCP_NAME]?.env };
    }
    const file = path.join(this.config.dataDir, client === 'claude' ? 'mcp-config.json' : 'opencode-config.json');
    const source = JSON.parse(await readFile(file, 'utf8'));
    if (client === 'claude') return installedEntry(source.mcpServers);
    const item = installedEntry(source.mcp.servers); return { command: item.command[0], args: item.command.slice(1), env: item.environment };
  }
  async previewMachineRegistration(client: SetupClient, configPath: string) {
    if (!['claude', 'opencode', 'codex'].includes(client)) throw new BrowserError('UNKNOWN_CLIENT', '机器登记支持 Codex、Claude Code 和 OpenCode 的现有 HTTP 配置。');
    const target = await this.target(client, { configPath }), before = await readConfig(target);
    if (before === undefined) throw new BrowserError('CLIENT_NOT_CONFIGURED', '请选择已经接入 SaltedFish 的客户端配置文件。');
    const { current, format, container, name } = clientDocument(client, before), parts = [...container, name];
    if (!current || typeof current.url !== 'string' || current.command !== undefined) throw new BrowserError('CLIENT_NOT_CONFIGURED', '机器登记只更新现有 SaltedFish HTTP 连接，不创建连接或转换 stdio。');
    try { if (!['http:', 'https:'].includes(new URL(current.url).protocol)) throw new Error(); } catch { throw new BrowserError('MACHINE_REGISTRATION_INVALID', '机器登记需要有效的现有 HTTP 地址，未修改配置。'); }
    const headerKey = client === 'codex' ? 'http_headers' : 'headers', oldHeaders = current[headerKey] ?? {};
    if (!oldHeaders || typeof oldHeaders !== 'object' || Array.isArray(oldHeaders) || Object.values(oldHeaders).some(value => typeof value !== 'string')) throw new BrowserError('MACHINE_REGISTRATION_INVALID', '机器登记需要现有 HTTP headers 为字符串映射，未修改配置。');
    const report = collectMachineIdentity(), machineHeaders = machineIdentityHeaders(report);
    const headers: Record<string, string> = { ...Object.fromEntries(Object.entries(oldHeaders).filter(([key]) => key.toLowerCase() !== MACHINE_IDENTITY_HEADER.toLowerCase())), ...machineHeaders } as Record<string, string>;
    let after: string;
    if (client === 'codex') after = mergeCodexHeaders(before, headers, name);
    else {
      const bom = before.startsWith('\ufeff') ? '\ufeff' : '', options = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: before.includes('\r\n') ? '\r\n' : '\n' } };
      let content = before.slice(bom.length);
      for (const key of Object.keys(oldHeaders)) if (key.toLowerCase() === MACHINE_IDENTITY_HEADER.toLowerCase() && key !== MACHINE_IDENTITY_HEADER) content = applyEdits(content, modify(content, [...parts, headerKey, key], undefined, options));
      content = applyEdits(content, modify(content, [...parts, headerKey, MACHINE_IDENTITY_HEADER], machineHeaders[MACHINE_IDENTITY_HEADER], options));
      after = bom + content; parsed(after, client === 'opencode');
    }
    const plan: Plan = { id: randomUUID(), client, target, before, after, entry: { url: current.url, headers }, selection: { trust: 'preserve', ...(client === 'opencode' ? { format } : {}) }, expires: Date.now() + 600000, metadataOnly: true };
    for (const [id, old] of this.plans) if (old.expires < Date.now()) this.plans.delete(id);
    if (this.plans.size >= 20) this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(plan.id, plan);
    return { planId: plan.id, client, target, report, note: '仅登记执行此命令的电脑信息；保留原地址、凭据、审批和其他设置。客户端重连后显示为“接入时登记”，不代表实时运行位置。' };
  }
  async preview(client: SetupClient, selection: SetupSelection = {}) {
    const { plan, view } = await this.compose(client, selection, false);
    for (const [id, old] of this.plans) if (old.expires < Date.now()) this.plans.delete(id);
    if (this.plans.size >= 20) this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(plan.id, plan);
    return view;
  }
  // create 为 false 时只生成预览，不建任何凭据；apply 带 true 重新生成，此时才会为按需接入的客户端创建独立授权。
  private async compose(client: SetupClient, selection: SetupSelection, create: boolean, id: string = randomUUID()) {
    if (!setupClients.includes(client)) throw new BrowserError('UNKNOWN_CLIENT', `仅支持 ${Object.values(clientLabels).join('、')}。`);
    const requested = selection.trust || 'preserve';
    if (!['service','preserve','prompt'].includes(requested) || (requested !== 'preserve' && selection.format === 'v1')) throw new BrowserError('TRUST_UNSUPPORTED', '一次信任不支持 OpenCode 1；可保留原审批接入。');
    // pi 默认不逐次确认，SaltedFish 不改它的审批，不论选什么都不写审批规则。
    const trust = clientOwnApprovals(client) ? 'preserve' : requested;
    // agy 新装后 mcp_config.json 是空文件。
    const target = await this.target(client, selection), before = await readConfig(target), source = before?.trim() ? before : client === 'codex' ? before ?? '' : '{}\n';
    const { data, format, container, name, legacy, current: old } = clientDocument(client, source, selection.format);
    if (client === 'opencode' && format === 'v1' && trust !== 'preserve') throw new BrowserError('TRUST_UNSUPPORTED', '一次信任仅支持 OpenCode 2；OpenCode 1 可保留原审批接入。');
    let entry = withCatalogRevision(await this.entry(client, selection, create || 'preview'), this.options.catalogRevision);
    const pendingCredential = !create && clientLazyCredential(client) && !this.options.entries?.[client] && !!this.options.credential;
    if ('url' in entry) entry = { ...entry, headers: preserveMachineIdentity(entry.headers, old?.[client === 'codex' ? 'http_headers' : 'headers']) };
    const major = format === 'v1' ? 1 : 2;
    if (client === 'opencode' && trust !== 'preserve' && Object.keys(data.mcp?.servers || {}).some(server => server.startsWith(`${MCP_NAME}_`))) throw new BrowserError('TRUST_NAMESPACE_CONFLICT', `另一个 MCP 的名称以 ${MCP_NAME}_ 开头，会与工具授权匹配重叠。请先为该服务改名；本次未改变权限。`);
    const generated = openCodeConfig(entry, major) as { mcp: Record<string, any> };
    const replacement = client === 'opencode' ? { ...(old || {}), ...(major === 1 ? generated.mcp[MCP_NAME] : generated.mcp.servers[MCP_NAME]) } : { ...(old || {}) };
    // OpenCode 1 的生成配置固定 enabled:true，旧条目明确设过就保留，不能悄悄启用用户停用的连接。
    if (client === 'opencode' && major === 1 && typeof old?.enabled === 'boolean') replacement.enabled = old.enabled;
    if (client === 'codex') {
      for (const key of ['command','args','env','env_vars','cwd','url','http_headers','env_http_headers','bearer_token_env_var']) delete replacement[key];
      Object.assign(replacement, 'url' in entry ? { url: entry.url, http_headers: entry.headers } : entry, { startup_timeout_sec: 20, tool_timeout_sec: 330 });
      replacement.tool_input_schema_max_bytes = Math.max(CODEX_TOOL_SCHEMA_MAX_BYTES, Number.isSafeInteger(replacement.tool_input_schema_max_bytes) ? replacement.tool_input_schema_max_bytes as number : 0);
      if (trust !== 'preserve') replacement.default_tools_approval_mode = trust === 'service' ? 'approve' : 'prompt';
      if (trust === 'prompt') for (const tool of Object.values(replacement.tools || {})) if (tool && typeof tool === 'object') (tool as any).approval_mode = 'prompt';
    } else if (client === 'opencode') {
      for (const key of ('url' in entry ? ['command','environment','cwd'] : ['url','headers','oauth'])) delete replacement[key];
      if (trust !== 'preserve') replacement.codemode = false;
    } else {
      // 只换连接方式，用户在 pi 的 /mcp 里改过的 exposure、enabled 这些保留。
      for (const key of ['command','args','env','cwd','type','url','serverUrl','headers','oauth','env_vars','env_http_headers','bearer_token_env_var']) delete replacement[key];
      Object.assign(replacement, 'url' in entry ? { [client === 'agy' ? 'serverUrl' : 'url']: entry.url, headers: entry.headers } : entry);
      if (client === 'codebuddy' || client === 'workbuddy' || (client === 'claude' && 'url' in entry)) replacement.type = 'url' in entry ? 'http' : 'stdio';
      // pi 的 timeout 按单次请求算，默认 60 秒，浏览器工具最长要 320 秒。43 个工具直接声明太占上下文，按需加载。
      if (client === 'pi') { replacement.timeout = Math.max(330, typeof replacement.timeout === 'number' && Number.isFinite(replacement.timeout) ? replacement.timeout : 0); replacement.exposure ??= 'deferred'; }
    }
    const highlights: string[] = [], attention = (note: string) => { notices.push(note); highlights.push(note); };
    const rules = await this.permissionSettings(client, selection, trust);
    const notices = [selection.projectDirectory ? '此配置仅面向所选项目，请在该项目中打开客户端；项目原有信任与审批仍然有效。' : selection.configPath ? '这是明确选择的配置文件；需确认客户端实际加载它，向导不修改启动参数。' : '项目配置或受管理设置可能覆盖用户级条目，请在客户端 MCP 面板核对。'];
    // 授权范围说明必须与服务端实际执行的边界一致（管理页保护 admin-origin-v1、文件路径检查 src/upload-policy.ts、/mcp 只收本机连接、客户端的账号与只读授权）；改动这些边界时同步改这里，tests/client-trust.test.ts 核对关键事实点。
    const limits = [
      'SaltedFish 服务仍会限制它：只能使用授权给该客户端的 Chrome 配置，只读授权不能执行写操作；服务管理页和扩展自身页面受保护，不能被读取或操作，也不能把标签页导航到它们（管理页在标签页列表里隐藏地址和标题）；Agent 只能从服务所在的电脑连接；上传和保存文件能用哪些路径由 Agent 自己的权限设置决定，SaltedFish 只拒绝它自己的数据目录和网络共享路径；浏览器电脑上的下载导出需要可选本机助手，仅在明确请求时读取 Chrome 下载的那个文件。',
      '撤销只阻止之后的调用，已发出的操作不会撤回。恢复审批只让工具重新需要你确认，并不撤销该客户端在 SaltedFish 的授权；要立即阻止访问，请在管理页“客户端授权”里撤销这个客户端（远程 Agent 在“远程服务器”页断开远程），或在扩展中暂停。请只对你信任的 Agent 开启一次信任。'];
    if (trust === 'service') notices.push('一次信任后，此 Agent 调用本 MCP 当前及将来的所有浏览器工具都不再逐次确认：可在它获准使用的 Chrome 配置里点击、输入、读取页面内容、截图并执行页面脚本，等同于以这些配置里已登录的身份操作网站。其他 MCP、Shell 和模型配置保持。', ...limits);
    if (client === 'pi') {
      attention('pi 默认不逐次确认工具调用，接入后就能用已登录的身份操作网站。');
      if (requested === 'prompt') attention('SaltedFish 不改 pi 的审批；要停止它访问，在管理页撤销它的授权。');
      notices.push(...limits);
      if (old?.exposure === undefined) notices.push('工具按需加载（exposure 设为 deferred），可以在 pi 的 /mcp 里改。');
      if (selection.projectDirectory) notices.push('pi 只在受信任的项目里读取 .pi/mcp.json。');
    }
    if (client === 'claude-desktop') attention('Claude Desktop 需完全退出并重新启动；工具审批请在 Desktop 内确认，SaltedFish 不改它的审批设置。');
    if (client === 'workbuddy') attention('WorkBuddy 需在 MCP 设置中刷新并批准 SaltedFish 配置，再新开会话；连接配置更新后可能需要重新批准。SaltedFish 不改它的审批设置。');
    if (client === 'codebuddy') notices.push('CodeBuddy 项目和受管理的设置可能覆盖用户配置；项目 MCP 的首次启用仍需在客户端确认。');
    if (client === 'codex' && trust === 'service' && Object.values(old?.tools || {}).some((tool: any) => tool.approval_mode && tool.approval_mode !== 'approve')) attention('保留已有的逐工具例外规则；这些工具仍按你原来的选择审批。');
    if (client === 'opencode' && trust !== 'preserve') notices.push(`此连接使用直接工具模式；仅调整 ${browserPermission} 的审批，保留通用 execute 与其他工具规则。`);
    if (trust === 'prompt') notices.push('取消此服务的默认信任，后续浏览器工具交回客户端审批；已有会话需重连。已发出的操作不会撤回，也不会撤销该客户端在 SaltedFish 的授权。');
    if (old?.enabled === false || old?.disabled === true || (client === 'codebuddy' && data.disabledMcpServers?.includes?.(name))) attention('保留了此连接原有的禁用状态；接入后需在客户端 MCP 面板启用才可使用。');
    if ('url' in entry) notices.push(`连接服务器：${new URL(entry.url).origin}。令牌只写入私有配置和备份，不在预览中显示。`);
    if (client === 'claude' && trust === 'preserve') notices.push('Claude Code 的审批保持不变：首次调用浏览器工具时在 Claude Code 里确认。');
    if (client === 'agy' && trust === 'preserve') notices.push('agy 的审批保持不变，按它自己的工具权限设置确认。');
    if (pendingCredential && !(await savedCredential(this.config.dataDir, client))) notices.push(`确认接入后才会为 ${clientLabels[client]} 新建一份独立授权；预览和取消都不会创建。`);
    if (rules?.change) notices.push(`审批规则写入 ${rules.change.target}。`);
    if (trust === 'service' && rules?.exceptions) attention('保留已有的逐工具例外规则；这些工具仍按你原来的选择审批。');
    if (legacy) notices.push(`旧条目 ${LEGACY_MCP_NAME} 已移除，审批设置沿用；已有会话需要重连。`);
    if (legacy && name === MCP_NAME) notices.push(`配置里同时有 ${MCP_NAME} 和 ${LEGACY_MCP_NAME}，以 ${MCP_NAME} 为准。`);
    if (client === 'claude' && selection.projectDirectory) {
      const userText = await readConfig(path.join(this.home, '.claude.json'));
      if (userText) {
        const user = parsed(userText, false), normalize = (value: string) => path.resolve(value).replaceAll('\\', '/').toLowerCase();
        const local = Object.entries(user.projects || {}).find(([key]) => normalize(key) === normalize(selection.projectDirectory!))?.[1] as any;
        if (local?.mcpServers?.[MCP_NAME] || local?.mcpServers?.[LEGACY_MCP_NAME]) attention('此项目在 Claude 用户文件中还存在本地同名 MCP，可能优先于项目文件；未改动它，请在 Claude MCP 面板确认。');
      }
    }
    const bom = source.startsWith('\ufeff') ? '\ufeff' : '', content = source.slice(bom.length);
    const edit = (text: string, keys: (string | number)[], value: unknown) => applyEdits(text, modify(text, keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: source.includes('\r\n') ? '\r\n' : '\n' } }));
    let after = client === 'codex' ? mergeCodex(legacy ? removeCodexServer(source, LEGACY_MCP_NAME) : source, replacement) : bom + edit(legacy ? edit(content, [...container, LEGACY_MCP_NAME], undefined) : content, [...container, MCP_NAME], replacement);
    if (client === 'opencode') {
      let rules = data.permissions ?? [];
      if (trust !== 'preserve' && (!Array.isArray(rules) || rules.some(rule => !rule || typeof rule.action !== 'string' || typeof rule.resource !== 'string' || !['allow','deny','ask'].includes(rule.effect)))) throw new BrowserError('CLIENT_CONFIG_INVALID', 'OpenCode 2 permissions 必须是规则数组；未覆盖原配置。');
      // OpenCode 按新工具名匹配，旧名称的规则要跟着改名，否则原来的允许和拒绝都不再生效。
      // OpenCode 1 的 permission 是单数对象，键是工具名（feng-chrome_* 之类），同样要改名；改名后键数不变才写，避免和已有的新名称键相撞。
      if (legacy && format === 'v1' && data.permission && typeof data.permission === 'object' && !Array.isArray(data.permission)) {
        const renamed = Object.fromEntries(Object.entries(data.permission as Record<string, unknown>).map(([key, value]) => [key === legacyBrowserPermission || key.startsWith(`${LEGACY_MCP_NAME}_chrome_`) ? MCP_NAME + key.slice(LEGACY_MCP_NAME.length) : key, value] as const));
        if (Object.keys(renamed).length === Object.keys(data.permission).length && !isDeepStrictEqual(renamed, data.permission)) after = bom + edit(after.slice(bom.length), ['permission'], renamed);
      }
      if (legacy && Array.isArray(rules)) rules = rules.map(rule => rule?.action === legacyBrowserPermission || rule?.action?.startsWith?.(`${LEGACY_MCP_NAME}_chrome_`) ? { ...rule, action: MCP_NAME + rule.action.slice(LEGACY_MCP_NAME.length) } : rule);
      // 只替换本服务的整组规则，不删其他工具/资源规则；最后一条确定本次明确选择。
      if (trust !== 'preserve') rules = [...rules.filter((rule: any) => !(rule.action === browserPermission && rule.resource === '*')), { action: browserPermission, resource: '*', effect: trust === 'service' ? 'allow' : 'ask' }];
      if (!isDeepStrictEqual(rules, data.permissions ?? [])) after = bom + edit(after.slice(bom.length), ['permissions'], rules);
      if (legacy && after.includes(`${LEGACY_MCP_NAME}_`)) attention(`配置里还有 ${LEGACY_MCP_NAME}_ 开头的规则或服务没有改名，请手动检查。`);
    }
    if (client === 'codebuddy' && legacy && Array.isArray(data.disabledMcpServers)) after = bom + edit(after.slice(bom.length), ['disabledMcpServers'], [...new Set(data.disabledMcpServers.map((item: unknown) => item === LEGACY_MCP_NAME ? MCP_NAME : item))]);
    if (client !== 'codex') parsed(after, clientJsonc(client));
    // 只改审批时不触碰 MCP 文件；另记连接位置，刷新目录才不会把 settings 当 MCP 配置。
    const files = source === after && rules?.change ? { ...rules.change, configTarget: target } : { target, before, after, ...(rules?.change ? { permissions: rules.change } : {}) };
    const plan: Plan = { id, client, ...files, entry, selection: { ...selection, trust, ...(client === 'opencode' ? { format } : {}) }, expires: Date.now() + 600000, ...(pendingCredential ? { pendingCredential } : {}) };
    const view = { planId: plan.id, client, target: plan.target, trust, mode: legacy ? 'migrate-server' : old ? 'replace-server' : 'add-server', unchanged: source === after && !rules?.change, backup: before !== undefined, notices, highlights,
      description: trust === 'preserve' ? `仅合并 ${MCP_NAME} 服务条目，保留其他配置、模型和权限；先验证独立凭据与 MCP，再备份并写入。` : `${trust === 'service' ? '信任' : '恢复审批'} SaltedFish，并自动接入；写入前验证 MCP 与备份配置。` };
    return { plan, view };
  }
  private async permissionSettings(client: SetupClient, selection: SetupSelection, trust: ClientTrust) {
    if (client !== 'claude' && client !== 'agy' && client !== 'codebuddy') return undefined;
    const target = await this.permissionTarget(client, selection), before = await readConfig(target), source = before?.trim() ? before : '{}\n', after = ({ claude: mergeClaudeSettings, agy: mergeAgySettings, codebuddy: mergeCodebuddySettings }[client])(source, trust);
    return { exceptions: ({ claude: claudeExceptions, agy: agyExceptions, codebuddy: codebuddyExceptions }[client])(source), change: after === source ? undefined : { target, before, after } };
  }
  async apply(id: string) {
    if (this.busy) throw new BrowserError('SETUP_BUSY', '另一个配置操作正在进行。');
    const plan = this.plans.get(id);
    if (!plan || plan.expires < Date.now()) throw new BrowserError('SETUP_PREVIEW_EXPIRED', '预览已过期，请重新预览。');
    this.busy = true;
    try {
      let files = plan.permissions ? [plan, plan.permissions] : [plan];
      const checkSelection = async () => { if (!plan.metadataOnly && await this.target(plan.client, plan.selection) !== (plan.configTarget ?? plan.target)) throw new BrowserError('SETUP_TARGET_CHANGED', '客户端生效配置位置已变化，请重新预览；未覆盖原文件。'); };
      await checkSelection();
      for (const file of files) {
        await this.assertTarget(file.target);
        if (hash(await readConfig(file.target)) !== hash(file.before)) throw new BrowserError('CLIENT_CONFIG_CHANGED', '预览后配置发生变化，请重新预览。');
      }
      // 按需接入的客户端预览时没有建凭据：确认后才创建，并用真实凭据重新生成要写的内容。
      if (plan.pendingCredential) {
        const built = (await this.compose(plan.client, plan.selection, true, plan.id)).plan;
        if (built.target !== plan.target || built.before !== plan.before || built.permissions?.target !== plan.permissions?.target || built.permissions?.before !== plan.permissions?.before) throw new BrowserError('CLIENT_CONFIG_CHANGED', '预览后配置发生变化，请重新预览。');
        Object.assign(plan, { ...built, expires: plan.expires, pendingCredential: undefined });
        files = plan.permissions ? [plan, plan.permissions] : [plan];
      }
      const verification = plan.metadataOnly ? undefined : await (this.options.verify || verifyClientEntry)(plan.entry);
      await checkSelection();
      for (const file of files) await this.assertTarget(file.target);
      if (plan.before === plan.after && !plan.permissions) {
        if (hash(await readConfig(plan.target)) !== hash(plan.before)) throw new BrowserError('CLIENT_CONFIG_CHANGED', '验证期间配置发生变化，请重新预览。');
        this.plans.delete(id);
        return { unchanged: true, client: plan.client, target: plan.target, trust: plan.selection.trust || 'preserve', verification, note: '接入与信任设置已经一致，未重复写入或生成备份。' };
      }
      const folder = path.join(this.config.dataDir, 'setup-backups'); await mkdir(folder, { recursive: true });
      const metadata = path.join(folder, `${id}.json`), ready = await exists(metadata);
      if (!ready && (await readdir(folder)).filter(file => file.endsWith('.json')).length >= 100) throw new BrowserError('SETUP_BACKUP_CAPACITY', '已保存 100 份配置备份，请先整理 setup-backups 再继续接入。');
      for (const [file, suffix] of [[plan, 'config'], [plan.permissions, 'permissions']] as const) {
        if (file?.before === undefined) continue;
        const backup = path.join(folder, `${id}.${suffix}`);
        if (await exists(backup)) { if (hash(await readConfig(backup)) !== hash(file.before)) throw new BrowserError('BACKUP_INVALID', '已有备份不完整或被修改，未覆盖；请重新预览创建新的备份。'); }
        else await writeFile(backup, file.before, { flag: 'wx', mode: 0o600 });
      }
      const record = (file: FileChange) => ({ target: file.target, existed: file.before !== undefined, beforeHash: hash(file.before), afterHash: hash(file.after) });
      const change = { id, client: plan.client, ...record(plan), ...(plan.configTarget ? { configTarget: plan.configTarget } : {}), ...(plan.permissions ? { permissions: record(plan.permissions) } : {}), selection: plan.selection, createdAt: new Date().toISOString() };
      if (ready) {
        const saved = await this.readBackup(id);
        if (saved.client !== change.client || !isDeepStrictEqual([saved.target, saved.existed, saved.beforeHash, saved.afterHash, saved.permissions], [change.target, change.existed, change.beforeHash, change.afterHash, change.permissions])) throw new BrowserError('BACKUP_INVALID', '已有备份与本次预览不一致，未覆盖；请重新预览。');
      } else await writeFile(metadata, JSON.stringify(change), { flag: 'wx', mode: 0o600 });
      // 连接配置和审批规则是两个文件：后一份写失败时撤回已写入且没被改动的前一份，重试和 restore 才有一致的起点。
      const written: FileChange[] = [];
      try { for (const file of files) { await atomicConfig(file.target, file.after, hash(file.before), () => this.assertTarget(file.target)); written.push(file); } }
      catch (error) {
        const stuck: string[] = [];
        for (const file of written.reverse()) {
          try {
            if (hash(await readConfig(file.target)) !== hash(file.after)) throw new Error('changed');
            if (file.before === undefined) await rm(file.target); else await atomicConfig(file.target, file.before, hash(file.after), () => this.assertTarget(file.target));
          } catch { stuck.push(file.target); }
        }
        if (stuck.length) throw new BrowserError('CLIENT_CONFIG_PARTIAL', `${error instanceof Error ? error.message : '写入失败'} 已写入的 ${stuck.join('、')} 没能撤回；备份已保留，请运行 connect --restore ${id} 恢复。`);
        throw error;
      }
      this.plans.delete(id);
      return { changeId: id, client: plan.client, target: plan.target, trust: plan.selection.trust || 'preserve', verification, note: plan.metadataOnly ? '机器信息已登记；客户端重连后显示。此次未连接网关，也未改变地址、凭据或审批。' : '配置已合并且 MCP 握手通过；在客户端新会话或 MCP 面板重连后生效，无需手动编辑配置。项目或组织策略仍可能覆盖此选择。' };
    } finally { this.busy = false; }
  }
  async restore(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new BrowserError('INVALID_CHANGE_ID', '配置变更 ID 无效。');
    if (this.busy) throw new BrowserError('SETUP_BUSY', '另一个配置操作正在进行。');
    this.busy = true;
    try {
      const folder = path.join(this.config.dataDir, 'setup-backups');
      const change = await this.readBackup(id), files = [[change, 'config'], ...change.permissions ? [[change.permissions, 'permissions']] : []] as [z.infer<typeof backupRecord>['permissions'] & {}, string][];
      // 每份文件只会是“接入后”（要恢复）或“接入前”（接入中途失败，没写进去，跳过）；其他内容说明被改过，一份都不动。
      const pending: typeof files = [];
      for (const entry of files) {
        const [file, suffix] = entry;
        await this.assertTarget(file.target);
        const current = hash(await readConfig(file.target));
        if (current === file.afterHash) {
          if (file.existed && hash(await readFile(path.join(folder, `${id}.${suffix}`), 'utf8').catch(() => '')) !== file.beforeHash) throw new BrowserError('BACKUP_INVALID', '备份校验失败，未覆盖。');
          pending.push(entry);
        } else if (current !== file.beforeHash) throw new BrowserError('CLIENT_CONFIG_CHANGED', '接入后配置已有其他改动，未覆盖；备份仍保留。');
      }
      for (const [file, suffix] of pending) {
        if (file.existed) {
          const before = await readFile(path.join(folder, `${id}.${suffix}`), 'utf8');
          if (hash(before) !== file.beforeHash) throw new BrowserError('BACKUP_INVALID', '备份校验失败，未覆盖。');
          await atomicConfig(file.target, before, file.afterHash, () => this.assertTarget(file.target));
        } else { await this.assertTarget(file.target); await rm(file.target); } // 只移除本次新建且哈希未变的单个配置文件。
      }
      return { restored: true, client: change.client, target: change.target };
    } finally { this.busy = false; }
  }
}
