import { z } from 'zod';
import { resultFields, flowSteps } from './task-program.js';
import { waitResponseArgs, waitDownloadArgs, eventWaitToolDefinitions } from './event-wait-tools.js';
import { fileTransferToolDefinitions } from './file-transfer-tools.js';
import { isScriptUrl, SCRIPT_URL_MESSAGE } from './shared.js';

/** 去掉字段说明的副本，校验规则（strict、refine、默认值）不变。传入 def 才不会挂 parent，转 JSON Schema 时也就不继承原来的说明。 */
export function bare<T extends z.ZodType>(schema: T): T {
  const def = { ...(schema as any)._zod.def };
  if (def.shape) def.shape = Object.fromEntries(Object.entries(def.shape).map(([key, value]) => [key, bare(value as z.ZodType)]));
  for (const key of ['innerType', 'element', 'in', 'out']) if (def[key]) def[key] = bare(def[key]);
  if (Array.isArray(def.options)) def.options = def.options.map((option: z.ZodType) => bare(option));
  return (schema as any).clone(def);
}

const profile = { profileId: z.string().min(1).describe('chrome_profiles 返回的配置 ID，必须明确指定；不可用另一个账号替代。') };
const target = { ...profile, tabId: z.number().int().nonnegative().describe('属于该 profileId 的标签页 ID。') };
const frame = { contextId: z.number().int().optional(), sessionId: z.string().optional().describe('chrome_contexts 中的 iframe 子会话 ID。') };
export const semanticLocator = z.object({ role: z.string().min(1).optional(), name: z.string().min(1).optional(), label: z.string().min(1).optional(), placeholder: z.string().min(1).optional(), text: z.string().min(1).optional(), testId: z.string().min(1).optional(), inside: z.string().optional().describe('CSS 选择器，可匹配多个：只找它们里面（含自身）的元素，如候选列表、弹窗。'), exact: z.boolean().default(true), nth: z.number().int().min(0).max(999).optional().describe('多个匹配时按文档顺序取第几个，0 起。') }).strict().refine(v => v.role || v.name || v.label || v.placeholder || v.text || v.testId, '至少指定一个语义定位条件。');
const locator = { selector: z.string().min(1).optional(), ref: z.string().optional().describe('最近 chrome_inspect/find 的元素 ref；刷新页面后失效。'), locator: semanticLocator.optional().describe('按角色/名称/标签/文字定位；多个匹配会停止，先 find 获取候选。') };
const paging = { offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(1000).default(50) };
const submissionIdentity=z.string().uuid().optional().describe('可选 UUID（8-4-4-4-12 十六进制格式），同一任务重试复用；不要用名称或任意字符串。');
const timeout = { timeoutMs: z.number().int().min(100).max(300000).default(30000) };
// 占用只属于持有者；唯一越过它的路径是本机管理员对远程 Agent（service.ts 的 takeOverRemote），release/recover 三个工具共用这句说明。
const takeover = '例外：只有本机管理员能接管远程 Agent 持有的占用，本机客户端之间、同一 Agent 的不同会话之间都不行。';
const observation={scopeSelector:z.string().min(1).max(2000).optional().describe('可选唯一 CSS 根元素，包含其 open Shadow DOM；根元素本身是控件时隐藏的也列出（如文件框）。'),scopeRef:z.string().min(1).max(200).optional().describe('用 find/inspect 给的 ref 作范围，和 scopeSelector 二选一。'),valueLimit:z.number().int().min(0).max(4000).default(256)};
const oneScope=(value:{scopeSelector?:string;scopeRef?:string})=>!(value.scopeSelector&&value.scopeRef);
const diagnostics={mode:z.enum(['summary','raw']).default('summary'),maxCharacters:z.number().int().min(1000).max(24000).default(6000).describe('内容预算（JS UTF-16 字符数）：summary 限制 data 摘要；raw 超限存档，preview 最多 min(预算,2048)。不含 MCP/结果元数据及 JSON 转义开销，不是 token 或完整响应上限。')};
const actionArgs = z.object({
  action: z.enum(['click', 'doubleClick', 'drag', 'setChecked', 'choose', 'hover', 'fill', 'type', 'press', 'scroll', 'select']), ...locator, ...frame,
  autoWait:z.boolean().default(true).describe('仅首次输入前等待就绪；false 为立即检查。输入派发后从不重试。'),
  text: z.string().optional(), key: z.string().optional(), modifiers: z.number().int().min(0).max(15).optional().describe('组合键位标志：Alt=1，Ctrl=2，Meta=4，Shift=8。用于 click/hover/scroll（随鼠标事件发送）和 press。'),
  x: z.number().optional(), y: z.number().optional(), deltaX: z.number().optional(), deltaY: z.number().optional(),
  button: z.enum(['left', 'right', 'middle']).optional(), values: z.array(z.string()).optional(),
  inputMode:z.enum(['insertText','keySequence','composition','paste']).optional().describe('type 不给时：扩展开着“像真人一样操作”（默认）就把 64 字以内的 US 键盘文本逐键打，其余整段 insertText；insertText 明确整段；keySequence 为 ASCII 逐键；composition 为浏览器组合输入；paste 派发提供文本的合成粘贴事件，未被页面接管时 insertText，不改系统剪贴板。'),
  fillMode:z.enum(['auto','input','setValue']).optional().describe('fill 默认 auto：文本控件使用浏览器编辑和撤销；日期等特殊字段直接设值。setValue 显式使用合成 input/change。'),
  selection:z.object({start:z.number().int().min(0),end:z.number().int().min(0)}).strict().optional().describe('UTF-16 选择区；contenteditable 按 textContent 偏移。'),
  compositionUpdates:z.array(z.string().max(10000)).min(1).max(100).optional(),compositionCommit:z.boolean().optional(),
  holdMs:z.number().int().min(0).max(10000).optional().describe('click 按住时长；不给时像真人一样随机按住几十毫秒（扩展关了这项设置时为 0）。'),
  checked:z.boolean().optional().describe('setChecked 的目标状态；已满足时不点击，改变后核验，不重试。radio 不能通过点击取消。'),
  to:z.object({...locator,x:z.number().finite().optional(),y:z.number().finite().optional()}).strict().optional().describe('drag 终点：唯一元素定位或 x/y。与起点共用 contextId/sessionId，只在同一 frame 上下文内拖拽。'),
  steps:z.number().int().min(2).max(100).optional().describe('drag 移动段数，默认按距离定（扩展关了“像真人一样操作”时为 12），上限 100。'),
  durationMs:z.number().int().min(0).max(10000).optional().describe('drag 总移动时长，默认按距离定（关了时 300 毫秒），包含在 timeoutMs 内。'),
  option:z.string().min(1).max(500).optional().describe('choose：点开定位到的下拉触发器后要选的选项文字；先找文字完全相同的，没有再找包含它的。原生 <select> 用 action:"select"。'),
}).strict().superRefine((value, context) => {
  const located = !!value.selector || !!value.ref || !!value.locator;
  if ([value.selector, value.ref, value.locator].filter(Boolean).length > 1) context.addIssue({ code: 'custom', message: 'selector、ref、locator 只能选一个。' });
  if (located&&(value.x!==undefined||value.y!==undefined)&&['click','doubleClick','drag','setChecked','choose','hover','scroll'].includes(value.action))context.addIssue({code:'custom',message:'元素定位与坐标只能选一种。'});
  if (['fill', 'select','setChecked','choose'].includes(value.action) && !located) context.addIssue({ code: 'custom', message: '此动作需要 selector、ref 或 locator。' });
  if(value.action==='choose'&&!value.option||value.option!==undefined&&value.action!=='choose')context.addIssue({code:'custom',message:'choose 必须给 option，其他动作不能带 option。'});
  if (['click','doubleClick','drag', 'hover'].includes(value.action) && !located && !(value.x !== undefined && value.y !== undefined)) context.addIssue({ code: 'custom', message: '指针起点需要元素定位或 x 和 y。' });
  if (['fill', 'type'].includes(value.action) && value.text === undefined) context.addIssue({ code: 'custom', message: '需要 text。' });
  if (value.action === 'press' && !value.key) context.addIssue({ code: 'custom', message: '需要 key。' });
  if (value.action === 'select' && !value.values) context.addIssue({ code: 'custom', message: '需要 values。' });
  // 修饰键只有鼠标类动作和 press 会用到；对 fill/type/select 静默忽略会让调用方以为生效了。modifiers:0 等于没用，允许。
  if(value.modifiers&&!['click','doubleClick','drag','hover','scroll','press'].includes(value.action))context.addIssue({code:'custom',message:'modifiers 仅用于 click、doubleClick、drag、hover、scroll、press。'});
  if(value.inputMode&&value.action!=='type'||value.fillMode&&value.action!=='fill'||value.holdMs!==undefined&&value.action!=='click')context.addIssue({code:'custom',message:'inputMode 仅用于 type；fillMode 仅用于 fill；holdMs 仅用于 click。'});
  if((value.compositionUpdates||value.compositionCommit!==undefined)&&value.inputMode!=='composition')context.addIssue({code:'custom',message:'组合输入参数需要 inputMode=composition。'});
  if(value.selection&&(value.action!=='type'||value.selection.end<value.selection.start))context.addIssue({code:'custom',message:'选择区仅用于 type 且 end 不小于 start；fill 替换整个字段。'});
  if(value.inputMode==='keySequence'&&(/[^\x20-\x7e]/.test(value.text||'')||(value.text?.length||0)>2000))context.addIssue({code:'custom',message:'keySequence 限 2000 个可打印 ASCII 字符；Unicode 用 insertText/composition，特殊键用 press。'});
  if(value.action==='setChecked'&&value.checked===undefined||value.checked!==undefined&&value.action!=='setChecked')context.addIssue({code:'custom',message:'setChecked 必须指定 checked，其他动作不能带 checked。'});
  if(value.action==='setChecked'&&value.button!==undefined&&value.button!=='left')context.addIssue({code:'custom',message:'setChecked 只使用左键。'});
  if(value.action==='drag'){
    const to=value.to,targets=to?[to.selector,to.ref,to.locator].filter(Boolean).length:0,coordinates=to?.x!==undefined&&to?.y!==undefined;
    if(!to||targets>1||targets===0&&!coordinates||targets>0&&(to.x!==undefined||to.y!==undefined))context.addIssue({code:'custom',message:'drag 的 to 必须是唯一元素定位，或完整的 x/y 坐标。'});
  }else if(value.to!==undefined||value.steps!==undefined||value.durationMs!==undefined)context.addIssue({code:'custom',message:'to、steps、durationMs 仅用于 drag。'});
});
const evalArgs = z.object({ expression: z.string().min(1).describe('结果按值返回，直接返回对象或数组即可，不用 JSON.stringify：有的网站把它换成了自己的 JS，readOnly 下会被拦。'), readOnly: z.boolean().optional(), replMode: z.boolean().optional().describe('按控制台方式执行：顶层 const/let 可重复声明，支持顶层 await。'), ...frame }).strict();
// 结果写进服务所在电脑的文件。写哪里由 Agent 自己的 harness 决定，服务只拒绝 SaltedFish 的数据目录（upload-policy.ts）；已有文件要 overwrite:true。
const output = { savePath: z.string().min(1).max(4096).optional().describe('把结果写进服务所在电脑的这个绝对路径，目录要已存在；SaltedFish 自己的数据目录不能写。'), overwrite: z.boolean().optional() };
const clip = z.object({ x: z.number().finite().min(0), y: z.number().finite().min(0), width: z.number().finite().positive().max(16384), height: z.number().finite().positive().max(16384) }).strict();
// textMatches 在页面里用 new RegExp(源码) 编译（不带标志），这里先确认编译得过，免得发到页面才报错。
const isPattern=(source:string)=>{try{new RegExp(source);return true;}catch{return false;}};
const conditionFields={...locator,...frame,state:z.enum(['visible','hidden','attached','enabled','disabled','editable','checked','unchecked']).default('visible').describe('checked/unchecked只核验状态，包含隐藏控件；ARIA mixed两者均不匹配。attached 只要元素在 DOM 里，看不见也算（如隐藏的文件框）。可另加visible等待。'),textContains:z.string().min(1).optional(),textMatches:z.string().min(1).max(1000).refine(isPattern,'textMatches 不是有效的 JavaScript 正则。').optional().describe('正则（JS 语法，不带斜杠）：页面或定位到的元素的文字匹配就算满足，用于事先不知道的文字，如热度数字。'),urlContains:z.string().min(1).optional(),valueEquals:z.string().max(100000).optional(),fileCount:z.number().int().min(0).max(10000).optional(),attribute:z.object({name:z.string().min(1).max(200),value:z.string().max(10000).nullable()}).strict().optional(),stableMs:z.number().int().min(0).max(10000).optional().describe('条件需连续满足的毫秒数，默认0立即核验；按需开启以确认异步编辑/预览稳定。'),match:z.enum(['one','any','all']).optional().describe('定位到多个元素时：one（默认）要求唯一，否则报错列出候选；any 任一满足；all 全部满足（一个都没有也算 hidden）。')};
const validCondition=(v:any)=>{const located=v.selector||v.ref||v.locator;return !!(located||v.expression||v.urlContains||v.textContains||v.textMatches)&&(!(v.valueEquals!==undefined||v.fileCount!==undefined||v.attribute||v.match||['attached','enabled','disabled','editable','checked','unchecked'].includes(v.state))||!!located)&&[v.selector,v.ref,v.locator].filter(Boolean).length<=1;};
const waitArgs = z.object({...conditionFields,expression:z.string().optional(),readOnly:z.boolean().optional()}).strict().refine(v=>validCondition(v)&&!(v.expression&&v.stableMs),'需要元素、文字、URL 或表达式条件；stableMs 仅用于结构化条件。');
const postcondition=z.object({...conditionFields,timeoutMs:z.number().int().min(100).max(120000).default(10000)}).strict().refine(validCondition,'后置检查需要元素、文字或 URL 条件；不执行任意 JS。');
const checked={postcondition:bare(postcondition).optional().describe('动作完成后核对页面；没满足就停在这一步，动作不重试，标签页照常可写（outcome:dispatched）。检查包含在批次总时限内。')};
const beforeUnload = { beforeUnload: z.literal('accept').optional().describe('页面问“确定离开吗”时直接离开；不给就停下、报 DIALOG_OPEN，用 chrome_dialog 答。') };
// 导航和新标签页的地址：javascript: 地址在派发前拒绝，见 isScriptUrl。
const pageUrl = z.string().url().refine(url => !isScriptUrl(url), SCRIPT_URL_MESSAGE);
// 新文档加载前在页面主世界执行的脚本（只给 chrome_navigate、chrome_new_tab，批次和任务里没有）。扩展把它套进一层函数再登记（extension/init-script.ts），
// 所以这里先确认它单独就是合法的函数体：这样它闭合不了外层函数，跑不到“受保护页面不执行”的判断外面去。只编译不执行。
// 非管理员经 chrome_cdp 登记的新文档脚本（Page.addScriptToEvaluateOnNewDocument 的 source）同样套这层函数，服务用同一个检查（service.ts）。
export function functionBodyError(source: string): string | undefined {
  try { new Function(source); return undefined; } catch (error) { return error instanceof Error ? error.message : String(error); }
}
const functionBody = z.string().min(1).max(200000).superRefine((source, context) => {
  const error = functionBodyError(source);
  if (error) context.addIssue({ code: 'custom', message: `initScript 不是合法的 JavaScript 函数体：${error}` });
});
const initScript = { initScript: functionBody.optional().describe('在新文档的页面脚本运行之前，于页面主世界执行这段脚本（用来接住页面自己发的第一批请求）。按函数体执行，像包在 (function(){…})() 里：顶层变量不进全局，要留给之后的 evaluate 用就挂到 window 上。只管这一次导航：派发前登记，调用返回时撤销；跑在这次导航产生的主 frame 文档（含重定向和跨域跳转后的落点）和加载期间出现的同进程 iframe 里，跨进程 iframe 和 worker 不跑，只想在顶层跑就在开头写 if(window!==top)return;。脚本自己的报错在 chrome_events 里（Runtime.exceptionThrown），不影响导航。') };
const navigateArgs = z.object({ action:z.enum(['goto','back','forward','reload']).default('goto'),url: pageUrl.optional(), wait: z.boolean().default(true), ...beforeUnload }).strict().superRefine((value,context)=>{
  if(value.action==='goto'&&!value.url||value.action!=='goto'&&value.url!==undefined)context.addIssue({code:'custom',message:'goto 必须提供 url；back、forward、reload 不接受 url。'});
});
const uploadArgs = z.object({ ...locator, ...frame, paths: z.array(z.string().min(1)).min(1).max(100).optional().describe('服务主机绝对路径；跨机器优先使用 transferIds。'), transferIds: z.array(z.string().uuid()).min(1).max(100).optional().describe('file_commit 完成的传入文件ID；与paths二选一，文件必须属于当前调用者和配置。') }).strict().refine(v => !!(v.selector || v.ref || v.locator) && (!!v.paths !== !!v.transferIds), '需要文件 input 定位，paths与transferIds必须且只能提供一个。');
const dialogArgs = z.object({ accept:z.boolean(), promptText:z.string().optional(), dialogId:z.string().uuid().optional(), expectedType:z.enum(['alert','confirm','prompt','beforeunload']).optional(), expectedMessage:z.string().max(2000).optional() }).strict();
const dialogPolicy = dialogArgs.superRefine((value,context)=>{
  if(value.accept && (!value.expectedType || value.expectedMessage===undefined)) context.addIssue({code:'custom',message:'预声明 accept=true 必须指定 expectedType 和 expectedMessage；不会默认接受任意弹窗。'});
});
// 每个分支自带完整字段，避免宿主把 allOf 交集显示为 unknown；不放宽输入校验。
// 批次和任务里每一步都内联一份参数，字段说明会重复十几遍，任务、流程工具也就超出 Codex 的单工具 32 KiB 预算。字段说明只留在单步工具（chrome_action、chrome_wait…）里。
const batchVariants=[
  z.object({ operation: z.literal('page.action'), args: bare(actionArgs), ...checked }).strict(),
  z.object({ operation: z.literal('page.evaluate'), args: bare(evalArgs), ...checked }).strict(),
  z.object({ operation: z.literal('page.wait'), args: bare(waitArgs).safeExtend({timeoutMs:z.number().int().min(100).max(300000).optional()}), ...checked }).strict(),
  z.object({ operation: z.literal('page.navigate'), args: bare(navigateArgs), ...checked }).strict(),
  z.object({ operation: z.literal('page.upload'), args: bare(uploadArgs), ...checked }).strict(),
  z.object({ operation: z.literal('page.dialog'), args: bare(dialogPolicy), ...checked }).strict(),
] as const;
export const batchStep = z.discriminatedUnion('operation',batchVariants);
const popupArgs = z.object({ urlContains: z.string().min(1).optional() }).strict();
export const taskStep = z.discriminatedUnion('operation', [
  batchVariants[0].extend(resultFields), batchVariants[1].extend(resultFields), batchVariants[2].extend(resultFields),
  batchVariants[3].extend(resultFields), batchVariants[4].extend(resultFields), batchVariants[5].extend(resultFields),
  z.object({ operation: z.literal('tabs.wait'), args: popupArgs, ...resultFields }).strict(),
  z.object({ operation: z.literal('page.screenshot'), args: z.object({fullPage:z.boolean().default(false)}).strict(), ...resultFields }).strict(),
  z.object({ operation: z.literal('page.inspect'), args: z.object({...frame,...paging,...observation,textLimit:z.number().int().min(0).max(1000000).default(12000)}).strict(), ...resultFields }).strict(),
  z.object({ operation: z.literal('page.cdp'), args: z.object({method:z.string().regex(/^[A-Za-z]+\.[A-Za-z]+$/),params:z.record(z.string(),z.unknown()).default({}),sessionId:z.string().optional()}).strict(), ...resultFields }).strict(),
  z.object({ operation: z.literal('network.start'), args: z.object({}).strict(), ...resultFields }).strict(),
  z.object({ operation: z.literal('network.stop'), args: z.object({}).strict(), ...resultFields }).strict(),
  z.object({ operation: z.literal('network.body'), args: z.object({requestId:z.string().min(1),sessionId:z.string().optional()}).strict(), ...resultFields }).strict(),
  z.object({ operation: z.literal('network.wait'), args: waitResponseArgs, ...resultFields }).strict(),
  z.object({ operation: z.literal('downloads.start'), args: z.object({url:z.string().url(),filename:z.string().optional()}).strict(), ...resultFields }).strict(),
  z.object({ operation: z.literal('downloads.wait'), args: waitDownloadArgs, ...resultFields }).strict(),
  ...flowSteps,
]);
export const taskPlan = z.object({ name: z.string().trim().min(1).max(100), steps: z.array(taskStep).min(1).max(200), visible: z.boolean().default(false), captureOnFailure: z.boolean().default(true), stepTimeoutMs: z.number().int().min(100).max(120000).default(30000), maxExecutedSteps:z.number().int().min(1).max(10000).default(1000).describe('含循环和控制步骤的总执行上限；达到后停止，不自动重跑。') }).strict();
export const workflowDefinition = taskPlan.extend({ description: z.string().max(1000).default(''), parameters: z.array(z.object({ name: z.string().regex(/^[A-Za-z_\u3400-\u9FFF][A-Za-z0-9_\u3400-\u9FFF]{0,63}$/).describe('中文或英文字母开头，可含数字和下划线。'), description: z.string().max(200).default('') }).strict()).max(40).default([]) });

export interface ToolDefinition {
  name: string; description: string; schema: z.ZodType; operation?: string; readOnly: boolean;
}
function tool(name: string, description: string, schema: z.ZodType, readOnly: boolean, operation?: string): ToolDefinition {
  return { name: `chrome_${name}`, description, schema, readOnly, operation };
}
export const toolDefinitions = [
  ...eventWaitToolDefinitions,
  ...fileTransferToolDefinitions,
  tool('profiles', '列出在线与已知离线 Chrome 配置。先确认名称和 online 状态，再使用明确 profileId；离线不切换其他账号。account 是 Chrome 登录账号；offline 说明离线原因；sameMachine 时上传不限大小。', z.object({}).strict(), true),
  tool('operations', '查询持久操作记录，包括服务重启后结果未知的操作。acknowledged=false 可筛选尚未核查的记录。记录不包含页面正文、脚本或上传内容。', z.object({ ...profile, state: z.enum(['running', 'succeeded', 'failed', 'unknown']).optional(), acknowledged: z.boolean().optional(), ...paging }).strict(), true),
  tool('recover_operation', `在检查实际网页/下载结果后确认某个未知操作。不会重放操作。仅 acknowledged=true 时解除该记录的保护。该操作所在标签页被他人占用时返回 TAB_CLAIMED。${takeover}`, z.object({ operationId: z.string().uuid(), acknowledged: z.literal(true) }).strict(), false),
  tool('rename_profile', '给 Chrome 配置设置清晰名称（例如个人、工作、账号 A）；不改变 Chrome 内的登录账号。', z.object({ ...profile, label: z.string().trim().min(1).max(100) }).strict(), false, 'profile.rename'),
  tool('windows', '列出指定配置的窗口；同一配置内的窗口共用登录态。', z.object(profile).strict(), true, 'windows.list'),
  tool('tabs', '列出指定配置的标签页，支持窗口和 URL/标题过滤、分页。本机管理页对非管理员客户端只显示为受保护标签页，不可操作。', z.object({ ...profile, windowId: z.number().int().optional(), query: z.string().optional(), ...paging }).strict(), true, 'tabs.list'),
  tool('new_tab', '在明确的 Chrome 配置中创建标签页，默认后台打开；可指定窗口。标签页进入本会话的标签组，可以直接写；结果里的 group 是组名，会话结束时组解散、标签页留下。', z.object({ ...profile, url: pageUrl.default('about:blank'), windowId: z.number().int().optional(), active: z.boolean().default(false), ...initScript, timeoutMs: z.number().int().min(100).max(300000).optional().describe('带 initScript 时：先开空白页、登记脚本再打开 url，等页面加载完才返回，这是等待的时限，默认 30000。') }).strict().refine(value => value.timeoutMs === undefined || value.initScript !== undefined, 'timeoutMs 只和 initScript 一起用。'), false, 'tabs.create'),
  tool('close_tab', '关闭指定配置的指定标签页；已经关掉的返回 alreadyClosed。', z.object({ ...target, ...beforeUnload }).strict(), false, 'tabs.close'),
  tool('focus_tab', '激活指定标签页并显示其窗口。', z.object(target).strict(), false, 'tabs.focus'),
  tool('keep_tab', '让标签页不被 Chrome 在内存紧张时自动丢弃（丢弃会打断上传和页面里的作业）；keep:false 恢复默认。后台标签页的定时器仍会被 Chrome 节流，需要密集定时的作业先 focus_tab 放到前台。', z.object({ ...target, keep: z.boolean().default(true) }).strict(), false, 'tabs.keep'),
  tool('claim_tab', '接管已有标签页：移进本会话的标签组并占用。写操作只能在本会话的标签组里，操作不是自己开的标签页前先调用；另一个会话组里的返回 TAB_CLAIMED，用户拖走的返回 TAB_TAKEN_BACK。固定的标签页和用户自己组里的不移动，只记占用。结束时 release，标签页放回原位。', z.object({ ...target, seconds: z.number().int().min(10).max(86400).default(600) }).strict(), false),
  tool('release_tab', `释放本客户端的标签页占用；他人的占用返回 TAB_CLAIMED。${takeover}接管成功时结果带 takenOver:true。`, z.object(target).strict(), false),
  tool('recover_tab', `在人工或代理确认超时后的页面结果后，解除标签页的写入暂停。不会重复之前的操作，仍有操作执行时拒绝恢复。标签页被他人占用时返回 TAB_CLAIMED。${takeover}`, z.object(target).strict(), false),
  tool('detach_tab', '释放本扩展对标签页的调试连接，供 DevTools 或其他浏览器工具使用。', z.object(target).strict(), false, 'tabs.detach'),
  tool('inspect', '读取文字、元素 ref、当前值/勾选/选择/只读状态；元素没写 visible、disabled、readOnly 时分别是可见、可用、可写。密码和常见敏感字段脱敏。支持 frame、范围及 sinceSnapshot 增量；基线失效返回 full。', z.object({ ...target, ...frame, ...paging,...observation,sinceSnapshot:z.string().min(1).max(200).optional(), textLimit: z.number().int().min(0).max(1000000).default(12000) }).strict().refine(oneScope,'scopeSelector 和 scopeRef 只能选一个。'), true, 'page.inspect'),
  tool('find', '按角色、可访问名称、控件标签、文字等查找可见元素，返回 ref、状态、box 和子控件数 controls。名称用 AccName 算法；exact:false 为不区分大小写的包含匹配；按文字找返回最贴近文字的元素。多匹配时收窄或用 nth，不猜测。', z.object({ ...target, ...frame,...observation, selector:z.string().min(1).max(2000).optional().describe('同 locator.inside：只找在这些元素里面的。'), locator: semanticLocator, ...paging }).strict().refine(oneScope,'scopeSelector 和 scopeRef 只能选一个。').refine(v=>!(v.selector&&v.locator.inside),'selector 和 locator.inside 只能给一个。'), true, 'page.find'),
  tool('wait_tab', '等待指定 opener 打开的新标签页，始终限定当前配置。excludeTabIds 使用点击前的标签页清单；多匹配时返回错误，禁止随意选一个。', z.object({ ...profile, openerTabId: z.number().int().nonnegative(), excludeTabIds: z.array(z.number().int().nonnegative()).max(5000), ...popupArgs.shape, ...timeout }).strict(), true, 'tabs.wait'),
  tool('pause_profile', '暂停这个 Chrome 配置并释放调试连接。恢复必须由用户在该配置的扩展中允许连接；不会自动重新接管。', z.object(profile).strict(), false, 'profile.pause'),
  tool('task_submit', '只在用户明确要排队执行时使用。提交账号队列任务，返回 taskId。submissionId 为业务任务生成一次并复用：重复请求返回原任务，内容冲突拒绝；不重放。支持postcondition与flow.if/else/repeat/end/set。saveAs保存data，bindings按args字段路径→变量路径传值，必填字段先填空字符串占位；禁止脚本/目标绑定。变量只在内存，失败即停。自动管理租约，提交前释放已有claim。', z.object({ ...target, ...taskPlan.shape,submissionId:submissionIdentity }).strict(), false),
  tool('tasks', '按账号、状态和名称查询任务，支持分页；记录不包含输入值或脚本。', z.object({ ...profile, ...paging, status: z.enum(['queued','running','pausing','paused','cancelling','cancelled','succeeded','failed','needs_review','interrupted']).optional(), query: z.string().max(100).default('') }).strict(), true),
  tool('task', '查看任务步骤、完成的 operationId 和故障截图引用。中断后不能据此自动重放。', z.object({ ...profile, taskId: z.string().uuid() }).strict(), true),
  tool('task_control', '暂停、继续或取消自己的任务；管理员可管理全部。暂停/取消在当前步骤结束后生效，已发出的动作不可撤回。离线后需显式继续，失败/未知/重启中断任务禁止自动重跑。', z.object({ ...profile, taskId: z.string().uuid(), action: z.enum(['pause', 'resume', 'cancel']) }).strict(), false),
  tool('task_diagnostics', '导出这个任务的脱敏诊断：步骤、操作状态、连接版本与处理指引。不包含参数、脚本、页面或凭据，截图只返回引用。', z.object({ ...profile, taskId: z.string().uuid() }).strict(), true),
  tool('task_recovery', '为已停止任务生成剩余步骤的编辑依据。fromStep 从 0 起；必须先核查页面。不会解除未知保护或执行动作，参数需重新输入。', z.object({ ...profile, taskId: z.string().uuid(), fromStep: z.number().int().min(0).max(199) }).strict(), true),
  tool('workflows', '列出限定账号的活动或归档流程，定义不跨账号共享；summary=true 只返回名称、说明、参数与步数，完整内容用 workflow_get。', z.object({ ...profile, ...paging, archived: z.boolean().default(false), summary: z.boolean().default(false) }).strict(), true),
  tool('workflow_save', '只在用户明确要保存流程时使用。按用户意图新建流程，或用 workflowId + expectedRevision 编辑新版本。支持 {{参数名}}；禁止 JS 插值、临时 ref/context 和保存密码/令牌。', z.object({ ...profile, definition: workflowDefinition, workflowId: z.string().uuid().optional(), expectedRevision: z.string().min(1).max(200).optional() }).strict().refine(v => !!v.workflowId === !!v.expectedRevision, '编辑需同时提供 workflowId 和 expectedRevision。'), false),
  tool('workflow_get', '读取明确账号的流程定义，revision 可指定历史版本；归档流程也可读取。', z.object({ ...profile, workflowId: z.string().uuid(), revision: z.string().min(1).max(200).optional() }).strict(), true),
  tool('workflow_history', '查看流程当前状态与历史版本清单，不执行流程。', z.object({ ...profile, workflowId: z.string().uuid() }).strict(), true),
  tool('workflow_copy', '明确复制流程并命名，可指定另一个已授权账号；副本有独立身份与历史，不执行页面动作。', z.object({ ...profile, workflowId: z.string().uuid(), name: z.string().trim().min(1).max(100), toProfileId: z.string().min(1).optional() }).strict(), false),
  tool('workflow_archive', '归档或恢复单个流程；已提交任务保留原计划。expectedRevision 防止覆盖其他编辑，归档后不再允许运行。', z.object({ ...profile, workflowId: z.string().uuid(), expectedRevision: z.string().min(1).max(200), archived: z.boolean() }).strict(), false),
  tool('workflow_restore', '把某个历史版本恢复为一个新版本，保留完整历史。提供当前 expectedRevision，归档流程需先恢复活动状态。', z.object({ ...profile, workflowId: z.string().uuid(), revision: z.string().min(1).max(200), expectedRevision: z.string().min(1).max(200) }).strict(), false),
  tool('workflow_remove', '经用户明确要求永久删除一个已归档流程及版本历史。此动作不可撤回；不取消已提交任务。', z.object({ ...profile, workflowId: z.string().uuid(), expectedRevision: z.string().min(1).max(200), confirmed: z.literal(true) }).strict(), false),
  tool('workflow_preview', '只预览参数展开后的步骤；可读历史 revision，不执行网页动作。workflow_run 只接受当前活动版本。', z.object({ ...profile, workflowId: z.string().uuid(), revision: z.string().min(1).max(200).optional(), parameters: z.record(z.string(), z.string().max(100000)).default({}) }).strict(), true),
  tool('workflow_run', '按已预览 revision 将流程加入账号/标签队列。参数不写入历史。同一 submissionId 重试（内容不变）返回原任务（deduplicated），流程事后被编辑或归档也一样；没有收据的新请求在流程变更或归档后拒绝运行。', z.object({ ...target, workflowId: z.string().uuid(), revision: z.string().min(1), parameters: z.record(z.string(), z.string().max(100000)).default({}),submissionId:submissionIdentity }).strict(), false),
  tool('accessibility', '读取 Chrome 原生无障碍树，默认有预算的分页摘要；raw 获取完整树，敏感输入框的值已隐藏，大结果保存后用 read_result 读取。', z.object({ ...target, sessionId: z.string().optional(),...paging,...diagnostics }).strict(), true, 'page.snapshot'),
  tool('contexts', '列出页面、同进程 iframe 和跨进程 iframe 的执行上下文及子会话；使用 contextId/sessionId 指定后续操作。', z.object(target).strict(), true, 'contexts.list'),
  tool('screenshot', '截图页面、整页、元素（selector/ref/locator）或 clip（默认页面坐标）。savePath 存成 .png，returnImage:false 不回图。后台标签页不切到前台；最小化的窗口临时恢复，结束后还原。', z.object({ ...target, fullPage: z.boolean().default(false), ...locator, clip: clip.optional(), clipViewport: z.boolean().optional().describe('clip 按视口坐标给（和 find 的 box、视口截图的图片坐标一致），页面滚动后不用自己加滚动距离；结果的 area 仍是页面坐标。'), scale: z.number().min(0.1).max(1).optional().describe('图片按比例缩小，省 token；coordinates 带 scale，图片坐标先除以它再换算。'), ...output, returnImage: z.boolean().default(true) }).strict().refine(value => [value.fullPage, !!(value.selector || value.ref || value.locator), !!value.clip].filter(Boolean).length <= 1 && [value.selector, value.ref, value.locator].filter(Boolean).length <= 1, 'fullPage、元素定位、clip 只能选一种。').refine(value => !value.clipViewport || !!value.clip, 'clipViewport 要和 clip 一起用。'), true, 'page.screenshot'),
  tool('navigate', '在指定标签页导航；action 默认 goto（需 url），或 back/forward/reload。默认等待本次文档完成；没有历史项时明确拒绝，不会因超时重复导航。', navigateArgs.safeExtend({ ...target, ...timeout, ...initScript }).refine(value => !(value.initScript !== undefined && value.wait === false), 'initScript 要等本次文档加载完才撤销，不能和 wait:false 一起用。'), false, 'page.navigate'),
  tool('action', '执行 click/doubleClick/drag/setChecked/choose/hover/fill/type/press/scroll/select。拖拽起终点必须同frame，setChecked已达目标不点击。默认仅派发前等待可见、可用/可编辑，指针另查稳定与遮挡；派发后不重试。支持 iframe。scroll 在元素（selector/ref/locator）中心或 x,y（缺省 0,0）处发滚轮，deltaY 默认 600，只给 deltaX 时 deltaY 为 0；modifiers 随 click/hover/scroll 的鼠标事件发送。type的focusVerified只核对派发后焦点（页面自行跳格时为 false，不算失败），value是派发后字段的内容（编辑器可能改写）；用postcondition核验结果。结果带pageChange：动作后最多约0.8秒内的新文字、新控件、已有控件的状态和URL变化，看得出结果就不用再读页面；changed:false只说明这段时间没看到变化，慢请求用wait。observe:false关闭。', actionArgs.safeExtend({ ...target, ...timeout, observe: z.boolean().default(true), postcondition: bare(postcondition).optional().describe('动作做完后核对页面，等跳转用 urlContains：满足时结果带 url、title；没满足报 POSTCONDITION_TIMEOUT，动作已做完、不要重复，标签页照常可写。核对包含在 timeoutMs 内。') }), false, 'page.action'),
  tool('evaluate', '在页面上下文执行 JavaScript 表达式，等待 Promise，可读写页面及调用页面 fetch。不是本机 Node.js；可能改变页面/服务端状态。readOnly:true 时由 Chrome 拦下副作用，标签页暂停写入时也能用；被拦返回 SIDE_EFFECT_BLOCKED。改动页面前就抛错的不算结果不明。长抓取用 job_start；savePath 存成文件。', z.object({ ...target, ...evalArgs.shape, ...output, ...timeout }).strict(), false, 'page.evaluate'),
  tool('job_start', '在页面里启动后台作业，立即返回 jobId。脚本的结果是 Promise、值，或接收 report(进度) 的函数；作业里的异常只在 job_status 报，不暂停标签页。页面导航后作业丢失。', z.object({ ...target, expression: z.string().min(1), ...timeout }).strict(), false, 'page.jobStart'),
  tool('job_status', '查看 job_start 的作业：state、进度、结果；waitMs 内等它结束。savePath 把结果存成文件。', z.object({ ...target, jobId: z.string().uuid(), waitMs: z.number().int().min(0).max(300000).default(0), ...output }).strict(), true),
  tool('wait', '本地等待元素可见或 JavaScript 条件成立，无需模型逐次轮询。表达式有执行能力，应仅用于条件判断；readOnly:true 由 Chrome 拦下副作用。结构化条件和 readOnly 表达式在标签页暂停写入时也能用。单次最多 300 秒，更久用 job_status。', waitArgs.safeExtend({ ...target, ...timeout }), false, 'page.wait'),
  tool('batch', '一次顺序执行多步 action/evaluate/wait/navigate/upload/dialog，固定 profileId/tabId。action/evaluate 后的 dialog 为一次预声明，接受时必须匹配类型和文本。失败即停，保留已完成步骤，不自动重试或回滚。结果带整批的 pageChange，含义同 action；observe:false 关闭。', z.object({ ...target, steps: z.array(batchStep).min(1).max(200), ...timeout, observe: z.boolean().default(true) }).strict(), false, 'page.batch'),
  tool('network_start', '开始捕获指定标签页的网络事件；请在触发请求前调用，无法追回之前的网络流量。', z.object(target).strict(), false, 'network.start'),
  tool('network_stop', '停止指定标签页的网络捕获。', z.object(target).strict(), false, 'network.stop'),
  tool('events', '读取网络/控制台/弹窗等事件，默认预算摘要；raw 保留原事件结构，认证类请求头、Cookie 和请求体已隐藏。since 用上页 latestSequence，headSequence 是缓存末端；droppedBefore 表示丢失范围。', z.object({ ...profile, tabId: z.number().int().optional(), since: z.number().int().nonnegative().default(0), method: z.string().optional(), urlContains: z.string().min(1).optional().describe('只看网址含这段的请求（发出、响应、结束整组）和事件。'), resourceType: z.string().min(1).optional().describe('只看这类请求：XHR、Fetch、Document、Script…'), ...paging,...diagnostics }).strict(), true),
  tool('network_body', '根据 Network 事件中的 requestId 获取响应体（可能为 base64）。需在浏览器缓冲区过期之前读取；大结果自动保存。', z.object({ ...target, requestId: z.string().min(1), sessionId: z.string().optional() }).strict(), true, 'network.body'),
  tool('upload', '把文件设进 file input，不弹系统选择框，支持 iframe。目标可以是文件框，也可以是看得见的上传按钮或区域（用它里面或最近的文件框；分不出时点它，用页面打开的那个）。paths 是服务所在电脑的绝对路径：sameMachine 的浏览器不限大小，其他单文件 100 MiB，跨机器优先用 file_begin/write/commit 的 transferIds。', uploadArgs.safeExtend({ ...target, ...timeout }), false, 'page.upload'),
  tool('download', '使用指定 Chrome 配置开始下载，返回 downloadId；filename 为下载目录中的相对路径。用 downloads 查看完成状态。', z.object({ ...profile, url: z.string().url(), filename: z.string().optional() }).strict(), false, 'downloads.start'),
  tool('site_permission', '查看或设置网站的自动下载（“此网站想下载多个文件”）或弹窗权限，只影响这个 origin；不给 setting 只查看。url 和 tabId 二选一。', z.object({ ...profile, url: z.string().url().optional(), tabId: z.number().int().nonnegative().optional(), permission: z.enum(['automaticDownloads', 'popups']).default('automaticDownloads').describe('popups：页面等请求回来才 window.open（导出常这样），Chrome 当弹窗拦下时设 allow。'), setting: z.enum(['allow', 'block', 'ask']).optional() }).strict().refine(value => !!value.url !== (value.tabId !== undefined), 'url 和 tabId 二选一。').refine(value => value.permission !== 'popups' || value.setting !== 'ask', '弹窗只有 allow 和 block。'), false, 'site.permission'),
  tool('downloads', '查看指定配置的下载状态、文件位置与错误；可按 downloadId 定位，页面触发的带 tabId。', z.object({ ...profile, downloadId: z.number().int().optional(), limit: z.number().int().min(1).max(1000).default(50) }).strict(), true, 'downloads.list'),
  tool('dialog', '响应已观察到的 JavaScript 弹窗；可用 dialogId/expectedType/expectedMessage 核对。批次/队列中紧跟 action/evaluate 的 dialog 是只消费一次的预声明策略，预声明 accept=true 必须给 expectedType 和 expectedMessage。框由本客户端的 action/batch 弹出时，答完原操作不再算结果未知，结果带 pageChange；writable 表示标签页能否继续写入，别的未知操作不受影响。', dialogArgs.extend(target), false, 'page.dialog'),
  tool('cdp', '执行 Chrome 扩展 debugger 支持的标签页 CDP 命令，如 DOM、Runtime、Network、Fetch、Input、Storage。Browser 和跨目标 Target 操作不支持；不会隐式切换账号。可能有副作用。文件类方法与 upload 受同样的路径限制。', z.object({ ...target, method: z.string().regex(/^[A-Za-z]+\.[A-Za-z]+$/), params: z.record(z.string(), z.unknown()).default({}), sessionId: z.string().optional(), ...timeout }).strict(), false, 'page.cdp'),
  tool('save_result', '把之前保存的结果（artifactId）写成服务所在电脑上的文件：JSON 结果存成 .json/.txt，截图存成 .png。', z.object({ artifactId: z.string().uuid(), path: z.string().min(1).max(4096), overwrite: z.boolean().optional() }).strict(), false),
  tool('read_result', '分页读取之前保存的大结果；offset/limit 的单位是 Unicode 字符（JS UTF-16）。截图类结果直接返回图片。仅允许本服务生成的 artifactId。', z.object({ artifactId: z.string().uuid(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(1000000).default(24000) }).strict(), true),
];

// 任务和流程工具不进默认目录：它们的说明占全部工具说明的一半以上，Agent 也用不到；另存结果、保持标签页也很少用到。这只是目录，不是授权；管理页走 service.invoke，不受影响。
export const isAdvancedTool = (name: string) => /^chrome_(workflow|task|save_result$|keep_tab$)/.test(name);

export const toolMap = new Map(toolDefinitions.map(definition => [definition.name, definition]));
