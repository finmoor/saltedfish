import { parse, parseTree, type Node, type ParseError } from 'jsonc-parser';
import { LEGACY_MCP_NAME, MCP_NAME } from './client-config.js';
import { parseCodex } from './codex-config.js';
import { BrowserError } from './shared.js';
import { clientJsonc, type SetupClient } from './client-types.js';

export function parseClientJson(text: string, comments: boolean): Record<string, any> {
  const source = text.replace(/^\ufeff/, '');
  const errors: ParseError[] = [], options = { allowTrailingComma: comments, disallowComments: !comments };
  const tree = parseTree(source, errors, options);
  if (errors.length || tree?.type !== 'object') throw new BrowserError('CLIENT_CONFIG_INVALID', '客户端配置不是有效对象，未覆盖原文件。');
  function check(node: Node) {
    if (node.type === 'object') {
      const keys = node.children!.map(child => child.children![0]!.value);
      if (new Set(keys).size !== keys.length) throw new BrowserError('DUPLICATE_CONFIG_KEY', '客户端配置含重复键，需先明确保留哪一项。');
    }
    node.children?.forEach(check);
  }
  check(tree);
  return parse(source, [], options) as Record<string, any>;
}

// 检测、预览、协议检查共用同一格式判定。既有格式自动沿用；空配置默认 OpenCode 2。
// 文档形状的规则（OpenCode 1/2 结构与混合、重复键、MCP 容器和本服务条目必须是对象）只写在这里：调用方不要再自带第二套检查，
// 否则改了这里的规则后，调用方里不可达的旧检查会让人误以为那里还有一道有效校验（tests/client-format.test.ts 守护）。
export function clientDocument(client: SetupClient, source: string, requested?: 'v1' | 'v2') {
  // agy 用 hujson 读配置，和 OpenCode 一样允许注释和结尾逗号。
  const data = client === 'codex' ? parseCodex(source) : parseClientJson(source || '{}', clientJsonc(client));
  let format: 'v1' | 'v2' = requested || 'v2';
  const object = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (client === 'codebuddy' && data.disabledMcpServers !== undefined && (!Array.isArray(data.disabledMcpServers) || data.disabledMcpServers.some((item: unknown) => typeof item !== 'string'))) throw new BrowserError('CLIENT_CONFIG_INVALID', 'CodeBuddy disabledMcpServers 必须是名称数组，未覆盖配置。');
  for (const value of client === 'codex' ? [data.mcp_servers] : client === 'opencode' ? [data.mcp, data.mcp?.servers] : [data.mcpServers]) {
    if (value !== undefined && !object(value)) throw new BrowserError('CLIENT_CONFIG_INVALID', 'MCP 配置必须是对象，请先检查原配置。');
  }
  if (client === 'opencode') {
    const legacy = data.permission !== undefined || Object.keys(data.mcp || {}).some(key => !['servers', 'timeout'].includes(key));
    const modern = data.mcp?.servers !== undefined || data.permissions !== undefined;
    if (legacy && modern) throw new BrowserError('MIXED_OPENCODE_CONFIG', '检测到 OpenCode 1 和 2 混合结构，请先在客户端明确使用的格式；未检查连接或改写文件。');
    if (requested === 'v2' && legacy) throw new BrowserError('LEGACY_OPENCODE_CONFIG', '检测到 OpenCode 1 配置结构，请选择 OpenCode 1 格式；不能混入 v2。');
    if (requested === 'v1' && modern) throw new BrowserError('MODERN_OPENCODE_CONFIG', '检测到 OpenCode 2 配置结构，请选择 OpenCode 2 格式。');
    format = requested || (legacy ? 'v1' : 'v2');
  }
  const container = client === 'codex' ? ['mcp_servers'] : client !== 'opencode' ? ['mcpServers'] : format === 'v1' ? ['mcp'] : ['mcp', 'servers'];
  let parent: Record<string, any> = data;
  for (const key of container) parent = parent[key] || {};
  if ([parent[MCP_NAME], parent[LEGACY_MCP_NAME]].some(value => value !== undefined && !object(value))) throw new BrowserError('CLIENT_CONFIG_INVALID', 'SaltedFish 配置条目无效，请先检查原配置。');
  // 新名称优先；只有旧名称时 name 指向旧条目，接入时再迁移。
  const legacy = parent[LEGACY_MCP_NAME] !== undefined, name = !legacy || parent[MCP_NAME] !== undefined ? MCP_NAME : LEGACY_MCP_NAME;
  return { data, format, container, name, legacy, current: parent[name] as Record<string, any> | undefined };
}
