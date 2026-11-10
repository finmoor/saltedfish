# 接入与一次信任

一次信任只调整 Agent 客户端对 `saltedfish` 这一项 MCP 的工具审批，不改变服务端授权，也不修改其他 MCP、Shell、模型或全局沙箱设置。

## 一次信任授予什么

开启后，该 Agent 调用本 MCP 当前及将来的浏览器工具不再逐次确认，但已有逐工具例外、项目或组织策略仍可能要求审批。

Agent 可以在获准使用的 Chrome 配置里点击、输入、读取页面、截图、上传文件并执行页面脚本，等同于以该配置已登录的身份操作网站。扩展身份不是网站账号认证；同一 Chrome 配置中的窗口共享登录态。只对可信的 Agent 开启一次信任。

| 客户端 | 服务级规则 |
| --- | --- |
| Codex CLI | `default_tools_approval_mode = "approve"`，保留逐工具例外 |
| OpenCode 2 | 允许 `saltedfish_*`，仅此连接设为 `codemode: false` |
| Claude Code / CodeBuddy | 在 `permissions.allow` 增加 `mcp__saltedfish__*` |
| agy | 在 `permissions.allow` 增加 `mcp(saltedfish/*)` |
| OpenCode 1 | 不提供一次信任适配，保留原审批接入 |
| pi | 不写审批规则；默认不逐次确认，适配器权限另行管理 |
| Claude Desktop / WorkBuddy | 不写审批存储，在应用内批准 |

具体文件和重载要求见[客户端配置与兼容性](client-compatibility.md)。

## 服务端仍然限制什么

- **浏览器范围。** 只能使用授权给该客户端的 Chrome 配置。自动接入使用的默认客户端凭据允许全部已配对配置；需收窄时，在管理页创建限定浏览器的独立授权。
- **只读授权。** 只读客户端不能执行写操作。客户端的一次信任不能提升为写权限。
- **受保护页面。** 服务管理页和扩展自身页面不能被非管理员 Agent 读取、操作或导航到；管理页地址和标题在标签列表中隐藏。
- **同机连接。** `/mcp` 只接受服务所在电脑上的连接。其他电脑即使有令牌也会收到 HTTP 403 `MCP_LOCAL_ONLY`。
- **文件路径。** 可读写范围交给 Agent 自己的权限或沙箱设置决定；SaltedFish 另行拒绝自己的数据目录、npm 安装数据根目录及网络共享路径。路径检查会解析符号链接、目录联接等实际目标。浏览器电脑上的下载导出仅在明确请求时，由可选助手读取 Chrome 下载的那个文件。
- **操作协调。** 标签页租约、互斥、会话标签组、资源额度和结果不明保护仍生效。它们不是额外的业务确认，也不能阻止已经派发的动作完成。

这些限制约束本服务接口，不是操作系统沙箱。原始 CDP 和页面脚本也不是沙箱。标签组是可见的协作范围，不是安全隔离边界。

## 接入并选择审批方式

在服务所在电脑上执行：

```sh
saltedfish connect --preview
saltedfish connect --clients codex,opencode --trust-browser
saltedfish connect --clients codex,opencode --keep-approvals
```

`--preview` 只显示计划，不写文件。交互执行可在预览后确认；非交互接入必须明确指定审批选项。`--keep-approvals` 保留现有审批，包括已存在的信任，不等于恢复逐次确认。

也可运行 `saltedfish dashboard --onboarding`。选择客户端和配置位置，预览目标、权限和保留内容，再选择信任或保留审批。程序验证独立凭据与工具发现后，备份并合并配置。已打开的客户端需要重连；Desktop 接入前完全退出，接入后重启。

`--config FILE` 或 `--project DIR` 可选择明确的绝对路径，一次一个客户端。agy、Claude Desktop、WorkBuddy 不支持项目配置。首次项目启用和组织策略不由 SaltedFish 取消，不能保证所有环境只弹一次确认。

## 恢复审批与撤销访问

### 恢复客户端审批

```sh
saltedfish connect --clients codex,opencode --revoke-trust
```

也可在接入页选择撤销一次信任，预览后保存。客户端重连后生效。

- Codex 将本服务默认审批及已有逐工具授权改回 `prompt`。
- OpenCode 2 将本工具组改回 `ask`。
- Claude Code、CodeBuddy、agy 移除本服务的整服务允许规则，保留逐工具规则和其他设置。
- pi、Desktop、WorkBuddy 不写撤销规则，需在客户端或服务端管理访问。

恢复审批不会撤销 SaltedFish 凭据；客户端若有其他允许策略，也可能继续放行。

### 阻止后续访问

在管理页“Agent 连接”或“访问权限”中撤销该客户端授权。也可用 `saltedfish clients list` 查找，再用 `saltedfish clients revoke ID` 撤销。扩展中的“暂停所有 Agent”会暂停当前 Chrome 配置，不影响其他配置。

撤销和暂停不保证撤回已发出的点击、上传或网站请求。出现结果不明时，先核对页面与操作记录，不要重放原任务。

## 备份与恢复配置

```sh
saltedfish connect --history
saltedfish connect --restore ID
saltedfish connect --refresh
```

历史记录也可在接入页恢复。恢复会校验接入后的文件状态；存在后续修改时停止，避免覆盖其他改动。重复接入相同配置不反复写入或堆积备份。

备份最多 100 份，保存在服务数据目录的 `setup-backups`，可能包含其他客户端凭据，不能公开分享。恢复配置不等于撤销服务授权。

`connect --refresh` 只刷新已登记连接，保留原授权和信任；不是新增授权或恢复审批的命令。安装与升级见[npm 指南](npm.md)。
