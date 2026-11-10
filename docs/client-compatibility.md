# 客户端配置与兼容性

优先用 `saltedfish connect` 或管理页接入，不必手动拼配置。本文说明配置位置、格式、重载和审批差异，不承诺覆盖所有客户端版本或组织策略。

当前服务默认列出 46 个工具；给 Agent 开启“高级工具”并重连后列出 64 个。工具用法见[交互说明](interaction.md)。

## 通用规则

- `/mcp` 只接受服务同机连接；其他电脑返回 HTTP 403 `MCP_LOCAL_ONLY`。Chrome 扩展可以位于其他电脑。
- Linux npm 用户级接入默认写 HTTP 配置；Windows 和项目级配置使用固定 stdio launcher。Claude Desktop 始终使用 stdio。
- 每个客户端使用独立授权。配置和备份含凭据，应当私有保管。
- 接入保留原禁用状态。文件里有连接不等于连接已经启用。
- 自定义配置用 `--config FILE`，项目配置用 `--project DIR`，均为绝对路径且一次一个客户端。向导不修改客户端启动参数，需确认客户端确实加载该文件。
- 配置变更后重新加载 MCP。新连接读到了新工具，不代表旧会话已刷新；项目和组织配置仍可能覆盖用户配置。

## Codex CLI

**配置位置与格式**

- 用户级：`~/.codex/config.toml`；设置 `CODEX_HOME` 时使用该目录下的 `config.toml`。
- 项目级：`.codex/config.toml`。
- TOML 服务表为 `mcp_servers.saltedfish`。stdio 使用 `command`、`args`、`env`；HTTP 使用 `url`、`http_headers`。

`connect` 设置 `startup_timeout_sec = 20`、`tool_timeout_sec = 330`，并将本服务的 `tool_input_schema_max_bytes` 保持至少 `32768`，保留已有更高值。不要缩小 schema 额度，否则复杂步骤参数可能丢失。

**重载与审批**

在 MCP 管理入口重连，或新开客户端会话。一次信任设置 `default_tools_approval_mode = "approve"`，保留已有逐工具例外；撤销时改回 `"prompt"`，同时将本服务已有逐工具 `approval_mode` 改回 `"prompt"`。不修改全局审批、沙箱或 Shell 权限。非交互模式仍可能受客户端总审批策略限制。

## OpenCode

**配置位置与格式**

- 用户级：`~/.config/opencode/opencode.json` 或 `opencode.jsonc`；`XDG_CONFIG_HOME` 改变配置根目录，`OPENCODE_CONFIG` 可直接指定文件。
- 项目级：项目根目录的 `opencode.json` 或 `opencode.jsonc`。
- 同一目录两个文件都存在时，向导拒绝猜测，需用 `--config` 选定文件。

OpenCode 2 使用 `mcp.servers.saltedfish`，stdio 的 `command` 为数组，环境变量写 `environment`；HTTP 使用 `type: "remote"`、`url`、`headers`、`oauth: false`。超时分别为启动 20 秒、目录 30 秒、执行 320 秒。

OpenCode 1 使用 `mcp.saltedfish`，使用 `enabled` 和数值 `timeout`，不能与 v2 结构混用。已有配置自动沿用格式，空配置默认 v2；管理页可明确选择格式，冲突时拒绝写入。

**重载与审批**

重连 MCP，再新开会话。一次信任仅支持 OpenCode 2：在 `permissions` 规则数组中允许 `saltedfish_*`，并只将此连接设为 `codemode: false`，以直接工具模式执行。撤销信任将工具组设为 `ask`；其他工具和通用 `execute` 权限保持不变。旧的 `permission` 对象不能当作 v2 的规则数组使用。

其他 MCP 不应使用以 `saltedfish_` 开头的名称，否则信任规则的匹配范围会重叠，向导会拒绝合并。OpenCode 1 应使用 `--keep-approvals` 接入，不支持一次信任。

工具目录可能异步加载。命令列出空目录时，应核对 MCP 状态及当前会话是否已加载，不要直接判断服务没有工具。

## Claude Code

**配置位置与格式**

- 用户级：`~/.claude.json`；设置 `CLAUDE_CONFIG_DIR` 时，向导使用该目录下的 `.claude.json`。
- 项目级：项目根目录 `.mcp.json`。
- 严格 JSON，连接写在 `mcpServers.saltedfish`。
- 用户审批：`~/.claude/settings.json`；设置 `CLAUDE_CONFIG_DIR` 时为该目录下的 `settings.json`。
- 项目审批：`.claude/settings.local.json`，不写入共享设置文件。

**重载与审批**

从 MCP 面板重连或新开会话。一次信任在 `permissions.allow` 增加 `mcp__saltedfish__*`；撤销只移除本服务的整服务允许规则。已有逐工具询问或拒绝规则保留。项目首次启用、项目同名 MCP 和受管理设置仍可能影响结果，需在客户端核对。

HTTP 调用撞上服务重启时，非交互 `-p` 会话可能不能自行恢复，需手动重连；不要据此重复业务动作。

## pi

**配置位置与格式**

- 用户级：`~/.pi/agent/mcp.json`；`PI_CODING_AGENT_DIR` 覆盖目录。
- 项目级：`.pi/mcp.json`，只在受信任的项目中读取。
- 严格 JSON，连接写在 `mcpServers.saltedfish`。

`connect` 将 `timeout` 保持至少 330 秒；没有设置过 `exposure` 时写入 `deferred`，按需加载工具。已有 `exposure`、`enabled` 保留。

**重载与审批**

在 pi 的 `/mcp` 中检查、启用或重连，必要时新开会话。pi 默认不逐次确认工具调用；SaltedFish 不写一次信任或撤销规则。使用 pi-mcp-adapter 时，适配器的 `approveTools` 由使用者管理；不要把不同适配器的配置格式混用。停止访问应撤销服务端授权，而不是依赖 `--revoke-trust`。

## agy / Antigravity CLI

**配置位置与格式**

- 仅用户级：`~/.gemini/config/mcp_config.json`，支持 JSONC。
- 连接写在 `mcpServers.saltedfish`。HTTP 地址写 `serverUrl`，也识别已有 `url`。
- 不支持 `--project`。
- 审批文件：`~/.gemini/antigravity-cli/settings.json`。

**重载与审批**

重连 MCP 或新开会话后核对连接。一次信任在 `permissions.allow` 增加 `mcp(saltedfish/*)`；撤销移除该规则，其他设置保留。若客户端本身的审批策略已默认放行工具，移除单条允许规则不会让它重新询问。

## Claude Desktop

**配置位置与格式**

- Windows 常规安装：`%APPDATA%/Claude/claude_desktop_config.json`。
- Windows 商店安装：数据目录可能在 `%LOCALAPPDATA%/Packages/Claude_*/LocalCache/Roaming/Claude/`，或迁移后的 `%LOCALAPPDATA%/Claude-Data/claude_*/`，文件名相同。向导会排除含 `.user-data-left.*` 标记的旧目录。
- macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`；SaltedFish 的 macOS 分发未验证。
- Linux 路径检测使用 `$XDG_CONFIG_HOME/Claude/claude_desktop_config.json`，未设置时为 `~/.config/Claude/` 下同名文件。这不表示存在官方 Linux 客户端。
- 严格 JSON，`mcpServers.saltedfish` 只使用 stdio，不支持 `--project`。

**接入与重载**

先完全退出 Desktop，包括托盘进程，再运行 `saltedfish connect --clients claude-desktop --keep-approvals`，随后重启。Desktop 开着时可能用内存中的配置覆盖外部写入。多数据目录时，从 Desktop 的“设置 → 开发者 → 编辑配置”确认文件，再用 `--config` 指定。

本机自动接入使用固定 stdio 入口。管理页“新增 Agent → Claude Desktop”生成 `saltedfish mcp-bridge` 配置，将 stdio 转发到同机服务的 HTTP 入口。桥接读取 `SALTEDFISH_MCP_URL`、`SALTEDFISH_MCP_TOKEN`，使用独立授权，不启动服务，不使用管理员凭据，也不重试失败的 POST。

GUI 若找不到全局 `saltedfish`，可将配置的 `command` 改为 Node 可执行文件绝对路径，将 `args` 改为 `["<全局 npm 根目录>/saltedfish/dist/npm-cli.js", "mcp-bridge"]`，原 `env` 保留。通过 `node -p process.execPath` 和 `npm root -g` 查路径。

审批在 Desktop 内确认，SaltedFish 不修改它的审批存储。桥接不能越过 `/mcp` 的同机限制。

## CodeBuddy

**配置位置与格式**

用户级依次取首个存在文件：`~/.codebuddy/.mcp.json`、`~/.codebuddy/mcp.json`、`~/.codebuddy.json`，均无时创建第一个。`CODEBUDDY_CONFIG_DIR` 覆盖目录；设置后，候选 `.codebuddy.json` 也在该目录内。

项目级优先 `.mcp.json`，其次 `mcp.json`。配置支持 JSONC 和尾逗号，连接写在 `mcpServers.saltedfish`，传输类型为 `http` 或 `stdio`。

**重载与审批**

重载 MCP；首次启用项目 MCP 时按提示确认。一次信任在用户配置目录的 `settings.json` 或项目 `.codebuddy/settings.local.json` 中增加 `mcp__saltedfish__*`。撤销移除整服务允许规则，保留其他规则、逐工具例外和禁用状态。项目与受管理设置可能覆盖用户设置。

## WorkBuddy

**配置位置与格式**

默认 `~/.workbuddy/mcp.json`。目录环境变量优先 `WORKBUDDY_CONFIG_DIR`，其次 `CODEBUDDY_CONFIG_DIR`。严格 JSON，连接为 `mcpServers.saltedfish`，传输类型为 `http` 或 `stdio`。不采用内置 CLI 的 `.mcp.json` 优先级，不支持项目配置。

**重载与审批**

在 MCP 设置中刷新、批准配置，再新开会话。连接配置变化后可能重新要求批准。SaltedFish 不修改它的审批存储；`--trust-browser`、`--revoke-trust` 不替代应用批准。

## 配置保护与排查

接入会备份原文件，尽量保留注释、BOM、换行和其他配置。坏 JSON、重复键、混合 OpenCode 格式、预览后路径或文件变化都会拒绝覆盖。文件占用时先退出写入它的应用，再重试。

用 `connect --history` 查看变更，`connect --restore ID` 恢复原字节。接入后有其他修改时，恢复会停止，不覆盖后续内容。升级刷新被跳过时，可显式选择文件重新预览；不要直接删除备份或强行覆盖配置。

排查顺序：确认实际配置文件 → 确认连接已启用 → 重连 MCP → 核对工具目录 → 核对项目或组织审批。一次信任的边界和撤销方法见[一次信任](once-trust.md)。

官方参考：[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[Claude Code MCP](https://code.claude.com/docs/en/mcp)、[OpenCode 2 MCP](https://opencode.ai/v2/docs/mcp-servers)、[Desktop 本地 MCP](https://modelcontextprotocol.io/docs/develop/connect-local-servers)、[CodeBuddy MCP](https://www.codebuddy.cn/docs/cli/mcp)。
