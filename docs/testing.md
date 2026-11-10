# 测试

测试分几组，各自证明不同的东西：单元测试只证明服务端逻辑，浏览器组证明扩展在真 Chrome 里的行为，客户端组证明真实 Agent 读得懂接入配置。改了哪一层，就跑覆盖那一层的组。

## 准备

```sh
npm ci
npm run build
```

需要 Node.js 24+。浏览器相关的测试要一个 Chrome for Testing：

```sh
npx @puppeteer/browsers install chrome@stable --path ~/.cache/puppeteer
```

测试会在 `~/.cache/puppeteer/chrome` 下找最新的版本；装在别处时用 `CHROME_TEST_EXECUTABLE` 指定。测试只用临时的独立用户数据目录，不碰你日常的 Chrome 配置。

## 分组

| 命令 | 内容 | 需要 |
| --- | --- | --- |
| `npm run typecheck` | 服务、扩展、测试、管理页四个工程的类型检查 | — |
| `npm test` | 单元测试（`tests/*.test.ts`），扩展跑在假的 `chrome` 对象上 | `npm run build` 之后 |
| `npm run test:browser` | 浏览器入口用例和 `execution*`、`interaction*`、`navigation*`、`styled-controls*`、`extension-compatibility*`、`product-depth*` 套件 | Chrome for Testing |
| `npm run test:ui` | 管理页和扩展设置页（`tests/ui*.integration.ts`） | Chrome for Testing |
| `npm run test:performance` | 交互开销：点击、填值、文本插入等的耗时和 CDP 调用数 | Chrome for Testing，见下文 |
| `npm run test:npm` | 打一个 npm 包，在隔离目录里真实安装、启动、升级、回滚 | 先 `npm run package:npm -- --candidate` |
| `npm run test:package` | Windows 独立安装包的安装、升级、回滚、卸载 | Windows，先 `npm run package:windows` |
| `npm run test:self-update` | 扩展一键更新，会弹出文件夹选择框 | 有桌面的 Windows |
| `npm run test:claude-trust` | 真实 Claude Code 读接入向导写的配置，模型换成本地桩，不用额度 | 装了 Claude Code |
| `npm run test:codex-trust`、`test:opencode-trust`、`test:clients` | 真实客户端加真实模型的接入验证 | 对应 CLI 和模型额度 |

单独跑某一个文件：

```sh
node --import tsx --test tests/interaction-feedback-1108.integration.ts
```

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `CHROME_TEST_EXECUTABLE` | 测试用的 Chrome。可以指向正式版 Chrome，测试仍然只用临时配置 |
| `INTERACTION_HEADFUL=1` | 交互用例开窗口跑，看得见过程；后台标签页等用例要这样才覆盖真实的窗口焦点 |
| `CLAUDE_TEST_EXECUTABLE`、`CODEX_TEST_EXECUTABLE`、`OPENCODE_TEST_EXECUTABLE` | 客户端测试用的 CLI，默认按常见安装位置找 |
| `PRODUCT_SERVICE_ROOT`、`INTERACTION_SERVICE_ROOT` | 指向另一份构建好的服务（例如上一版），用来验证新旧服务、新旧扩展混用 |
| `INTERACTION_EXTENSION` | 指向另一份构建好的扩展，验证旧扩展收到新参数时的表现 |
| `PERF_BASELINE` | 性能组的基线报告，见下文 |

## 性能测试

性能组量的是产品自身的开销，不是帧节奏：Chrome 用 `--disable-gpu-vsync --disable-frame-rate-limit` 启动，Agent 光标和拟人输入关掉（它们开着时的耗时另记，不进比较）。

没有 `PERF_BASELINE` 时只采集数据，报告里 `compared:false`。要比较时，先在同一台电脑、同样的负载下用上一版跑一次，再把它的报告给 `PERF_BASELINE`。基线和当前环境差太多时，用两份构建交替多跑几轮再下结论。不要和其他测试同时跑。

## Windows 上的注意事项

- 测试里启动 Chrome 一律用 `tests/chrome-launch.ts` 的 `launchTestChrome`；自己直接起 `chrome.exe` 的，先调 `seedChromeUserData`。Windows 版 Chrome 用全新用户数据目录启动时会用空密码试登录一次系统账户，每次记一条登录失败，跑一轮测试就可能把账户锁住；预置 `Local State` 后不会再试。
- 调用 Windows 系统程序用绝对路径。Git Bash 的 PATH 里有同名的 msys 程序（例如 `whoami.exe`），行为不同。
- PowerShell 5 读的中文 `.ps1` 文件必须保留 UTF-8 BOM。

## 发行前

维护者发版时，同一个候选包要依次通过类型检查、单元、管理页、浏览器、性能五组（`npm run verify:release`），再在 Windows 和 Linux 上各跑一次 `npm run test:npm`，最后 `npm run release:npm` 核对证据、冻结发行包。这套流程绑定候选包哈希和源码指纹，构建后源码有任何变化都要重新出候选。
