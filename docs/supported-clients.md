# 支持的 Agent 客户端

SaltedFish 支持以下八种客户端。接入向导只合并 `saltedfish` 这一项 MCP，不修改模型登录或其他 MCP。

## 客户端与接入方式

| 客户端 | 接入方式 | 一次信任 |
| --- | --- | --- |
| Codex CLI（`codex`） | 用户或项目 TOML；HTTP 或 stdio | 支持，仅设置本 MCP 的默认许可，保留逐工具例外 |
| OpenCode（`opencode`） | JSON/JSONC；OpenCode 2 使用 `mcp.servers`，OpenCode 1 使用 `mcp`；HTTP 或 stdio | OpenCode 2 支持 `saltedfish_*` 工具组；OpenCode 1 保留宿主审批 |
| Claude Code（`claude`） | 用户 JSON 或项目 `.mcp.json`；HTTP 或 stdio | 支持 `mcp__saltedfish__*` 规则 |
| pi（`pi`） | 用户 `mcp.json` 或项目 `.pi/mcp.json`；HTTP 或 stdio | 不写审批规则；默认不逐次确认，按 pi 或所用适配器的设置管理 |
| agy / Antigravity CLI（`agy`） | 用户级 JSONC `mcp_config.json`；HTTP 或 stdio | 支持 `mcp(saltedfish/*)` 规则 |
| Claude Desktop（`claude-desktop`） | 用户级严格 JSON，仅 stdio；管理页配置通过 `mcp-bridge` 转发到同机 HTTP 服务 | 在应用内确认，不写审批存储 |
| CodeBuddy（`codebuddy`） | 用户或项目 JSONC；HTTP 或 stdio | 支持 `mcp__saltedfish__*` 规则；项目首次启用仍需确认 |
| WorkBuddy（`workbuddy`） | 用户级严格 JSON；HTTP 或 stdio | 在应用内批准，配置更新后可能需要重新批准 |

Linux npm 用户级自动接入默认使用 HTTP，Claude Desktop 除外。Windows 和项目级自动接入使用固定 stdio launcher，避免将令牌写进可能入库的项目文件。手动使用管理页生成的配置时，按客户端支持的传输导入。

`claude` 始终指 Claude Code，不是 Claude Desktop。详细路径、格式和重载步骤见[客户端配置与兼容性](client-compatibility.md)。

## 使用 `saltedfish connect`

在服务所在电脑上、以使用该客户端的操作系统用户执行：

```sh
saltedfish connect --preview
saltedfish connect --keep-approvals
saltedfish connect --clients codex,opencode,claude --trust-browser
saltedfish connect --clients claude-desktop,codebuddy,workbuddy --keep-approvals
```

- 不传 `--clients` 时，只接入检测到已安装或已有配置的客户端。
- `--preview` 只显示计划，不写配置。
- `--keep-approvals` 接入并保留原审批；它不会撤销已有信任。
- `--trust-browser` 为支持的客户端开启服务级信任，范围见[一次信任](once-trust.md)。
- `--revoke-trust` 撤销本服务的默认信任，不撤销 SaltedFish 服务凭据。
- 交互接入可先看计划再确认；非交互接入必须明确指定审批选项。
- `--config FILE` 或 `--project DIR` 指定绝对路径，一次只能选择一个客户端。agy、Claude Desktop、WorkBuddy 不支持项目配置。
- `connect --history` 查看备份，`connect --restore ID` 恢复原配置，`connect --refresh` 刷新已登记连接。

向导先验证独立凭据和 MCP 工具发现，再备份、合并配置。检测和握手成功不代表客户端已经加载新配置，也不代表项目或组织审批已经放行。修改后在客户端新开会话或重连 MCP；Claude Desktop 接入前应完全退出，接入后重启。

## 同机连接边界

`/mcp` 只接受服务所在电脑上的连接：连接两端地址相同，或对端为回环地址。其他电脑的请求返回 HTTP 403 `MCP_LOCAL_ONLY`，持有有效令牌也不能越过这一限制。连接本机内网 IP 符合这个条件。

Chrome 扩展不受这条同机限制，可以从其他电脑连接服务。若 Agent 需要在另一台电脑使用，应在那台电脑另装 SaltedFish 服务。

Claude Desktop 的 `mcp-bridge` 只转换 stdio 与 HTTP，不绕过同机限制，不启动另一套服务，也不使用管理员凭据。具体配置见[Claude Desktop 配置](client-compatibility.md#claude-desktop)。
