# 浏览器工具语义

本文面向编写 Agent 提示词、排查工具结果和阅读实现的使用者与贡献者。说明当前浏览器工具的定位、输入、等待、结果和安全边界，不是网站业务流程教程。

工具参数以 MCP 工具目录的 schema 为准。下文动作示例只列动作参数；实际调用还须传入明确的 `profileId`、`tabId`。参数校验错误按“字段路径: 说明”返回，多条用分号分隔；未知字段会被拒绝。

`chrome_save_result`、`chrome_keep_tab` 和任务、流程工具属于高级工具目录。需要在管理页启用高级工具并重新连接客户端；目录开关不是授权开关。

## 目标与身份

### 配置、标签页与 frame

- 先用 `chrome_profiles` 确认配置名称和 `online`，再用 `chrome_tabs` 选择标签页。页面操作绑定 `profileId + tabId`，不会退回第一个配置或当前活动标签页。
- `profileId` 表示 Chrome 配置，不是网站账号认证。同一配置内的窗口共用登录态；不同配置应分别确认。目标离线时，不换另一个配置代替。
- 用 `chrome_contexts` 获取 iframe 的 `contextId`、`sessionId`，再传给支持 frame 的操作。引用只对原文档和原 frame 有效。上下文失效返回 `STALE_CONTEXT`；子会话失效或不属于该标签页返回 `UNKNOWN_FRAME`，不会猜测坐标。
- 子会话只登记页面类目标，如跨进程 iframe；worker 不作为可操作页面列出。拖拽起终点必须处于同一 frame 上下文。
- 一次操作绑定同一条浏览器连接。断线重连后，不把剩余步骤发给新连接，也不复用旧标签页身份继续执行。

### 标签组与写操作范围

MCP 会话第一次 `chrome_new_tab` 或 `chrome_claim_tab` 时建立自己的标签组。新标签页默认后台打开；会话已有组时，默认沿用组所在的窗口。

写操作只能作用于本会话新建、接管的标签页及其打开的链接或弹窗。已有标签页先用 `chrome_claim_tab` 接管；否则返回 `TAB_OUTSIDE_GROUP`。读取不受标签组范围限制，但仍受配置授权和管理页保护限制。

- 别的活动会话组里的标签页不能写入或接管。组范围检查拒绝写入时返回 `TAB_OUTSIDE_GROUP`；接管或占用冲突返回 `TAB_CLAIMED`。
- 用户把标签页拖出 Agent 组，视为收回，返回 `TAB_TAKEN_BACK`。不要再次接管；可请用户拖回原组，或新建标签页。仅把其他标签页拖入组里不算授权。
- 固定标签页、用户自己组里的标签页和不能分组的窗口不会被强行移动；接管后通过占用协调。未能进组时可带 `TAB_NOT_GROUPED` 警告。
- `chrome_release_tab` 释放占用。会话结束时解散组，标签页保留，接管来的标签页放回原位，相关占用解除。

标签组是多 Agent 的协调边界，不是安全沙箱。任务队列和普通 RPC 不使用 MCP 会话的标签组生命周期；配置授权、占用和结果未知保护仍独立生效。

### 断线后接回标签页

同一 Agent（同一份客户端凭据）重连并建立新 MCP 会话后，写原会话标签页时可以自动接回，结果带 `TAB_REJOINED` 警告。须同时满足：

1. 原会话已经结束，不能抢同一 Agent 的另一个活动会话。
2. 标签页仍在原来的同源网站。
3. 标签页没有进入用户自己的组，没有其他会话的组或有效占用。
4. 扩展仍保留原会话记录。

记录存于 `chrome.storage.session`，保留 24 小时、最多 32 个已结束会话。浏览器重启或扩展重载会清空。管理页主动“结束并释放”不保留自动接回记录。不满足条件时返回 `TAB_OUTSIDE_GROUP` 并解释原因；核对后可显式 `chrome_claim_tab`。自动接回不扩大原有授权。

## 定位与读取元素

### 定位参数

多数元素操作接受 `selector`、`ref`、`locator` 三选一，不接受它们与指针坐标混用。

| 参数 | 含义 |
| --- | --- |
| `selector` | CSS 选择器，定位目标本身；多个匹配通常拒绝执行 |
| `ref` | 最近 `chrome_find` 或 `chrome_inspect` 返回的元素引用；导航、刷新或缓存淘汰后可能失效 |
| `locator` | 语义条件，可组合 `role`、`name`、`label`、`placeholder`、`text`、`testId` |
| `locator.exact` | 默认 `true`；`false` 为不区分大小写的包含匹配 |
| `locator.nth` | 按文档顺序取第几个，0 起，最大 999；结果带 `matchedBeforeNth` |
| `locator.inside` | CSS 范围，可匹配多个根，只在这些根及其后代中找；仍须提供至少一个语义条件 |
| `scopeSelector` / `scopeRef` | `chrome_inspect`、`chrome_find` 的观察范围，二选一；`scopeSelector` 要求唯一根，`scopeRef` 使用已有引用 |

可访问名称按 AccName 算法计算。定位的文字、名称、标签和占位符比较时合并空白，并按 NFKC 归一化；全角与半角兼容字符可匹配，返回原文不变。`testId` 对应 `data-testid`。

`locator.text` 只保留最贴近文字的那一层，不同时返回包含它的外层容器。多个匹配不要猜：先收窄范围或获取候选，再使用 `ref`、`nth`。`AMBIGUOUS_SELECTOR`、`AMBIGUOUS_SCOPE` 的消息最多列出 5 个候选，结构化信息在 `detail.candidates`、`detail.total`。

`chrome_find` 必须提供 `locator`；其 `selector` 是 `locator.inside` 的简写，不是独立目标定位。`selector` 与 `locator.inside` 同时提供返回 `INVALID_ARGUMENT`。`inside` 未匹配任何根时，查找结果带 `insideMatched:0`；动作的 `ELEMENT_NOT_FOUND` 也会说明范围为空。无效 CSS 返回 `INVALID_SELECTOR`。

`chrome_find` 是即时读取，没有目标就返回空，不等候选出现。`chrome_action` 默认 `autoWait:true`，只在首次输入前等待目标就绪；`autoWait:false` 立即检查。已经派发输入后不自动重试。

```json
{"action":"click","locator":{"text":"选择","inside":".suggestions"}}
```

`inside` 可用于所有接受 `locator` 的位置，包括拖拽终点 `to.locator`、上传、截图、等待、批次步骤和后置条件。需要扩展 0.3.26 及以上，能力 `interaction-v10`。

### 读取结果与上下文

`chrome_inspect` 返回页面文字、元素引用、值、勾选、选择和只读状态。省略 `visible`、`disabled`、`readOnly` 时，分别表示可见、可用、可写。密码和常见敏感字段脱敏。

- `scopeSelector`、`scopeRef` 范围包含其 open Shadow DOM。范围本身是控件时，即使隐藏也会列出，例如隐藏文件框。
- 文件框带 `fileCount`、`fileNames`、`fileSizes`。多选下拉带选中项信息；富文本返回编辑器纯文本。
- `valueLimit` 默认 256，最多 4000。被截断的值带 `valueTruncated`，部分结果另带 `valueLength`。
- `sinceSnapshot` 请求增量；基线失效、范围改变或文档变化时返回 `mode:"full"`，不把不同范围混作增量。增量结果可带 `removedRefs`、`unchanged`。

`chrome_find` 的每个元素带 `box:[x,y,width,height]`，单位是视口 CSS 像素。存在可操作子元素时带 `controls`，最多计数 100；`chrome_inspect` 仅在至少 2 个时带该字段。

查找结果还可能带：

| 字段 | 含义 |
| --- | --- |
| `within:{role,name,ref}` | 最近的对话框、列表框、菜单或文本编辑器等语义容器；可把 `within.ref` 用作 `scopeRef` |
| `layer:"overlay"` | 无相应语义角色，但处于符合规则的固定或绝对定位浮层；盖住大部分视口的布局不算 |
| `context` | 按文字找到多个元素时的附近文字；最多向上 4 层寻找，截到 40 字以内 |

这些字段是定位线索，不保证识别所有自定义浮层。没有角色的页面控件不会被补写角色。

### 可见性、遮挡与容器

查找、检查、动作前检查、结构化等待和 `pageChange` 使用统一可见性规则：元素已渲染、尺寸非零、不是隐藏状态，自己和祖先不完全透明，不在收起的 `<details>` 或隐藏内容中。

正在运行的 CSS 动画、过渡按结束时的透明度和 `visibility` 判断。后台页面可能停在动画第一帧；淡入按可见处理，淡出按已消失处理。这不是截图像素证明，也不代表落点没有遮挡。

`ELEMENT_NOT_VISIBLE` 可带 `detail.reason`、导致隐藏的 `detail.node` 和最近可见祖先 `detail.nearestVisible`。后者包含 `ref`、`selector`、`role`、`name`、`box`。

| `detail.reason` | 含义 |
| --- | --- |
| `display_none` | 自己或祖先 `display:none` |
| `collapsed` | 位于收起的 `<details>` 中 |
| `content_hidden` | 祖先 `content-visibility:hidden` |
| `not_rendered` | 没有渲染框，如 `display:contents` |
| `visibility_hidden` | `visibility:hidden` |
| `transparent` | 自己或祖先透明，且没有在淡入 |
| `empty_box` | 宽或高为 0 |
| `outside_viewport` | 滚动后仍在视口外 |
| `clipped` | 被祖先的 `overflow` 裁掉 |

指针动作还验证 frame 几何、落点命中、遮挡和稳定性。遮挡返回 `ELEMENT_OBSCURED`，`detail.cover` 说明遮挡元素；`pointer-events:none` 会单独说明。加载遮罩可能短暂存在，默认等待就绪，不一发现遮挡就立即失败。

点击或双击一组选项的容器，若落点会选中其中一项且至少有两个可见选项，返回 `CONTAINER_TARGET`、未派发。请定位具体选项，或使用 `choose`。其他可点击容器的结果可能带 `landedOn`，说明实际落在哪个子控件。

### 样式化 checkbox 与 radio

透明原生 checkbox、radio 有非零尺寸，且关联 label 或相邻 label 内有覆盖中心的可见背景、边框皮肤时，可以被查找并按原生输入点击。结果带 `painted:false`、`visualProxy:"label-skin"`；这里的可见表示有交互外观，不是 input 本身绘制了像素。

皮肤搜索最多 4 个关联 label、1 个相邻 label，合计 32 个元素。点击仍须命中 input，检查禁用、inert、frame 和遮挡；不会转为 label 点击或 JavaScript `click()`。零尺寸、纯伪元素皮肤、远离控件的 label 不在此规则内。

定位 label 或其文字时，透明 input 覆盖文字、且落点确实属于同一控件，可以放行。定位 input 本身仍须命中它。无法命中复选框文字时，错误可能建议用该 input 的 `ref` 执行 `setChecked`。

## 动作与输入

### 指针、勾选、拖拽与滚动

| `chrome_action.action` | 语义 |
| --- | --- |
| `click` / `doubleClick` | 元素定位或视口 `x/y`；按坐标点击时可带 `hit`，说明按下前落点上的顶层元素 |
| `hover` | 移到元素或坐标，允许目标被禁用 |
| `setChecked` | 指定 `checked`；已经满足时不点击，改变后核验；radio 不能通过点击取消 |
| `drag` | 起点和 `to` 各用元素定位或坐标；共用源 `contextId/sessionId`，不跨 frame |
| `scroll` | 在元素中心或 `x/y` 发滚轮；不指定位置时为视口原点；允许禁用的滚动容器 |
| `select` | 原生 `<select>` 使用 `values` 按选项 value 选择，不按显示文字匹配 |
| `choose` | 自定义下拉触发器使用 `option` 选择文字 |

```json
{"action":"doubleClick","selector":".filename"}
{"action":"setChecked","selector":"#agree","checked":true}
{"action":"drag","selector":"#card","to":{"selector":"#column"},"steps":12,"durationMs":300}
```

`drag.steps` 为 2–100，`durationMs` 为 0–10000，计入操作期限。失败时释放按住的指针；已发出的事件不回滚、不重放。

`scroll` 的元素定位与 `x/y` 二选一。`deltaX`、`deltaY` 都省略时纵向滚 600；只给一个时另一个为 0。结果带 `scrolled`、实际 `x/y`、`deltaX`、`deltaY`。

`modifiers` 是位标志：Alt=1、Ctrl=2、Meta=4、Shift=8。支持 `click`、`doubleClick`、`drag`、`hover`、`scroll`、`press`，结果按适用路径回显。鼠标动作将标志放进每个鼠标事件，不单独派发修饰键的键盘事件；依赖键盘事件的页面使用 `press`。`fill`、`type`、`select` 等不支持非零 `modifiers`。

`hit` 只用于未指定 frame 的顶层坐标点击、双击，含 `ref`、`selector`，以及可用的 `role`、`name` 或短文字。按元素定位的点击不带它。

### 自定义下拉 `choose`

```json
{"action":"choose","locator":{"role":"combobox","name":"分类"},"option":"知识"}
```

先点开触发器；已有 `aria-expanded=true` 时不再点。查找触发器外可见的候选，先找文字完全相同的，再找包含匹配；优先 option、menuitem 等角色和新出现的选项。选中后读取触发器文字或其中 input 的值，确认包含目标，成功返回 `chosen`、`triggerText`、`verified:true`。

触发器有 `aria-controls`、`aria-owns` 时只在其指向的弹层中找。没有关联且本次点开下拉时，只认点开后出现的候选；下拉原本已展开又没有 ARIA 关联时，无法用“新出现”收窄，应先确认页面结构和候选。

- 原生 `<select>` 在点击前返回 `NOT_CUSTOM_DROPDOWN`；改用 `select`。
- 选项未在等待期限内出现：`OPTION_NOT_FOUND`，消息列出可见选项。
- 有多个同样贴近的选项：`AMBIGUOUS_OPTION`，带候选。
- 点击后读不回选择：`CHOICE_NOT_CONFIRMED`。

如果已经点开或操作了下拉，失败按 `outcome:"dispatched"` 返回。标签页仍可写，但不要重复整个动作；先核对，必要时按 Esc 收起下拉。

### 文本输入模式

| 调用 | 语义 |
| --- | --- |
| `fill`，`fillMode:"auto"`（默认） | 文本、textarea、contenteditable 使用浏览器编辑，替换全部内容并核验；日期等特殊字段回退直接设值 |
| `fillMode:"input"` | 强制浏览器编辑；不支持的字段返回 `EDIT_MODE_UNSUPPORTED`；支持撤销，`change` 随正常失焦发生 |
| `fillMode:"setValue"` | 直接设置 value、textContent，派发合成 `input/change`，随后回读核验 |
| `type`，省略 `inputMode` | 按拟人输入设置选择逐键或整段插入；保留已有焦点字段的选择区 |
| `inputMode:"insertText"` | 在当前选择区一次插入 Unicode 文本，不表示逐键输入 |
| `inputMode:"keySequence"` | US 键位逐键输入，最多 2000 个可打印 ASCII 字符；特殊键用 `press` |
| `inputMode:"composition"` | 按 `compositionUpdates` 发送组合阶段，再提交 `text`；`compositionCommit:false` 取消 |
| `inputMode:"paste"` | 派发携带提供文本的合成 `paste`；页面接管则交给页面，否则用 `insertText`；不读写系统剪贴板 |

`selection:{start,end}` 只用于 `type`，采用 UTF-16 偏移；contenteditable 按 `textContent` 定位。`fill` 总是替换全部内容。`press` 与逐键输入共用 US 键位映射；不支持的键在输入前返回 `UNSUPPORTED_KEY`。

`fill` 成功表示最终值核验通过，带 `verified:true`。页面取消或改写值时返回 `EDIT_NOT_APPLIED`，保留结果未知保护；`setValue` 也不例外。多行换行和富文本比较规则见下节；其他格式转换不能直接当成已经按请求填写成功。

`type` 不将请求文字与最终值比较，结果中的字段须分别理解：

| 字段 | 含义 |
| --- | --- |
| `requestedCharacters` | 请求文字长度，不是页面接受的字符数 |
| `dispatched:true` | 输入已派发，不等于业务处理成功 |
| `mode` | 实际输入模式，如 `keySequence` |
| `verification:"not_checked"` | 未做目标值相等核验 |
| `focusVerified` | 派发后是否仍能确认原目标持有焦点且可编辑 |
| `value` | 派发后可读到的字段内容，最多 256 字；编辑器可能已改写文字 |
| `valueTruncated` / `valueLength` | 内容截断及原长度 |
| `valueRedacted:true` | 密码等敏感字段不回传值 |

粘贴被页面接管时可直接返回 `handledByPage:true`，不保证具有上表所有字段。应通过 `chrome_inspect`、`chrome_wait` 或 `postcondition` 核对应用结果，而不是根据派发数量推断成功。

### 富文本与事件边界

contenteditable 编辑根未显式写 role 时按 `textbox` 处理，可用 `locator:{role:"textbox"}` 查找。`pageChange` 同样按 textbox 列出。

多行字段将 CRLF、CR 规范为 LF。富文本的值和核验采用编辑行纯文本：块之间换行，行尾维护光标的占位 `br` 不计正文，NBSP 按空格比较，连续空行保留。纯文本核验不代表精确 HTML、样式、编辑器内部模型或服务端已经保存；有这些要求时另行读取和等待。

`select`、直接设值、合成粘贴与浏览器组合输入保留各自实际事件语义，不等同于物理键盘、操作系统输入法或真实剪贴板。合成 `input` 可跨 open Shadow DOM，`change` 不跨边界；不改写事件的 `isTrusted`。

### 拟人输入、指针与焦点

扩展设置“像真人一样移动鼠标、打字”（`humanInput`）默认开启。用途是按真实用户节奏输入，兼容依赖悬停、按住和拖拽时序的页面。

- 鼠标沿变速曲线移动，在元素可见区域内选择偏离中心并对齐设备像素的落点。若偏移会点到别的控件或选项，则退回中心。
- 点击前停顿，按住几十毫秒；`click` 的 `holdMs` 可显式指定 0–10000 毫秒。
- `fill`、`type` 在字段没有焦点时先鼠标点击。`fill` 再全选；富文本为避免空段落差异仍用脚本选择。
- 默认短文本在不超过 64 字符、US 键盘可输入且剩余期限足够时逐键输入。中文、长文本或不适用的内容整段插入。显式 `inputMode:"insertText"` 的 `type` 不改成逐键。
- `type` 仅在执行器刚点进字段时视需要按 End；字段原来已有焦点时不改选区。因此先 `press` 全选再 `type` 是替换，不是追加。
- 拖拽使用曲线和停顿；滚轮按约 100 的分格拆开。未指定滚动位置时仍使用视口原点。
- 无论开关如何，按下、按住移动携带 `force:0.5`；`press`、逐键输入的修饰键先按下、后松开。

开启后每次点击通常多 0.4–1 秒，短字段逐键填写可达数秒。可在扩展设置关闭；显式输入模式仍按其语义执行。

焦点和移动错误必须结合派发阶段判断：

- 输入前及逐键、组合输入的各步之间，复查原文档、引用、焦点和可编辑性。变化则停止剩余输入，返回 `FOCUS_CHANGED` 或 `NOT_EDITABLE`；不把焦点抢回。已经送出的字符可能生效。
- 派发后页面主动跳到下一格、禁用字段或移走焦点，不单独判失败。`fill` 值核验通过即可成功，可能带 `focusVerified:false`；`type` 如实报告焦点和可读到的值，不因 `false` 自动重输。
- 悬停使同一元素移动时，执行器可等待停稳并跟随，最多 3 次、总计约 1.5 秒。仍不稳定或元素变化则在按下前返回 `ELEMENT_MOVED`、`not_dispatched`。
- 按住期间再次复核目标。目标移动超过约 4 CSS 像素或无法继续安全命中时，在目标外释放，避免迟到的点击。此时已按下，不能按未派发处理。

同窗口视觉操作进入窗口队列，不同窗口可以并行。标签页互斥、占用和窗口队列保护不同竞态。异常路径尽量释放按键和鼠标，但分离的 CDP 调用不是原子事务。

## 结果、核对与恢复

### `outcome` 与不重放

失败响应的 `outcome` 描述此次操作的派发结果，不是业务是否成功。

| `outcome` | 含义 | 调用方处理 |
| --- | --- | --- |
| `not_dispatched` | 此步未派发业务输入，确定未开始执行该动作 | 排除阻碍、核对目标后可重试；不代表页面连悬停等准备性变化都没有 |
| `dispatched` | 动作已经执行，但选择确认或后置检查未通过 | 标签页通常仍可写；先核对，不重复动作 |
| `unknown` | 无法确认动作最终结果，可能部分或全部生效 | 暂停相关写入，先核对实际页面，再显式恢复 |

不要只凭错误码判断能否重试。同一错误可因发生阶段不同具有不同 `outcome`。批次中某一步未派发，不代表整批未执行；已完成步骤保留。

典型派发前拒绝包括：`EXTENSION_UPDATE_REQUIRED`、`ADMIN_PAGE_PROTECTED`、`TAB_OUTSIDE_GROUP`、`WINDOW_BUSY`、`TAB_BUSY`、`NO_VIEWPORT`、参数或定位错误，以及业务命令发出前的 `CANCELLED`、`DEADLINE_EXCEEDED`、`PROFILE_OFFLINE`、`CONNECTION_CHANGED`、`OPERATION_JOURNAL_FAILED`。

`RESULT_UNKNOWN`、`OPERATION_PENDING` 拒绝的是本次新调用，按 `not_dispatched` 返回；旧操作的保护仍在，不因新调用被拒绝而解除。`NAVIGATION_FAILED` 只有能证明失败导航没有经过重定向时才按未派发处理；证据不足仍为 `unknown`。

超时、断线、`SCRIPT_TIMEOUT`、`OPERATION_HUNG` 只表示停止等待，不保证页面里的异步工作也停了。不得自动重放提交、付款、上传或其他业务动作。

错误消息最多 8000 字，超出会标记截断。扩展回传结果帧不合格时，只让对应命令以 `INVALID_RESULT_FRAME`、结果未知失败，不关闭整条已鉴权连接。

### 暂停写入时核对

结果未知会保留在持久操作记录中，并阻止相关重复写入。核对可使用：

- `chrome_inspect`、`chrome_find`、截图和其他仍获授权的只读观察。
- 结构化 `chrome_wait`，如元素、文字和 URL 条件。
- 带 `readOnly:true` 的 `chrome_evaluate`、表达式 `chrome_wait`。
- `chrome_operations` 查询记录，`acknowledged:false` 查未核对项。

读取不会解除保护。确认页面、下载或业务结果后，用 `chrome_recover_tab` 或 `chrome_recover_operation`（`acknowledged:true`）显式确认；它们不重放原操作。仍有操作执行时不能恢复，占用属于别人时返回 `TAB_CLAIMED`。

`readOnly:true` 是 Chrome 副作用检查的请求参数，不是客户端授权。只读授权的客户端仍不能调用原本具有脚本执行权限的 `chrome_evaluate`、`chrome_wait` 工具。

日志写入分两个阶段：业务命令前无法写日志，则拒绝且未派发；业务完成后的日志落盘失败，则保留业务结果并附 `OPERATION_JOURNAL_FAILED` 警告。不要为补日志重跑动作；修复存储、重启服务并核对后再恢复。

### `pageChange`

`chrome_action`（滚动除外）和 `chrome_batch` 默认观察动作前后的页面变化，`observe:false` 可关闭。摘要约 600 字节，不是完整快照。

| 字段 | 含义 |
| --- | --- |
| `changed` | 观察期间是否看到变化；`false` 不等于动作无效，可带 `waitedMs` |
| `added` / `moreText` | 新文字及未放入摘要的条数 |
| `updated` / `moreUpdated` | 已有控件的值、勾选、展开、禁用、名称等变化，带 `ref`、`name`；敏感值脱敏 |
| `elements` / `moreElements` | 新出现或由隐藏转可见的控件，可直接用其引用操作 |
| `removedText` | 消失文字条数 |
| `url` / `title` | 改变后才带 |
| `navigated` / `loading` | 文档变化、仍在加载 |

观察会短暂等待页面安静，最多约 0.8 秒；慢请求另用结构化等待或网络等待。观察读取不占窗口视觉队列；读取失败只少这段摘要，不把业务动作判失败。原生弹窗中断时，摘要由 `chrome_dialog` 答完后读取。队列任务不做这种面向即时调用方的观察。

### 后置条件

`chrome_action` 以及批次、任务的页面步骤可带 `postcondition`。结构与等待条件一致，但不接受任意 JavaScript。默认继承动作 frame，可显式指定检查 frame。

```json
{"action":"click","selector":"#submit","postcondition":{"urlContains":"/complete","stableMs":200,"timeoutMs":10000}}
```

默认立即检查；未满足时按约 100 毫秒间隔有限等待。`stableMs` 默认 0，可要求连续满足，最长 10000 毫秒。`postcondition.timeoutMs` 默认 10000、范围 100–120000，并受动作、批次或任务步骤的剩余期限约束，不会在动作期限之外另加等待。

满足后 `postcondition` 带 `matched`、`url`、`title`；受保护管理页不回传地址和标题。未满足返回 `POSTCONDITION_TIMEOUT` 或检查错误，`outcome:"dispatched"`：动作做完了，不重复，标签页仍可写。单步动作的原结果在 `detail.action`；批次失败步骤的结果在 `failedStep.result`。

任务队列没有即时调用方核对，此类失败仍停在 `needs_review`。`fileCount` 只证明文件已选入 input；上传完成、转码、预览和业务保存须用对应页面条件另行确认。

## 等待与事件

### 结构化条件

`chrome_wait` 可按元素、文字、URL 或表达式等待。优先使用结构化条件，不让模型逐次读取、睡眠再重试。

| 条件 | 语义 |
| --- | --- |
| `state:"visible"` | 默认状态，元素可见 |
| `state:"hidden"` | 元素隐藏，或纯隐藏等待中的元素已不存在 |
| `state:"attached"` | 元素仍在 DOM；不要求可见，须提供元素定位 |
| `state:"enabled"` / `"disabled"` / `"editable"` | 要求元素可见，再核对可用、禁用或可编辑状态 |
| `state:"checked"` / `"unchecked"` | 只核对存在控件的勾选状态，隐藏控件也参与；ARIA `mixed`、缺省均不算 unchecked |
| `valueEquals` | 字段值相等 |
| `textContains` | 页面或目标元素文字包含，合并空白并按 NFKC 比较 |
| `textMatches` | JavaScript 正则源码，不带斜杠或标志；先试合并空白文字，再试 NFKC 文字，正则自身不归一化 |
| `urlContains` | 当前网址包含指定字符串 |
| `fileCount` | 文件框已选文件数 |
| `attribute:{name,value}` | 属性值；`value:null` 检查属性不存在 |
| `match:"one"` / `"any"` / `"all"` | 默认 one 要求唯一；any 任一满足，all 全部满足，隐藏元素也纳入检查 |
| `stableMs` | 结构化条件连续满足的时间；不用于表达式等待 |

组合的字段共同约束条件。没有任何匹配时，只满足不带值、文件数、属性或文字要求的纯 `state:"hidden"`；附加条件不会因为元素消失而自动通过。`stableMs` 仍须满足。

按原文档已发出的 `ref` 等隐藏时，元素被移除算隐藏。别的文档、frame 或未知引用返回 `STALE_ELEMENT_REF`，不当成已消失。

```json
{"locator":{"role":"textbox","name":"标题"},"valueEquals":"示例标题","stableMs":200}
{"selector":"input[type=file]","state":"attached"}
{"textMatches":"数量\\s*[\\d.]+"}
```

`WAIT_TIMEOUT` 尽可能带现场：当前 `url`、`title`、`loading`；等文字时有最多 3 段 `closestText`；等元素时有 `matches`、`visible`；等隐藏时有最多 3 个 `stillVisible`（引用、角色、名称）。后置检查超时也采用这些诊断。

单次 `chrome_wait` 最多 300 秒；批次 `page.wait.timeoutMs` 范围 100–300000，且受整批期限限制。客户端工具期限可能更短；`saltedfish connect` 配置的超时约 320–330 秒，不代表每个客户端都会持续同步等待。长作业使用 `chrome_job_start` 加分段 `chrome_job_status`。

表达式等待可能有副作用。若每轮都执行完并返回假值，最后的 `WAIT_TIMEOUT` 按 `not_dispatched` 返回，不暂停写入；这只描述等待失败，不撤销此前表达式的副作用。表达式本身抛错按脚本执行规则处理。

### 网络响应与正文

推荐顺序：

1. 动作前 `chrome_network_start`，保存返回的 `since`。
2. 执行页面动作。
3. `chrome_wait_response` 使用相同目标和 `since`；`url`、`urlContains`、`requestId` 必须三选一，可加 `method`、`status`、`sessionId`。
4. 默认 `waitFor:"finished"` 等正文接收结束。用返回的 `requestId`、`sessionId` 调 `chrome_network_body`；`waitFor:"response"` 只等响应头。
5. 用完 `chrome_network_stop`。

只认游标之后发出的请求，不把更早请求迟到的响应当成这次动作的结果。状态不符、请求失败、捕获停止、连接变化或事件丢失都明确失败，不重发请求。

需要捕获首屏请求时，先 `chrome_new_tab` 打开 `about:blank`，开启捕获后再导航。捕获跟随标签页的调试连接，不因普通导航关闭。相比脚本改写请求函数，这种方式无需修改页面逻辑，但须及时读取各个响应体。

`chrome_events` 支持 `urlContains`、`resourceType`，按请求整组筛选；非网络事件按自身 URL 筛。分页用上一页 `latestSequence`，开始等待可用动作前 `headSequence`。`droppedBefore` 表示缓存已丢失的范围，不能忽略后继续猜结果。`mode:"raw"` 保留原事件结构，但仍隐藏认证类请求头、Cookie 和请求体；需要原始协议能力时使用受授权限制的 `chrome_cdp`。

网络正文受 Chrome 缓冲区约束：每标签页约 100 MB、单响应约 20 MB；导航到新文档后旧正文可能失效。服务事件缓存有数量和字节预算，默认 2000 条、8 MiB，须及时分页消费。`chrome_network_body` 可返回 `base64Encoded:true`，此时正文须解码；大结果使用结果引用。

### 下载等待与网站权限

`chrome_download` 主动开始下载，返回 `downloadId`。已知下载用 `chrome_wait_download {downloadId}`；完成立即返回，中断、记录不存在或文件已删除明确失败，不恢复或重新开始下载。

页面触发的下载按调试连接的 `Page.downloadWillBegin` 与 Chrome 下载事件的 URL 配对，成功时 `chrome_downloads` 带 `tabId`，并产生 `downloads.created`。按 `tabId` 等下一次下载时：

- 不给 `since`，也接受最近 15 秒内刚开始的下载，覆盖点击与开始等待之间的间隔。
- 返回 `sequence`；连续等待时将其传给下一次的 `since`。
- 游标超出序列返回 `EVENT_CURSOR_INVALID`，所需历史已淘汰返回 `EVENT_HISTORY_LOST`。
- 尚未确定下载时标签页关闭返回 `TAB_NOT_FOUND`；已经确定下载则继续等该下载完成。
- 已开始但超时未完成时，用明确的 `downloadId` 继续等，不再次触发业务动作。

Chrome 可能拦截同一页面第二次起的自动下载，工具看不到被拦的下载记录。按标签页等待超时后，只有确实存在或可能存在此前下载时才提示自动下载设置，并可带最近 3 条页面报错 `detail.console`。也可能是接口没给文件，或异步 `window.open` 被弹窗规则拦截；先核对网络和页面。

`chrome_site_permission` 按 origin 查看或设置权限，`url`、`tabId` 二选一：

- `permission:"automaticDownloads"`（默认）：`allow`、`block`、`ask`。
- `permission:"popups"`：仅 `allow`、`block`，需要 `site-permission-v2`。
- 省略 `setting` 仅查看；设置是写操作并记操作记录。设置只影响目标 origin，不是全局关闭浏览器限制。

`chrome_downloads` 的 `url`、`finalUrl`、`referrer` 最多 300 字，截断时带对应的 `Truncated` 字段。

## 页面脚本与原始 CDP

### `chrome_evaluate` 与内部隔离

`chrome_evaluate` 在指定页面上下文运行 JavaScript，可等待 Promise、读写 DOM、调用页面 `fetch`。它不是服务所在电脑的 Node.js，不是只读工具，也不是操作系统沙箱。结果按值返回，直接返回对象或数组即可，无需 `JSON.stringify`。

`replMode:true` 按 DevTools 控制台语义执行，支持重复顶层 `const`、`let` 声明和顶层 `await`；需要 `evaluate-v2`。不带只读限制的顶层声明可能留在页面全局，调用方须自行管理。

产品内部 DOM 查询、元素引用和快照则在每个 frame 的隔离执行环境运行，引用存于闭包，不在页面主世界登记运行时变量。首次初始化后复用；导航、frame 销毁、调试分离和配置暂停使缓存失效，引用不迁移到新文档。

每标签页最多缓存 256 个 frame 环境；每个页面运行时保留最多 5000 个元素引用，快照最多 8 份、5 分钟、累计 2 MiB。超出时明确拒绝或淘汰旧记录。内部观察不申请浏览器用户手势；显式脚本沿用自身执行语义。[Chrome 隔离执行环境说明](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts#work_in_isolated_worlds)。

变量隔离不等于权限隔离。网页能观察 DOM 和输入事件，不承诺无法识别自动化。调用方显式脚本、后台作业和 `initScript` 有各自的主世界行为，不受“内部运行时不新增全局变量”的保证覆盖。

### 只读检查与改写建议

`readOnly:true` 使用 Chrome 的 `throwOnSideEffect`：在可能副作用前中止，返回 `SIDE_EFFECT_BLOCKED`、未派发，不解除结果未知保护。DOM 修改、点击、请求、定时器等不能在此模式执行。

部分纯读取也可能被 Chrome 拦下。规则由 Chrome 内置，扩展不能放宽；错误会按表达式提供改写建议：

| 被拦写法 | 可尝试的读取写法 |
| --- | --- |
| `getElementById` | `querySelector` |
| `getClientRects` | `getBoundingClientRect` |
| `checkVisibility` | 读取矩形和 `getComputedStyle`，自行判断所需条件 |
| `matches` | `[...(el.parentNode||document).querySelectorAll(selector)].includes(el)` |
| `closest` | 先取候选集合，再沿 `parentElement` 查找 |
| `elementFromPoint` | 按 `getBoundingClientRect` 比较位置；这不等同浏览器命中测试 |
| 对象展开、`Object.fromEntries`、`Object.assign` | 循环给新对象赋值 |
| `structuredClone` | 数据适用且内置函数未被替换时，可尝试 JSON 序列化复制；直接返回对象通常更简单 |

例如在普通文档中寻找匹配祖先：

```javascript
const all = [...document.querySelectorAll('.panel')];
let e = document.querySelector('#field');
while (e && !all.includes(e)) e = e.parentElement;
e?.getAttribute('data-state');
```

这些建议不是所有 DOM 结构的完全等价替换。跨 Shadow DOM、脱离文档元素或精确命中测试有额外语义，须按实际页面核对。

常见可用读取包括 `querySelectorAll`、`getAttribute`、`textContent`、`getBoundingClientRect`、`offsetWidth`、`offsetHeight`、`classList.contains`、数组转换和局部对象构造；实际仍以 Chrome 检查结果为准。

有的页面用 core-js 一类补丁替换 `JSON.stringify` 等内置函数，甚至替换 `Function.prototype.toString`。只读执行被拦后，扩展可通过调试器检查相关函数，消息点名替换项，结构化列表在 `detail.replacedBuiltins`。直接返回对象，不必序列化后再解析。

顶层 `const`、`let` 因创建全局词法变量被拦时，扩展自动包进 `{ … }` 再试一次，保留最后表达式的结果，不留下全局词法变量。`var`、函数声明不能靠块作用域解决；改用局部 `const/let` 或返回值的立即执行函数。

### 普通脚本的副作用试跑

不带 `readOnly` 的 `chrome_evaluate` 和表达式等待会先在副作用检查下试跑：

1. 试跑完成，直接使用结果，不再执行第二遍。
2. 在可能副作用前抛错，`JAVASCRIPT_ERROR` 标记未派发，不暂停标签页。
3. 遇到可能副作用，Chrome 中止试跑，再正常执行。试跑最多占一半期限，且不超过 2 秒。

Chrome 的试跑中止不会进入页面 `catch/finally`。`Promise`、async 函数、顶层声明、请求、日志和定时器等会使脚本走正常执行路径；正常执行后抛错或超时，不能推断没有副作用。

### 后台作业

长时间抓取或计算使用 `chrome_job_start`，立即返回 `jobId`，再用 `chrome_job_status` 读取：

- 脚本可返回值、Promise，或接收 `report(progress)` 的函数；作业状态为 `running`、`done`、`failed`、`missing`。
- 已建立作业的异常记入作业，不把启动调用改成结果未知。脚本同步部分抛错、尚未建立作业时，仍按普通脚本规则处理。
- `chrome_job_status.waitMs` 为 0–300000，可分多次等待；`savePath` 可将结果存文件而不在回复里携带完整结果。
- 记录存于页面主世界 `globalThis.__saltedfishJobs`，导航或刷新即丢失。登记新作业时清理旧记录，保留最近最多 19 个已结束记录，再加入新作业。

它不是持久后台任务服务。页面关闭、刷新、Chrome 丢弃标签页或定时器节流都可能影响作业；参见下文 `chrome_keep_tab`。

### 导航前 `initScript`

`chrome_new_tab`、`chrome_navigate` 可带 `initScript`，在新文档创建后、页面脚本运行前，于页面主世界执行。需要扩展 0.3.25 及以上，能力 `init-script-v1`。

- 只覆盖这一次导航：派发前登记，调用结束时无论成功失败都撤销。之后的刷新、整页跳转须重新提供。
- 按函数体执行，允许 `return`。顶层 `const`、`let`、`function` 留在函数里；要给后续脚本读取，须显式挂到 `window`。
- 最长 200000 字。参数校验只编译、不执行；非法函数体返回 `INVALID_ARGUMENT`。
- 作用于本次导航的主 frame 文档，包括重定向和跨进程落点，以及调用返回前出现的同进程 iframe。不覆盖跨进程 iframe、dedicated worker 或 service worker。仅顶层执行可加 `if(window!==top)return;`。
- 没有新文档就不运行，如 hash 导航、`pushState`，或前进后退通过 bfcache 恢复。
- 不能与 `wait:false` 一起使用；批次、任务的 `page.navigate` 不接受它。
- 脚本自己抛错不影响导航，可在 `chrome_events` 中看 `Runtime.exceptionThrown`。登记被 Chrome 拒绝返回 `INIT_SCRIPT_REJECTED`、未派发。

`chrome_new_tab` 带脚本时先建立空白标签页并加入会话组，再登记、导航。此时 `timeoutMs` 默认 30000；只有带脚本时才允许该参数。导航失败的 `detail.tabId` 指明已建立的标签页，不要再盲目新建。未派发的空白页可继续导航；结果未知则先核对。

调用返回带 `initScript:{removed:true}`。若撤销失败，附 `INIT_SCRIPT_NOT_REMOVED` 警告：以后新文档可能继续运行脚本，直到 `chrome_detach_tab` 或关闭标签页。撤销只停止未来注入，不会撤回已经执行的脚本；已安装的页面逻辑通常随文档更换才消失。

这是写操作，没有 `readOnly` 或副作用试跑；标签组、结果未知和管理页保护照常生效。服务可在开空白标签页之前因缺能力拒绝调用。若只需响应正文，优先考虑导航前开启网络捕获；脚本注入适用于确实需要页面内逻辑的场景。

### `chrome_cdp`

原始 CDP 始终绑定指定配置和标签页，可使用扩展 debugger 支持的 DOM、Runtime、Network、Fetch、Input、Storage 等命令。Browser 域和跨目标 Target 操作不支持；不会隐式切换配置，也不能绕过原有授权、文件路径和目标限制。

非管理员调用 `Page.addScriptToEvaluateOnNewDocument` 时，`params.source` 同样须为合法函数体，套函数后执行；顶层 `var`、`function` 不成为页面全局，需显式写入 `window`。指定 `worldName` 也按同样方式包装。脚本在受保护管理页及扩展页整段不执行。

这种原始登记不会自动随调用结束撤销；须使用 `Page.removeScriptToEvaluateOnNewDocument`，或断开调试连接。只覆盖一次导航时使用 `initScript` 更直接。原始 CDP 不是沙箱，能改变页面、网络与已登录网站状态。

## 截图与文件

### 截图范围和坐标

`chrome_screenshot` 支持视口、`fullPage:true`、单个元素（`selector/ref/locator`）或 `clip`，这些范围互斥。元素和区域截图不替调用方滚动，允许捕获视口外区域。

- `clip` 默认页面 CSS 坐标。
- `clipViewport:true` 将 `clip` 解释为视口坐标，工具加上截图时滚动距离；结果 `area` 仍是页面坐标。
- `scale` 范围 0.1–1，用于缩小图片。需要扩展能力 `screenshot-v3`。
- 有 `coordinates.cssPixels:true` 时，原始比例为 1 图像像素对应 1 CSS 像素；缩图后先除以 `coordinates.scale`，省略时按 1。
- 比例来自 `Page.getLayoutMetrics`，不是简单使用页面 `devicePixelRatio`。读不到比例时可能按设备像素返回，且不带 `coordinates`；此时不要假设图像坐标可直接点击。

当前坐标返回与换算：

| 截图 | `coordinates` 与换算 |
| --- | --- |
| 视口 | `viewport:true`，不带 `area/scroll`；点击坐标 = 图片坐标 ÷ scale |
| 整页、元素、clip | 带 `area`、`scroll`、`toViewport`；点击坐标 = 图片坐标 ÷ scale + `toViewport` |

`toViewport` 为 `area` 左上角减 `scroll`。换算只反映截图时的几何，页面后来滚动或重排后应重新定位。

### 固定元素

截图区域超出视口时，固定定位和已粘住的元素按截图时位置画入图片；页面已经滚动，整页图中的顶栏可能出现在中部。`coordinates.fixed` 列出检测到的元素及图片内 `box`、`selector`：截图前按 7×7 视口网格采样，最多保留面积最大的 3 个，不列占满大半视口的元素。它不是完整固定元素清单。

需要顶栏在图顶时，先显式滚到顶部再截图。截图工具不会替调用方滚动或改视口高度，因为这些动作会触发滚动、懒加载、重排等页面行为。区域完全在视口内时不带固定元素信息。

### 保存结果

`savePath` 是服务所在电脑的绝对路径，不是浏览器电脑或 Agent 任意远端的路径。

| 工具 | 保存参数与类型 |
| --- | --- |
| `chrome_screenshot` | `savePath`，仅 `.png`；`returnImage:false` 不在回复中回图 |
| `chrome_evaluate` / `chrome_job_status` | `savePath`，`.json/.txt/.csv/.md/.html`；字符串写入非 JSON 文件时保留原文 |
| `chrome_save_result` | 已有 `artifactId` 加 `path`、可选 `overwrite`；路径参数不是 `savePath` |
| `chrome_read_result` | 按 `artifactId` 分页读取大结果，`offset/limit` 单位为 JS UTF-16 字符；图片引用直接回图 |

目标目录必须存在，缺失返回 `OUTPUT_DIRECTORY_NOT_FOUND`。已有文件需 `overwrite:true`，只覆盖普通文件，不覆盖目录或符号链接。会改页面的脚本在派发前预检输出目标；业务已完成后保存失败只附警告，不应为保存再执行脚本。

截图指定 `savePath` 后不再另存原始 artifact。`returnImage:false` 即使保存失败也不会回图；可见 `saved:false` 和 `RESULT_STORAGE_FAILED` 警告。大结果存储失败也不把已完成业务改判为未执行。

### 上传目标与传输

`chrome_upload` 和批次 `page.upload` 接受 `paths` 或 `transferIds`，必须二选一，不弹系统文件选择框。

目标可直接定位隐藏的 `input[type=file]`。也可定位可见上传按钮、区域或文字，按以下顺序寻找文件框：

1. 目标所在 label 关联的文件框。
2. 目标内部的文件框，包括 open Shadow DOM。
3. 向上最多 4 层，停在首次含文件框的祖先，不继续扩大到整个页面。

该层存在多个文件框返回 `AMBIGUOUS_FILE_INPUT`，列出候选、不上传；都没有返回 `NOT_FILE_INPUT`。可定位更近的区域，或直接用候选 `ref`。间接定位成功时结果带 `input`，包含实际文件框的 `ref`、`selector`，以及可用的 `accept`、`multiple`、区域文字 `area`；直接定位文件框时不带。

目标尚未出现时等待，预留约 2 秒设置文件和回读。禁用文件框或不支持多文件的目标明确拒绝，不任意选择别处的文件框。这种区域定位需要扩展 0.3.26；更早扩展只认文件框本身，失败会提示更新。

`chrome_profiles` 中的 `sameMachine:true` 表示服务按连接地址和用户代理判断浏览器与自己同机：连接来自本机地址，且浏览器操作系统与服务一致。此时检查路径后把真实路径交给 Chrome 的 `DOM.setFileInputFiles`，由 Chrome 读取，不经服务传内容，没有内容传输的大小上限，结果带 `transport:"path"`。回读文件名、大小不符返回 `UPLOAD_FILE_MISMATCH`、结果未知，页面可能已开始处理。管理员可配置 `uploadByPath:"never"` 始终传内容。

不同机器的浏览器由服务传内容，单文件最多 100 MiB、每批 256 MiB。`chrome_cdp` 的文件方法不能把服务路径当成异机浏览器路径，否则返回 `FILE_LOCATION_REQUIRED`；使用 `chrome_upload`。

上传的持久操作记录带 `detail.files`：名称、大小、SHA-256；批次另有从 0 起的 `step`。不记录完整路径或文件内容。哈希异步计算完成后补入。设置文件成功仍不等于业务上传、转码完成。

### 文件分块与导出

分块接口传输文件，不自动执行网页上传：

- 传入：`chrome_file_begin` 声明 `filename/size/sha256/submissionId` → `chrome_file_write` 按字节偏移发送 `base64` → `chrome_file_commit` 校验 → 将返回的 `transferId` 放入上传的 `transferIds`。
- 取回：确认下载完成 → `chrome_file_export` 提供 `downloadId/submissionId` → `chrome_file_read` 分块读取，并在接收端核对 SHA-256。
- 重试：复用同一 `submissionId`，用 `chrome_file_status` 看 `receivedBytes`；相同偏移允许重传相同字节，冲突拒绝。

单文件最多 100 MiB、块最多 256 KiB；全局预留容量 1 GiB、每主体 256 MiB，传输 1 小时到期。文件落专用暂存目录，按客户端和 Chrome 配置隔离，不能指定任意本机读取路径。元数据、进度可跨服务重启恢复；不会自动恢复网页动作。

浏览器电脑上的下载导出需要可选本机助手，当前提供 Windows 版；助手只读取该 `downloadId` 对应的文件，不接受任意路径。下载导出仍遵守文件路径限制。

### 保持标签页

`chrome_keep_tab` 设置 `autoDiscardable:false`，阻止 Chrome 因内存压力自动丢弃该标签页；`keep:false` 恢复默认。`chrome_tabs` 带 `autoDiscardable`、`discarded`。

它不保证页面或作业永久存活，也不关闭后台定时器节流。密集定时作业可显式 `chrome_focus_tab`，或把等待轮询放在服务侧的 `chrome_wait`、`chrome_job_status`。

## 后台标签页与 Agent 光标

当前扩展的视觉动作默认不切换窗口的活动标签页。通过焦点模拟，Agent 可在后台标签页点击、输入、滚动和拖拽，不把这些输入发给用户正在使用的其他标签页。动作期间目标页面可能认为自己可见且有焦点，结束后恢复焦点模拟状态。

- 后台截图先开启 screencast，并用 CDP Overlay 的透明小区域促使 Chrome 出帧，不向页面 DOM 添加节点。约 1.5 秒仍没有截图时，才短暂激活目标标签页兜底，再尝试切回；若用户已主动切换则不覆盖其选择。
- 后台页面的 `target=_blank`、`window.open` 若使新标签页成为前台，扩展按发起页面的 `Page.windowOpen` 识别并尝试切回原活动页，使新标签页留在后台。用户本来正在看 Agent 页、或打开的是新窗口时不做这种处理。Chrome 可能先短暂激活，不能保证完全没有切换瞬间。
- 用 `chrome_tabs`、`chrome_wait_tab` 找新标签页。`chrome_wait_tab` 要求指定 opener，配合动作前的 `excludeTabIds`；多匹配明确报错，不任意选一个。
- 登录、扫码或需要用户确认时，显式 `chrome_focus_tab` 再请用户操作。
- 最小化窗口会临时恢复，不主动抢焦点，完成后再还原；不能承诺最小化状态完全不改变。

扩展设置“Agent 操作时显示它的光标”（`showCursor`）默认开启。光标、按下提示和目标框由 CDP Overlay 绘制在页面外，不往页面 DOM 或主世界添加提示对象；空闲约 2.5 秒收起，产品截图前隐藏。后台操作时，光标在 Agent 标签页上，不显示在用户的其他标签页。

后台动作行为需要扩展 0.3.24 及以上。更早扩展可能在视觉动作时激活标签页；此项没有独立能力门控，不能只看工具参数推断它已生效。

## 弹窗、导航与离开页面

`chrome_dialog` 只响应已经观察到的原生 JavaScript 弹窗，可用 `dialogId`、`expectedType`、`expectedMessage` 核对身份。点击自己触发弹窗时，`DIALOG_OPEN` 错误直接携带弹窗内容和标识，不必先另查事件。

同一调用方响应自己 `chrome_action` 引发的弹窗后，原动作可以结为成功；中断的批次结为失败，因为后续步骤没运行。结果带 `writable` 和答完后的 `pageChange`，通常不需要再 `chrome_recover_tab`。

以下情况不自动解除未知保护：脚本弹出的框（答完脚本仍可能继续）、错配响应、另一客户端的响应、用户自己关闭、标签页另有未知操作。由新命令开始前已经存在的弹窗造成的 `DIALOG_OPEN` 可是未派发；本命令自己触发的弹窗不能据此当成没执行。

批次或任务紧跟动作、脚本的 `page.dialog` 可作一次性预声明。`accept:true` 必须同时指定 `expectedType`、`expectedMessage`，不默认接受任意弹窗。

`chrome_navigate.action` 为 `goto`（默认）、`back`、`forward`、`reload`。仅 goto 接受且必须提供 `url`。没有对应历史记录时未派发；导航途中超时仍须检查实际页面。`chrome_close_tab` 关闭已不存在的标签页返回 `closed:true, alreadyClosed:true`。

`chrome_navigate`、`chrome_close_tab` 可带 `beforeUnload:"accept"` 自动接受离开页面提示，实际接受时结果带 `beforeUnload:"accepted"`。省略则报 `DIALOG_OPEN`，由 `chrome_dialog` 回答：离开使原操作成功，留下使原操作失败，答完等待原命令收尾后返回，不要求额外恢复。

## 权限、路径与离线诊断

### 本机连接和管理页保护

Agent 在服务所在电脑连接。`/mcp` 只接受本机连接；`/rpc` 对非管理员也执行本机限制，其他电脑上的 Chrome 扩展仍可连接服务。非本机 Agent 请求返回 HTTP 403、`MCP_LOCAL_ONLY`。这些接口规则不是操作系统沙箱。

非管理员客户端不能读取、截图、执行脚本、点击、关闭或导航到 SaltedFish 管理页、扩展自己的页面，返回 `ADMIN_PAGE_PROTECTED`、未派发。判断依据是派发时目标当前地址，不是接管时地址；脚本执行还有来源检查。

受保护标签页仍可出现在列表，URL 隐藏，标题标为受保护。原始 `Debugger.*` 及直接引用管理页来源的 CDP 参数受到限制，可返回 `CDP_METHOD_RESTRICTED`。非管理员新文档脚本在受保护来源整段不执行，包括继承来源的空白 iframe。

`chrome_navigate`、`chrome_new_tab` 和批次导航不接受 `javascript:` URL，返回 `INVALID_ARGUMENT`；执行脚本用 `chrome_evaluate`。非管理员不能通过导航、下载、历史操作或原始 CDP 打开 `file:`、`view-source:file:`，返回 `FILE_URL_NOT_ALLOWED`。本机文件由 Agent 自己的文件工具读取，页面上传用上传工具。

### 本机文件边界与容量

Agent 的文件访问许可应由它自己的 harness 管理。SaltedFish 不另设上传、保存目录白名单；这不表示 SaltedFish 能替 harness 对每次本机文件访问做审批。

非管理员上传、结果保存、下载导出及相关原始 CDP 文件方法只拒绝 SaltedFish 数据目录（含 npm 安装目录）和网络共享路径。检查会还原真实路径，处理符号链接、目录联接、`..`、Windows 短名和映射到共享的盘符。违规返回 `UPLOAD_PATH_NOT_ALLOWED` 或 `OUTPUT_PATH_NOT_ALLOWED`。

非管理员的大结果只给 `artifactId` 和文件名；错误中的数据目录替换为 `<数据目录>`。其他本机路径，如下载文件位置，可能正常返回；不要理解成所有路径都已隐藏。

默认全局并发 `maxPendingRequests` 为 128。单个非管理员主体最多约 1/8（至少 1，默认 16）；另留约 1/8 给管理员恢复操作。超出分别返回 `PRINCIPAL_BUSY`、`SERVER_BUSY`，都是此次操作未开始。

非管理员合计结果存储最多使用 `resultByteLimit` 的 90%，单个主体约 1/4、最低额度 64 KiB。超出时可带 `RESULT_STORAGE_FAILED`，不重判已完成业务；管理员可用 `results list`、`results remove` 清理。管理员仍受全局容量限制。

授权后的页面操作仍可以使用登录身份读写网站。原始脚本、CDP、只读授权提示与标签组都不能代替操作系统权限或网站业务授权。

### 离线与扩展重载

`chrome_profiles` 的离线配置可带 `offline:{reason,since,recovery}`；`PROFILE_OFFLINE` 消息也给恢复办法：

| 原因 | 含义 |
| --- | --- |
| `debugging-canceled` | 用户在 Chrome 调试提示条取消连接 |
| `agent` | `chrome_pause_profile` 暂停 |
| `user` | 用户在扩展中暂停 |
| `disconnected` | 其他连接断开 |

原因仅保留在服务内存，重连后清除；服务重启不知道原因时不补猜。用户主动取消调试默认保持暂停。扩展可选择取消后约 1 分钟自动恢复，默认关闭；Service Worker 休眠时由周期 alarm 检查。

多个 Chrome 配置共用解压扩展目录时，文件可能已更新但后台仍运行旧代码。后台启动发现版本不一致会尝试自动重载一次；仍不一致时 `chrome_profiles.extensionReload` 说明文件与代码版本。此时请用户在 `chrome://extensions` 重新加载 SaltedFish，不是再次下载更新；名称、配对保持。缺能力的调用仍拒绝，不执行页面动作。

## 批次、任务与业务身份

`chrome_batch` 固定一个 `profileId/tabId`，顺序执行 `page.action/evaluate/wait/navigate/upload/dialog`。失败即停，保留完成步骤，没有自动回滚或重试。

任务队列通过 `chrome_task_submit` 提交，保存流程通过 `chrome_workflow_run` 运行。只在明确需要排队或保存流程时使用，不把结果未知的任务重新提交当成恢复方式。任务因变量、执行预算等本地异常失败，同配置后续排队任务也暂停，可见 `PREVIOUS_TASK_FAILED`。

### 受理去重

`submissionId` 是可选 UUID，同一业务只生成一次。连接或响应丢失后，重试须复用相同身份和内容：

- 身份按调用方、Chrome 配置隔离；同内容返回原 `taskId`，不同内容或目标拒绝。
- 任务意图与去重收据在同一 SQLite 事务落盘，指纹使用服务密钥 HMAC。原始参数不进入收据或任务历史。
- 详细终态历史保留 500 项；收据不随详情清理，详情过期时拒绝重新执行。
- 收据保留 30 天；容量紧张可回收超过 24 小时保护期的最旧记录，保护期内不回收。过了收据保留期不能再依赖这个身份防重。
- 总量 10000，其中 1000 为管理员保留；单个非管理员最多 2000。满时返回 `SUBMISSION_QUOTA` 或 `SUBMISSION_CAPACITY`、未派发，已有身份重试先查原收据，不受新增额度限制。

省略身份虽可提交，但失去受理重试去重；不要为绕过未知结果或额度自动换身份。此机制只保证本安装内的任务受理，不代替网站自身业务幂等。

`chrome_workflow_run` 对同一身份、同一请求 `revision` 和内容先找原收据。流程后来被修改或归档，重试仍返回原任务并带 `deduplicated`；没有收据的新请求照常校验，可能返回 `WORKFLOW_CHANGED`、`WORKFLOW_ARCHIVED`。

### 条件、循环与结果变量

任务、保存流程用平面控制步骤：`flow.if`、可选 `flow.else`、`flow.repeat`、`flow.end`、`flow.set`。最多嵌套 8 层，每循环最多 100 次。`maxExecutedSteps` 默认 1000、最多 10000，控制步骤也计数，耗尽即停。

`saveAs` 保存步骤的 `data`；`bindings` 为“args 字段路径 → 变量路径”。先提供能通过 schema 的占位参数，运行时替换后重新校验。例如动作步骤可写：

```json
{"operation":"page.action","args":{"action":"fill","selector":"#title","text":"placeholder"},"bindings":{"text":"page.title"}}
```

条件支持 `exists/truthy/equals/notEquals/contains/lt/lte/gt/gte`；`flow.repeat` 的 `while` 每轮读取当前变量。只允许自有属性、数组下标，不允许原型路径、脚本插值、改变配置或 tab/frame、动态生成 CDP 方法。脚本、CDP 步骤不接受结果绑定。

变量预算为单值 256 KiB、单任务 1 MiB、全局 16 MiB。变量只在内存，不进入历史或诊断；服务重启后任务中断，不恢复自动执行。大结果应保存 artifact 引用。

任务还能编排 `page.screenshot/inspect/cdp`、`network.start/stop/body/wait`、`downloads.start/wait`、`tabs.wait`。例如把 `network.start` 结果存为 `capture`，后续 `network.wait` 用 `bindings:{"since":"capture.since"}`。普通批次仍使用固定的六类页面步骤，控制流只用于任务、流程。

## 扩展版本与能力

当前服务、npm 包与扩展版本为 0.3.28。服务按扩展实际声明的能力检查，不以 manifest 版本字符串代替能力验证。建议服务与扩展保持同版。

下表列本参考涉及的能力。早期基础能力统一以 0.3.26 作为公开兼容基线，不追溯首次实现版本；单独列出的最低版本用于解释近期参数对稍旧扩展的要求。

| 能力 | 最低扩展版本或公开基线 | 用途与缺失时行为 |
| --- | --- | --- |
| `semantic-locators`、`element-state-v2`、`frame-coordinates-v2` | 0.3.26 公开基线 | 语义定位、元素状态、frame 坐标；使用对应功能时缺失则拒绝 |
| `execution-v3`、`interaction-v4`、`interaction-v5` | 0.3.26 公开基线 | 页面读取、截图、输入、等待、上传、批次的基础要求；缺失则拒绝 |
| `admin-origin-v1` | 0.3.26 公开基线 | 非管理员按标签页操作的管理来源保护；缺失则拒绝 |
| `structured-wait`、`popup-wait`、`dialog-control` | 0.3.26 公开基线 | 相应结构化等待、新标签页等待、弹窗控制；缺失则拒绝 |
| `interaction-v6` | 0.3.26 公开基线 | 鼠标修饰键、元素滚动、仅给 `deltaX` 的滚动语义；用到才检查 |
| `interaction-v7` | 0.3.26 公开基线 | 双击、拖拽、勾选、后退/前进/重新加载；用到才检查 |
| `file-content-v1`、`browser-file-read-v1` | 0.3.26 公开基线 | 异机浏览器文件内容接收、可选助手读下载；缺失则拒绝对应文件路径 |
| `read-only-eval-v1` | 0.3.26 公开基线 | `readOnly:true`，包括批次脚本与等待；缺失则拒绝，不按普通脚本运行 |
| `tab-groups-v1` | 0.3.26 公开基线 | MCP 会话标签组协调；缺失时没有扩展侧标签组，不能将其视为安全隔离 |
| `self-update-v1` | 0.3.26 公开基线 | 扩展设置页自行更新；缺失时需按安装方式更新，不是页面动作门控 |
| `store-build` | Chrome 应用商店版 | 商店版声明它代替 `self-update-v1`，由商店更新；管理页据此提示从应用商店更新。不是页面动作门控 |
| `pause-control` | 0.3.26 公开基线 | `chrome_pause_profile`；缺失则拒绝，可在扩展中手动暂停 |
| `activity` | 0.3.26 公开基线 | 活动协议声明；当前没有服务端消费方，不代表额外执行权限 |
| `evaluate-v2` | 0.3.15 | `replMode`、后台作业启动；缺失则拒绝 |
| `screenshot-v2` | 0.3.15 | 元素与 `clip` 截图；缺失则拒绝 |
| `downloads-v2` | 0.3.15 | 下载来源标签页、按标签页等下载、自动下载权限；新调用缺失则拒绝，旧结果可能不带来源 |
| `tab-keep-v1` | 0.3.15 | `chrome_keep_tab`；缺失则拒绝 |
| `interaction-v8` | 0.3.17 | `choose`、`nth`、`scopeRef`、`match:any/all`、批次等待的 `timeoutMs`；用到才检查 |
| `site-permission-v2` | 0.3.19 | 弹窗权限；缺失则拒绝，不能误改为自动下载权限 |
| `screenshot-v3` | 0.3.20 | `clipViewport:true`、非默认 `scale`；用到才检查 |
| `interaction-v9` | 0.3.24 | `textMatches`、单步动作 `postcondition`；用到才检查 |
| `init-script-v1` | 0.3.25 | 导航、新标签页 `initScript`；缺失则拒绝，连新空白标签页也不开 |
| `interaction-v10` | 0.3.26 | 所有位置的 `locator.inside`、查找 `selector` 简写、`state:"attached"`；用到才检查 |

页面动作的必需能力缺失时，服务在派发前返回 `EXTENSION_UPDATE_REQUIRED`，不让旧扩展忽略参数后执行错误语义。并非每个新增结果字段都有门控：`context`、编辑器 `within`、`type.value`、`toViewport`、`fixed`、`hit`、上传 `input` 在旧扩展中可能只是缺失。不要据字段缺失推断页面没有该状态。

扩展也检查服务的 `execution-v3`、`interaction-v4`、`interaction-v5`、`admin-origin-v1`，缺失返回 `SERVICE_UPDATE_REQUIRED`、拒绝执行。服务仍公布的 `execution-v2` 是协议遗留声明，不是当前执行要求。连接采用 v2 双向挑战应答，配对密钥只作 HMAC 密钥，不在握手线上明文发送；握手完成前不执行命令。

相关实现位于 `src/tools.ts`、`src/shared.ts`、`src/service.ts`、`extension/executor.ts`、`extension/page-runtime.ts`。架构说明见[架构文档](https://github.com/finmoor/saltedfish/blob/main/docs/architecture.md)，性能和其他测试方法见[测试文档](https://github.com/finmoor/saltedfish/blob/main/docs/testing.md)。安装见 [npm 使用说明](npm.md)，一般限制见[已知边界](beta-limitations.md)，安全报告见[安全政策](https://github.com/finmoor/saltedfish/blob/main/SECURITY.md)。
