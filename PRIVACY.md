# 隐私说明 / Privacy Policy

最后更新 / Last updated: 2026-11-09

SaltedFish 由两部分组成：你自己运行的 SaltedFish 服务（在你的电脑或你的内网机器上），和装在 Chrome 里的 SaltedFish 扩展。开发者不运营任何接收你数据的服务器。

SaltedFish consists of a service that you run yourself (on your computer or a machine in your network) and a Chrome extension. The developer does not operate any server that receives your data.

## 扩展处理哪些数据 / What the extension handles

扩展只把数据发给你配对的那个 SaltedFish 服务，不发给开发者或任何第三方。

The extension only sends data to the SaltedFish service you paired it with. Nothing is sent to the developer or to any third party.

| 数据 | 用途 | 去向 |
| --- | --- | --- |
| 你授权的 Agent 请求读取的页面内容：文字、元素、无障碍树、截图、网络请求和响应、下载记录 | 完成 Agent 的请求 | 你配对的 SaltedFish 服务，再交给发出请求的 Agent |
| 标签页和窗口的网址、标题 | 让 Agent 和管理页知道有哪些标签页 | 你配对的 SaltedFish 服务 |
| 这个 Chrome 配置登录的 Google 账号邮箱（`identity.email`） | 在管理页里区分多个 Chrome 配置 | 你配对的 SaltedFish 服务 |
| 配对信息（服务地址、配对密钥）和扩展设置 | 连接服务 | 只存在扩展本地存储里；配对密钥不在网络上传输 |

| Data | Purpose | Sent to |
| --- | --- | --- |
| Page content that an agent you authorized asks to read: text, elements, accessibility tree, screenshots, network requests and responses, downloads | To carry out the agent's request | Your paired SaltedFish service, then the agent that asked |
| URLs and titles of tabs and windows | So agents and the dashboard know which tabs exist | Your paired SaltedFish service |
| The email of the Google account this Chrome profile is signed in to (`identity.email`) | To tell Chrome profiles apart in the dashboard | Your paired SaltedFish service |
| Pairing data (service address, pairing secret) and settings | To connect to the service | Stored locally in the extension only; the pairing secret is never sent over the network |

扩展不收集分析数据、不投放广告、不出售或转让数据，不把数据用于与上述用途无关的目的，也不用于判断信用或放贷。

The extension collects no analytics, shows no ads, does not sell or transfer data, does not use data for purposes unrelated to the above, and does not use it to determine creditworthiness or for lending.

## 服务处理哪些数据 / What the service handles

SaltedFish 服务运行在你自己的机器上，数据存在它的数据目录里（npm 安装在 Windows 上默认是 `%LOCALAPPDATA%\SaltedFish\npm`，Linux 是 `~/.local/share/saltedfish`，见 [限制与数据说明](docs/beta-limitations.md#数据存放位置)）：

- 操作记录：工具名、目标配置和标签页、时间、状态。不保存脚本、页面正文和文件内容。
- 结果文件：Agent 要求保存的大结果和截图，存在 `data/results`，有容量上限，可以在管理页或用 `saltedfish results remove` 删除。
- 授权：各 Agent 的凭据、配对记录、管理页会话。

The service runs on your own machine and stores its data in its data directory: an operation log (tool names, targets, times, states — no scripts, page text or file contents), result files the agent asked to keep (size-limited, removable), and credentials and pairing records.

## Agent 和模型服务 / Agents and model providers

工具返回的页面内容和截图会交给调用它的 AI Agent（例如 Claude Code、Codex），再由那个 Agent 发给它所用的模型服务。这部分数据的处理遵循那个 Agent 和模型服务的隐私政策，不受 SaltedFish 控制。只给 Agent 授权它需要的 Chrome 配置。

Page content and screenshots returned by tools are passed to the AI agent that called them (for example Claude Code or Codex) and from there to that agent's model provider, under their privacy policies. Only grant agents the Chrome profiles they need.

## 遥测 / Telemetry

SaltedFish 不发送遥测、崩溃报告或使用统计。SaltedFish sends no telemetry, crash reports or usage statistics.

## 联系 / Contact

在 https://github.com/finmoor/saltedfish/issues 提问；安全问题见 [SECURITY.md](SECURITY.md)。

Questions: https://github.com/finmoor/saltedfish/issues. Security issues: see [SECURITY.md](SECURITY.md).
