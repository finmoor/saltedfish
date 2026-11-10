# 参与开发 / Contributing

欢迎 issue 和 PR。中文、英文都可以。Issues and pull requests are welcome, in Chinese or English.

## 开始之前

- 改动较大（新工具、协议、权限模型、数据格式）先开 issue 说清要解决的问题，避免做完才发现方向不对。
- 安全问题不要开公开 issue，按 [SECURITY.md](SECURITY.md) 私下报告。
- 先读 [架构说明](docs/architecture.md) 和 [浏览器工具语义](docs/interaction.md)。

## 开发环境

```sh
npm ci
npm run build
npm run typecheck
npm test
```

Node.js 24+，依赖以 `package-lock.json` 为准。浏览器相关测试和 Chrome for Testing 的准备见 [测试](docs/testing.md)。

开发时用独立的数据目录和端口，不碰已经装好的服务：

```sh
CHROME_MCP_DATA_DIR=.local/dev CHROME_MCP_PORT=18422 node dist/cli.js setup
```

（PowerShell 用 `$env:CHROME_MCP_DATA_DIR='.local/dev'` 的写法。）`.local/`、`dist/`、`release/` 都不进仓库。

## 设计约束

改动要守住这些约束，它们是产品可靠性的基础：

- **目标必须显式**：所有页面操作都带 `profileId + tabId`，不能退回“第一个配置”或“当前活动标签页”。
- **不重放**：写操作派发前先落盘。崩溃、超时、断线留下的结果不明的操作保持保护，先核对页面再显式恢复，绝不自动重试提交、付款这类业务动作。
- **不往页面里加东西**：新功能不往页面 DOM 和主世界里注入对象，不增加页面能观察到的事件；给用户看的提示画在页面外（CDP Overlay、扩展界面）。
- **不打扰用户的标签页**：视觉动作不切换窗口的当前标签页，Agent 在后台标签页里操作。
- **授权在服务端执行**：MCP 工具的 `readOnlyHint` 只是标注；只读授权限制的是本服务接口，不是操作系统沙箱。不能绕过配置和标签页的限制。
- **兼容**：工具名 `chrome_*`、环境变量 `CHROME_MCP_*`、桥接握手和存储里的内部标识保持不变，改了会让已配对的浏览器断开。

## 新增或修改工具

一个工具的改动通常要同时改这些地方：

1. `src/tools.ts`：schema 和说明（说明总长有预算，保持简短）；
2. `src/service.ts`：服务端执行和权限；
3. `extension/`：扩展里的路由和执行；需要新扩展才支持的参数，加能力名，旧扩展收到时报需要更新、不派发；
4. 测试：服务端单元测试，加上真 Chrome 的集成用例（`tests/interaction-*.integration.ts` 等）；
5. 文档：[docs/interaction.md](docs/interaction.md)。

错误码要能告诉调用方下一步怎么办。

## 提交 PR

- 一个 PR 做一件事，说明改了什么、为什么、怎么验证的（跑了哪些组，结果如何）。
- 修缺陷时尽量先写一个能复现的用例，修复前失败、修复后通过。
- 测试里不要写死个人路径、真实账号、真实网站的数据；用环境变量和自建的测试页面。
- 提交前跑 `npm run typecheck` 和 `npm test`；改到扩展行为的再跑相关的浏览器用例。

提交即表示你同意以 [MIT 许可](LICENSE) 发布你的贡献。By submitting a contribution you agree to license it under the [MIT License](LICENSE).
