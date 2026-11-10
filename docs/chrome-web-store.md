# Chrome 应用商店上架

上架前要做的事、商店表单里要填的内容。商店审核对 `debugger` 权限和 `<all_urls>` 会做深度审查，说明要具体。

## 提交前必须改的代码

1. **商店版关掉一键更新。** 一键更新会从已配对的服务下载扩展文件，写进扩展自己的文件夹再重载（`extension/self-update.ts`）。商店禁止扩展执行远程获取的代码，商店安装的扩展还有内容校验，文件被改就会被 Chrome 判成已损坏。商店版由商店更新：构建时区分商店版，去掉设置页的“更新”按钮和对应的消息处理，服务端也不要向商店版推更新提示。
2. **Windows 设置入口认商店版的扩展 ID。** Native Messaging 的 `allowed_origins` 现在按“加载已解压的扩展程序”的文件夹路径算扩展 ID（`src/native-settings-registration.ts` 的 `unpackedExtensionOrigin`）。商店版 ID 固定，要能登记它。
3. **扩展 ZIP 里的 `pairing.json`。** 管理页下载的 ZIP 带服务地址；商店版没有这个文件，首次打开时在设置页填服务地址（设置页已经有这个输入框），确认流程走得通。
4. **英文名称和描述。** `manifest.json` 现在只有中文。加 `default_locale` 和 `_locales/{zh_CN,en}/messages.json`，商店和 `chrome://extensions` 才会按语言显示。

## 单一用途

> 让用户自己的 AI Agent，经由用户自己运行的 SaltedFish 服务，在用户授权的范围内操作这个 Chrome 配置里的网页。
>
> Lets the user's own AI agents operate web pages in this Chrome profile, through a SaltedFish service the user runs themselves, within the scope the user authorizes.

## 权限说明

| 权限 | 为什么需要 |
| --- | --- |
| `debugger` | 核心功能。通过 Chrome DevTools Protocol 执行 Agent 请求的点击、输入、截图、读取无障碍树、等待网络响应，并在后台标签页里操作而不切换用户正在看的标签页。只在 Agent 请求某个标签页时附加到那个标签页。 |
| `<all_urls>`（host permission） | Agent 要操作的网站由用户在自己的任务里决定，无法事先列出。只在用户授权的 Agent 请求时访问对应页面。 |
| `scripting` | 在页面的隔离环境里定位元素、读取文字和表单状态。不向页面主环境注入对象。 |
| `tabs` | 列出标签页的网址和标题，打开、关闭、定位 Agent 要用的标签页。 |
| `tabGroups` | 把每个 Agent 会话的标签页放进它自己的标签组，让用户看得出哪些标签页由 Agent 使用，并限制写操作只落在这些标签页上。 |
| `downloads` | Agent 请求下载文件、等待页面触发的下载完成、列出下载记录。 |
| `contentSettings` | Agent 明确请求时，为指定网站允许自动下载或弹出窗口。 |
| `storage` | 保存配对信息和扩展设置。 |
| `alarms` | 与服务断线后定时重连。 |
| `identity`、`identity.email` | 读取这个 Chrome 配置登录的 Google 账号邮箱，显示在用户自己的管理页里，用来区分多个 Chrome 配置。只发给用户配对的服务。 |
| `nativeMessaging` | Windows 上从扩展设置页直接打开本机 SaltedFish 管理页，以及可选的文件助手读取 Chrome 已下载的文件。 |

**远程代码**：不使用。扩展执行的全部代码都在包内；商店版不包含一键更新（见上文）。Agent 请求的页面脚本（`chrome_evaluate`）是用户授权的 Agent 发起、在页面里求值的数据，不是扩展自身的代码。

## 数据披露（商店“隐私权”页）

- 收集的数据类型：网站内容（页面文字、截图）、网页浏览记录（标签页网址和标题）、个人身份信息（Google 账号邮箱）。
- 用途：只用于扩展的单一用途；数据只发给用户自己配对的 SaltedFish 服务。
- 声明：不出售给第三方；不用于与单一用途无关的目的；不用于信用评估或放贷。
- 隐私政策地址：`https://github.com/finmoor/saltedfish/blob/main/PRIVACY.md`

## 商店素材

| 项目 | 规格 | 状态 |
| --- | --- | --- |
| 图标 | 128×128 PNG | 已有 `extension/icon-128.png` |
| 截图 | 1280×800 或 640×400，1–5 张 | 待做：扩展设置页、管理页的浏览器列表、Agent 授权、标签组 |
| 小型宣传图 | 440×280 | 待做 |
| 简短描述 | 132 字以内 | 见下 |
| 详细描述 | 中文、英文各一份 | 见下 |

简短描述：

- 中文：让 AI Agent 通过你自己运行的 SaltedFish 服务，用上你正在用的 Chrome：多配置隔离，写操作限定在 Agent 自己的标签组里。
- English: Let your AI agents use the Chrome you already use, through a SaltedFish service you run yourself. Per-profile grants, writes limited to the agent's own tab group.

详细描述（英文，中文按 README 改写）：

> SaltedFish connects AI agents such as Claude Code, Codex and OpenCode to the Chrome profiles you already use, over MCP.
>
> This extension is one half of SaltedFish. The other half is the SaltedFish service, which you install and run yourself (`npm install -g saltedfish`). The extension only talks to the service you pair it with; nothing is sent to the developer.
>
> • Each Chrome profile is paired and authorized separately.
> • Agents work in background tabs inside their own tab group, without switching the tab you are using.
> • Writes are logged before they are sent; operations with an unknown result are never replayed automatically.
> • Pause the agent at any time from the extension.
>
> Source code and documentation: https://github.com/finmoor/saltedfish

## 账号和流程

- 开发者账号要一次性注册费，用维护者自己的 Google 账号注册；账号操作和付款由维护者本人完成。
- 首次提交审核通常要几天；`debugger` 权限可能要求补充说明或演示视频。
- 商店版和“加载已解压的扩展程序”的版本是两个不同的扩展 ID。已经配对的旧扩展换成商店版时，用管理页离线卡片上的“重新连接”接回原来的浏览器身份。
