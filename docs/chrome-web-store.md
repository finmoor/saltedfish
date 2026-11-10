# Chrome 应用商店上架

上架前要做的事、商店表单里要填的内容。商店审核对 `debugger` 权限和 `<all_urls>` 会做深度审查，说明要具体。

## 商店版构建

商店版和“加载已解压的扩展程序”的版本用同一份源码，构建时用开关区分：

```sh
npm run package:extension-store
```

它先照常构建，再用 `node scripts/build-extension.mjs --store` 构建到 `dist/extension-store`，打包成 `release/saltedfish-extension-store-<版本>.zip`，上传到开发者后台的就是这个文件。商店版和默认版的区别：

- **没有一键更新。** 一键更新会从已配对的服务下载扩展文件，写进扩展自己的文件夹再重载（`extension/self-update.ts`）。商店禁止扩展执行远程获取的代码，商店安装的扩展还有内容校验，文件被改会被 Chrome 判成已损坏。商店版构建时 `extension/build-target.ts` 换成 `STORE_BUILD=true`，`self-update.ts` 换成 `self-update-store.ts`：设置页没有“更新”按钮，后台不响应更新消息，工具栏不显示 NEW。构建和打包都会检查产物里没有写文件夹的代码。
- **声明 `store-build` 代替 `self-update-v1`。** 管理页据此提示“商店会自动更新”，不再叫用户覆盖文件夹。
- **不带服务地址。** 管理页下载的 ZIP 带服务地址；商店版首次打开时在设置页填服务地址。
- **带英文描述。** 商店版的 manifest 加 `default_locale: "en"`，描述和工具栏标题取自 `extension/store-locales/{en,zh_CN}/messages.json`（打包进 `_locales/`），商店和 `chrome://extensions` 按浏览器语言显示。默认版不带 `_locales`：一键更新只认平铺的文件。

**商店分配的扩展 ID** 登记在 `src/native-settings-registration.ts` 的 `STORE_EXTENSION_IDS`。Windows 本机设置入口和文件助手（Native Messaging）只认允许名单里的扩展；“加载已解压的扩展程序”的 ID 按文件夹路径算，商店版的 ID 在第一次把 ZIP 上传到开发者后台时分配。服务版本比商店版旧、名单里还没有这个 ID 时，商店版照样能用，只是在 Windows 上点“打开管理页”会走登录页，不能直接进入。

开发者后台不能用脚本操作：Chrome 不允许任何扩展脚本操作应用商店页面，上传和填表由维护者本人在浏览器里完成。

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

**远程代码**：申报“使用”。扩展自身的逻辑全部在包内，不从网络加载代码，商店版也不包含一键更新（见上文）；但 `chrome_evaluate`、`chrome_wait` 的表达式和 `initScript` 是用户授权的 Agent 发来的 JS 字符串，扩展经 `chrome.debugger`（`Runtime.evaluate`）在目标网页里执行，和在开发者工具控制台里执行一样，不在扩展自己的上下文里运行。商店对远程代码的定义包括“不在扩展包里的 JS”，所以如实申报并说明。

## 数据披露（商店“隐私权”页）

- 收集的数据类型：网站内容（页面文字、截图）、网页浏览记录（标签页网址和标题）、个人身份信息（Google 账号邮箱）。
- 用途：只用于扩展的单一用途；数据只发给用户自己配对的 SaltedFish 服务。
- 声明：不出售给第三方；不用于与单一用途无关的目的；不用于信用评估或放贷。
- 隐私政策地址：`https://raw.githubusercontent.com/finmoor/saltedfish/main/PRIVACY.md`。不用 `github.com/.../blob/...`：提交时那个页面对匿名访问返回过 503，商店报“无法访问隐私权政策链接”。

## 商店素材

| 项目 | 规格 | 状态 |
| --- | --- | --- |
| 图标 | 128×128 PNG | 已有 `extension/icon-128.png` |
| 截图 | 1280×800 或 640×400，1–5 张 | 管理页的概览、浏览器、操作记录三张，用测试服务和 Chrome for Testing 截的，不含真实账号 |
| 小型宣传图 | 440×280 | 已做 |
| 简短描述 | 132 字以内 | 见下 |
| 详细描述 | 中文、英文各一份 | 见下 |

简短描述就是商店版 manifest 的描述，以 `extension/store-locales/*/messages.json` 的 `extDescription` 为准：

- English: Let your AI agents use the Chrome you already use, through a SaltedFish service you run yourself.
- 中文：让 AI Agent 通过你自己运行的 SaltedFish 服务，用上你正在用的 Chrome。

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
