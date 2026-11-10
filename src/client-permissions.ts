import { isDeepStrictEqual } from 'node:util';
import { applyEdits, modify } from 'jsonc-parser';
import { LEGACY_MCP_NAME, MCP_NAME, type ClientTrust } from './client-config.js';
import { parseClientJson } from './client-document.js';
import { BrowserError } from './shared.js';

// Claude Code、CodeBuddy 和 agy 的审批规则都写在 permissions.allow / ask / deny，只是规则写法不同。
interface RuleFormat { label: string; grants: (name: string) => string[]; ofService: (rule: string) => boolean; legacy?: (rule: string) => string; comments: boolean }
const lists = ['allow', 'ask', 'deny'] as const;
const claudePrefix = (name: string) => `mcp__${name}`;
const legacyRule = new RegExp(`^${claudePrefix(LEGACY_MCP_NAME)}(__|$)`);
const claude: RuleFormat = { label: 'Claude Code', grants: name => [claudePrefix(name), `${claudePrefix(name)}__*`], ofService: rule => rule === claudePrefix(MCP_NAME) || rule.startsWith(`${claudePrefix(MCP_NAME)}__`), legacy: rule => rule.replace(legacyRule, `${claudePrefix(MCP_NAME)}$1`), comments: false };
const agy: RuleFormat = { label: 'agy', grants: name => [`mcp(${name}/*)`], ofService: rule => rule.startsWith(`mcp(${MCP_NAME}/`), comments: true };
const codebuddy: RuleFormat = { ...claude, label: 'CodeBuddy', comments: true };
export const claudePermission = claude.grants(MCP_NAME)[1]!;
export const agyPermission = agy.grants(MCP_NAME)[0]!;

function rules(format: RuleFormat, source: string) {
  const permissions = parseClientJson(source || '{}', format.comments).permissions ?? {};
  if (typeof permissions !== 'object' || Array.isArray(permissions) || lists.some(list => permissions[list] !== undefined && !(Array.isArray(permissions[list]) && permissions[list].every((rule: unknown) => typeof rule === 'string')))) throw new BrowserError('CLIENT_CONFIG_INVALID', `${format.label} 的 permissions 规则必须是字符串数组；未覆盖原配置。`);
  return permissions as Partial<Record<(typeof lists)[number], string[]>>;
}
const trusted = (format: RuleFormat) => (source: string, name = MCP_NAME) => !!rules(format, source).allow?.some(rule => format.grants(name).includes(rule));
// 用户针对单个工具留的询问或拒绝优先于整服务的允许，信任时要提醒。
const exceptions = (format: RuleFormat) => (source: string) => { const current = rules(format, source); return [...current.ask ?? [], ...current.deny ?? []].some(rule => format.ofService(format.legacy?.(rule) ?? rule)); };
// 只动本服务的规则：旧连接名的规则跟着改名，信任和撤销只增删整服务的允许规则，其他规则和设置保持原样。
const merge = (format: RuleFormat) => (source: string, trust: ClientTrust) => {
  const bom = source.startsWith('\ufeff') ? '\ufeff' : '', current = rules(format, source), options = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: source.includes('\r\n') ? '\r\n' : '\n' } };
  const grants = format.grants(MCP_NAME);
  let text = source.slice(bom.length);
  for (const list of lists) {
    const before = current[list] ?? [];
    let next = [...new Set(format.legacy ? before.map(format.legacy) : before)];
    if (list === 'allow' && trust === 'service' && !next.some(rule => grants.includes(rule))) next.push(grants.at(-1)!);
    if (list === 'allow' && trust === 'prompt') next = next.filter(rule => !grants.includes(rule));
    if (!isDeepStrictEqual(next, before)) text = applyEdits(text, modify(text, ['permissions', list], next, options));
  }
  return bom + text;
};
export const claudeTrusted = trusted(claude), claudeExceptions = exceptions(claude), mergeClaudeSettings = merge(claude);
export const agyTrusted = trusted(agy), agyExceptions = exceptions(agy), mergeAgySettings = merge(agy);
export const codebuddyTrusted = trusted(codebuddy), codebuddyExceptions = exceptions(codebuddy), mergeCodebuddySettings = merge(codebuddy);
