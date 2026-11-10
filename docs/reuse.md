# 开源比较与复用决定

核验日期：2026-10-23。比较以官方 README、许可元数据和指定源码为依据，不把 README 的宣传描述当作无条件能力保证。

| 项目 | 许可 | 可复用内容 | 第一版取舍 |
| --- | --- | --- | --- |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | Apache-2.0 | Chrome 调试、现有会话接入、性能与网络分析的设计 | 作为功能基线，未整体 fork；第一版采用扩展接入日常多个配置，不要求用户为每个配置配置调试端口 |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | Apache-2.0 | 元素动作、扩展连接、profile-dir-name、任务执行的设计 | 未把它嵌入为第二个 MCP 服务，避免两套会话管理；后续可增加 Playwright 执行适配器 |
| [mcp-chrome](https://github.com/hangwin/mcp-chrome) | MIT | 扩展 + 本机通信、文件和网络工具 | 阅读 native-host.ts；功能多但带录制回放、代理面板等较大系统，第一版不整体搬入 |
| [OpenCode Browser / Lightbridge](https://github.com/ADORSYS-GIS/lightbridge-opencode-toolbeit) | MIT | 每安装持久 ID、label、目标路由、WebSocket 重连和心跳 | 阅读 bridge-client.ts、command-router.ts、MCP server.ts；借鉴设计，未复制源码。它已有多浏览器 target 支持，不能把多账号说成其缺失能力 |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x) | MIT（v1） | 协议、schema、stdio、工具注册、客户端握手 | 直接依赖 1.32.1；v1 此时仍维护，后续可独立迁移 v2，不影响浏览器桥接协议 |
| [ws](https://github.com/websockets/ws) / [Zod](https://github.com/colinhacks/zod) | MIT | WebSocket 和输入验证 | 直接依赖并锁版本 |
| [Puppeteer](https://github.com/puppeteer/puppeteer) | Apache-2.0 | 启动和驱动独立 Chrome for Testing | puppeteer-core 仅用于自动化验收，不用它接管用户原有 Chrome |

实现没有复制上述浏览器项目的源码；运行时直接复用 SDK、ws、Zod，构建使用 esbuild，测试使用 Puppeteer。Chrome 的 DOM、Input、Runtime、Network、Accessibility 等能力直接调用浏览器提供的协议。

这次自有代码集中在用户需要掌控的部分：明确账号路由、任务占用、批量执行、失败不重放、结果保存、配置命名和自动配对。没有为了“无限制”维护一个 Chromium fork，也没有声称能取消 AI 客户端的审批和模型规则。

## 官方技术依据

- [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)：支持的协议域、iframe execution context 与子目标。
- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)：可作为后续系统窗口/文件服务桥接方案，第一版未安装 Native Host。
- [Chrome DevTools 现有会话连接](https://developer.chrome.com/docs/devtools/agents/get-started/configuration)：Chrome 144+ autoConnect，需要用户允许。
- [MCP SDK v1 文档](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)：实际使用的 SDK API。

源码研究副本仅缓存在 `.research`，未作为产品内容打包。

beta.10 新增直接运行时依赖 [toml-eslint-parser](https://github.com/ota-meshi/toml-eslint-parser) 1.0.3 / MIT，用语法树与字符范围编辑 Codex TOML，避免用正则把注释或多行字符串误认成配置表。
