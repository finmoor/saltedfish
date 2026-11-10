# 安装与运维指南

SaltedFish 由一个服务和 Chrome 扩展组成。Agent 通过 MCP 调用服务，扩展连接同一个服务。当前服务、npm 包和扩展版本均为 `0.3.28`。

## 系统要求

- Node.js 24 或更新版本。
- Windows、Linux 已验证安装与运行；macOS 未验证分发。
- Chrome 及加载扩展的权限。当前可使用开发者模式加载；Chrome 应用商店上架准备中。
- Agent 和 SaltedFish 服务必须在同一台电脑上。Chrome 扩展可以在其他电脑上连接服务。

## 安装

```sh
npm install -g saltedfish
saltedfish install
```

`npm install` 只安装命令行，不启动后台服务，也不修改客户端配置。`saltedfish install` 创建独立运行快照、初始化并启动服务，输出扩展目录。在交互终端中，它会询问是否接入检测到的 Agent；支持的客户端见[支持的 Agent 客户端](supported-clients.md)。

可按需要跳过接入，或明确选择审批方式：

```sh
saltedfish install --no-connect
saltedfish connect --clients codex,opencode --keep-approvals
saltedfish connect --clients codex,opencode --trust-browser
```

自动化接入必须明确传入 `--trust-browser` 或 `--keep-approvals`。一次信任的权限范围见[一次信任](once-trust.md)。`--no-start` 安装后保持服务停止，不能同时自动接入客户端或开启开机启动。

## 首次连接浏览器

1. 运行 `saltedfish dashboard`，打开管理页。
2. 在“浏览器”页输入名称，为每个 Chrome 配置分别生成配对码。是否允许该浏览器直接打开已登录管理页，单独选择。
3. 在对应 Chrome 配置打开 `chrome://extensions`，开启开发者模式，选择“加载已解压的扩展程序”。服务与 Chrome 同机时，选择安装命令输出的扩展目录；不在同机时，从管理页下载扩展并解压到固定目录。
4. 打开 SaltedFish 扩展，粘贴配对码并连接。回到管理页确认该浏览器在线。
5. 接入 Agent，重载客户端的 MCP 连接，再明确选择浏览器和标签页开始操作。

配对码不是管理页登录码。浏览器配对与 Agent 授权分别管理；配对本身不会授予 Agent 访问权限。不要把扩展目录、客户端配置或配对码当作公开资料分享。

手动加载后保持扩展文件夹路径固定。换文件夹或移除重装会丢失原扩展存储；在管理页原浏览器的离线卡片点“重新连接”，用新配对码恢复原身份、名称、授权和记录。

需要导出 Chrome 下载文件时，可在 Chrome 所在的 Windows 电脑安装可选文件助手：`saltedfish helper install --extension-dir DIR`，其中 `DIR` 是实际加载的扩展目录。助手只在明确请求时读取对应下载文件，安装助手不启动浏览器服务。

## Linux 服务器部署

Linux 首次执行 `saltedfish install` 时，默认监听默认路由对应的内网 IP，端口为 `18445`。多网卡或自定义端口时明确指定：

```sh
saltedfish install --host 192.168.1.10 --port 18445 --no-connect
saltedfish dashboard
```

其他电脑上的 Chrome 扩展可以连接 `http://192.168.1.10:18445`。`/mcp` 只接受服务所在电脑上的连接；开放监听地址不等于允许跨机接入 Agent。连接自己的内网 IP 也属于同机连接。

只在本机使用时：

```sh
saltedfish install --local --no-connect
```

Windows 和 macOS 默认只监听本机。`--local` 不能与 `--host`、`--url`、证书或内网明文选项混用。重复运行 `install` 不会自动改变既有监听方式；显式指定网络选项会重新配置。`--port` 用于首次安装，已有安装不会通过它更换端口。

### HTTP 与 HTTPS

HTTP/WS 不加密，只在可信内网使用。首次安装指定私网 IP 时会自动配置内网明文模式；公网地址必须使用证书，不支持公网或通配地址上的明文监听。不要直接把管理页和浏览器连接端口暴露到不可信网络。

HTTPS 安装需要同时指定监听地址、访问地址、证书和私钥。以下地址仅作示例，证书须覆盖访问地址中的主机：

```sh
saltedfish install --host 192.168.1.10 --port 18445 --url https://192.168.1.10:18445 --cert /path/server.crt --key /path/server.key --local-port 18446 --no-connect
```

`--cert` 与 `--key` 必须成对提供。证书文件不能包含私钥；初始化会检查证书有效期、主机匹配和密钥匹配。`--local-port` 指定仅回环可访问的辅助端口。Chrome 必须信任所用证书。

已有安装先停止服务，再修改监听配置：

```sh
saltedfish stop
saltedfish configure-server --host 192.168.1.10 --url http://192.168.1.10:18445 --allow-insecure-lan
saltedfish start
```

`configure-server` 的明文内网模式必须显式传入 `--allow-insecure-lan`；HTTPS 使用 `--cert`、`--key`，不能同时启用明文模式。修改地址后，核对扩展和 Agent 配置中的地址。Linux 更新原路径下的证书文件后，可向服务发送 `SIGHUP`；新证书校验失败时继续使用原证书。

## 开机启动

Linux 使用 systemd：

```sh
saltedfish autostart on
saltedfish autostart status
saltedfish autostart off
```

交互安装会询问是否开启，脚本安装可传 `--autostart`。root 使用系统单元；普通用户使用用户单元，并尝试开启 linger，以便未登录时启动。没有 systemd 时，将 `saltedfish start` 加入自己的启动脚本。

这个单元只在开机时拉起服务，不负责持续守护。启停仍用 SaltedFish 命令；`systemctl stop saltedfish` 不会停止后台服务。`autostart off` 关闭开机启动，但不停止当前服务。显式 `saltedfish stop` 后，下次开机也保持停止，执行 `start` 才恢复。

同一系统或用户作用域共用 `saltedfish.service`。多个独立安装不能仅凭 `autostart status` 判断单元属于哪个安装，应核对单元入口。更换 Node 路径后，运行 `upgrade` 或 `autostart on` 更新入口。

Windows 的默认 stdio 接入会在打开 Agent 时按需启动服务，不需要此 systemd 设置。HTTP 连接不会替 Agent 拉起已停止的服务。

## 日常命令与管理页登录

| 命令 | 用途 |
| --- | --- |
| `saltedfish status` | 查看包版本、活动运行版本和服务状态 |
| `saltedfish start` / `saltedfish stop` | 启动或停止服务 |
| `saltedfish restart` | 重启服务 |
| `saltedfish logs --lines 100` | 查看最近日志；行数为 1–1000 |
| `saltedfish doctor` | 检查安装、服务和连接 |
| `saltedfish diagnostics` | 导出诊断文件；分享前检查路径和名称 |
| `saltedfish extension` | 输出扩展目录 |
| `saltedfish dashboard` | 打开管理页 |
| `saltedfish dashboard --onboarding` | 进入客户端接入页 |
| `saltedfish dashboard --logout-all` | 注销全部管理页会话，不打开页面 |
| `saltedfish connect --preview` | 预览客户端接入计划 |
| `saltedfish version` | 查看命令行包版本 |

服务忙碌时，停止、重启和升级会拒绝打断任务。核查后可显式使用 `stop --force` 或 `restart --force`。已派发动作仍可能完成，结果不明保护不会因此清除。显式停止后，MCP 不会自动重启服务，需运行 `start`。

Windows 的 `dashboard` 默认打开浏览器；其他系统或设置 `SALTEDFISH_NO_BROWSER=1` 时，只打印登录链接和 4 位登录码。它们算同一次登录，用掉一个，另一个也失效。有效期为 5 分钟；短码不分大小写，只有最新一个有效，输错 5 次短码作废，链接仍可用。

登录链接不含长期管理员密钥，但仍不可转发。管理页会话空闲 30 分钟或达到 12 小时后失效，服务重启也会失效；退出管理页只撤销当前会话。

## 升级与回滚

```sh
saltedfish upgrade
saltedfish rollback
```

`upgrade` 检查发行包配置的更新源，用当前 Node 自带的 npm 下载新版，再切换运行快照。下载失败不改变运行版本；查询更新源失败时仍可切换到本机已安装的包。仅执行 `npm install -g saltedfish` 不会替换正在运行的快照。

切换前校验文件、数据格式和服务空闲状态。启动失败时，在数据格式兼容的前提下回到旧版；新数据已不能由旧版读取时，只向前恢复。`rollback` 不下载，只切回本机保存的上一兼容版本。原本停止的服务保持停止。

数据、配对、客户端授权和结果记录不回滚，也不会复活已撤销授权。同一版本的不同文件内容拒绝覆盖。

服务原先运行并在切换后恢复时，升级和回滚会刷新本安装接入过、仍可确认归属的客户端配置。服务原先停止时不会自动刷新，也可单独执行：

```sh
saltedfish connect --refresh
```

`connect --refresh` 只更新已登记连接的工具目录版本及必要连接信息，保留原授权、信任和禁用状态，不重新授权，不能与其他接入选项混用。无法确认归属或已经恢复的配置会跳过并报告；需显式更新时，用 `connect --clients ... --keep-approvals`。已打开的客户端必须重连，进行中的会话可能仍保留旧工具目录。Claude Desktop 需完全退出后再刷新，随后重启。

### 扩展更新

手动加载的扩展不会由 Chrome 自动更新。服务提供新版后，扩展图标显示 `NEW`。打开设置页点“更新”，首次选择 Chrome 实际加载的扩展文件夹，并允许编辑。扩展从已配对服务下载、校验文件后写入并重载，配对保留。Agent 正在操作时不能更新。

多个 Chrome 配置共用文件夹时，一个配置更新文件后，其他配置可能只需重新加载。管理页提示“扩展需要重新加载”时，即使显示版本已是新的，也应在 Chrome 扩展页重新加载。

扩展的一键更新只升不降；服务回滚不会通过这条通道降级其他电脑上的扩展。本机由安装管理器维护的扩展目录则随运行快照同步，代码变化后仍需重新加载。功能缺失时按提示更新服务或扩展，不要反复重试原动作。

## 中断恢复

升级中断或提示遗留维护记录时：

```sh
saltedfish status
saltedfish logs
saltedfish recover-lock
```

`recover-lock` 核对管理事务、运行身份和实际数据格式，完成升级或安全退回，不杀进程，不恢复旧数据库。服务忙碌、不可达或记录损坏时会保留现场并说明下一步。不要手动删除维护记录来绕过保护。

只有确认运行记录已经陈旧时，才用 `saltedfish recover-lock --forget-run local` 丢弃该记录。它只处理记录，不停止进程；不能用来解除浏览器动作的结果不明保护。后者见[管理页功能指南](product-features.md)。

## 数据目录与独立安装

| 系统 | 默认安装数据根目录 |
| --- | --- |
| Windows | `%LOCALAPPDATA%/SaltedFish/npm` |
| Linux / macOS | `$XDG_DATA_HOME/saltedfish`；未设置时为主目录下依次为 `.local`、`share`、`saltedfish` 的目录 |

使用 `SALTEDFISH_HOME` 或每次传入 `--home DIR` 指定独立根目录。运行快照在 `versions`，固定入口为 `launcher.mjs`；服务数据在 `data/local`，扩展在 `data/local/extension`，管理日志在 `logs`。多套安装使用不同根目录和端口，不会互相接管。

凭据、SQLite、结果及配置备份均属于私有数据。备份与清理说明见[限制与数据说明](beta-limitations.md)。

## 离线 TGZ 安装

从可信发行来源取得 TGZ 后：

```sh
npm install -g ./saltedfish-0.3.28.tgz
saltedfish install
```

已有服务升级时，安装 TGZ 后执行 `saltedfish upgrade --no-fetch`，跳过联网检查。包内包含运行依赖，不含用户数据或凭据；Node.js 仍需另行准备。

## 卸载

先关闭使用 SaltedFish 的 Agent，并确认没有在途操作。需要恢复客户端原配置时，先运行 `connect --history` 和 `connect --restore ID`；文件有后续改动时恢复会拒绝覆盖，也可在客户端手动移除该连接。

Linux 先运行 `saltedfish autostart off`。Windows 若注册过设置入口或可选助手，按需要运行 `saltedfish desktop unregister`、`saltedfish helper uninstall`。然后：

```sh
saltedfish stop
npm uninstall -g saltedfish
```

卸载 npm 包不会自动移除 Chrome 扩展、客户端配置、数据和运行快照。确认不再需要后再手动清理对应目录；不要删除仍被其他安装或 Chrome 使用的文件夹。
