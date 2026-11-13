# SaltedFish 架构

本文说明当前版本 0.3.29 的组件、执行模型和故障边界。服务、npm 包和 Chrome 扩展使用同一个版本号。工具参数与返回值的完整语义见[交互说明](interaction.md)。

SaltedFish 由一个常驻服务、每个 Chrome 配置中的扩展、管理页和 SQLite 状态库组成。Agent 通过服务的 `/mcp` 调用工具；扩展通过 `/bridge` 建立 WebSocket 连接，使用 Chrome API 和 Chrome DevTools Protocol（CDP）执行命令。管理页与这些端点由同一服务提供。

```text
Agent ── Streamable HTTP /mcp ──────────────┐
Agent ── stdio 适配器 ── 本机 /rpc ────────┤
管理页 ── 同源 HTTP 管理接口 ──────────────┤
                                          ▼
                              SaltedFish 常驻服务
                           鉴权 → 准入 → 日志 → 派发
                             │                │
                       SQLite / 结果文件      │ WS/WSS /bridge
                                              ▼
                                      Chrome 配置中的扩展
                                              │ Chrome API / CDP
                                              ▼
                                         窗口与标签页
```

一次调用先经过 schema 校验、授权和目标检查，再进入协调层。写操作在派发前记录到 SQLite。扩展执行后返回结果或带执行阶段的错误；服务据此更新日志、保存大结果，并向 Agent 返回。HTTP 与 stdio 共用 `BrowserService`，不各建一套执行核心。

## 网络与部署

- Windows 和 macOS 默认只监听 `127.0.0.1`。
- Linux 首次安装默认探测默认路由使用的内网 IP，监听该地址的端口 `18445`。例如 `http://192.168.1.10:18445`。其他电脑上的 Chrome 扩展可以直接连接，不需要额外中转。
- `saltedfish install --local` 只监听本机；多网卡环境可用 `--host` 指定内网 IP。重复安装保留已有监听配置，除非显式修改。
- 明文 HTTP/WS 只适用于可信内网。跨机器明文监听必须启用 `allowInsecureLan`，并绑定服务地址对应的私网 IP；公网地址和通配地址不能使用此模式。公网部署需要 TLS 证书，使用 HTTPS/WSS。

**Agent 必须与服务在同一台电脑。** `/mcp` 在鉴权前检查 socket 地址：对端是回环地址，或连接两端地址相同，才接受连接；否则返回 HTTP 403、`MCP_LOCAL_ONLY`。因此连接本机的内网 IP 也可用。内部 `/rpc` 对非管理员使用相同限制，不是供远程 MCP 客户端填写的端点。TLS 不会取消这项限制。

`/bridge` 和管理页不受上述同机限制，但仍需通过各自的来源与凭据检查。服务验证 Host、Origin、Bearer 和桥接握手，不接受任意网页来源。HTTP 不加密页面内容、结果或管理请求，桥接鉴权也不能代替 TLS。

安装与网络配置见 [npm 使用说明](npm.md)。

## 身份与授权

### 浏览器配置身份

扩展首次启动时在 `chrome.storage.local` 生成持久的 `profileId`。它表示 Chrome 配置，不是网站账号。`instanceId` 每次扩展后台启动时变化，用于区分连接实例。`label` 只是可编辑别名，不能作为认证依据。

同一 Chrome 配置中的窗口共用登录态，不同配置分别连接。重复的在线 `profileId` 不会覆盖已有连接。复制浏览器配置后，应为副本重建身份，或通过管理页明确处理配对。

扩展可通过 `chrome.identity.getProfileUserInfo` 提供 Chrome 登录账号，`chrome_profiles` 将它显示为 `account`。这项信息只在内存中保存，不代表当前网站登录的是同一个账号；未登录 Chrome 时可以没有该字段。

### 配对与桥接握手

每个浏览器使用独立配对密钥。配对可选的管理授权与连接授权分开生成、验证和撤销。只有连接授权的扩展不能调用管理 API；获准管理的扩展可通过专用入口换取一次性登录码，不取得长期管理员密钥。撤销管理授权也会撤销由它签发的登录码和管理会话。

`/bridge` 使用双向挑战应答，流程是 `hello` → `challenge` → `auth` → `ready`：

1. 扩展发送协议号、配对标识和随机数，不发送配对密钥。
2. 服务发送自己的随机数，以及绑定双方随机数的 HMAC-SHA256 证明。
3. 扩展验证服务后，发送绑定随机数、`profileId` 和 `instanceId` 的客户端证明。
4. 服务验证证明、绑定配对与浏览器身份后，登记连接并返回能力清单。`ready` 之前不执行命令或发送业务事件。

配对密钥在这次握手中只作为 HMAC 的 key，不直接传输。证明不能换一个身份重放。鉴权前同时最多 16 条连接，每条累计原始数据不超过 16 KiB，并有 5 秒握手期限；鉴权后业务帧的上限为 128 MiB。

扩展重装或改用另一个加载目录后，原存储可能不可用。管理页对离线浏览器提供“重新连接”：撤销旧配对，换发绑定原 `profileId` 的配对码，保留名称、Agent 授权和记录。在线浏览器不能被这样替换；已配对扩展不能直接接受另一个身份的配对码。

### Agent 授权与管理会话

管理员凭据、浏览器配对密钥和 Agent 凭据彼此分离。每个 Agent 可独立限制 Chrome 配置范围、设为只读或撤销。结果文件读取同样检查配置范围。“高级工具”开关只改变 MCP 暴露的工具目录，不扩大授权范围。安装、升级、回滚不能重新启用已撤销授权。撤销阻止后续派发，不能保证撤回已经发生的动作。

管理页使用有期限的会话，而不是在 URL 中携带长期管理员密钥：

- `saltedfish dashboard` 通过 `POST /session/code` 取得一次性登录码，放入 URL 片段。登录码有效 5 分钟，只能使用一次；服务仅在内存保留其哈希，最多保留 16 个。
- 页面通过 `POST /session` 换取会话令牌，保存在 `sessionStorage`。会话空闲 30 分钟或累计 12 小时后失效，最多保留 32 个，服务重启后全部失效。
- 终端打印登录链接时可同时提供 4 位短码。短码与链接共享一次登录机会，只有最新短码有效，输错 5 次会使短码失效，不影响长码。
- `DELETE /session` 退出当前会话；`saltedfish dashboard --logout-all` 撤销全部会话。会话令牌不能再签发登录码或撤销全部会话。

**只读授权限制本服务接口，不是操作系统沙箱。** 原始 CDP 和页面 JavaScript 都可能有副作用；MCP 的 `readOnlyHint` 只是标注，实际权限由服务执行。能够以同一系统用户身份任意读写服务文件的程序处于系统信任边界内。

非管理员不能读取、操作或导航到 SaltedFish 管理页和扩展自身页面，也不能让浏览器打开 `file:` 本机文件网址。服务在严格参数校验后附加保留字段 `adminGuard`，扩展按标签页的实时地址逐步检查；命中返回 `ADMIN_PAGE_PROTECTED`，且未派发。脚本执行有同任务内的来源检查；截图、网络读取等路径还会复查地址并丢弃受保护结果。列表中受保护标签页的 URL 和标题会被隐藏。原始 CDP 也受限制，`Debugger.*` 返回 `CDP_METHOD_RESTRICTED`。

安全报告方式见 [SECURITY.md](../SECURITY.md)，数据处理边界见 [PRIVACY.md](../PRIVACY.md)。

## 执行与并发模型

### 显式目标与连接代际

标签页操作使用 `profileId + tabId` 显式路由，不以活动标签页、标题或配置列表第一项兜底。新建标签页等尚无 `tabId` 的操作也必须明确 `profileId`。

每条桥接命令有 `id` 和 `deadline`，响应只接受原连接返回的数据。任务、上传预检和每次异步派发都绑定预期连接对象。浏览器断线重连后，即使身份或标签页编号相同，也不向新连接发送旧任务尾部。旧 socket 的断开清理只影响它自己的未完成请求。

批次在步骤之间检查期限、暂停、授权和连接。失败后停止，不执行剩余步骤。队列中已经超时的命令不会在稍后获得资源时继续执行。

### 三层协调

| 层次 | 作用 | 边界 |
| --- | --- | --- |
| 标签页租约 | `chrome_claim_tab` 为调用 owner 取得有期限的占用；`chrome_release_tab` 释放 | 协调客户端之间的工作归属 |
| 标签页互斥 | 同一标签页的写操作不能同时执行 | 保护命令执行期间的竞态 |
| 同窗口视觉队列 | 扩展按窗口串行执行需要视口、鼠标或键盘的操作 | 同一窗口内协调；不同窗口可并行 |

这三层不能互相替代，也不能阻止手工操作或其他软件修改页面。租约默认上限 4096，申请时和定时维护时回收过期项。

全局在途调用默认上限 128。非管理员各自最多使用全局上限的八分之一，且为管理员保留恢复名额；拥塞分别返回 `PRINCIPAL_BUSY` 或 `SERVER_BUSY`。暂停、释放占用、任务控制和弹窗响应等控制操作不受这一执行名额限制。

### MCP 会话标签组

标签组是工作范围的可见协调边界，**不是安全边界**。一个 MCP 会话在每个窗口里最多有一个组。常规写操作只能落在本会话创建、接管或由这些页面打开的标签页与弹窗上；页面读取不受标签组限制，但仍受授权范围限制。

- `chrome_new_tab` 和 `chrome_claim_tab` 成功后尝试加入会话标签组。已有组时，未指定窗口的新标签页优先在该组窗口创建。其他窗口的标签页在其原窗口建组，不跨窗口搬走。
- 固定标签页、用户已有组中的标签页和弹窗窗口不强行移动；成功取得的租约仍可作为写入依据。新标签页无法进组时，服务尝试改为占用 10 分钟，并返回 `TAB_NOT_GROUPED` 警告；若占用也失败，写入前仍需接管。
- 成员名单单独记录。手动拖进组不等于授权。拖出组算收回，释放占用，写入和再次接管返回 `TAB_TAKEN_BACK`；拖回原组后恢复。
- 其他活跃会话组中的标签页不能写或抢占，接管返回 `TAB_CLAIMED`。不属于当前会话且无有效租约时，写入返回 `TAB_OUTSIDE_GROUP`。
- 会话结束后解散组、释放全部租约，标签页保留。接管来的标签页在仍处于原窗口时尽量恢复原位置。异常退出通过周期性对账清理，连续两轮不在线才解散，避免短暂心跳中断立即释放。

组归属保存在扩展的 `storage.local`，Chrome 是组是否存在的事实来源；服务只通知和对账。组查询失败时不会单凭这次失败拦住业务。任务和普通 RPC 不套用 MCP 标签组规则，仍受授权、租约和互斥约束。该机制依赖能力 `tab-groups-v1`。

会话结束时，扩展可在 `storage.session` 暂存原标签页归属，保留 24 小时、最多 32 个会话。同一 Agent 重连后，只有页面同源、没有其他活跃占用、未加入其他组且原 owner 不在线时，才自动接回并返回 `TAB_REJOINED`。手动“结束并释放”不会触发这种自动接回。

Chrome 可能保存标签组标题和组内网址，因此标题只包含 Agent 名称，不放任务内容。退出 Chrome 时仍存在的已保存组，扩展没有接口保证清除。

### 会话寿命与使用状态

建立 MCP 连接只表示“待命”。正在执行、占用标签页或最近操作过标签页才算“使用中”；`chrome_profiles`、`chrome_tabs` 这类探测不算使用页面。

stdio 适配器通过心跳登记会话，调用本身也续期；收到 EOF 后注销。HTTP 客户端若开过 GET 推送流，流断开后 2 分钟没有新请求才结束会话；从未开推送流的客户端按空闲 30 分钟处理。同一 Agent 最多有 16 个 HTTP 会话。服务可按原会话 ID 恢复传输，会话 owner 同时绑定凭据身份，不能换凭据接管别人的会话。

### 后台标签页与弹窗

视觉动作通常不切换窗口的当前标签页。扩展使用 `Emulation.setFocusEmulationEnabled`，让后台标签页接收输入；服务在动作前后管理焦点模拟，扩展在未开启时补开，结束后归还状态。

后台截图通过 `Page.startScreencast` 加 CDP Overlay 的透明重绘提示请求新画面，不向页面 DOM 添加节点。等待约 1.5 秒仍无法取得画面时，才短暂切到目标标签页，完成后在用户未另行切换的情况下切回。因此“不切前台”有截图兜底例外。最小化窗口会临时恢复，结束后在条件允许时重新最小化。

后台页面打开的新标签页若被 Chrome 放到前台，扩展结合发起方的 `Page.windowOpen` 事件识别，并尝试把它留在后台、切回原标签页。手动停止调试默认会暂停扩展，不自动重新接管；可选的自动恢复由扩展设置控制。

弹窗控制者绑定命令、连接、配置和标签页。`chrome_dialog` 不能绕过配置范围或只读限制。由输入触发的弹窗可能使原命令提前返回，但物理执行仍可能尚未结束；服务保留相应控制关系。`beforeUnload:"accept"` 可显式处理导航或关闭前的确认；否则应答完确认框后再核对原操作。脚本弹窗应答后还可能继续执行，不能仅凭应答解除未知结果保护。

## 结果与故障语义

### 写前日志与未知结果

SQLite 使用 WAL 和 `FULL` 同步模式。写操作发送前保存工具、目标、时间和 `running` 状态，已知结果返回后再记录完成。超时、断线或进程终止可能使结果不明；服务重启将残留 `running` 转为 `unknown`，继续阻止相关目标的新写入。

状态库只在服务成功绑定监听端口后打开，防止另一个竞争启动的进程把仍在运行的操作误判为崩溃。管理命令通过服务 API 修改授权，不并行初始化同一状态库。

错误通过 `phase` 和 `outcome` 描述执行阶段：

| `outcome` | 含义 | 后续处理 |
| --- | --- | --- |
| `not_dispatched` | 有明确证据表明尚未派发本次动作，通常为 `phase:"precondition"` | 记失败，不新增未知结果保护 |
| `unknown` | 可能已经生效，无法确认结果 | 保护标签页或配置，先核查再恢复 |
| `dispatched` | 动作已派发且执行结束，但后置核对未通过 | 不隔离标签页，但不能据此重复业务动作；队列任务仍需核查 |

授权、目标或队列准入失败，日志在派发前写不进去，以及 Chrome 明确拒绝命令等情况，可标记未派发。脚本运行期异常或 Promise 拒绝不能证明没有副作用，不能直接当作未执行。点击或输入完成也不等于网站业务成功。

带标签页的未决操作只保护该标签页；没有标签页、影响范围不明的未决操作保护整个配置。`OPERATION_PENDING` 和 `RESULT_UNKNOWN` 的检查位于租约、互斥准入之后，避免拒绝新调用时又制造一条未知结果。内存隔离状态以数据库中仍未确认的记录为准。

### 超时与坏帧

CDP 的同步脚本期限不能覆盖所有异步等待。扩展另设 watchdog：表达式超时返回 `SCRIPT_TIMEOUT`；命令无法收尾时返回 `OPERATION_HUNG`，写命令还会断开该标签页的调试器，让挂起的调用收尾。它们按未知结果处理。相对 `timeoutMs` 按扩展收到命令时的本机时钟计时，不依赖两台电脑时钟一致。

桥接鉴权前的坏帧会断开连接。鉴权后，单个坏帧不会直接断开整个浏览器：可关联到在途命令的非法结果以 `INVALID_RESULT_FRAME`、`unknown` 结束该命令；无法解析或不合格的事件被丢弃。错误文本在扩展和服务两侧截到 `ERROR_MESSAGE_LIMIT`，当前为 8000 字符，避免一条页面错误影响其他调用。

### 恢复与存储故障

先用页面读取、截图、下载状态或网站业务记录核对，再调用 `chrome_recover_operation` 或标签页恢复工具显式确认。恢复只解除保护，不重放动作，也不能证明网站事务已经提交或撤销。已经发出的网络请求无法保证取消。

业务结果已知、完成日志却写入失败时，返回原业务结果并附加 `OPERATION_JOURNAL_FAILED`，不伪报业务未执行。残留日志继续阻止重复写入；修复存储并重启后，再核查和恢复。

大结果保存失败同样独立返回 `RESULT_STORAGE_FAILED`，不能诱导 Agent 重复已经发生的业务操作。

对永远无法重新连接的配置，只有管理员能通过管理页预览并明确放弃其未知结果记录。服务要求配置离线、无运行中操作，并校验确认数量；此操作不访问浏览器、不重放步骤，也不取消已暂停或待核查任务。没有提供让 Agent 自行丢弃这些保护的 MCP 工具。

## 数据与资源预算

数据目录保存配置、独立客户端凭据、浏览器配对、SQLite 状态库和结果文件；程序版本目录不包含这些运行数据。操作审计不保存脚本、页面正文、令牌或上传文件内容。上传在 `operations.detail` 中记录文件名、大小和 SHA-256，摘要由后台流式计算补齐。结果文件和显式保存的流程定义是独立的数据类别，不受“审计不存正文”这句话覆盖。

| 资源 | 默认预算或策略 |
| --- | --- |
| 网络与控制台事件 | 内存队列受条数和字节双重限制，默认 2000 条、8 MiB；返回序列号和丢失边界 |
| 大 JSON 与图片 | 保存到数据目录的 `results`，元数据写 SQLite，默认总容量 1 GiB |
| 结果配额 | 非管理员合计最多占总预算的 90%；单个主体上限为 max(min(总预算, 64 KiB), floor(总预算 / 4))；管理员仍受总容量约束 |
| 元素引用与快照 | 每个页面运行时最多保留 5000 个引用；快照最多 8 份、5 分钟、累计 2097152 字符 |
| 提交去重收据 | 保留 30 天；容量紧张时只回收超过 24 小时保护期的旧收据；总量 10000，预留管理员 1000，单个非管理员最多 2000 |

JSON 结果由 `ResultReader` 按 `artifactId` 有界流式分页读取。它使用 64 KiB 解码块，按 UTF-16 字符偏移建立检查点索引；首次读取需扫描文件得到总字符数，后续可复用索引。并发读取有许可上限，不把大文件全部常驻内存。结果文件的访问仍需通过授权检查。

结果元数据保存失败时清理本次新文件。清理失败或启动发现未登记的孤儿文件时，计入 `untrackedResultBytes`，不自动删除历史文件。配额不足使用 `RESULT_QUOTA`；收据容量不足使用 `SUBMISSION_QUOTA` 或 `SUBMISSION_CAPACITY`，不删除保护期内的收据来接受新任务。

状态格式通过 `PRAGMA user_version` 标记，当前运行时支持的上限是 `STATE_VERSION = 3`。格式只升不降；`state-compatibility.ts` 只读检查标记，不迁移或恢复状态。不能恢复旧数据库快照来绕过不兼容降级，因为这会丢失撤销状态与未知结果保护。

管理员 `/diagnostics` 提供内存、运行时长及请求、互斥、租约、事件和结果计数，不提供页面正文或凭据。产品没有自带遥测；工具返回的页面和截图会交给调用它的 AI 客户端，后续受该客户端的数据规则管理。

## 任务与流程

任务按 `profileId` 顺序排队，最多 4 个配置并行；每个配置在队列中最多 20 个任务，全局最多 100 个。单任务定义最多 200 步，单步最长 120 秒；分支和循环还受 `maxExecutedSteps` 总执行次数约束，默认 1000。运行计划单个最多 2 MiB、全局最多 32 MiB，结束或取消后释放。

每一步复用服务的授权、租约、日志与未知结果保护，不是另一条不受检查的执行通道。任务绑定原连接，撤销在后续授权复查时生效；暂停和取消等待当前步骤结束，不能保证撤销该步骤已发生的业务效果。任务日志写入失败会停止调度并拒绝新增或继续任务，需要修复存储并重启，不自动解锁或续跑。

任务参数和脚本只在运行进程内保存。SQLite 的 `task_records` 保存步骤类型、状态、操作引用与截图引用，最多保留 500 条终态记录。重启后未结束任务标为 `interrupted`，不自动恢复执行。`task_summaries` 由触发器维护列表摘要，列表不必解析完整步骤记录。

带 `submissionId` 的提交先查去重收据：同一身份、配置和提交标识的内容一致时返回原任务并带 `deduplicated`；内容不同则返回 `TASK_SUBMISSION_CONFLICT`。去重只防止重复受理，不会让中断任务自动继续。

流程保存明确要求保留的定义，绑定单个配置。参数只在允许的字段值中替换，不向 JavaScript 表达式插值，也不保存临时元素引用、上下文或会话。执行必须匹配预览的 `revision`；过期编辑拒绝覆盖。

流程定义与当前版本在同一 SQLite 事务中保存。最多 100 个流程，单个 2 MiB；每流程最多 50 版，历史总计 64 MiB，归档最多 1000 项。复制时分别检查源、目标配置权限。任务只保存源流程及版本引用；恢复草稿需要重新输入参数，不执行步骤或解除保护。业务是否完成必须由核验步骤判断，不能用点击成功代替。

## Chrome 扩展

### 执行器与页面运行时

`extension/background.ts` 管理身份、配对连接、暂停与后台消息；`extension/executor.ts` 调用 Chrome API/CDP 并协调输入、导航、弹窗、截图和页面运行时。

执行能力受 Chrome 扩展与 debugger API 限制，不是操作系统 UI 自动化。Chrome 内部页、其他扩展页、系统授权框和验证码没有通用操作保证。调试连接可能与 DevTools 或其他扩展冲突；CDP 的 Browser 域和跨目标 Target 操作不支持。更多限制见[已知边界](beta-limitations.md)。

DOM 读取与语义定位逻辑构建成独立 bundle，经 `Page.createIsolatedWorld` 注入隔离世界。`isolated-runtime.ts` 缓存上下文标识和初始化 Promise，元素引用留在各隔离世界内；导航、上下文销毁和调试器分离会使缓存失效。页面运行时不能依赖主世界中的同名变量，也不通过向页面 DOM 添加控制节点来通信。

共享状态逻辑处理禁用继承、只读状态、可见性、敏感字段隐藏和增量快照。可见性会考虑动画结束时的状态，而不是只看当前瞬间的透明度。语义可访问名称是近似值，多匹配时不猜目标；导航或节点替换后应重新定位。

跨 frame 输入沿 frame tree 和执行上下文确定 renderer，用四点投影换算坐标，并逐级检查遮挡。输入前复查文档、目标和焦点。悬停引起同一目标移动时允许有限跟随；按下后明显移动则避免在新位置完成点击。页面改变输入焦点时返回 `FOCUS_CHANGED`，不无条件抢回。

定位与核验使用同一套页面运行时：

- `locator.inside` 用 CSS 限定候选范围，可匹配多个容器。`chrome_find` 的 `selector` 是它的简写，由服务转换后发送。动作会等待目标出现。
- `locator.nth` 明确选择多匹配中的第几项，`scopeRef` 限定读取范围，等待的 `match:"any"` / `match:"all"` 控制多匹配核验，不隐式挑一个。
- 条件 `state:"attached"` 只要求元素存在于 DOM，不要求可见；`textMatches` 用正则核对文本。文字比较合并空白并按 NFKC 归一，不改返回的原文。
- 按 `ref` 等待 `state:"hidden"` 时，已移除的元素算隐藏；等待隐藏超时可用 `stillVisible` 列出仍可见的候选。
- `chrome_find` 可返回 `within`、`layer` 和 `context`，帮助区分编辑器、浮层与同名候选。
- `chrome_action` 支持 `postcondition`，满足时带 `url`、`title`；`type` 可带派发后读回的 `value`，不将它冒充请求值核验。动作结果中的 `pageChange` 是页面变化摘要，不是业务成功证明。
- 上传目标不是文件框时，会检查关联 label、内部和向上最多四层内最近一层的文件框。向上那层有多个时，打开 CDP 文件选择框拦截、点一下目标，用页面自己打开的那个，不按类名或位置猜；没打开选择框返回 `FILE_CHOOSER_NOT_OPENED`（点击已派发）。目标本身含多个时返回 `AMBIGUOUS_FILE_INPUT`。结果可带实际文件框的 `input` 信息。
- 按元素定位的指针动作只在目标不完整可见、或中心被挡住裁掉时才滚动（iframe 里照旧滚到正中），滚过的结果带 `scrolled`；点击结果带落点上的元素 `hit`。

`chrome_evaluate` 和表达式等待的 `readOnly:true` 使用 Chrome 的 `throwOnSideEffect` 检查。被阻止时返回 `SIDE_EFFECT_BLOCKED`，可在写入暂停期间用于只读核对。顶层 `const` / `let` 因创建全局绑定而被拦时，会包进块作用域再试一次。有的页面用 core-js 一类补丁替换 `JSON.stringify` 等内置函数，Chrome 无法判定其副作用；扩展会检查相关内置函数并给出替代写法。只读执行不是通用 JavaScript 沙箱。

显式请求的页面脚本与内部隔离运行时不同。`chrome_navigate`、`chrome_new_tab` 的 `initScript` 在新文档的主世界执行，使用 `Page.addScriptToEvaluateOnNewDocument` 临时登记，调用结束时尝试撤销，正常情况下只覆盖这次导航。撤销失败返回 `INIT_SCRIPT_NOT_REMOVED` 警告，之后的新文档仍可能执行它；断开调试连接可清除登记。带脚本的新建标签页拆为“开空白页、登记脚本后导航”两步。非管理员脚本套入带受保护来源检查的函数；它仍是调用方主动要求的页面脚本，不是光标或提示机制。导航接口拒绝 `javascript:` 地址，应使用脚本工具执行代码。

### 截图与坐标

`chrome_screenshot` 支持视口、整页、元素和裁剪截图。坐标说明使用 CSS 像素，换算基于 `Page.getLayoutMetrics`，不直接假定页面的 `devicePixelRatio` 等于截图比例。取不到布局指标时照常截图，不附坐标说明。

视口截图标记 `coordinates.viewport`，不附加 `area`、`scroll` 偏移。其他截图提供 `toViewport`；带缩放时先除以 `scale` 再换算。`clipViewport` 表示按视口坐标解释裁剪区域。整页或超出视口的截图可用 `coordinates.fixed` 标出采样到的固定、粘性元素画在图里的位置；不会为此滚动页面，也不保证列出所有固定元素。直接按坐标点击时，结果可带落点元素 `hit`。

### Agent 光标与拟人输入

`showCursor` 默认开启。光标与目标框由 `extension/agent-cursor.ts` 使用 CDP Overlay 绘制，只提示位置，不派发输入，动作不等待动画。提示不往页面 DOM 或主世界加东西；后台标签页不会为了显示光标切到前台。空闲后自动收起，产品截图及原始 `Page.captureScreenshot` 前先隐藏，结束后恢复。Overlay 失败不使业务动作失败。

`humanInput` 默认开启，设置名为“像真人一样移动鼠标、打字”。`extension/human-input.ts` 只计算落点、曲线和时长，执行器负责派发。用途是按真实用户的节奏输入，兼容依赖悬停、按住、拖拽时序的页面：

- 鼠标落点在可见范围内适当偏离中心，沿变速曲线移动；偏移会命中其他控件时退回中心。点击包含悬停停顿和按住时间，拖拽也有起止停顿。
- 字段尚未聚焦时先尝试点击。`fill` 全选后替换；`type` 保留已有焦点与选区，刚点进字段时才按需移动到末尾，因此全选后 `type` 是替换。
- 不超过 64 字符且时间足够的 US 键盘文本逐键输入。需要输入法的文本、长文本或显式 `inputMode:"insertText"` 仍整段插入。滚轮拆成多格，中间停顿。
- 关闭后省去上述轨迹与节奏。按下事件的 `force:0.5`、`press` 和逐键输入的修饰键实际按下/松开，不受开关影响。

这会增加耗时，每次点击约多 0.4–1 秒，短文本输入也可能需要数秒。网页能观察 DOM 和输入事件，不承诺无法识别自动化。

### 能力协商与更新

能力名的唯一事实源是 `src/shared.ts` 的 `CAPABILITY`。扩展握手声明能力，服务在 `ready` 中公布自身能力。服务按请求需要检查能力，缺少时在派发前返回 `EXTENSION_UPDATE_REQUIRED`；扩展不满足服务要求时返回 `SERVICE_UPDATE_REQUIRED`。新增参数不能让旧扩展静默忽略后按另一种语义执行。

例如，`locator.inside` 和 `state:"attached"` 需要扩展 0.3.26 及以上、能力 `interaction-v10`。旧扩展收到这些请求会报需要更新，不派发。`initScript` 使用 `init-script-v1`；其他工具的能力要求见[交互说明](interaction.md)。

自更新只适用于“加载已解压的扩展程序”的安装方式。Chrome 应用商店版用 `scripts/build-extension.mjs --store` 构建：`extension/build-target.ts` 换成 `STORE_BUILD=true`，`self-update.ts` 换成不下载、不写文件的 `self-update-store.ts`，握手声明 `store-build` 代替 `self-update-v1`，由商店更新。Windows 本机设置入口的允许名单除了按文件夹路径算出的扩展 ID，还包括 `STORE_EXTENSION_IDS` 里登记的商店 ID。上架步骤见 [Chrome 应用商店上架](chrome-web-store.md)。

手动加载的自更新在设置页标签中进行，使用 File System Access API：

1. 服务通过配对鉴权的 `/extension/update` 返回版本、包哈希及绑定本次随机数的 HMAC 证明。扩展验证证明和下载包的 SHA-256，不只相信版本提示。
2. 用户选择并允许编辑扩展文件夹。扩展写入随机文件，再从自己的扩展地址读取，确认选中的是 Chrome 正在加载的目录，而不是内容相同的副本。
3. 先备份待覆盖内容，逐文件写入，`manifest.json` 最后写。失败时恢复已写文件；恢复也失败会明确提示手工修复。
4. 写完调用 `chrome.runtime.reload()`。文件夹句柄保存在 IndexedDB，但后续仍可能需要一次点击手势重新授权。磁盘文件已经更新时可只重载，不必重新选目录。

更新只升不降，服务回滚不会自动降级扩展。桥接握手不直接发送配对密钥，但 `/extension/*` 的配对鉴权请求会使用 Bearer；在明文 HTTP 上仍依赖可信内网假设。

多个 Chrome 配置共用扩展文件夹时，manifest 可能已经更新，后台却仍运行旧代码。后台比较 manifest 与编译进去的 `VERSION`，发现前者更新时自动重载一次；`staleReload` 记录同一版本组合，避免循环。握手同时带 `codeVersion`，服务可通过 `chrome_profiles` 的 `extensionReload` 和管理页提示要求重新加载。

## 文件读写边界

本机 Agent 能读写哪些文件，由它自己的 harness 决定，例如权限提示或沙箱。SaltedFish 不再另设目录白名单。这一设计以 `/mcp` 只接受本机连接为前提；服务不会替调用方的 harness 提供操作系统级路径隔离。

对非管理员的路径请求，服务额外保护两类位置：

- SaltedFish 自身数据目录，以及 npm 安装 home。它们含配置、管理员凭据和配对密钥，不能经受限接口读取或覆盖。
- Windows 网络共享（UNC）和设备路径。原始共享路径在任何文件系统访问前拒绝；解析后还会再次检查，防止映射或链接落到共享。

比对使用 `realpath` 解析符号链接、目录联接、短文件名和相对跳转。上传须为存在的本机绝对路径、普通文件；输出的父目录必须已存在。拒绝返回 `UPLOAD_PATH_NOT_ALLOWED` 或 `OUTPUT_PATH_NOT_ALLOWED`，不派发业务动作。

`chrome_upload`、批次 `page.upload`、原始 CDP 的 `DOM.setFileInputFiles` / `Input.dispatchDragEvent`、`savePath`、同机下载导出及可选助手读下载共用路径策略，不能换工具绕过。非管理员响应隐藏 SaltedFish 数据目录路径，结果引用使用 `artifactId` 和文件名；下载位置等其他路径照常返回。

浏览器和服务同机时，上传可把已检查的真实路径交给 Chrome，不受内容传送大小上限限制。跨机器浏览器使用内容传送，单文件最多 100 MiB、每批最多 256 MiB。`uploadByPath:"never"` 可强制使用内容传送。可选 Windows 本机助手只按明确请求读取浏览器电脑上的下载文件，不承担浏览器命令中转。

## 安装、升级与客户端接入

主分发入口是公共 npm：`npm install -g saltedfish`。安装命令本身不启动服务或改写客户端配置。npm 全局目录提供管理命令；固定 launcher 从安装 home 的 `active.json` 选择不可变版本快照，运行数据与版本分离。

`saltedfish upgrade` 先用当前 Node 附带的 npm 下载新包，再由新包完成切换。下载不等于切换运行版本：切换前检查文件与忙状态，失败回退。`saltedfish rollback` 只允许切到能理解当前数据格式的版本，不恢复旧授权快照。显式停止标记阻止 MCP 自动拉起服务。

安装管理使用独立 SQLite 互斥，进程退出后由系统释放。升级、回滚和恢复另记维护阶段；`recover-lock` 根据活动版本和只读数据格式检查决定回退或向前完成。若状态损坏或无法安全判定，拒绝继续，不能用旧库覆盖。后台工作进程有随机令牌鉴权的私有回环控制口，管理操作同时核对安装和进程身份，不只按进程号结束进程。

Windows 可选独立包自带 Node、生产依赖和 .NET 启动器，稳定入口选择独立版本目录。升级、回滚保留数据、撤销状态与未知操作记录；卸载先检查占用再移除程序，保留数据。文件校验只能发现损坏，不能代替发布者签名。

客户端能力清单集中在 `src/client-types.ts`。接入复用检测、独立凭据、真实 MCP 预检、备份、局部合并和恢复：

- JSONC/TOML 修改尽量保留其他配置与注释。坏配置、重复键、预览后变化或恢复时哈希不符都会拒绝覆盖。
- 完整配置备份只保存在受保护的数据目录，不进入日志、模型或页面响应。
- 支持的客户端可显式设服务级信任，默认保留原审批；不会取消客户端自身的权限机制。
- Linux npm 的用户级接入优先使用 HTTP；项目配置不写入独立令牌，继续使用本地入口。HTTP 不能替 Agent 自动启动服务，Linux 可选 systemd 开机启动入口只在开机时拉起一次服务。
- 只支持 stdio 的客户端可用 `mcp-bridge` 转发到同机 `/mcp`。它转发 MCP 帧，不读取管理员凭据、不初始化本机服务、不重试失败 POST；初始化通知完成后才转发业务请求，退出时尝试结束 HTTP 会话。它不能绕过 `MCP_LOCAL_ONLY`。

客户端配置细节见[支持的客户端](supported-clients.md)、[客户端兼容性](client-compatibility.md)和[一次信任](once-trust.md)。

## 代码导航

以下路径均相对仓库根目录。表中列出当前主架构涉及的模块，不展开旧安装兼容实现。

| 路径 | 职责 |
| --- | --- |
| `src/cli.ts`、`src/mcp.ts`、`src/mcp-http.ts` | CLI、stdio MCP 工具工厂、HTTP MCP 会话与同机准入 |
| `src/http-server.ts`、`src/auth.ts` | HTTP/WS 路由、来源检查、桥接鉴权、管理页会话 |
| `src/browser-pairings.ts`、`src/browser-connection.ts` | 独立浏览器配对持久化、连接身份辅助逻辑 |
| `src/service.ts`、`src/tools.ts` | 工具执行、权限与能力检查、输出封装；工具 schema 来源 |
| `src/broker.ts`、`src/state-store.ts` | 连接代际、请求、租约与互斥；SQLite 授权、操作、任务与结果元数据 |
| `src/shared.ts`、`src/version.ts` | 跨层类型、错误阶段、能力名与版本常量 |
| `src/config.ts`、`src/service-config.ts`、`src/service-network.ts`、`src/install-network.ts` | 配置解析、监听与 TLS 配置、安装时网络选择 |
| `src/agent-presence.ts`、`src/agent-groups.ts` | 会话与使用状态；标签组通知和对账 |
| `src/interaction-policy.ts` | 服务焦点模拟和扩展视觉队列共用的操作分类 |
| `src/upload-policy.ts`、`src/output-files.ts`、`src/browser-upload.ts` | 路径保护、输出文件、跨机器上传准备 |
| `src/file-transfer.ts`、`src/file-transfer-tools.ts`、`src/native-files.ts` | 文件传送与显式下载文件读取 |
| `src/result-reader.ts`、`src/observations.ts` | 大结果有界分页、无障碍树与事件摘要 |
| `src/tasks.ts`、`src/task-program.ts`、`src/task-limits.ts` | 配置队列、任务控制流、计划展开与预算 |
| `src/workflow-store.ts`、`src/recovery.ts`、`src/page-jobs.ts` | 流程版本与归档、恢复建议、显式页面后台作业 |
| `src/client-types.ts`、`src/client-paths.ts` | 客户端能力清单、配置位置与优先级 |
| `src/client-setup.ts`、`src/client-config.ts`、`src/client-document.ts`、`src/codex-config.ts` | 接入预览、局部合并、备份与恢复、配置格式判定 |
| `src/client-credentials.ts`、`src/client-permissions.ts`、`src/client-connect.ts`、`src/client-launch.ts` | 独立凭据、宿主审批规则、接入命令与启动入口 |
| `src/mcp-bridge.ts` | 同机 stdio → HTTP MCP 帧转发 |
| `src/npm-cli.ts`、`src/npm-runtime.ts`、`src/npm-worker.ts`、`src/npm-update.ts` | npm 管理命令、home 与版本快照、私有控制口、下载升级 |
| `src/management-lock.ts`、`src/state-compatibility.ts`、`src/autostart.ts` | 安装互斥、只读格式探测、Linux 开机启动 |
| `src/extension-download.ts`、`src/zip.ts` | 生成带服务地址但不含配对密钥的扩展 ZIP |
| `extension/background.ts`、`extension/bridge-auth.ts`、`extension/options.ts`、`extension/service-probe.ts` | 扩展身份与连接、握手、设置页、打开管理页前的连接检查 |
| `extension/executor.ts`、`extension/window-lock.ts` | Chrome API/CDP 执行与同窗口视觉队列 |
| `extension/page-runtime.ts`、`extension/page-functions.ts`、`extension/isolated-runtime.ts` | 页面语义逻辑、调用表达式、隔离上下文缓存 |
| `extension/input-target.ts`、`extension/text-input.ts`、`extension/keyboard.ts`、`extension/pointer-actions.ts` | 输入前复查、文本、键位与指针输入 |
| `extension/frame-point.ts`、`extension/frame-geometry.ts`、`extension/navigation.ts`、`extension/init-script.ts`、`extension/dialogs.ts` | frame 坐标与遮挡、导航完成观察、新文档脚本、弹窗策略 |
| `extension/tab-groups.ts`、`extension/background-popups.ts` | 会话标签组、后台页面打开新标签页时的前台恢复 |
| `extension/agent-cursor.ts`、`extension/human-input.ts`、`extension/page-change.ts` | Overlay 提示、输入轨迹与节奏、动作后的页面变化 |
| `extension/download-tabs.ts`、`extension/upload-content.ts`、`extension/self-update.ts` | 下载来源匹配、上传内容、手动加载扩展的自更新 |
| `ui/` | 管理页入口、导航、Agent 与浏览器连接、操作记录、任务和流程编辑 |
| `packaging/`、`scripts/` | 可选独立包启动与安装、构建与分发脚本 |

管理页静态资源由 `src/http-server.ts` 的白名单提供，向 `ui/` 新增文件时需同步登记。新增工具或参数应同步考虑 schema、服务执行、扩展路由、权限标注、能力检查和行为测试。测试方法见 [docs/testing.md](testing.md)，贡献约定见 [CONTRIBUTING.md](../CONTRIBUTING.md)。
