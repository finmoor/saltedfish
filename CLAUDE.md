# SaltedFish 开发说明

SaltedFish 让 AI Agent 通过 MCP 操作用户日常使用的 Chrome：一个服务（`src/`，npm 包 `saltedfish`）加一个 Chrome 扩展（`extension/`），管理页在 `ui/`。面向用户的介绍见 [README.md](README.md)，参与开发见 [CONTRIBUTING.md](CONTRIBUTING.md)。

开始改代码前先读：

- [docs/architecture.md](docs/architecture.md)：组成、身份与授权、执行模型、故障语义；
- [docs/interaction.md](docs/interaction.md)：每个浏览器工具的行为、结果和错误码；
- [docs/testing.md](docs/testing.md)：测试分组和各自证明什么。

## 开发命令

Node.js 24+，依赖以 `package-lock.json` 为准。

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run test:browser
npm run test:ui
```

浏览器测试用 Chrome for Testing 和临时的独立配置，不接管日常 Chrome。开发用独立的数据目录和端口（`CHROME_MCP_DATA_DIR`、`CHROME_MCP_PORT`），不要碰已经装好的服务，不要打印 `config.json`、配对文件和客户端令牌。`.local/`、`.packaging/`、`release/` 不进仓库。

## 长期约束

- 新功能不往页面 DOM 和主世界里加东西，不增加页面能观察到的事件和时序差异；给用户看的提示画在页面外（CDP Overlay、扩展界面）。
- 本机 Agent 能读写哪些文件由它自己的 harness 决定，服务只拒绝 SaltedFish 数据目录（含 npm 安装目录）和网络共享路径，不加目录白名单。前提是 `/mcp` 只接受本机连接（`src/mcp-http.ts` 的 `fromThisMachine`）。服务不监听 `0.0.0.0`；Linux 默认监听内网 IP，给别的电脑上的 Chrome 扩展连。
- 服务、npm 包和扩展用同一个版本号，`manifest.json` 的 `version` 和 `version_name` 都写它；`scripts/check-release.mjs` 会核对。已交付的包不改字节，产品字节有任何变化都要升版本号。
- 客户端配置里的连接名是 `saltedfish`，`connect` 和 `upgrade` 自动迁移旧的 `feng-chrome` 条目。工具名 `chrome_*`、HMAC 域、`CHROME_MCP_*` 环境变量、页面运行时的内部标识（如 `FengPage`）和存储键保持不变，改了会中断握手或丢失配对。见 [docs/branding.md](docs/branding.md)。

## 实现约定

- 所有目标必须使用 `profileId + tabId`；不能选第一个配置或当前活动窗口作为隐式后备。扩展 UUID 表示 Chrome 配置，不是网站账号认证。
- 服务端将一次任务绑定到同一连接代际。断线后不继续向重连的连接发送任务尾部。
- 写操作发送前写 SQLite；崩溃、超时、断线产生的未知结果必须保留保护。先核对实际页面，再显式恢复，绝不自动重放提交、付款等业务动作。
- 标签页租约、标签页互斥和同窗口视觉队列分别保护不同竞态，不可随意删掉。不同窗口允许并行。
- Windows 后台输入需要焦点模拟；最小化窗口里截图会挂住。视觉操作不切换窗口的当前标签页（用户可能正在同一窗口里用别的标签页），后台标签页靠焦点模拟出帧、收输入；只有最小化窗口临时恢复，结束后还原。用户主动停止调试后保持暂停。
- 只读授权限制本服务接口，不是操作系统沙箱。原始 CDP/JS 均有副作用；不得绕过 profile/target 限制。MCP 工具的 `readOnlyHint` 只是标注，实际授权在服务端执行。
- 网络事件和结果文件有容量预算。业务动作已经完成而保存结果失败时，返回独立警告，不把业务改判失败以诱导重试。
- 日志完成状态落盘失败也保留业务结果并返回警告；未完成落盘的 running 与 unknown 都阻止重复写入，修复存储后重启并显式恢复。租约默认 4096 上限且定期回收过期项。
- SQLite 只能在服务器成功监听后打开，避免第二个启动进程把仍在运行的任务误标为崩溃。CLI 管理授权通过服务 API，不直接打开同一个状态库。
- setup、升级、回滚不能复活已撤销客户端。回滚保留当前数据库，不能恢复旧授权快照。
- 新工具同步修改 schema、服务执行、扩展路由、权限标注和对应行为测试。错误码要能指导用户恢复。
- 测试里不写死个人路径、真实账号和真实网站数据；本机程序的位置走 `tests/local-tools.ts`（先看环境变量）。

## 文件导航


| 文件 | 职责 |
| --- | --- |
| `src/cli.ts` / `src/mcp.ts` | 原生/开发 CLI、配置生成、stdio MCP |
| `src/npm-cli.ts` / `npm-runtime.ts` / `npm-worker.ts` | npm 包命令；home、版本快照、固定 launcher、升级回退；随机令牌鉴权的私有回环控制口 |
| `src/management-lock.ts` / `state-compatibility.ts` | 安装管理专用互斥；只读数据格式标记，挡住不兼容降级 |
| `src/npm-update.ts` | `upgrade` 查新版并用当前 Node 的 npm 装回原目录 |
| `src/autostart.ts` | Linux 开机启动：写 systemd 单元，只在开机拉一次服务 |
| `src/http-server.ts` / `src/auth.ts` | localhost 管理与 RPC、鉴权、管理页会话与一次性登录码、桥接握手 v2 服务端 |
| `src/upload-policy.ts` / `output-files.ts` | 非管理员上传、savePath、下载导出共用的路径检查：只拒绝数据目录和 UNC（realpath 比对，防联接与短名绕进去）；结果写成文件 |
| `src/agent-presence.ts` / `agent-groups.ts` | 会话和使用状态；标签组的通知和对账，组的归属记在扩展里 |
| `src/broker.ts` / `src/state-store.ts` | 连接、租约、未知结果；SQLite 操作日志、授权和结果元数据 |
| `src/service.ts` / `src/tools.ts` | 64 个工具的执行与输出（默认目录 46 个，见 `isAdvancedTool`）；工具 schema 来源 |
| `src/page-jobs.ts` | job_start 在页面里登记作业；job_status 的只读状态表达式 |
| `src/result-reader.ts` / `observations.ts` | 大结果有界分页读取；无障碍树与事件摘要 |
| `src/interaction-policy.ts` | 视觉动作分类，服务端焦点模拟与扩展窗口队列共用 |
| `src/extension-download.ts` / `zip.ts` | 管理页下载的扩展 ZIP，运行时写入服务地址（不含令牌） |
| `src/tasks.ts` / `task-limits.ts` | 账号队列、步骤历史、流程参数预览与预算 |
| `src/workflow-store.ts` / `src/recovery.ts` | 流程事务/版本/归档、故障恢复建议 |
| `src/client-setup.ts` / `client-config.ts` / `client-document.ts` / `codex-config.ts` | 接入向导；JSONC/TOML 局部合并与统一格式判定、备份/验证/恢复 |
| `src/client-types.ts` / `client-paths.ts` | 八客户端能力清单、配置优先级与 Desktop 商店版数据目录定位 |
| `src/client-permissions.ts` / `client-credentials.ts` | Claude Code、CodeBuddy 和 agy 的审批规则；按客户端名建或沿用的独立凭据，命令行和服务进程共用 |
| `src/mcp-bridge.ts` | Desktop 远程 stdio→HTTP 转发；独立凭据，不初始化本机服务、不重放失败 POST |
| `src/client-connect.ts` / `client-launch.ts` | connect 命令；原生与 npm 共用的客户端启动入口 |
| `src/remote-gateway.ts` / `remote-connector.ts` / `remote-protocol.ts` | 服务器端远程 MCP 与设备接入；本机主动 WSS 连接；协议与权限交集 |
| `src/gateway-cli.ts` / `gateway-setup.ts` / `gateway-tls.ts` | 网关初始化/启动/接入、TLS 预检与修复 |
| `src/shared.ts` / `config.ts` / `version.ts` | 共享类型与错误语义、配置加载、版本号 |
| `extension/background.ts` / `options.ts` | 配置身份、连接、暂停、重连；扩展设置页 |
| `extension/executor.ts` / `window-lock.ts` | Chrome/CDP 执行、窗口视觉队列 |
| `extension/page-runtime.ts` / `page-functions.ts` / `isolated-runtime.ts` | 注入隔离世界的页面逻辑、调用表达式、隔离上下文缓存 |
| `extension/tab-groups.ts` | 标签组：建组、放回原位、解散，记录每个组属于哪个会话 |
| `extension/agent-cursor.ts` | Agent 光标：用 CDP Overlay 画在页面上层，页面看不到，动作不等它；截图前收起 |
| `extension/human-input.ts` | 像真人一样操作：落点、鼠标轨迹、各段停顿和按住时长、滚轮分格，只算数不发命令 |
| `extension/page-change.ts` | 动作结果里的页面变化：动作前开始观察、动作后等到安静再读，失败只少一段信息 |
| `extension/text-input.ts` / `input-target.ts` / `keyboard.ts` | 文本输入、派发前目标与焦点复核、press/keySequence 共用键位 |
| `extension/download-tabs.ts` | 页面触发的下载按 URL 配上来源标签页 |
| `extension/background-popups.ts` | Agent 的后台标签页打开的新标签页被放到前台时，切回用户原来的标签页（按发起方的 `Page.windowOpen` 认） |
| `extension/service-probe.ts` | 打开管理页前确认地址连得上，弹窗和后台共用 |
| `extension/self-update.ts` | 一键更新：解析和校验更新包、确认文件夹、写入和回退 |
| `extension/bridge-auth.ts` | 桥接握手 v2 的扩展侧：双向挑战应答，配对密钥只作 HMAC 的 key，不上线 |
| `extension/dialogs.ts` / `frame-point.ts` / `frame-geometry.ts` / `navigation.ts` | 弹窗策略、跨 frame 命中与遮挡、四点投影、按 loader 确认导航 |
| `ui/` | 本地管理页：app.js 入口，workspace.js 导航，product.js 任务/流程/接入，activity.js 操作记录与解除保护，identity.js 账号标识，editor.js 高级步骤 |
| `packaging/` | 原生启动器、安装/回滚/卸载；npm-README.md 是 npm 包 README 模板 |
| `scripts/` | 构建与打包（package-npm/windows/extension）、发行门禁（verify-release、release-evidence、source-bound-build、promote-npm、check-release） |


## Windows 已知坑

- 测试和实验里启动 Chrome 一律用 `tests/chrome-launch.ts` 的 `launchTestChrome`，直接起 `chrome.exe` 的先调 `seedChromeUserData`。Windows 版 Chrome 用全新用户数据目录启动时会用空密码试登录一次系统账户，每次记一条登录失败（安全日志 4625），跑一轮测试就可能触发账户锁定；预置 `Local State` 后不再试。
- 调用 Windows 系统程序用绝对路径（`windowsSystemFile`），不按裸名查找：Git Bash 的 PATH 里 `whoami.exe` 是 msys 版本。
- 交互性能测试固定关闭 vsync，`PERF_BASELINE` 必须指向同参数、同环境的报告；不要和其他测试同时跑。性能核加能效核的 CPU 上，渲染进程被排到能效核时 fill、insertText 会慢一倍，数字可疑时用两份构建交替测量再下结论。
- PowerShell 5 读的中文 `.ps1` 文件必须保留 UTF-8 BOM；不要依赖新 PowerShell 语法。
- `$PSScriptRoot` 默认参数在 PowerShell 5 有兼容问题，依赖它的默认值在函数体或脚本体里设置。
- `File.Replace` 的 backup 参数不要传 `$null`，PowerShell 5 会转成空字符串；用独立备份路径，成功后删除那一个备份文件。
- .NET 启动器转发 stdio 必须逐块 flush；只用 `CopyToAsync` 会缓冲小 MCP 消息，导致握手超时。
- PowerShell 5 不要把启动常驻服务的原生命令接到 `Out-Null` 或 `2>&1` 捕获，可能等待后台进程持有的输出管道。
- 包内 Node 要校验 OpenJS Authenticode 签名并附 LICENSE；这不代表产品启动器自身已签名。
- 只清理能确认由测试创建的临时目录和进程；递归删除或移动前验证绝对目标位于预期工作区。不要清理用户浏览器数据。

## 维护者的内部记录

发行记录、交接状态、评审报告和运行环境不在本仓库。本机有 `.internal/` 目录（被 git 忽略，是单独的私有仓库）时，开始工作前先读 `.internal/CLAUDE.md`，那里是当前状态、发行流程和各台机器的情况；新的发行记录、评审和过程文件写进 `.internal/`，不要写进本仓库。
