export function clientReloadHint(client, label) {
  if (client === 'claude-desktop') return '完全退出并重启 Claude Desktop，在应用内确认工具审批';
  if (client === 'workbuddy') return '在 WorkBuddy 的 MCP 设置中刷新并批准 SaltedFish 配置，再新开会话';
  return `在 ${label} 中新开会话或重载 MCP`;
}

export function clientImportHint(client) {
  if (client === 'claude-desktop') return 'Desktop 必须和服务在同一台电脑上（服务只接受本机的 Agent），这台电脑已装好 SaltedFish，确保 Desktop 能启动 saltedfish 命令。将配置合并到“设置 → 开发者 → 编辑配置”打开的 claude_desktop_config.json；完全退出并重启，在应用内确认审批。若提示找不到命令，按客户端兼容文档改为 node 和 npm-cli.js 的绝对路径。';
  if (client === 'workbuddy') return '合并到 WorkBuddy 配置目录下的 mcp.json（默认 ~/.workbuddy/mcp.json，严格 JSON）。在 MCP 设置中刷新并批准配置，再新开会话。';
  if (client === 'codebuddy') return '合并到 CodeBuddy 首个存在的用户配置：~/.codebuddy/.mcp.json、~/.codebuddy/mcp.json、~/.codebuddy.json；都不存在时用第一个。配置目录可由 CODEBUDDY_CONFIG_DIR 覆盖。重载 MCP，按客户端提示确认审批。';
  return '将配置合并到服务所在电脑上目标 Agent 的 MCP 配置文件（别的电脑上的 Agent 连不上），再新开会话或重载 MCP。';
}
