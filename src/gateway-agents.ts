import { mkdir, readFile, open, rename, unlink, rmdir, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { GatewayConfig } from './remote-gateway.js';
import { remoteUrl } from './remote-protocol.js';
import { withManagementMutex } from './management-lock.js';
import { BrowserError, NOT_DISPATCHED } from './shared.js';
import { CODEX_TOOL_SCHEMA_MAX_BYTES, MCP_NAME, openCodeConfig, withCatalogRevision } from './client-config.js';
import { mergeCodex } from './codex-config.js';
import { validateGatewayTls } from './gateway-tls.js';

export const gatewayAgentsHelp = 'agents list | agents add --name NAME --device UUID (--profiles UUID,UUID | --all-profiles) [--read-only] [--url https://HOST:PORT]';
const addInput = z.object({
  name: z.string().trim().min(1).max(100), deviceId: z.string().uuid(),
  profiles: z.union([z.literal('*'), z.array(z.string().uuid()).min(1).max(1000)]),
  readOnly: z.boolean().default(false), url: z.string().max(2048).optional(),
}).strict();
function fail(code: string, message: string): never { throw new BrowserError(code, message, NOT_DISPATCHED); }
const stringify = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const sameName = (name: string) => name.trim().normalize('NFKC').toLocaleLowerCase();
type FileMetadata = { uid: number; gid: number; mode: number };
const fileMetadata = (info: FileMetadata): FileMetadata => ({ uid: info.uid, gid: info.gid, mode: info.mode & 0o7777 });
export type GatewayAgentInvocation = { platform: NodeJS.Platform; command: string[]; suffix: string[] };
function connectInstruction(id: string, invocation?: GatewayAgentInvocation) {
  if (!invocation) return undefined;
  const windows = invocation.platform === 'win32';
  const quote = (value: string) => `'${value.replaceAll("'", windows ? "''" : "'\\''")}'`;
  const argv = [...invocation.command, 'connect', '--agent', id, '--clients', 'codex', '--keep-approvals', ...invocation.suffix];
  return { command: (windows ? '& ' : '') + argv.map(quote).join(' '), shell: windows ? 'PowerShell' : 'Bash / sh' };
}

async function configuration(directory: string) {
  const canonical = await realpath(path.resolve(directory));
  const file = path.join(canonical, 'gateway.json');
  const info = await lstat(file);
  if (!info.isFile()) fail('GATEWAY_CONFIG_PATH', 'gateway.json 必须是普通文件，未跟随配置文件链接。');
  if (info.size > 1024 * 1024) fail('GATEWAY_CONFIG_TOO_LARGE', '网关配置超过 1 MiB，未修改。');
  const original = await readFile(file, 'utf8');
  if (Buffer.byteLength(original) > 1024 * 1024) fail('GATEWAY_CONFIG_TOO_LARGE', '网关配置超过 1 MiB，未修改。');
  return { canonical, file, original, metadata: fileMetadata(info), config: GatewayConfig.parse(JSON.parse(original)) };
}

export async function listGatewayAgents(directory: string) {
  const { config } = await configuration(directory);
  return {
    devices: config.devices.map(({ id, label }) => ({ id, label })),
    agents: config.agents.map(({ id, label, deviceId, profiles, readOnly }) => ({ id, label, deviceId, profiles, readOnly })),
    note: '这里列出已授权身份，不代表在线；实际会话与活动请在浏览器连接管理页查看。',
  };
}

async function writePrivate(file: string, content: string, metadata?: FileMetadata) {
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    if (metadata) {
      // 配置可能归网关服务用户所有；先恢复所有者，再恢复可能被 chown 清除的模式位。
      if (process.platform !== 'win32') await handle.chown(metadata.uid, metadata.gid);
      await handle.chmod(metadata.mode);
    }
    await handle.sync();
  } finally { await handle.close(); }
}

async function configurationUnchanged(file: string, original: string, metadata: FileMetadata) {
  const info = await lstat(file);
  return info.isFile() && info.uid === metadata.uid && info.gid === metadata.gid && (info.mode & 0o7777) === metadata.mode
    && await readFile(file, 'utf8') === original;
}

export async function addGatewayAgent(directory: string, input: unknown, invocation?: GatewayAgentInvocation) {
  const parsed = addInput.safeParse(input);
  if (!parsed.success) fail('GATEWAY_AGENT_ARGUMENT', '新增 Agent 参数无效：需要名称、明确设备 UUID 和浏览器配置范围。');
  const value = parsed.data;
  if (Array.isArray(value.profiles) && new Set(value.profiles).size !== value.profiles.length) fail('GATEWAY_AGENT_ARGUMENT', '浏览器配置 ID 不能重复。');
  const initial = await configuration(directory);
  try {
    return await withManagementMutex(initial.canonical, async () => {
      const { canonical, file, original, metadata, config } = await configuration(directory);
      if (canonical !== initial.canonical) fail('GATEWAY_CONFIG_CHANGED', '网关目录身份已变化，未写入授权。');
      if (!config.devices.some(device => device.id === value.deviceId)) fail('GATEWAY_DEVICE_NOT_FOUND', '没有这个设备 ID；先运行 gateway agents list 核对，不能默认使用另一台电脑。');
      if (config.agents.some(agent => sameName(agent.label) === sameName(value.name))) fail('GATEWAY_AGENT_NAME_EXISTS', '该 Agent 名称已经存在；请为不同客户端使用可区分的名称。');
      if (config.agents.length >= 64) fail('GATEWAY_AGENT_CAPACITY', '当前网关最多 64 个 Agent 身份，未新增授权。');
      let endpoint: string, ca: string | undefined;
      if (value.url) {
        remoteUrl(value.url); // 拒绝带凭据/查询/路径的 URL，非回环必须 TLS。
        const url = new URL(value.url);
        if (!['http:', 'https:'].includes(url.protocol)) fail('GATEWAY_AGENT_URL', '客户端地址使用 http:// 或 https://，不使用 WebSocket 地址。');
        const hosts = new Set([...config.allowedHosts, `${config.host}:${config.port}`, `127.0.0.1:${config.port}`, `localhost:${config.port}`,
          ...(config.localPort ? [`127.0.0.1:${config.localPort}`, `localhost:${config.localPort}`] : [])]);
        if (!hosts.has(url.host)) fail('GATEWAY_AGENT_URL', '这个地址未在当前网关的允许 Host 中；请填写网关实际公布的地址。');
        if (url.protocol === 'https:') {
          if (!config.tls) fail('GATEWAY_AGENT_URL', '当前网关没有 TLS 配置，不能生成 HTTPS 接入。');
          ca = await validateGatewayTls(config.tls, url.hostname);
        } else if (config.tls && Number(url.port || 80) === config.port) fail('GATEWAY_AGENT_URL', '该端口使用 TLS，请使用 HTTPS。');
        url.pathname = '/mcp'; endpoint = url.toString();
      } else {
        if (!config.localPort) fail('GATEWAY_LOCAL_PORT_REQUIRED', '未配置回环 MCP 端口；请显式提供 --url 指向网关地址。');
        endpoint = `http://127.0.0.1:${config.localPort}/mcp`;
      }
      const id = randomUUID(), token = randomBytes(32).toString('hex');
      const instruction = connectInstruction(id, invocation);
      const next = GatewayConfig.parse({ ...config, agents: [...config.agents, { id, label: value.name, token, deviceId: value.deviceId, profiles: value.profiles, readOnly: value.readOnly }] });
      const root = path.join(canonical, 'agents'); await mkdir(root, { recursive: true, mode: 0o700 });
      if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) fail('GATEWAY_AGENT_PATH', 'Agent 凭据目录不能是链接，未写入授权。');
      const staging = path.join(root, `.new-${id}`), destination = path.join(root, id), temporary = path.join(canonical, `.gateway-agents-${id}.tmp`);
      const entry = withCatalogRevision({ url: endpoint, headers: { Authorization: `Bearer ${token}` } });
      if (!('url' in entry)) throw new Error('Expected HTTP entry');
      const contents: Record<string, string> = {
        'agent.token': token + '\n',
        'codex-remote.toml': mergeCodex('', { url: endpoint, http_headers: entry.headers, startup_timeout_sec: 20, tool_timeout_sec: 330, tool_input_schema_max_bytes: CODEX_TOOL_SCHEMA_MAX_BYTES }),
        'claude-remote.json': stringify({ mcpServers: { [MCP_NAME]: { type: 'http', url: endpoint, headers: entry.headers } } }),
        'opencode-remote.json': stringify(openCodeConfig(entry)),
        ...(ca ? { 'gateway-ca.pem': ca } : {}),
        'README.txt': `Agent：${value.name}\n设备：${value.deviceId}\n范围：${value.profiles === '*' ? '所有当前及未来浏览器配置' : value.profiles.join(', ')}\n权限：${value.readOnly ? '只读' : '读取与操作'}\nMCP：${endpoint}\n\n此目录包含私有凭据，请仅交给这个 Agent 的使用者。三个客户端配置是替代格式；不同 Agent 应各自新增独立身份。\n${value.url ? '此地址用于明确的网关端点。' : '此回环地址只能用于网关所在电脑，其他电脑不能直接使用。'}\n${ca ? 'TLS 保持正常校验；如果客户端尚不信任该证书，请按客户端支持的方式信任 gateway-ca.pem，不要关闭 TLS 验证。\n' : ''}${instruction ? `在网关机用 ${instruction.shell} 自动接入：\n${instruction.command}\n` : '请按客户端的 MCP 接入方式导入本目录对应的配置文件。\n'}Claude Code 可使用本目录 claude-remote.json。其他电脑需要安全传递对应配置，按客户端 MCP 接入方式导入。\n`,
      };
      let folder = staging, committed = false;
      await mkdir(staging, { mode: 0o700 });
      try {
        for (const [name, content] of Object.entries(contents)) await writePrivate(path.join(staging, name), content);
        if (await realpath(directory) !== canonical || await realpath(root) !== root || !await configurationUnchanged(file, original, metadata)) fail('GATEWAY_CONFIG_CHANGED', '配置或凭据目录在预检后发生变化，未覆盖现有授权。');
        await rename(staging, destination); folder = destination;
        await writePrivate(temporary, stringify(next), metadata);
        if (!await configurationUnchanged(file, original, metadata)) fail('GATEWAY_CONFIG_CHANGED', '配置已被其他程序修改，未覆盖。');
        await rename(temporary, file); committed = true;
        return { agentId: id, name: value.name, deviceId: value.deviceId, profiles: value.profiles, readOnly: value.readOnly, mcpUrl: endpoint,
          credentialDirectory: destination, tokenFile: path.join(destination, 'agent.token'),
          clientFiles: { codex: path.join(destination, 'codex-remote.toml'), claude: path.join(destination, 'claude-remote.json'), opencode: path.join(destination, 'opencode-remote.json') },
          ...(ca ? { caFile: path.join(destination, 'gateway-ca.pem') } : {}),
          next: instruction?.command ?? '请按客户端的 MCP 接入方式导入 clientFiles 中的对应配置文件。',
          ...(instruction ? { nextShell: instruction.shell } : {}),
          note: '已新增授权身份；运行中的网关会重新读取授权列表。这不代表 Agent 已连接，连接后请回到浏览器 Agent 列表核验。',
          endpointScope: value.url ? 'explicit-gateway-url' : 'gateway-machine-only' };
      } finally {
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (!committed && await realpath(folder).catch(() => '') === folder && !((await lstat(folder)).isSymbolicLink())) {
          // 只清理由本次随机 ID 创建的确切文件，不递归删除未知内容。
          for (const name of Object.keys(contents)) await unlink(path.join(folder, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
          await rmdir(folder).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
        }
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('另一个安装或恢复操作')) fail('GATEWAY_AGENT_BUSY', '另一个网关授权修改正在进行，请稍后重试；现有授权未覆盖。');
    throw error;
  }
}

export function takeGatewayAgentOption(args: string[], name: string) {
  const indexes = args.flatMap((arg, index) => arg === name ? [index] : []);
  if (indexes.length > 1) fail('GATEWAY_AGENT_ARGUMENT', `参数 ${name} 不能重复。`);
  if (!indexes.length) return undefined;
  const index = indexes[0]!, value = args[index + 1];
  if (!value || value.startsWith('--')) fail('GATEWAY_AGENT_ARGUMENT', `参数 ${name} 需要值。`);
  args.splice(index, 2); return value;
}

export async function gatewayAgentsCommand(directory: string, inputArgs: string[], invocation?: GatewayAgentInvocation) {
  const args = [...inputArgs], command = args.shift();
  if (command === 'list' && !args.length) return listGatewayAgents(directory);
  if (command !== 'add') fail('GATEWAY_AGENT_ARGUMENT', gatewayAgentsHelp);
  const name = takeGatewayAgentOption(args, '--name'), deviceId = takeGatewayAgentOption(args, '--device'), profiles = takeGatewayAgentOption(args, '--profiles'), url = takeGatewayAgentOption(args, '--url');
  const flag = (value: string) => { const found = args.indexOf(value); if (found < 0) return false; args.splice(found, 1); return true; };
  const all = flag('--all-profiles'), readOnly = flag('--read-only');
  if (args.length || !!profiles === all || profiles === '*') fail('GATEWAY_AGENT_ARGUMENT', '明确使用 --profiles UUID,UUID 或 --all-profiles；其余只接受 --name、--device、--read-only 和 --url。');
  return addGatewayAgent(directory, { name, deviceId, profiles: all ? '*' : profiles?.split(','), readOnly, ...(url ? { url } : {}) }, invocation);
}
