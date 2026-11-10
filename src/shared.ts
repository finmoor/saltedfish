export type JsonObject = Record<string, unknown>;
// outcome：not_dispatched 没有向页面派发任何输入；unknown 可能已经生效，暂停这个标签页的写入；
// dispatched 动作已经派发并执行完，失败的是之后的核对（后置条件、选项没出现），不暂停写入，但也不要重复这一步。
export interface ErrorDetails { phase?: 'precondition' | 'execution' | 'postcondition'; outcome?: 'not_dispatched' | 'unknown' | 'dispatched'; detail?: JsonObject }
export interface ErrorInfo extends ErrorDetails { code:string;message:string }
// 明确的“尚未向页面派发任何输入”：服务端据此把失败记为 failed，而不是 unknown 并隔离标签页。只用于确实发生在派发之前的拒绝。
export const NOT_DISPATCHED: Readonly<ErrorDetails> = Object.freeze({ phase: 'precondition', outcome: 'not_dispatched' });

export interface ProfileInfo {
  id: string;
  label: string;
  instanceId: string;
  version: string;
  /** 后台代码编译进去的版本（扩展 0.3.21 起）。比 version（manifest）旧说明 Chrome 沿用了旧的后台脚本，见 staleCodeHint。 */
  codeVersion?: string;
  userAgent: string;
  capabilities?: string[];
  connectedAt?: string;
  online?: boolean;
  connectionType?: 'direct' | 'legacy';
  /** Chrome 登录的 Google 账号邮箱（扩展 0.3.15 起，没登录 Chrome 就没有）；不是网站账号。 */
  account?: string;
  /** 浏览器和服务在同一台电脑：直连从本机地址进来，且浏览器的操作系统和服务一致。上传据此直接把本机路径交给 Chrome。 */
  sameMachine?: boolean;
}

export interface Target {
  profileId: string;
  tabId: number;
}

export interface WireCommand {
  type: 'command';
  id: string;
  operation: string;
  args: JsonObject;
  deadline: number;
  timeoutMs?: number;
}

export interface WireReply {
  type: 'result';
  id: string;
  result?: unknown;
  error?: ErrorInfo;
}

export interface BrowserEvent {
  sequence: number;
  profileId: string;
  tabId?: number;
  method: string;
  params: JsonObject;
  time: string;
}

export class BrowserError extends Error {
  constructor(public code: string, message: string, public details:ErrorDetails = {}) {
    super(message);
    this.name = 'BrowserError';
  }
}

// 错误消息的上限。页面抛出的错误可能有几百 KB（ReferenceError 会回显整个标识符），给模型看没有用，
// 扩展发送前、服务收到后都截到这个长度；超过桥接帧的上限曾让整条连接断开。
export const ERROR_MESSAGE_LIMIT = 8000;
export function clipMessage(text: string, limit = ERROR_MESSAGE_LIMIT): string {
  if (text.length <= limit) return text;
  const marker = `…（消息已截断，原长 ${text.length} 字）`;
  let end = Math.max(0, limit - marker.length);
  // 不把代理对拆成半个字符。
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end) + marker;
}

// javascript: 地址交给导航，就是在当前页面执行代码，结果没法确认（标签页会暂停写入）。导航和新标签页在派发前拒绝它。
export const SCRIPT_URL_MESSAGE = 'javascript: 地址会在页面里执行代码，不当导航用，未派发；要执行脚本用 chrome_evaluate。';
export function isScriptUrl(url: string): boolean {
  try { return new URL(url).protocol === 'javascript:'; } catch { return /^[\s\u0000-\u001f]*javascript:/i.test(url); }
}
// 本机文件网址（file:，含 view-source:file:、filesystem:file:）。非管理员不能让浏览器打开它们：
// 手动加载的扩展默认有文件网址访问权，打开 SaltedFish 数据目录里的 config.json 就能读到管理员令牌（2026-11-06 全局评审 U55）。
export function isLocalFileUrl(url: unknown): boolean {
  return typeof url === 'string' && /^[\s\u0000-\u001f]*(?:view-source:[\s\u0000-\u001f]*)?(?:filesystem:[\s\u0000-\u001f]*)?file:/i.test(url);
}
export const LOCAL_FILE_URL_MESSAGE = '非管理员客户端不能让浏览器打开本机文件（file: 网址）。本机文件用 Agent 自己的工具读，上传用 chrome_upload。尚未向浏览器派发。';

// zod 的校验错误默认把 issue 数组 JSON 化当消息；对外只说哪个字段、什么问题。路径为空（顶层多了字段）时不带前缀。
// 按名字认，不 import zod：扩展也用这个文件，不该把 zod 打进扩展。
interface ValidationIssue { path?: PropertyKey[]; message: string }
const validationIssues = (error: unknown): ValidationIssue[] | undefined =>
  error instanceof Error && error.name === 'ZodError' && Array.isArray((error as { issues?: unknown }).issues) ? (error as unknown as { issues: ValidationIssue[] }).issues : undefined;
export function validationMessage(issues: ValidationIssue[]): string {
  return clipMessage(issues.map(issue => (issue.path?.length ? issue.path.map(String).join('.') + ': ' : '') + issue.message).join('; ') || '参数无效。', 3000);
}

export function errorInfo(error: unknown): ErrorInfo {
  const issues = validationIssues(error);
  return {
    code: error instanceof BrowserError ? error.code : 'OPERATION_FAILED',
    message: clipMessage(issues ? validationMessage(issues) : error instanceof Error ? error.message : String(error)),
    ...(error instanceof BrowserError ? error.details : {}),
  };
}

// 只有明确的派发前失败可以解除不确定性；普通脚本异常不能证明没有副作用。
export function unknownResult(error?:ErrorInfo) {
  if(error?.outcome==='not_dispatched'||error?.outcome==='dispatched')return false;
  if(error?.outcome==='unknown')return true;
  return !!error;
}

// 字段名或可访问名称命中这些词就按敏感字段处理；页面读取、raw 输出和流程保存用同一口径。
export const SENSITIVE_FIELD = /(?:password|passwd|secret|token|api[\s_-]*key|credential|authorization|\botp\b|\bcvv\b|\bcvc\b|card[\s_-]*number|密码|口令|令牌|密钥|验证码|校验码|卡号|安全码)/i;

export function pageItems<T>(items: T[], offset = 0, limit = 50) {
  return {
    items: items.slice(offset, offset + limit), total: items.length,
    nextOffset: offset + limit < items.length ? offset + limit : null,
  };
}

// ---- 本机管理页保护 ----
// 管理页的 sessionStorage 随标签页保留，标签页跨站往返后仍在，所以不能只在 claim 时判断：
// 服务端对非管理员主体在每条命令里附带管理页 origin 列表，扩展按“派发时读到的标签页当前 URL”逐步核对。
export const ADMIN_GUARD_MARKER = 'SALTEDFISH_ADMIN_PAGE_PROTECTED';
export const adminOrigins = (port: number): string[] => [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
// 浏览器里 chrome-extension:// 的 origin 是 scheme+host，而 Node 的 URL 对非特殊协议返回 'null'；统一按 scheme+host 取。
// 没有主机的地址（about:、data:、file:）得到空串，永远不会和任何保护的 origin 相等。
export function originOf(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  try { const url = new URL(value); return url.origin !== 'null' ? url.origin : url.host ? `${url.protocol}//${url.host}` : ''; } catch { return ''; }
}
export function isProtectedUrl(value: unknown, origins: readonly string[]): boolean {
  const origin = originOf(value);
  return !!origin && origins.includes(origin);
}
// 前置到页面脚本最前面，与脚本在同一个任务里核对 origin，消除“检查之后页面才跳转到管理页”的竞态。
// 抛出原始字符串，不依赖页面可以改写的 Error；脚本其余部分的完成值语义不变。
export function adminGuardPrefix(origins: readonly string[]): string {
  return origins.length ? `if(${origins.map(origin => `location.origin===${JSON.stringify(origin)}`).join('||')})throw ${JSON.stringify(ADMIN_GUARD_MARKER)};` : '';
}
export const hiddenTabTitle = '(SaltedFish 本机管理页，内容受保护)';
// 标签页仍可见，避免“标签凭空消失”的困惑，但 URL（可能带登录片段）和标题不再暴露。
export function hideAdminTab<T extends JsonObject>(tab: T, origins: readonly string[]): T {
  return isProtectedUrl(tab.url, origins) || isProtectedUrl(tab.pendingUrl, origins) ? { ...tab, url: '', ...(tab.pendingUrl !== undefined ? { pendingUrl: '' } : {}), title: hiddenTabTitle, adminPage: true } : tab;
}
// 结果树里（列表、嵌套的批次结果）任何指向管理页的标签页信息都隐藏；深度有限，只在没有命中的分支原样返回。
export function hideAdminTabs(value: unknown, origins: readonly string[], depth = 0): unknown {
  if (Array.isArray(value)) return value.map(item => hideAdminTabs(item, origins, depth));
  if (!value || typeof value !== 'object' || depth > 4) return value;
  const record = value as JsonObject;
  if (isProtectedUrl(record.url, origins) || isProtectedUrl(record.pendingUrl, origins)) return hideAdminTab(record, origins);
  let changed: JsonObject | undefined;
  for (const [key, item] of Object.entries(record)) { const next = hideAdminTabs(item, origins, depth + 1); if (next !== item) (changed ??= { ...record })[key] = next as JsonObject[string]; }
  return changed ?? record;
}

// ---- 扩展桥接握手（v2）：双向挑战应答，配对密钥从不在线上明文传输 ----
export const BRIDGE_PROTOCOL = 2;
export const BRIDGE_NONCE = /^[a-f0-9]{32}$/;
export const BRIDGE_PROOF = /^[a-f0-9]{64}$/;
export type BridgeRole = 'server' | 'client';
// 服务端证明绑定双方 nonce；扩展证明还绑定它声明的身份，换身份不能复用同一个证明。
export function bridgeProofInput(role: BridgeRole, clientNonce: string, serverNonce: string, profileId = '', instanceId = ''): string {
  return ['saltedfish-bridge-v2', role, clientNonce, serverNonce, profileId, instanceId].join('\n');
}
// 扩展更新的证明：服务用配对密钥签下版本、包的哈希和扩展这次给的随机数。服务地址常是未加密的内网 HTTP，更新包本身不鉴权，真假靠这个证明和哈希。
export function extensionUpdateProofInput(profileId: string, nonce: string, version: string, sha256: string): string {
  return ['saltedfish-extension-update-v1', profileId, nonce, version, sha256].join('\n');
}

// ---- 扩展与服务的能力名（协议字面量的单一事实源）----
// 扩展在握手里声明自己支持的能力，服务按操作逐项核对（src/service.ts）；服务在 ready 帧里公布自己的能力，扩展据此判断服务是否够新。
// 新增能力只改这里：扩展声明、服务公布、两端的最低要求和测试替身都由这些常量派生，其他位置不要再手写字符串（tests/capabilities.test.ts 守卫）。
export const CAPABILITY = {
  semanticLocators: 'semantic-locators', structuredWait: 'structured-wait', popupWait: 'popup-wait', pauseControl: 'pause-control',
  activity: 'activity', dialogControl: 'dialog-control', elementStateV2: 'element-state-v2', frameCoordinatesV2: 'frame-coordinates-v2',
  executionV2: 'execution-v2', executionV3: 'execution-v3', interactionV4: 'interaction-v4', interactionV5: 'interaction-v5',
  interactionV6: 'interaction-v6', interactionV7: 'interaction-v7', adminOriginV1: 'admin-origin-v1',
  fileContentV1:'file-content-v1',
  browserFileReadV1:'browser-file-read-v1',
  readOnlyEvalV1:'read-only-eval-v1',
  selfUpdateV1:'self-update-v1',
  tabGroupsV1:'tab-groups-v1',
  evaluateV2:'evaluate-v2',
  screenshotV2:'screenshot-v2',
  downloadsV2:'downloads-v2',
  tabKeepV1:'tab-keep-v1',
  interactionV8:'interaction-v8',
  sitePermissionV2:'site-permission-v2',
  screenshotV3:'screenshot-v3',
  interactionV9:'interaction-v9',
  interactionV10:'interaction-v10',
  initScriptV1:'init-script-v1',
  storeBuild:'store-build',
} as const;
export type Capability = typeof CAPABILITY[keyof typeof CAPABILITY];
const C = CAPABILITY;
// 扩展声明的全部能力。activity 目前只是声明，没有服务端消费方。
// interaction-v6：click/hover/scroll 的 modifiers 随鼠标事件发送；scroll 支持元素定位，只给 deltaX 时 deltaY 为 0。服务只在请求真正用到这些语义时才要求它。
// read-only-eval-v1：表达式带 readOnly 时由 Chrome 拦截副作用。服务据此放行暂停写入的标签页，旧扩展会照常执行，所以只有请求用到时才要求它。
// self-update-v1：扩展能在设置页里自己更新。管理页据此决定提示点“更新”还是手动覆盖文件夹。
// site-permission-v2：site_permission 能设弹窗（popups）。旧扩展不认 permission，会改成自动下载设置，所以用到时才要求。
// screenshot-v3：截图的 clipViewport、scale。旧扩展会忽略它们，把 clip 当页面坐标、按原尺寸出图，所以用到时才要求。
// interaction-v8：choose 动作、locator.nth、scopeRef、条件的 match:any/all、批次里 page.wait 的 timeoutMs。旧扩展会忽略这些字段按旧语义执行（scopeRef 被忽略就读了整页），所以用到时才要求。
// interaction-v9：条件的 textMatches（正则）、chrome_action 的 postcondition。旧扩展会忽略这两个字段：只给 textMatches 的等待立刻算成立，动作不核对就报成功，所以用到时才要求。
// interaction-v10：locator.inside、条件的 state:"attached"。旧扩展会忽略 inside 在整页里找（可能点到范围外的同名元素），attached 当成 visible 一直等，所以用到时才要求。
//   同版扩展还会：上传的目标不是文件框时用它里面或最近的文件框，按坐标点击的结果带点中的元素，整页截图标出固定元素画在哪；这几样旧扩展只是没有，不用判断。
// init-script-v1：navigate、new_tab 的 initScript（新文档加载前在主世界执行的脚本）。旧扩展会忽略它照常导航，钩子没装上调用方也不知道，所以用到时才要求。
// evaluate-v2：evaluate 支持 replMode。screenshot-v2：元素截图和 clip。downloads-v2：下载带来源标签页、等标签页的下一次下载、按站点设置自动下载。tab-keep-v1：标签页不被自动丢弃。旧扩展会忽略这些参数照旧执行或不认识操作，所以只在请求用到时才要求。
export const EXTENSION_CAPABILITIES: readonly Capability[] = [C.semanticLocators, C.structuredWait, C.popupWait, C.pauseControl, C.activity, C.dialogControl, C.elementStateV2, C.frameCoordinatesV2, C.executionV3, C.interactionV4, C.interactionV5, C.adminOriginV1, C.interactionV6, C.interactionV7,C.fileContentV1,C.browserFileReadV1, C.readOnlyEvalV1, C.selfUpdateV1, C.tabGroupsV1, C.evaluateV2, C.screenshotV2, C.downloadsV2, C.tabKeepV1, C.interactionV8, C.sitePermissionV2, C.screenshotV3, C.interactionV9, C.initScriptV1, C.interactionV10];
// Chrome 应用商店版（extension/build-target.ts）由商店更新：不声明 self-update-v1，改声明 store-build，管理页据此提示从应用商店更新。数量不变，旧服务也接受（只校验字符串和个数）。
export function extensionCapabilities(store:boolean):Capability[]{return store?[...EXTENSION_CAPABILITIES.filter(item=>item!==C.selfUpdateV1),C.storeBuild]:[...EXTENSION_CAPABILITIES];}
// 扩展要求服务具备的能力：缺任何一项，扩展拒绝执行动作（SERVICE_UPDATE_REQUIRED）。
export const EXTENSION_REQUIRES_SERVER: readonly Capability[] = [C.executionV3, C.interactionV4, C.interactionV5, C.adminOriginV1];
// 服务在 ready 帧里公布的能力。execution-v2 在仓库内已没有消费方，保留是为了更早的扩展构建仍能连上。
export const SERVER_CAPABILITIES: readonly Capability[] = [C.executionV2, ...EXTENSION_REQUIRES_SERVER];
// 管理页据以提示“需要刷新扩展”的最低扩展能力（/health 的 requiredExtensionCapability）。更高的能力由服务按请求单独要求，不抬高这条基线，避免无谓的强制刷新。
export const REQUIRED_EXTENSION_CAPABILITY: Capability = C.interactionV5;
