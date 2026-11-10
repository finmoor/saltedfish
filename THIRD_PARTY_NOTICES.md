# 第三方依赖

本项目直接依赖的第三方软件及许可：

| 组件 | 版本 | 许可 | 用途 |
| --- | --- | --- | --- |
| @modelcontextprotocol/sdk | 1.32.1 | MIT | MCP 协议与工具注册 |
| ws | 8.22.0 | MIT | 浏览器 WebSocket 桥 |
| zod | 4.6.7 | MIT | 输入验证 |
| jsonc-parser | 3.3.1 | MIT | 保留注释的客户端配置解析与局部编辑 |
| toml-eslint-parser | 1.0.3 | MIT | Codex TOML 语法树解析，按范围编辑服务条目 |
| esbuild | 0.28.2 | MIT | 扩展构建 |
| puppeteer-core | 25.16.0 | Apache-2.0 | 独立浏览器测试 |
| typescript | 7.0.2 | Apache-2.0 | 类型检查与构建 |
| Node.js | Windows 包内的确切版本见 release.json | MIT 及所含组件许可 | 内测包自带运行时 |

完整依赖版本和传递依赖见 `package-lock.json`。各依赖的版权与许可全文随安装包位于 `node_modules/<package>/LICENSE*`。打包分发依赖时须保留原许可文件。

Windows 包的 Node.js 许可全文及其所含组件声明保存在 `runtime/LICENSE.txt`。打包时保留原始 node.exe 并验证 OpenJS Foundation 数字签名；产品启动器自身尚未签名。

ChromeDevTools MCP、Playwright MCP、hangwin/mcp-chrome、OpenCode Browser 用于设计比较，未复制其源码。比较与来源见 `docs/reuse.md`。

## dom-accessibility-api 0.7.1

用于扩展内的可访问名称与角色计算，构建时打包进页面执行代码；MIT 授权。来源：https://github.com/eps1lon/dom-accessibility-api 。以下为完整许可：
MIT License

Copyright (c) 2020 Sebastian Silbermann

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
