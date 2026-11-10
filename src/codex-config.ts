import { parseForESLint, getStaticTOMLValue, type AST } from 'toml-eslint-parser';
import { MCP_NAME } from './client-config.js';
import { BrowserError } from './shared.js';
import { isDeepStrictEqual } from 'node:util';

const starts = (a: (string | number)[], b: string[]) => b.every((key, i) => a[i] === key);
function document(source: string) {
  try { return parseForESLint(source.replace(/^\ufeff/, ''), { tomlVersion: '1.0' }).ast; }
  catch { throw new BrowserError('CLIENT_CONFIG_INVALID', 'Codex TOML 配置无效或含重复键，未覆盖原文件。'); }
}
export function parseCodex(source: string): Record<string, any> { return getStaticTOMLValue(document(source)) as Record<string, any>; }
function value(input: unknown): string {
  if (typeof input === 'string' || typeof input === 'boolean' || (typeof input === 'number' && Number.isFinite(input))) return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(value).join(', ')}]`;
  if (input && typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype) return `{ ${Object.entries(input).map(([key, item]) => `${JSON.stringify(key)} = ${value(item)}`).join(', ')} }`;
  throw new BrowserError('CLIENT_CONFIG_INVALID', 'SaltedFish 配置含不支持的 TOML 值，未覆盖原文件。');
}
// 使用解析器的范围而非正则匹配表名；字符串、注释和其他服务的原始字节不参与替换。
export function mergeCodex(source: string, server: Record<string, unknown>): string {
  return mergeScope(source, ['mcp_servers', MCP_NAME], server);
}
export function mergeCodexHeaders(source: string, headers: Record<string, string>, name = MCP_NAME): string {
  return mergeScope(source, ['mcp_servers', name, 'http_headers'], headers);
}
export function removeCodexServer(source: string, name: string): string {
  return mergeScope(source, ['mcp_servers', name]);
}
// 不传 server 时删除该范围：连同其后的空行一起去掉，文件末尾不留空行。
function mergeScope(source: string, scope: string[], server?: Record<string, unknown>): string {
  const bom = source.startsWith('\ufeff') ? '\ufeff' : '', text = source.slice(bom.length), ast = document(text);
  if (isDeepStrictEqual(scope.reduce((item: any, key) => item?.[key], getStaticTOMLValue(ast)), server)) return source;
  const edits: { start: number; end: number; text: string }[] = [];
  let inline = false, tableAnchor: (typeof edits)[number] | undefined;
  const keyParts = (key: AST.TOMLKey) => key.keys.map(part => part.type === 'TOMLBare' ? part.name : part.value);
  const removal = ([start, end]: [number, number]) => { if (!server) while (text[end] === '\r' || text[end] === '\n') end++; return { start, end, text: '' }; };
  const visit = (node: AST.TOMLKeyValue, base: string[]) => {
    const keys = [...base, ...keyParts(node.key)];
    if (starts(keys, scope)) { edits.push(removal(node.range)); return; }
    if (!starts(scope, keys)) return;
    const current = getStaticTOMLValue(node.value) as Record<string, any>;
    if (!current || typeof current !== 'object' || Array.isArray(current)) throw new BrowserError('CLIENT_CONFIG_INVALID', 'Codex mcp_servers 必须是表。');
    let parent = current;
    for (const key of scope.slice(keys.length, -1)) { parent[key] ??= {}; parent = parent[key]; }
    if (server) parent[scope.at(-1)!] = server; else delete parent[scope.at(-1)!];
    edits.push({ start: node.value.range[0], end: node.value.range[1], text: value(current) }); inline = true;
  };
  for (const node of ast.body[0].body) {
    if (node.type === 'TOMLKeyValue') visit(node, []);
    else if (starts(node.resolvedKey, scope)) {
      const edit=removal(node.range);edits.push(edit);tableAnchor??=edit;
    }
    else if (node.kind === 'standard') for (const field of node.body) visit(field, node.resolvedKey as string[]);
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const block=server&&`[${scope.join('.')}]${eol}${Object.entries(server).map(([key, item]) => `${JSON.stringify(key)} = ${value(item)}`).join(eol)}`;
  // 保留已有表的位置与外部空白；反复升级不能不断留下旧表换行再追加新表。
  if(block&&!inline&&tableAnchor)tableAnchor.text=block;
  let result = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  if (block&&!inline&&!tableAnchor) result += `${result.endsWith('\n') || !result ? '' : eol}${eol}${block}${eol}`;
  if (!block) { const kept = result.trimEnd(); result = kept && kept + eol; }
  parseCodex(result); return bom + result;
}
