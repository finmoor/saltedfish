// 接入、HTTP 校验和配置解析共用客户端清单；claude 始终指 Claude Code。
export const setupClients = ['codex', 'opencode', 'claude', 'pi', 'agy', 'claude-desktop', 'codebuddy', 'workbuddy'] as const;
export type SetupClient = typeof setupClients[number];
export const clientLabels: Record<SetupClient, string> = { codex: 'Codex', opencode: 'OpenCode', claude: 'Claude Code', pi: 'pi', agy: 'agy', 'claude-desktop': 'Claude Desktop', codebuddy: 'CodeBuddy', workbuddy: 'WorkBuddy' };
export const clientJsonc = (client: SetupClient) => ['opencode', 'agy', 'codebuddy'].includes(client);
export const clientUserOnly = (client: SetupClient) => ['agy', 'claude-desktop', 'workbuddy'].includes(client);
export const clientOwnApprovals = (client: SetupClient) => ['pi', 'claude-desktop', 'workbuddy'].includes(client);
export const clientLazyCredential = (client: SetupClient) => !['claude', 'opencode', 'codex'].includes(client);
