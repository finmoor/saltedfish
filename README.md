# SaltedFish

> You chill. Agents browse.
> Agent 干活，你当咸鱼。

[English](README.en.md)

SaltedFish 让 AI Agent 通过 MCP 用上你正在用的 Chrome：已登录的账号、装好的扩展、多个 Chrome 配置，都不用重新准备。当前版本 **0.3.28**。

它由两部分组成：一个本机（或内网）服务，和装在每个 Chrome 配置里的扩展。Agent 连服务的 MCP 入口，扩展主动连服务，服务负责授权、排队、记录和恢复。

```
Claude Code / Codex / OpenCode / …  ──MCP──▶  SaltedFish 服务  ◀──WebSocket──  Chrome 扩展（每个 Chrome 配置一个）
                                              管理页 · 授权 · 操作记录
```

## 特点

- **用你自己的浏览器**：不用另开一个干净的浏览器重新登录。每个 Chrome 配置单独配对、单独授权，同名也不会串号；配置离线时明确报错，不会换到另一个账号。
- **不打扰你**：Agent 在后台标签页里操作，不切换你正在看的标签页。每个 Agent 会话的标签页放在自己的标签组里，写操作只能落在这个组里。
- **不重放**：写操作派发前先记下来。断线、崩溃、超时留下的结果不明的操作会挡住后续写入，先核对页面再显式恢复，提交、付款这类动作不会被自动重试。
- **少往返**：动作结果直接带页面变化；`chrome_batch` 在浏览器里一次跑完一段填表、点击、等待。
- **多种 Agent**：`saltedfish connect` 自动写好 Codex CLI、Claude Code、OpenCode、pi、agy、Claude Desktop、CodeBuddy、WorkBuddy 的配置，写之前备份。

## 快速开始

需要 Node.js 24+ 和 Chrome。

```sh
npm install -g saltedfish
saltedfish install
```

`install` 启动服务、接入检测到的本机 Agent，并打印扩展目录。然后：

1. 在每个要接入的 Chrome 配置里打开 `chrome://extensions`，开启“开发者模式”，“加载已解压的扩展程序”，选上面打印的扩展目录。
2. 运行 `saltedfish dashboard` 打开管理页，在“浏览器”里给这个 Chrome 生成配对码，粘贴到扩展设置里。
3. 在 Agent 里新开一个会话，让它用 SaltedFish。

常用命令：

```sh
saltedfish status          # 服务状态
saltedfish dashboard       # 打开管理页（一次性登录码，5 分钟有效）
saltedfish connect         # 接入本机 Agent；--clients 指定范围，--trust-browser 设为免逐次确认
saltedfish upgrade         # 下载新版并切换，失败自动回退
saltedfish rollback        # 切回上一兼容版本
saltedfish logs --lines 100
```

**服务装在哪**：Windows 和 macOS 默认只监听本机。Linux 默认监听内网 IP、端口 18445，别的电脑上的 Chrome 扩展可以连过来；这种模式用不加密的 HTTP，只适合信任的内网，公网部署要证书。不论哪种，Agent 的 `/mcp` 只接受服务所在电脑上的连接。详见 [安装与运维](docs/npm.md)。

## 交给 Agent

提示词示例：

> 使用 SaltedFish。先列出浏览器配置，找到“工作”，只操作这个配置。新开一个标签页完成任务，最后核对页面结果。

Agent 的典型流程：

1. `chrome_profiles` 找到配置，`chrome_tabs` 看有哪些标签页。
2. 写操作只能在本会话的标签组里：`chrome_new_tab` 开的标签页直接用，已有的标签页先 `chrome_claim_tab` 接管。读不受限。
3. `chrome_inspect`、`chrome_find` 读页面、找元素，`chrome_action` 点击和输入。结果里的 `pageChange` 看得出结果，就不用再读一次页面。
4. 确定的多步操作交给 `chrome_batch`：

```json
{
  "profileId": "明确选择的配置 ID",
  "tabId": 123,
  "steps": [
    { "operation": "page.action", "args": { "action": "fill", "selector": "#name", "text": "示例名称" } },
    { "operation": "page.action", "args": { "action": "click", "selector": "#preview" } },
    { "operation": "page.wait", "args": { "selector": ".preview-ready" } }
  ],
  "timeoutMs": 60000
}
```

批量操作失败即停。点击完成只代表输入事件发出去了，业务是否成功要看页面或网络结果。

工具共 64 个，默认列出 46 个；任务、流程这类不常用的在管理页给 Agent 打开“高级工具”后出现。schema 见 [src/tools.ts](src/tools.ts)，行为细节见 [浏览器工具语义](docs/interaction.md)。

## 能力

| 能力 | 说明 |
| --- | --- |
| 多配置 | `profileId + tabId` 显式路由；每个 Chrome 配置一个持久身份 |
| 协作 | 每个 Agent 独立授权，可限定配置、设为只读、随时撤销；标签组、标签页租约、同窗口视觉动作排队 |
| 页面 | 文字、元素、无障碍树、截图、页面脚本、Chrome 扩展可用的 CDP；导航前注入脚本（`initScript`） |
| 复杂界面 | open Shadow DOM、同源与跨源 iframe、JavaScript 弹窗、样式化下拉 |
| 网络与文件 | 网络事件、响应体、等待接口返回、上传、下载与完成状态 |
| 输入 | Agent 光标画在页面之外；可选拟人输入（鼠标轨迹、逐键输入），兼容依赖悬停、按住、拖拽时序的页面 |
| 恢复 | 操作派发前写入 SQLite；进程被强杀或重启后保护仍在 |
| 长结果 | 大 JSON 和图片落盘，分页读取 |
| 用户接管 | 扩展里可以暂停；在 Chrome 里手动停止调试会暂停连接，不自动重新接管 |

## 安全与数据

- 服务验证 Host、Origin 和凭据。扩展和服务之间是双向挑战应答，配对密钥不在线上传输。
- 授权限制的是本服务的接口，不是操作系统沙箱。被授权的 Agent 能在获准的配置里以已登录的身份点击、输入、读取页面、执行页面脚本；开了一次信任后不再逐次确认。只给需要的配置授权，用完可以撤销。
- 非管理员 Agent 不能读写 SaltedFish 的数据目录和网络共享路径，不能打开 `file:` 地址，不能操作管理页；本机其他文件能不能读写由 Agent 自己的权限设置决定。
- 不发送遥测。工具返回的页面内容、截图会交给调用它的 Agent，由那个 Agent 和它所用的模型服务处理。
- 操作记录只存工具名、目标、时间和状态，不存脚本、页面正文和文件内容。

细节见 [隐私说明](PRIVACY.md)、[一次信任](docs/once-trust.md)、[限制与数据说明](docs/beta-limitations.md)。发现漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。

## 已知限制

- 已在 Windows 和 Linux 上验证；macOS 没有验证分发。
- Chrome 内部页面、其他扩展的页面、系统原生窗口、验证码和系统授权对话框没有自动化保证。
- 网页能观察到 DOM 和输入事件；不承诺网站识别不出自动化操作。
- Agent 连着时，Chrome 每个标签页顶部有一条“正在调试此浏览器”的提示条。Chrome 启动时带 `--silent-debugger-extension-api` 可以去掉，代价见 [安装与运维](docs/npm.md)。
- Chrome 的调试接口可能和 DevTools、其他扩展冲突，部分 CDP 域不能通过扩展使用。
- 已经发出去的动作撤不回来。任务运行时手动改网页可能影响结果，手动接管前先在扩展里暂停。

## 文档

- [安装与运维](docs/npm.md) · [支持的 Agent](docs/supported-clients.md) · [各客户端的配置细节](docs/client-compatibility.md)
- [管理页功能](docs/product-features.md) · [一次信任](docs/once-trust.md) · [浏览器工具语义](docs/interaction.md)
- [架构](docs/architecture.md) · [测试](docs/testing.md) · [名称与兼容](docs/branding.md) · [开源复用比较](docs/reuse.md)

## 参与开发

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

```sh
npm ci
npm run build
npm run typecheck
npm test
```

## 许可

[MIT](LICENSE)。第三方依赖的许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
