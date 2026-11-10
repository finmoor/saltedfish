# SaltedFish

> You chill. Agents browse. — Agent 干活，你当咸鱼。

Let AI agents use the Chrome you already use, over MCP: signed-in accounts, multiple Chrome profiles, writes scoped to the agent's own tab group, no automatic replays. Works with Codex CLI, Claude Code, OpenCode, pi, agy, Claude Desktop, CodeBuddy and WorkBuddy. Source, English README and issue tracker: https://github.com/finmoor/saltedfish

让 AI Agent 通过 MCP 用上你正在用的 Chrome。当前版本 **{{version}}**，服务和 Chrome 扩展同一个版本号。需要 Node.js 24+。

## 开始使用

~~~sh
npm install -g saltedfish
saltedfish install
saltedfish dashboard
~~~

`install` 启动服务、接入检测到的本机 Agent（`--no-connect` 跳过，之后随时可以 `saltedfish connect`）。Linux 服务器要开机自动启动，安装时选上，或之后运行 `saltedfish autostart on`。

在管理页的“浏览器”里给每个 Chrome 配置生成配对码，下载扩展 ZIP 并解压，在 `chrome://extensions` 开启开发者模式、“加载已解压的扩展程序”选这个目录，再把配对码粘贴到扩展设置里。每个 Chrome 配置单独配对，名称、网站登录和浏览器身份由 Chrome 自己保存。

在“Agent 连接”里给 Agent 新建授权，选允许它用哪些浏览器。`/mcp` 只接受服务所在电脑上的连接；别的电脑上的 Agent 要在那台电脑上另装服务。Claude Desktop 用自带的 stdio→HTTP 桥接，其余客户端用 HTTP 直连。各客户端的配置位置和审批见 [支持的 Agent](docs/supported-clients.md) 和 [各客户端的配置细节](docs/client-compatibility.md)。

扩展里的“打开管理页”进入当前服务。只有被允许管理的浏览器能直接拿到一次性登录码；普通的浏览器配对只能连接浏览器，没有管理权限。管理页会话空闲 30 分钟、最长 12 小时过期，可以随时注销。

离线安装：`npm install -g ./saltedfish-{{version}}.tgz`。

## 服务监听在哪

Windows 和 macOS 默认只监听本机。Linux 首次安装时监听默认路由的内网 IP、端口 18445，并打印服务地址；别的电脑上的 Chrome 扩展连这个地址，这台电脑上的 Agent 也用它（连自己的内网 IP 算本机）。这种模式下 HTTP/WS 不加密，只在信任的内网使用；探测到公网地址时拒绝。

多网卡时用 `--host 192.168.1.10` 指定内网 IP，`--port` 换端口，只在本机用加 `--local`。

需要 HTTPS 时用浏览器信任的证书：

~~~sh
saltedfish install --host 10.0.0.10 --url https://browser.example.com:18445 --cert /etc/saltedfish/fullchain.pem --key /etc/saltedfish/privkey.pem --local-port 18446 --no-connect
~~~

改监听配置前先停止服务，再运行 `configure-server`。Linux 服务收到 SIGHUP 后校验并加载更新过的证书，已有的浏览器连接保持。

## 去掉“正在调试此浏览器”提示条

Agent 连上后，Chrome 在每个标签页的地址栏下方加一条“……调试此浏览器”的提示条，网页区域少大约 56 像素，断开调试后也不会马上消失。这是 Chrome 自己加的，扩展去不掉。

Chrome 启动时带上 `--silent-debugger-extension-api` 就不会出现：

1. 在打开 Chrome 用的快捷方式上右键 → 属性，在“目标”最后加一个空格和 `--silent-debugger-extension-api`。任务栏上的先右键 Chrome 图标，再右键菜单里的“Google Chrome”。开始菜单和公共桌面上的快捷方式要管理员权限才能改。
2. 完全退出 Chrome：关掉所有 Chrome 窗口（几个 Chrome 配置共用一个进程，都要关），托盘里有 Chrome 图标的也右键退出。
3. 从改好的快捷方式重新打开 Chrome。

要知道的事：

- 这条提示是 Chrome 的安全提醒。带上参数以后，**任何**使用调试接口的扩展连上来都不会提示，只装你信得过的扩展。
- 提示条上的“取消”也没了。要暂停 Agent，用扩展里的暂停按钮或管理页。
- Chrome 没开着时，从别的软件里点链接打开的 Chrome 不带这个参数，提示条又会出现。
- 想恢复提示，删掉参数，完全退出再重开 Chrome。

## 可选的 Windows 文件助手

普通的浏览器操作和上传都直接连服务。只有要导出浏览器所在电脑上已下载的文件时才需要助手：

~~~sh
saltedfish helper install --extension-dir C:/SaltedFish/extension
saltedfish helper status
~~~

安装助手不启动浏览器服务。助手只接受已登记的 SaltedFish 扩展，只按明确请求读取 Chrome 下载记录里的那个普通文件，SaltedFish 数据目录和网络共享路径除外。

## 升级

`saltedfish upgrade` 下载最新版并切换运行版本，失败回退（离线装好 TGZ 后用 `upgrade --no-fetch`）；`rollback` 只切到兼容当前数据格式的版本，不会用旧数据库绕过已撤销的授权。`--home` 指定安装位置，Windows 默认在 `%LOCALAPPDATA%/SaltedFish/npm`。

`upgrade` 只换服务，扩展要单独更新：在扩展设置页点“更新”，第一次选扩展所在的文件夹。不要删除扩展，配对和浏览器数据都保留。

## 文档

- [安装与运维](docs/npm.md)
- [浏览器工具语义](docs/interaction.md)
- [管理页功能](docs/product-features.md)
- [一次信任](docs/once-trust.md)
- [限制与数据说明](docs/beta-limitations.md)
- [名称与兼容](docs/branding.md)
- 架构、测试、安全报告：https://github.com/finmoor/saltedfish

MIT License.
