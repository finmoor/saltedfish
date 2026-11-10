import { VERSION } from './version.js';
import type { SetupClient } from './client-types.js';

export interface ClientEntry { command: string; args: string[]; env: Record<string, string> }
export interface RemoteClientEntry { url: string; headers: Record<string, string> }
export type SetupEntry = ClientEntry | RemoteClientEntry;
export type ClientTrust = 'preserve' | 'service' | 'prompt';
export const MCP_NAME = 'saltedfish';
// 0.3.0-beta.5 之前写入客户端配置的名称，只用于识别和迁移旧条目。
export const LEGACY_MCP_NAME = 'feng-chrome';
export const browserPermission = `${MCP_NAME}_*`;
export const legacyBrowserPermission = `${LEGACY_MCP_NAME}_*`;
// Codex 默认会压缩超过 5000 字节的单工具 schema；步骤分支需要完整保留。
export const CODEX_TOOL_SCHEMA_MAX_BYTES = 32768;

// 显式改变连接配置的版本，避免宿主升级后复用相同入口的旧工具目录。
// 仅是非敏感的目录修订标记，不参与授权或改变配对身份。
export function withCatalogRevision(entry: SetupEntry, revision = VERSION): SetupEntry {
  if ('url' in entry) return { ...entry, headers: { ...entry.headers, 'X-SaltedFish-Catalog-Version': revision } };
  return { ...entry, env: { ...entry.env, SALTEDFISH_CATALOG_VERSION: revision } };
}

// OpenCode v1 和 v2 的配置结构不同，不能用 enabled/数字 timeout 混填 v2。
export function openCodeConfig(entry: SetupEntry, major: 1 | 2 = 2) {
  const server = 'url' in entry ? { type: 'remote', url: entry.url, headers: entry.headers, oauth: false } : { type: 'local', command: [entry.command, ...entry.args], environment: entry.env };
  return major === 1
    ? { mcp: { [MCP_NAME]: { ...server, enabled: true, timeout: 320000 } } }
    : { mcp: { servers: { [MCP_NAME]: { ...server, timeout: { startup: 20000, catalog: 30000, execution: 320000 } } } } };
}

// env 子表的服务名必须和主表一致，否则 Codex 拿不到独立凭据，连接会退回管理员令牌。
export function codexConfig(entry: ClientEntry) {
  const env = Object.entries(entry.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n');
  return `[mcp_servers.${MCP_NAME}]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\nstartup_timeout_sec = 20\ntool_timeout_sec = 320\ntool_input_schema_max_bytes = ${CODEX_TOOL_SCHEMA_MAX_BYTES}\n\n[mcp_servers.${MCP_NAME}.env]\n${env}\n`;
}

// 配置只能导入和服务在同一台电脑上的 Agent：/mcp 只接受本机连接（mcp-http.ts 的 fromThisMachine），别的电脑连上去是 403 MCP_LOCAL_ONLY。
// Linux 服务监听内网 IP，同机的 Agent 连这个 IP 也算本机。密钥只在创建授权的这次响应中提供。
export function httpAgentConfigurations(url:string,token:string): Record<SetupClient, string>{
  const entry=withCatalogRevision({url,headers:{Authorization:'Bearer '+token}}) as RemoteClientEntry;
  return{
    claude:JSON.stringify({mcpServers:{[MCP_NAME]:{type:'http',...entry}}},null,2),
    opencode:JSON.stringify(openCodeConfig(entry),null,2),
    codex:`[mcp_servers.${MCP_NAME}]\nurl = ${JSON.stringify(url)}\nhttp_headers = { ${Object.entries(entry.headers).map(([k,v])=>JSON.stringify(k)+' = '+JSON.stringify(v)).join(', ')} }\nstartup_timeout_sec = 20\ntool_timeout_sec = 320\ntool_input_schema_max_bytes = ${CODEX_TOOL_SCHEMA_MAX_BYTES}\n`,
    // pi 写进 ~/.pi/agent/mcp.json，agy 写进 ~/.gemini/config/mcp_config.json；字段和 connect 写的一样。
    pi:JSON.stringify({mcpServers:{[MCP_NAME]:{...entry,timeout:330,exposure:'deferred'}}},null,2),
    agy:JSON.stringify({mcpServers:{[MCP_NAME]:{serverUrl:entry.url,headers:entry.headers}}},null,2),
    codebuddy:JSON.stringify({mcpServers:{[MCP_NAME]:{type:'http',...entry}}},null,2),
    workbuddy:JSON.stringify({mcpServers:{[MCP_NAME]:{type:'http',...entry}}},null,2),
    'claude-desktop':JSON.stringify({mcpServers:{[MCP_NAME]:{command:'saltedfish',args:['mcp-bridge'],env:{SALTEDFISH_MCP_URL:url,SALTEDFISH_MCP_TOKEN:token,SALTEDFISH_CATALOG_VERSION:VERSION}}}},null,2),
  };
}
