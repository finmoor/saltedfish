import { hideAdminTabs, BrowserError, errorInfo, isProtectedUrl, isScriptUrl, isLocalFileUrl, LOCAL_FILE_URL_MESSAGE, SCRIPT_URL_MESSAGE, originOf, adminGuardPrefix, ADMIN_GUARD_MARKER, NOT_DISPATCHED, type JsonObject } from '../src/shared';
import { elementExpression, inspectExpression, findExpression, documentExpression,conditionExpression,waitContextExpression } from './page-functions';
import { WindowLocks } from './window-lock';
import { Dialogs } from './dialogs';
import { framePoint } from './frame-point';
import { IsolatedRuntime, WORLD_NAME } from './isolated-runtime';
import { textInput } from './text-input';
import { navigatePage } from './navigation';
import { initScriptRegistration, initScriptSource } from './init-script';
import { keyboardKey, modifierFlag, modifierKeys, type KeyboardKey } from './keyboard';
import { inputTargetExpression, type InputTarget } from './input-target';
import { ACTION_SETTLE_MS, INPUT_SETTLE_MS, PageChanges } from './page-change';
import { needsViewportOperation } from '../src/interaction-policy';
import { dragPointer, assertPointUnchanged, samePoint, nearPoint, PRESSED_FORCE, type PointerPoint } from './pointer-actions';
import { aimRatio, mousePath, startPoint, wheelSteps, pause, keyGap, type PathPoint } from './human-input';
import {browserUploads,uploadContent} from './upload-content';
import {DownloadTabs} from './download-tabs';
import {JOB_REGISTER_FUNCTION} from '../src/page-jobs';
import {AgentCursor,type CursorBox} from './agent-cursor';
import { BackgroundPopups } from './background-popups';

type Emit = (method: string, params: JsonObject, tabId?: number) => void;
let emit: Emit = () => {};
let downloadTabs = new DownloadTabs(() => {});
const attached = new Set<number>();
const attaching = new Map<number, Promise<void>>();
// 程序发起的 detach：记请求时间，等 onDetach 事件消费；Chrome 对程序 detach 与用户取消都报 canceled_by_user，事件可能晚于返回很久。
const expectedDetach = new Map<number, number>();
const EXPECTED_DETACH_MS = 15000;
const contexts = new Map<number, Map<string, JsonObject>>();
const childSessions = new Map<number, Set<string>>();
const isolated = new IsolatedRuntime(send,tabId=>[...(contexts.get(tabId)?.values()||[])]);
const active = new Set<number>();
// 开着焦点模拟的标签页（服务经 page.cdp 开的，或 useViewport 自己补开的），调试会话断开时 Chrome 自己就关了。
// 后台标签页靠它出帧、收输入，视觉动作因此不用切到前台。
const focusEmulated = new Set<number>();
const windowLocks = new WindowLocks();
// Agent 的后台标签页弹出的新标签页不盖住用户正在看的标签页。
const backgroundPopups = new BackgroundPopups({ activate: tabId => chrome.tabs.update(tabId, { active: true }), get: tabId => chrome.tabs.get(tabId) });
const cursor = new AgentCursor(send);
const dialogs = new Dialogs((tabId, args, sessionId) => send(tabId, 'Page.handleJavaScriptDialog', args, sessionId));
const pageChanges = new PageChanges({evaluate:evaluateInternal,sleep:ms=>sleep(ms),tab:async(tabId,frame)=>{
  const tab=await chrome.tabs.get(tabId),origins=guardOrigins(frame);
  return origins&&(isProtectedUrl(tab.url,origins)||isProtectedUrl(tab.pendingUrl,origins))?{status:tab.status}:tab;
}});
let controlEpoch = 0;
// 只有页面类目标（跨进程 iframe 等）有 Page 域和 frame 树，才登记为子会话；dedicated worker 等没有 Page 域，登记后 framePoint 遍历子会话会抛出未分类的原始错误。
// 缺少 targetInfo.type 时按旧行为接纳（真实 Chrome 总会给出）；framePoint 对单个会话的失败另有防御。
const PAGE_TARGET_TYPES = new Set(['page', 'iframe']);
const isPageTarget = (info: unknown) => { const type = (info as JsonObject | undefined)?.type; return typeof type !== 'string' || PAGE_TARGET_TYPES.has(type); };
export function cancelOperations() { controlEpoch++;browserUploads.clear(); }
// 后台按扩展设置打开；默认关着，设置读到之前不画。
export function setCursorShown(on: boolean) { cursor.setEnabled(on); }
// 像真人一样操作（扩展设置，默认开）：鼠标沿轨迹移过去、落点偏离中心、按住几十毫秒、短文本逐键打。关掉时只剩按下的 pressure，节奏和以前一样。
let humanInput = true;
export function setHumanInput(on: boolean) { humanInput = on; }
// 每个输入会话（主页面、跨进程 iframe）里鼠标最后停在哪：下一次从这里移过去。
const pointers = new Map<string, PathPoint>();
const pointerKey = (tabId: number, sessionId?: string) => `${tabId}|${sessionId || ''}`;
function forgetPointer(tabId: number, sessionId?: string) { if (sessionId !== undefined) pointers.delete(pointerKey(tabId, sessionId)); else for (const key of [...pointers.keys()]) if (key.startsWith(`${tabId}|`)) pointers.delete(key); }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// CDP 的 timeout 只终止同步执行，管不住 awaitPromise 的等待：页面里永不结束的 Promise 会让调用一直挂着，
// 标签页的占用释放不了，恢复和关闭都会被拒绝。所以到期由这里保证，不依赖 CDP 回复。
const SCRIPT_GRACE_MS = 200, WATCHDOG_GRACE_MS = 500;
function settleBy<T>(work: Promise<T>, at: number, expired: () => Promise<never>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => { expired().catch(reject); }, Math.min(2 ** 31 - 1, Math.max(0, at - Date.now()))); });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}
const failureText = (error: unknown) => error instanceof Error ? error.message : String(error);
// 下面两类是 Chrome 在动作发生之前的拒绝，可以确定没有执行；其他失败不能证明没有副作用，仍按结果未知处理。
const tabMissing = (error: unknown) => /^No tab with id/.test(failureText(error));
const tabGone = () => new BrowserError('TAB_NOT_FOUND', '指定标签页不存在，不回退到活动标签。', NOT_DISPATCHED);
// 方法不存在、参数不合法这些协议层错误，命令没有进入执行。
const CDP_REJECTIONS = new Set([-32600, -32601, -32602, -32700]);
function cdpRejection(error: unknown) {
  try { const reply = JSON.parse(failureText(error)); return CDP_REJECTIONS.has(reply?.code) ? String(reply.message) : undefined; }
  catch { return undefined; }
}
// 导航时旧的执行上下文先消失，新的还没登记。这几种失败说明上下文换代了，不说明页面或动作有问题。
const CONTEXT_LOST = /Cannot find context with specified id|Cannot find default execution context|Execution context was destroyed|Inspected target navigated or closed|No frame for given id found/;
const contextLost = (error: unknown) => error instanceof BrowserError ? error.code === 'STALE_CONTEXT' : CONTEXT_LOST.test(failureText(error));
// 内部查询到期时 CDP 中断它，回一条笼统的 Internal error；回复来得太晚时 evaluate 先按 SCRIPT_TIMEOUT 收尾。两者都只说明这一轮没读到。
const readInterrupted = (error: unknown) => !(error instanceof BrowserError) || error.code === 'SCRIPT_TIMEOUT';
// 派发输入之前只读页面：上下文换代等下一轮，到期被中断按超时算，其他原始失败也没有派发过输入，不能记成结果未知。
function beforeInput(error: unknown, args: JsonObject, deadline: number) {
  if (args.autoWait !== false && args.contextId === undefined && contextLost(error)) return 'lost';
  if (!readInterrupted(error)) return undefined;
  if (args.autoWait !== false && Date.now() >= deadline) return 'expired';
  const info = errorInfo(error);
  throw new BrowserError(info.code, info.message, { phase: 'precondition', outcome: 'not_dispatched' });
}
export const isTabBusy = (id: number) => active.has(id);
export const hasActiveOperations = () => active.size > 0;

// ---- 本机管理页保护（只约束非管理员主体） ----
// 服务端对非管理员主体在每条命令里附带 adminGuard（管理页 origin 列表），扩展再并上自己的扩展页 origin。
// 管理页的 sessionStorage 随标签页保留，标签页跨站往返后仍在，所以按“派发时读到的标签页当前 URL”判断，而不是 claim 时：
// 批次的每一步、等待的每一轮都重新核对；页面脚本在同一个任务里再核对一次 origin（见 evaluate），消除“检查之后才跳转到管理页”的竞态；
// 不经页面脚本读取内容的操作，事后核对期间没有访问过管理页，否则丢弃结果。
let adminPageOrigins: string[] = [];
export function setAdminOrigins(origins: string[]) { adminPageOrigins = origins; }
const adminTabs = new Set<number>();
const adminVisits = new Map<number, number>();
const extensionOrigin = () => { try { return originOf(chrome.runtime.getURL('/')); } catch { return ''; } };
const protectedOrigins = (extra: readonly unknown[] = []) => [...new Set([...extra.filter((item): item is string => typeof item === 'string'), ...adminPageOrigins, extensionOrigin()].filter(Boolean))];
const guardOrigins = (args: JsonObject) => Array.isArray(args.adminGuard) && args.adminGuard.length ? protectedOrigins(args.adminGuard) : undefined;
const carryGuard = (args: JsonObject): JsonObject => args.adminGuard === undefined ? {} : { adminGuard: args.adminGuard };
const protectedPage = (outcome: 'not_dispatched' | 'unknown' = 'not_dispatched') => new BrowserError('ADMIN_PAGE_PROTECTED', '这是 SaltedFish 本机管理页（或扩展自身页面），非管理员客户端不能读取或操作，也不会收到它的内容。请让用户在别的标签页完成，或使用管理员凭据。', { phase: outcome === 'unknown' ? 'execution' : 'precondition', outcome });
function noteUrl(tabId: number, url: unknown) { if (isProtectedUrl(url, protectedOrigins())) adminTabs.add(tabId); else adminTabs.delete(tabId); }
async function assertNotAdminPage(tabId: number, args: JsonObject) {
  const origins = guardOrigins(args); if (!origins) return;
  let tab: chrome.tabs.Tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; } // 标签页不存在由后续步骤按 TAB_NOT_FOUND 报告
  if (isProtectedUrl(tab.url, origins) || isProtectedUrl(tab.pendingUrl, origins)) throw protectedPage();
}

export function attachEvents(callback: Emit): void {
  emit = callback;
  downloadTabs = new DownloadTabs((item, tabId) => emit('downloads.created', { id: item.id, url: String(item.finalUrl || item.url || '').slice(0, 2048), filename: item.filename, mime: item.mime, startTime: item.startTime, ...(tabId !== undefined ? { tabId } : {}) }, tabId));
  chrome.downloads.onCreated.addListener(item => downloadTabs.created(item));
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId === undefined) return;
    attached.delete(source.tabId); focusEmulated.delete(source.tabId); contexts.delete(source.tabId); childSessions.delete(source.tabId); dialogs.forget(source.tabId);isolated.forget(source.tabId);cursor.forget(source.tabId);forgetPointer(source.tabId);
    const requestedAt = expectedDetach.get(source.tabId), intentional = requestedAt !== undefined && Date.now() - requestedAt <= EXPECTED_DETACH_MS; expectedDetach.delete(source.tabId);
    if (reason === 'canceled_by_user' && !intentional) { cancelOperations(); emit('bridge.userPaused', { reason }, source.tabId); }
    emit('debugger.detached', { reason }, source.tabId);
  });
  chrome.debugger.onEvent.addListener((source, method, parameters) => {
    if (source.tabId === undefined) return;
    let params = (parameters || {}) as JsonObject;
    const tabId = source.tabId;
    if (method === 'Target.attachedToTarget' && isPageTarget(params.targetInfo)) {
      const sessionId = String(params.sessionId);
      const sessions = childSessions.get(tabId) || new Set<string>(); sessions.add(sessionId); childSessions.set(tabId, sessions);
      void Promise.all([
        send(tabId, 'Runtime.enable', {}, sessionId),
        send(tabId, 'Page.enable', {}, sessionId),
        send(tabId, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId),
      ]).catch(() => {});
    }
    if (method === 'Target.detachedFromTarget') {
      const sessionId = String(params.sessionId); childSessions.get(tabId)?.delete(sessionId);
      isolated.forget(tabId,sessionId);cursor.forget(tabId,sessionId);forgetPointer(tabId,sessionId);
      for (const [key, context] of contexts.get(tabId) || []) if (context.sessionId === sessionId) contexts.get(tabId)?.delete(key);
    }
    if (method === 'Runtime.executionContextCreated') {
      const context = params.context as JsonObject;
      const entries = contexts.get(tabId) || new Map<string, JsonObject>();
      entries.set(`${source.sessionId || ''}:${context.id}`, { ...context, sessionId: source.sessionId }); contexts.set(tabId, entries);
    }
    if (method === 'Runtime.executionContextDestroyed') {contexts.get(tabId)?.delete(`${source.sessionId || ''}:${params.executionContextId}`);isolated.forget(tabId,source.sessionId||'',Number(params.executionContextId));}
    if (method === 'Runtime.executionContextsCleared') {
      isolated.forget(tabId,source.sessionId||'');
      for (const [key, context] of contexts.get(tabId) || []) if (context.sessionId === source.sessionId) contexts.get(tabId)?.delete(key);
    }
    if(method==='Page.frameNavigated')isolated.navigated(tabId,String((params.frame as JsonObject).id),source.sessionId);
    if (method === 'Page.frameNavigated') {
      const frame = params.frame as JsonObject, onAdmin = isProtectedUrl(frame.url, protectedOrigins());
      if (onAdmin) adminVisits.set(tabId, (adminVisits.get(tabId) ?? 0) + 1);
      if (!source.sessionId && frame.parentId === undefined) { if (onAdmin) adminTabs.add(tabId); else adminTabs.delete(tabId); }
    }
    if(method==='Page.frameDetached')isolated.navigated(tabId,String(params.frameId),source.sessionId);
    if (method === 'Page.javascriptDialogOpening') params = dialogs.opening(tabId, params, source.sessionId);
    if (method === 'Page.javascriptDialogClosed') dialogs.closed(tabId);
    if (method === 'Page.windowOpen') void backgroundPopups.windowOpen(tabId);
    // 后台截图期间开的 screencast：每一帧都要回执，Chrome 才接着出下一帧。
    if (method === 'Page.screencastFrame' && screencasting.has(tabId)) void send(tabId, 'Page.screencastFrameAck', { sessionId: params.sessionId }, source.sessionId).catch(() => {});
    if (method === 'Page.downloadWillBegin' && typeof params.url === 'string') downloadTabs.willBegin(tabId, params.url);
    if (/^(Network\.|Runtime\.consoleAPICalled|Runtime\.exceptionThrown|Page\.javascriptDialog|Page\.fileChooser|Inspector\.)/.test(method)) {
      // 管理页的控制台、网络（含 Authorization 请求头）事件不转发内容，只留一个标记，避免其他客户端经 chrome_events 读到。
      emit(method, adminTabs.has(tabId) && /^(Network\.|Runtime\.)/.test(method) ? { adminPage: true, sessionId: source.sessionId } : { ...params, sessionId: source.sessionId }, tabId);
    }
  });
  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    backgroundPopups.onRemoved(tabId, removeInfo?.windowId);
    attached.delete(tabId); focusEmulated.delete(tabId); contexts.delete(tabId); childSessions.delete(tabId); dialogs.forget(tabId);isolated.forget(tabId);pageChanges.forget(tabId);adminTabs.delete(tabId);adminVisits.delete(tabId);cursor.forget(tabId);forgetPointer(tabId);
    emit('tabs.removed', {}, tabId);
  });
  chrome.downloads.onChanged.addListener(delta => emit('downloads.changed', delta as unknown as JsonObject));
  chrome.tabs.onCreated.addListener(tab => { void backgroundPopups.onCreated(tab); emit('tabs.created', tabInfo(tab) as JsonObject, tab.id); });
  chrome.tabs.onActivated.addListener(info => { void backgroundPopups.onActivated(info); });
  void chrome.tabs.query({ active: true }).then(tabs => backgroundPopups.seed(tabs), () => {});
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => { if (change.url !== undefined) noteUrl(tabId, change.url); if (change.status === 'complete') emit('tabs.updated', tabInfo(tab) as JsonObject, tabId); });
}

export async function detachAll() {
  cancelOperations();
  await Promise.all([...attached].map(async tabId => { try { await detachTab(tabId); } catch { /* 已分离。 */ } }));
  attached.clear(); focusEmulated.clear(); contexts.clear(); childSessions.clear();isolated.clear();
}

async function detachTab(tabId: number) {
  expectedDetach.set(tabId, Date.now());
  try { await chrome.debugger.detach({ tabId }); }
  catch (error) { expectedDetach.delete(tabId); throw error; } // 没有真的 detach，不会有事件来消费标记
  finally { attached.delete(tabId); focusEmulated.delete(tabId); cursor.forget(tabId); forgetPointer(tabId); }
}

async function ensure(tabId: number) {
  try{noteUrl(tabId,(await chrome.tabs.get(tabId)).url);}catch{throw new BrowserError('TAB_NOT_FOUND','指定标签页不存在，不回退到活动标签。',{phase:'precondition',outcome:'not_dispatched'});}
  // attached 在 attach 成功后就置位，这时 Runtime.enable 还没完成、执行上下文还没登记；先看 attaching，并发请求才会等到准备好。
  if (attaching.has(tabId)) return attaching.get(tabId);
  if (attached.has(tabId)) return;
  const promise = (async () => {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      attached.add(tabId);
      await send(tabId, 'Runtime.enable');
      await send(tabId, 'Page.enable');
      await send(tabId, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    } catch (error) {
      // 初始化没做完的标签页不能留在 attached 里，否则之后的 ensure 直接放行、没有执行上下文，一直报 STALE_CONTEXT。回滚并分离，下次重新初始化。
      const wasAttached = attached.has(tabId);
      if (wasAttached) { await detachTab(tabId).catch(() => {}); contexts.delete(tabId); childSessions.delete(tabId); isolated.forget(tabId); }
      if (!wasAttached) throw new BrowserError('ATTACH_FAILED', `无法调试标签页 ${tabId}：${String(error)}。检查是否为 Chrome 受限页面，或被其他调试器占用。`,{phase:'precondition',outcome:'not_dispatched'});
      throw error;
    }
  })();
  attaching.set(tabId, promise);
  try { await promise; } finally { attaching.delete(tabId); }
}

async function send(tabId: number, method: string, params: JsonObject = {}, sessionId?: string): Promise<JsonObject> {
  if (sessionId && !childSessions.get(tabId)?.has(sessionId)) throw new BrowserError('UNKNOWN_FRAME', 'iframe 会话已失效或不属于此标签页，请重新读取 chrome_contexts。',{phase:'precondition',outcome:'not_dispatched'});
  return await chrome.debugger.sendCommand({ tabId, ...(sessionId ? { sessionId } : {}) }, method, params) as JsonObject;
}

async function evaluate(tabId: number, expression: string, args: JsonObject, deadline: number, options: { returnByValue?: boolean; userGesture?: boolean; readOnly?: boolean; awaitPromise?: boolean; objectGroup?: string } = {}): Promise<unknown> {
  // 内部观察不得赋予网页用户激活；只有显式 JS 执行保留原有手势语义。replMode 只来自调用方的 evaluate，内部表达式不带。
  const { returnByValue = true, userGesture = false, readOnly = false, awaitPromise = true, objectGroup } = options, replMode = args.replMode === true;
  if(args.contextId!==undefined&&!contexts.get(tabId)?.has(`${args.sessionId||''}:${args.contextId}`))throw new BrowserError('STALE_CONTEXT','执行上下文已失效，请重新读取 chrome_contexts。',{phase:'precondition',outcome:'not_dispatched'});
  const guard = guardOrigins(args);
  const result = await settleBy(send(tabId, 'Runtime.evaluate', {
    expression: guard ? adminGuardPrefix(guard) + expression : expression, returnByValue, awaitPromise, userGesture, ...(readOnly ? { throwOnSideEffect: true } : {}), ...(replMode ? { replMode: true } : {}), ...(objectGroup ? { objectGroup } : {}),
    timeout: Math.max(1, deadline - Date.now()),
    ...(args.contextId !== undefined ? { contextId: args.contextId } : {}),
  }, args.sessionId as string | undefined), deadline + SCRIPT_GRACE_MS, async () => { throw new BrowserError('SCRIPT_TIMEOUT', '脚本到期仍未结束，已停止等待。页面里的异步任务可能还在继续；先检查页面，不要重放。', { phase: 'execution', outcome: 'unknown' }); });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails as JsonObject;
    // 前缀在页面脚本最前面抛出：此时用户代码尚未运行，页面已经是管理页，视为未派发。
    if (guard && (details.exception as JsonObject | undefined)?.value === ADMIN_GUARD_MARKER) throw protectedPage();
    const description = String((details.exception as JsonObject | undefined)?.description || details.text);
    // V8 在第一个可能有副作用的操作之前就终止了，页面没有变化。
    if (readOnly && description.startsWith('EvalError: Possible side-effect')) throw new BrowserError('SIDE_EFFECT_BLOCKED', `${SIDE_EFFECT_LEAD}${readOnlyHint(expression)}确实要写入就去掉 readOnly。`, NOT_DISPATCHED);
    throw new BrowserError('JAVASCRIPT_ERROR', description);
  }
  const value = result.result as JsonObject;
  return returnByValue ? (value.value ?? value.unserializableValue ?? null) : value;
}

// Chrome 的副作用检查只认它标了“无副作用”的内置函数，下面这些纯读取也会被拦（Chrome 154 实测）。照着换成能过检查的写法。
const READ_ONLY_SWAPS: [RegExp, string][] = [
  [/\.getElementById\s*\(/, 'getElementById 换成 querySelector(\'#id\')'],
  // 等价写法 Chrome 154、156 实测能过（.local/feedback-1108-spike/probe.ts）：querySelectorAll 是标了无副作用的，局部变量、数组的 includes 也算。
  [/\.closest\s*\(/, 'closest 换成先取 const all=[...document.querySelectorAll(选择器)]，再 let e=el; while(e&&!all.includes(e)) e=e.parentElement'],
  [/\.matches\s*\(/, 'matches 换成 [...(el.parentNode||document).querySelectorAll(选择器)].includes(el)'],
  [/\.elementsFromPoint\s*\(|\.elementFromPoint\s*\(/, 'elementFromPoint 换成按 getBoundingClientRect 比位置'],
  [/\.checkVisibility\s*\(/, 'checkVisibility 换成 getBoundingClientRect 和 getComputedStyle'],
  [/\.getClientRects\s*\(/, 'getClientRects 换成 getBoundingClientRect（宽高为 0 就是没显示）'],
  [/Object\.(fromEntries|assign)\s*\(/, 'Object.fromEntries、Object.assign 换成循环给新对象赋值'],
  [/structuredClone\s*\(/, 'structuredClone 换成 JSON.parse(JSON.stringify(...))'],
  [/\{\s*\.\.\./, '对象展开 {...a} 换成循环给新对象赋值'],
  [/\b(fetch|setTimeout|setInterval|console\.\w+|Math\.random|getSelection)\s*\(/, 'fetch、定时器、console、Math.random、getSelection 本来就算副作用'],
  [/(?:^|[;\n}])\s*(?:var\s|function\s*\*?\s*[\w$])/, '顶层的 var、函数声明会在页面全局建变量，算副作用：改用 const/let，或整段包进 (()=>{ …; return … })()'],
];
// 顶层的 const/let 也在全局作用域建变量，被拦时自动包进大括号再试，见 evaluateReadOnly。
const TOP_LEVEL_LEXICAL = /(?:^|[;\n}])\s*(?:const|let)\s+[\w$[{]/;
// 调用方要求的只读执行。顶层 const/let 会在页面全局作用域建变量，Chrome 算副作用；被拦时包进 { … } 再试一次：
// 第一次在改动前就被拦下，页面没有变化，重试是安全的；块里的 const/let 出不了块，结果仍是最后一个表达式的值。
// 包了还被拦就是别的写法，照旧报第一次的错和提示。试跑（evaluateChecked）不走这里：它要保留调用方建全局变量的本意。
// memo 给轮询用（page.wait）：同一次等待包过一次就一直包，不每轮先被拦一次。
async function evaluateReadOnly(tabId: number, expression: string, args: JsonObject, deadline: number, memo: { wrap?: boolean } = {}) {
  try { return await readOnlyAttempt(tabId, expression, args, deadline, memo); }
  catch (error) {
    if (errorInfo(error).code !== 'SIDE_EFFECT_BLOCKED') throw error;
    const replaced = await replacedBuiltins(tabId, expression, args, Math.min(deadline, Date.now() + BUILTIN_PROBE_MS)).catch(() => [] as string[]);
    if (!replaced.length) throw error;
    throw new BrowserError('SIDE_EFFECT_BLOCKED', SIDE_EFFECT_LEAD + replacedHint(replaced, expression), { ...NOT_DISPATCHED, detail: { replacedBuiltins: replaced } });
  }
}
async function readOnlyAttempt(tabId: number, expression: string, args: JsonObject, deadline: number, memo: { wrap?: boolean }) {
  const wrapped = `{\n${expression}\n}`;
  if (memo.wrap) return evaluate(tabId, wrapped, args, deadline, { readOnly: true });
  try { return await evaluate(tabId, expression, args, deadline, { readOnly: true }); }
  catch (error) {
    if (errorInfo(error).code !== 'SIDE_EFFECT_BLOCKED' || !TOP_LEVEL_LEXICAL.test(expression)) throw error;
    try { const value = await evaluate(tabId, wrapped, args, deadline, { readOnly: true }); memo.wrap = true; return value; }
    catch (retry) { const info = errorInfo(retry); if (info.code === 'SIDE_EFFECT_BLOCKED' || info.code === 'JAVASCRIPT_ERROR' && info.message.startsWith('SyntaxError')) throw error; throw retry; }
  }
}
const readOnlySwaps = (expression: string) => READ_ONLY_SWAPS.filter(([pattern]) => pattern.test(expression)).map(([, hint]) => hint);
function readOnlyHint(expression: string) {
  const found = readOnlySwaps(expression);
  return found.length ? `可能是这些写法被拦了：${found.join('；')}。` : '只读核对请只读取（querySelector、getAttribute、textContent、getBoundingClientRect 都能用）。';
}
const SIDE_EFFECT_LEAD = '表达式可能改动页面，Chrome 已拦下，页面没有变化。';
function replacedHint(replaced: string[], expression: string) {
  const others = replaced.filter(name => name !== 'JSON.stringify'), swaps = readOnlySwaps(expression);
  const fixes = [...(replaced.includes('JSON.stringify') ? ['结果本来就按值返回，去掉 JSON.stringify、直接返回对象即可'] : []), ...(others.length ? [`${others.join('、')}换成不用它的写法`] : [])];
  return `这个页面把 ${replaced.join('、')} 换成了自己的 JS（网站打的补丁，比如 core-js），Chrome 判断不了它有没有副作用：${fixes.join('；')}。${swaps.length ? `另外，${swaps.join('；')}。` : ''}确实要写入就去掉 readOnly。`;
}

// 网站常把内置函数换成自己的 JS（core-js 这类补丁，还会把 Function.prototype.toString 一起换掉、假装是原生的）。Chrome 的副作用检查只放行它标过的原生函数，
// 页面的 JS 实现证明不了，只读执行就被拦（有的页面用 core-js 一类的补丁换掉了 JSON.stringify，就是这样）。被拦以后按表达式里出现的写法，读出这些函数在这个页面上是不是原生：
// 页面里只取函数本身、不调用，属性用 getOwnPropertyDescriptor 读、不碰 getter，同样在副作用检查下跑；真假看 CDP 给的函数描述，它取自 V8，不经页面的 toString。页面看不到这次检查。
// 只在被拦以后做，最多 1 秒，读不到就只少这段说明。
const BUILTIN_STATIC = /\b(JSON|Object|Array|Number|String|Reflect|Math|Date|Promise|Symbol)\s*\.\s*([A-Za-z_$][\w$]*)/g, BUILTIN_METHOD = /\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
const BUILTIN_PROTOTYPES = ['Array', 'String', 'Object', 'RegExp', 'Number', 'Function', 'Element', 'Node', 'Document', 'HTMLElement'];
const BUILTIN_PROBE_MS = 1000, BUILTIN_GROUP = 'saltedfish-builtins', NATIVE_SOURCE = /\{\s*\[native code\]\s*\}\s*$/;
export function builtinProbeExpression(expression: string): string | undefined {
  const statics = new Map<string, [string, string]>(), methods = new Set<string>();
  for (const match of expression.matchAll(BUILTIN_STATIC)) statics.set(`${match[1]}.${match[2]}`, [match[1]!, match[2]!]);
  for (const match of expression.matchAll(BUILTIN_METHOD)) methods.add(match[1]!);
  if (!statics.size && !methods.size) return undefined;
  // 不用页面的 split、for…of 这类可能也被换掉的东西，只用下标循环。
  return `(()=>{const out={},own=Object.getOwnPropertyDescriptor,statics=${JSON.stringify([...statics.values()])},owners=${JSON.stringify(BUILTIN_PROTOTYPES)},methods=${JSON.stringify([...methods])};
for(let i=0;i<statics.length;i++){const holder=globalThis[statics[i][0]],found=holder&&own(holder,statics[i][1]);if(found&&typeof found.value==='function')out[statics[i][0]+'.'+statics[i][1]]=found.value;}
for(let i=0;i<owners.length;i++){const type=globalThis[owners[i]],proto=type&&type.prototype;if(!proto)continue;for(let j=0;j<methods.length;j++){const found=own(proto,methods[j]);if(found&&typeof found.value==='function')out[owners[i]+'.prototype.'+methods[j]]=found.value;}}
return out;})()`;
}
async function replacedBuiltins(tabId: number, expression: string, args: JsonObject, deadline: number): Promise<string[]> {
  const probe = builtinProbeExpression(expression), sessionId = args.sessionId as string | undefined;
  if (!probe) return [];
  try {
    const handle = await evaluate(tabId, probe, { ...args, replMode: undefined }, deadline, { readOnly: true, returnByValue: false, objectGroup: BUILTIN_GROUP }) as JsonObject;
    if (!handle.objectId) return [];
    const listed = await settleBy(send(tabId, 'Runtime.getProperties', { objectId: handle.objectId, ownProperties: true }, sessionId), deadline, async () => { throw new Error('timeout'); });
    return ((listed.result as JsonObject[] | undefined) || []).filter(item => { const description = (item.value as JsonObject | undefined)?.description; return typeof description === 'string' && !NATIVE_SOURCE.test(description); }).map(item => String(item.name)).slice(0, 8);
  } finally { await send(tabId, 'Runtime.releaseObjectGroup', { objectGroup: BUILTIN_GROUP }, sessionId).catch(() => {}); }
}

// 先在 Chrome 的副作用检查下试跑：跑完就是结果；碰到可能的副作用之前抛错，说明页面没有任何变化，是确定的失败；碰到可能的副作用时 Chrome 中止试跑（页面里的 try/catch 接不住，finally 也不执行；Promise 和 async 函数直接算副作用），再正常执行一遍。
// 试跑最多占一半期限、不超过 2 秒，超时也是在改动前被终止的，照样退回正常执行。
const PROBE_MS = 2000;

const DIALOG_RELEASE_MS = 2000;
// 等待超时的现场写成一句话，原样数据另放 detail。
const WAIT_CONTEXT_MS = 1500;
function waitScene(context: JsonObject) {
  const parts = [`现在在「${String(context.title || '无标题')}」（${String(context.url)}）${context.loading ? '，页面还在加载' : ''}`];
  if (Array.isArray(context.closestText) && context.closestText.length) parts.push(`最接近的文字：${context.closestText.map(text => JSON.stringify(text)).join('、')}`);
  if (typeof context.matches === 'number') parts.push(context.matches ? `匹配的元素 ${context.matches} 个，看得见的 ${context.visible} 个` : '没有匹配的元素');
  else if (context.lookup) parts.push(`定位失败（${String(context.lookup)}）`);
  const attribute = context.attribute as { name?: string; values?: (string | null)[] } | undefined;
  if (attribute?.name && Array.isArray(attribute.values) && attribute.values.length) parts.push(`它们的 ${attribute.name} 现在${attribute.values.map(value => value === null ? '没有这个属性' : `是 ${JSON.stringify(value)}`).join('、')}`);
  if (Array.isArray(context.stillVisible) && context.stillVisible.length) parts.push(`还看得见：${(context.stillVisible as JsonObject[]).map(item => `${item.role ? `[${String(item.role)}]` : ''}${item.name ? `「${String(item.name)}」` : ''} ref ${String(item.ref)}`).join('、')}，要等其中一个消失就按它的 ref 等`);
  return parts.join('；') + '。';
}
async function evaluateChecked(tabId: number, expression: string, args: JsonObject, deadline: number): Promise<{ value: unknown } | undefined> {
  const probeDeadline = Date.now() + Math.min(PROBE_MS, Math.max(0, (deadline - Date.now()) / 2));
  try { return { value: await evaluate(tabId, expression, args, probeDeadline, { readOnly: true }) }; }
  catch (error) {
    if (!(error instanceof BrowserError)) return undefined;
    if (error.code === 'JAVASCRIPT_ERROR') throw new BrowserError('JAVASCRIPT_ERROR', `${error.message}
脚本在改动页面之前就抛出了异常，页面没有变化。`, NOT_DISPATCHED);
    if (error.code === 'SIDE_EFFECT_BLOCKED' || error.code === 'SCRIPT_TIMEOUT') return undefined;
    throw error;
  }
}

// 语法错误时脚本一行都没运行，是确定的失败；运行期异常不能证明没有副作用，仍按结果未知处理。replMode 的顶层 await 编译不过，由试跑报语法错误。
async function assertCompiles(tabId: number, expression: string, args: JsonObject, deadline: number) {
  if (args.replMode === true) return;
  const compiled = send(tabId, 'Runtime.compileScript', { expression, sourceURL: '', persistScript: false, ...(args.contextId !== undefined ? { executionContextId: args.contextId } : {}) }, args.sessionId as string | undefined).catch(() => undefined);
  const details = (await settleBy(compiled, deadline, async () => { throw new BrowserError('DEADLINE_EXCEEDED', '页面在期限内没有响应，脚本未执行。', NOT_DISPATCHED); }))?.exceptionDetails as JsonObject | undefined;
  if (details) throw new BrowserError('JAVASCRIPT_SYNTAX_ERROR', String((details.exception as JsonObject | undefined)?.description || details.text), NOT_DISPATCHED);
}

async function evaluateInternal(tabId:number,expression:string,args:JsonObject,deadline:number,returnByValue=true):Promise<unknown>{
  args={...args,replMode:undefined,contextId:await isolated.get(tabId,args,deadline)};
  if(!returnByValue)return evaluate(tabId,expression,args,deadline,{returnByValue:false});
  // 这层包装每次调用都要发一遍，错误整理放在页面运行时里（FengPage.caught），不随每次调用重复传。
  const wrapped=`(()=>{let __fengInputStarted=false;try{return {ok:true,value:(${expression})};}catch(error){return FengPage.caught(error,__fengInputStarted);}})()`;
  const result=await evaluate(tabId,wrapped,args,deadline) as any;
  if(!result?.ok)throw new BrowserError(result?.error?.code||'INTERNAL_RESULT_INVALID',result?.error?.message||'页面结果无效。',{phase:result?.error?.phase,outcome:result?.error?.outcome||'unknown',...(result?.error?.detail?{detail:result.error.detail}:{})});
  return result.value;
}

function tabInfo(tab: chrome.tabs.Tab) {
  return { tabId: tab.id, openerTabId: tab.openerTabId, windowId: tab.windowId, title: tab.title, url: tab.url, active: tab.active, status: tab.status, groupId: tab.groupId, incognito: tab.incognito, ...(tab.discarded ? { discarded: true } : {}), ...(tab.autoDiscardable === false ? { autoDiscardable: false } : {}) };
}

export async function execute(operation: string, args: JsonObject, deadline: number, commandId: string = crypto.randomUUID()): Promise<unknown> {
  const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
  // 代际必须在第一次 await 之前取：等待管理页核对期间若发生取消，旧命令不能拿到新代际继续执行。
  const epoch = controlEpoch;
  if (tabId !== undefined && operation !== 'tabs.detach' && guardOrigins(args)) {
    await assertNotAdminPage(tabId, args);
    if (epoch !== controlEpoch) throw new BrowserError('CANCELLED', '连接或授权状态已变化，命令未派发。', NOT_DISPATCHED);
  }
  if (tabId !== undefined && operation === 'page.dialog') {
    // 触发弹窗的动作当时读不到结果，答完再读：页面随后的跳转和提示都在这时才出现。
    const result = await dialogs.respond(tabId, args);
    // 被弹窗挡住的那条命令答完才收尾（松开鼠标、导航停下）；等它让出标签页再返回，调用方紧接着的下一步不会撞上 TAB_BUSY。
    for (const until = Math.min(deadline, Date.now() + DIALOG_RELEASE_MS); active.has(tabId) && Date.now() < until;) await sleep(20);
    return { ...result, ...await pageChanges.read(tabId, ACTION_SETTLE_MS, deadline) };
  }
  // 新命令被已打开的弹窗挡在门外：本命令还没有派发任何输入，所以是明确的未派发。弹窗若由此前已派发的输入触发，那条操作自己的 unknown/隔离保护不受影响；
  // 而在命令运行期间由其输入触发的 DIALOG_OPEN（dialogs.opening/assert）仍不带 not_dispatched，保持未知。
  if (tabId !== undefined && dialogs.has(tabId) && !['tabs.list','tabs.close','tabs.detach'].includes(operation)) throw new BrowserError('DIALOG_OPEN','标签页有弹窗，先用 chrome_events 核对并调用 chrome_dialog；不要重放触发动作。', NOT_DISPATCHED);
  const read = ['tabs.list', 'tabs.wait', 'windows.list', 'page.inspect', 'page.find', 'page.snapshot', 'network.body', 'contexts.list', 'downloads.list'].includes(operation);
  if (tabId !== undefined && !read) {
    if (active.has(tabId)) throw new BrowserError('TAB_BUSY', '此标签页仍有操作执行中。', NOT_DISPATCHED);
    active.add(tabId);
  }
  const needsViewport = needsViewportOperation(operation, args);
  const run = () => dispatch(operation, args, deadline, epoch);
  const input = () => tabId !== undefined && needsViewport ? withViewport(tabId, deadline, run) : run();
  // 页面变化在窗口队列之外读：等待期间不占着同窗口的其他标签页，也不让后台标签页多停留在前台。
  const physical = () => tabId !== undefined && observes(operation, args) ? observed(tabId, operation, args, deadline, input) : input();
  // 兜底：任何调用挂住都不能占着标签页。断开调试器让还挂着的 CDP 调用收尾，这个标签页下次使用时会重新连接。
  const hung = () => new BrowserError('OPERATION_HUNG', '操作到期仍未结束，已停止等待。页面可能已经部分生效；先检查页面，不要重放。', { phase: 'execution', outcome: 'unknown' });
  let expired = false;
  const bounded = () => settleBy(physical().catch(error => { throw expired ? hung() : error; }), deadline + WATCHDOG_GRACE_MS, async () => {
    expired = true;
    if (tabId !== undefined && !read && attached.has(tabId)) await Promise.race([detachTab(tabId).catch(() => {}), sleep(WATCHDOG_GRACE_MS)]);
    throw hung();
  });
  if (tabId === undefined || read) return bounded();
  return dialogs.run(tabId, commandId, deadline, () => epoch === controlEpoch, bounded, async interrupted => {
    try { if (interrupted && attached.has(tabId)) await send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).then(() => focusEmulated.delete(tabId), () => {}); }
    finally { active.delete(tabId); emit('bridge.commandFinished', {commandId}, tabId); }
  }).catch(error=>{if(operation==='page.batch'&&error instanceof BrowserError&&['DIALOG_OPEN','DIALOG_MISMATCH'].includes(error.code))return dialogs.interruptedBatch(tabId,error);throw error;});
}

const observes = (operation: string, args: JsonObject) => args.observe === true && (operation === 'page.batch' || operation === 'page.action' && args.action !== 'scroll');
// 点击和回车常常发请求，多等一会儿才看得到提示；其余动作的变化基本是同步的。批次按最后一步算，带后置检查时结果已经确认过。
function settleFor(operation: string, args: JsonObject) {
  const last = operation === 'page.batch' ? (args.steps as { operation: string; args: JsonObject; postcondition?: JsonObject }[]).at(-1) : { operation, args, postcondition: args.postcondition as JsonObject | undefined };
  return last?.operation === 'page.action' && ['click', 'doubleClick', 'press', 'choose'].includes(String(last.args.action)) && !(last as { postcondition?: JsonObject }).postcondition ? ACTION_SETTLE_MS : INPUT_SETTLE_MS;
}
async function observed(tabId: number, operation: string, args: JsonObject, deadline: number, run: () => Promise<unknown>): Promise<unknown> {
  await ensure(tabId).catch(() => {}); // 连不上时交给动作本身报错。
  await pageChanges.start(tabId, { contextId: args.contextId, sessionId: args.sessionId, ...carryGuard(args) }, deadline);
  try {
    const result = await run() as JsonObject;
    // 弹窗打断时结果还没定，留给 chrome_dialog 读。
    return dialogs.interrupted(tabId) ? result : { ...result, ...await pageChanges.read(tabId, settleFor(operation, args), deadline) };
  } catch (error) { if (!dialogs.interrupted(tabId)) pageChanges.drop(tabId); throw error; }
}

// 读取页面内容但不经页面脚本（因而没有页内前缀保护）的操作：事后核对期间没有访问过管理页，否则丢弃结果。
const contentReads = new Set(['page.screenshot', 'page.snapshot', 'network.body', 'contexts.list']);
async function dispatch(operation: string, args: JsonObject, deadline: number, epoch: number): Promise<unknown> {
  const origins = guardOrigins(args), guardedTab = args.tabId;
  if (!origins || typeof guardedTab !== 'number' || operation === 'tabs.detach') return dispatchOperation(operation, args, deadline, epoch);
  await assertNotAdminPage(guardedTab, args);
  if (operation === 'page.navigate' && isProtectedUrl(args.url, origins)) throw protectedPage();
  // 服务端已经拒绝非管理员打开 file: 网址，这里再挡一道（扩展默认有文件网址访问权）。
  if (operation === 'page.navigate' && isLocalFileUrl(args.url)) throw new BrowserError('FILE_URL_NOT_ALLOWED', LOCAL_FILE_URL_MESSAGE, NOT_DISPATCHED);
  const visits = adminVisits.get(guardedTab) ?? 0;
  const result = await dispatchOperation(operation, args, deadline, epoch);
  if (contentReads.has(operation) || operation === 'page.cdp') {
    const outcome = operation === 'page.cdp' ? 'unknown' : 'not_dispatched';
    if ((adminVisits.get(guardedTab) ?? 0) !== visits) throw protectedPage(outcome);
    try { await assertNotAdminPage(guardedTab, args); } catch { throw protectedPage(outcome); }
  }
  return result;
}

async function dispatchOperation(operation: string, args: JsonObject, deadline: number, epoch: number): Promise<unknown> {
  if (typeof args.tabId === 'number') dialogs.assert(args.tabId);
  // 每个操作（含批次里的每一步）开始时的拒绝：这一步还没有派发。批次里此前已完成的步骤保留在结果里，不受影响。
  if (epoch !== controlEpoch) throw new BrowserError('CANCELLED', '连接或授权状态已变化，后续操作已停止。已发出的操作不会自动撤销。', NOT_DISPATCHED);
  if (Date.now() > deadline) throw new BrowserError('DEADLINE_EXCEEDED', '操作超时，后续步骤未执行。', NOT_DISPATCHED);
  if(operation.startsWith('file.stage.'))return browserUploads.receive(operation,args);
  if (operation === 'tabs.list') { const tabs = (await chrome.tabs.query(args.windowId ? { windowId: Number(args.windowId) } : {})).map(tabInfo); return args.hideProtected ? hideAdminTabs(tabs, protectedOrigins()) : tabs; }
  if (operation === 'tabs.wait') {
    await chrome.tabs.get(Number(args.openerTabId));
    while (Date.now() < deadline) {
      if (epoch !== controlEpoch) throw new BrowserError('CANCELLED', '新标签页等待已取消。');
      const tabs = (await chrome.tabs.query({})).filter(tab => tab.openerTabId === args.openerTabId && !(args.excludeTabIds as number[]).includes(tab.id!) && (!args.urlContains || (tab.url || '').includes(String(args.urlContains))));
      if (tabs.length > 1) throw new BrowserError('AMBIGUOUS_TAB', '出现多个符合条件的新标签页，请指定更精确的 URL 条件。');
      if (tabs[0]?.status === 'complete') return tabInfo(tabs[0]);
      await sleep(100);
    }
    throw new BrowserError('WAIT_TIMEOUT', '没有发现已加载的匹配新标签页。先检查现有标签页，不要重复点击。');
  }
  if (operation === 'windows.list') return (await chrome.windows.getAll()).map(window => ({ windowId: window.id, focused: window.focused, state: window.state, width: window.width, height: window.height, type: window.type, incognito: window.incognito }));
  if (operation === 'tabs.create') {
    if (isScriptUrl(String(args.url || ''))) throw new BrowserError('INVALID_URL', SCRIPT_URL_MESSAGE, NOT_DISPATCHED);
    try { return tabInfo(await chrome.tabs.create({ url: String(args.url || 'about:blank'), active: args.active === true, ...(args.windowId ? { windowId: Number(args.windowId) } : {}) })); }
    catch (error) { throw new BrowserError('TAB_CREATE_REJECTED', `Chrome 没有创建标签页：${failureText(error)}`, NOT_DISPATCHED); }
  }
  if (operation === 'downloads.list') return (await chrome.downloads.search({ limit: Number(args.limit || 50), ...(args.downloadId !== undefined ? { id: Number(args.downloadId) } : {}), orderBy: ['-startTime'] })).map(item => { const tabId = downloadTabs.tabOf(item.id); return tabId === undefined ? item : { ...item, tabId }; });
  if (operation === 'site.permission') {
    // 网站的“自动下载”设置：同一页面第二个起的下载默认要用户在 Chrome 里点允许，打开后不再拦。按 origin 设置，只影响这个网站。
    const url = typeof args.url === 'string' ? args.url : (await chrome.tabs.get(Number(args.tabId))).url;
    let origin: URL;
    try { origin = new URL(String(url)); } catch { throw new BrowserError('SITE_PERMISSION_UNSUPPORTED', '网址无效，没有改设置。', NOT_DISPATCHED); }
    if (!/^https?:$/.test(origin.protocol)) throw new BrowserError('SITE_PERMISSION_UNSUPPORTED', '只能设置 http/https 网站，没有改设置。', NOT_DISPATCHED);
    // popups：页面在请求回来以后才 window.open（导出文件常这样），已经不算用户点击，Chrome 会当弹窗拦下。
    const popups = args.permission === 'popups', pattern = `${origin.protocol}//${origin.hostname}${origin.port ? ':' + origin.port : ''}/*`;
    const setting = (popups ? chrome.contentSettings.popups : chrome.contentSettings.automaticDownloads) as chrome.contentSettings.ContentSetting<string>;
    if (args.setting) {
      try { await setting.set({ primaryPattern: pattern, setting: String(args.setting) }); }
      catch (error) { throw new BrowserError('SITE_PERMISSION_REJECTED', `Chrome 没有接受这个设置：${failureText(error)}`, NOT_DISPATCHED); }
    }
    const current = await setting.get({ primaryUrl: origin.href });
    return { origin: origin.origin, pattern, permission: popups ? 'popups' : 'automaticDownloads', setting: current.setting, ...(args.setting ? { changed: true } : {}) };
  }
  if (operation === 'downloads.start') {
    // 文件名或地址不合法时 Chrome 直接拒绝，下载没有开始；网络失败走下载记录的 interrupted 状态，不在这里。
    try { return { downloadId: await chrome.downloads.download({ url: String(args.url), saveAs: false, ...(args.filename ? { filename: String(args.filename) } : {}) }) }; }
    catch (error) { throw new BrowserError('DOWNLOAD_REJECTED', `Chrome 拒绝了这次下载，没有开始：${failureText(error)}`, NOT_DISPATCHED); }
  }
  const tabId = Number(args.tabId);
  if (!Number.isInteger(tabId) || tabId < 0) throw new BrowserError('INVALID_TARGET', '此操作需要明确的 tabId。');
  if (operation === 'tabs.close') {
    // 标签页已经不在了（下载页这类自己关掉的）：要的结果已经达成，不报错。tabId 在一次浏览器运行里不会复用。
    let gone = false;
    const close = () => chrome.tabs.remove(tabId).catch(error => { if (!tabMissing(error)) throw error; gone = true; });
    if (args.beforeUnload !== 'accept') { await close(); return { closed: true, ...(gone ? { alreadyClosed: true } : {}) }; }
    // 要能看到并答 beforeunload，先连上这个标签页；连不上（已经关了）就照常关。
    await ensure(tabId).catch(() => {});
    const { accepted } = await dialogs.leaving(tabId, close);
    return { closed: true, ...(gone ? { alreadyClosed: true } : {}), ...(accepted ? { beforeUnload: 'accepted' } : {}) };
  }
  // 内存紧张时 Chrome 会丢弃后台标签页，上传和页面里的作业就断了；keep 时关掉自动丢弃。
  if (operation === 'tabs.keep') {
    try { await chrome.tabs.update(Number(args.tabId), { autoDiscardable: args.keep === false }); return tabInfo(await chrome.tabs.get(Number(args.tabId))); }
    catch (error) { throw new BrowserError('TAB_NOT_FOUND', `标签页不存在或已关闭：${failureText(error)}`, NOT_DISPATCHED); }
  }
  if (operation === 'tabs.focus') {
    const tab = await chrome.tabs.update(tabId, { active: true }).catch(error => { throw tabMissing(error) ? tabGone() : error; });
    if (!tab) throw new BrowserError('TAB_NOT_FOUND', '标签页已关闭。');
    const window = await chrome.windows.get(tab.windowId);
    await chrome.windows.update(tab.windowId, { focused: true, ...(window.state === 'minimized' ? { state: 'normal' } : {}) }); return tabInfo(tab);
  }
  if (operation === 'tabs.detach') { if (attached.has(tabId)) await detachTab(tabId); return { detached: true }; }
  await ensure(tabId);
  dialogs.assert(tabId);
  if (epoch !== controlEpoch) throw new BrowserError('CANCELLED', '控制已暂停。', NOT_DISPATCHED);
  const sessionId = args.sessionId as string | undefined;
  if (operation === 'contexts.list') return { contexts: [...(contexts.get(tabId)?.values() || [])].filter(c=>c.name!==WORLD_NAME), frameTree: await send(tabId, 'Page.getFrameTree') };
  if (operation === 'page.inspect') return evaluateInternal(tabId, inspectExpression(args), args, deadline);
  if (operation === 'page.find') return evaluateInternal(tabId, findExpression(args), args, deadline);
  if (operation === 'page.snapshot') return send(tabId, 'Accessibility.getFullAXTree', {}, sessionId);
  if (operation === 'page.jobStart') {
    // 先完整执行脚本，不等它的 Promise；再把结果交给页面里的登记函数挂成作业。脚本同步部分抛错时作业没有建立，按 evaluate 的规则报。
    await assertCompiles(tabId, String(args.expression), args, deadline);
    dialogs.arm(tabId);
    const started = await evaluate(tabId, String(args.expression), args, deadline, { returnByValue: false, userGesture: true, awaitPromise: false }) as JsonObject;
    const global = await evaluate(tabId, 'globalThis', { ...args, replMode: undefined }, deadline, { returnByValue: false }) as JsonObject;
    try {
      const value = started.objectId ? { objectId: started.objectId } : started.unserializableValue ? { unserializableValue: started.unserializableValue } : { value: started.value ?? null };
      const registered = await send(tabId, 'Runtime.callFunctionOn', { objectId: global.objectId, functionDeclaration: JOB_REGISTER_FUNCTION, arguments: [{ value: String(args.jobId) }, value], returnByValue: true }, sessionId);
      if (registered.exceptionDetails) throw new BrowserError('JOB_REGISTER_FAILED', '脚本已经开始执行，但作业没登记上；先核查页面，不要重跑。', { phase: 'execution', outcome: 'unknown' });
      return { jobId: (registered.result as JsonObject).value };
    } finally {
      for (const objectId of [started.objectId, global.objectId]) if (objectId) await send(tabId, 'Runtime.releaseObject', { objectId }, sessionId).catch(() => {});
    }
  }
  if (operation === 'page.evaluate') {await assertCompiles(tabId, String(args.expression), args, deadline);if(args.readOnly===true)return evaluateReadOnly(tabId, String(args.expression), args, deadline);
    const checked=await evaluateChecked(tabId, String(args.expression), args, deadline);if(checked)return checked.value;
    dialogs.arm(tabId);return evaluate(tabId, String(args.expression), args, deadline, {userGesture:true});}
  if (operation === 'page.navigate') {
    if (args.beforeUnload === 'accept') {
      const { result, accepted } = await dialogs.leaving(tabId, () => dispatchOperation(operation, { ...args, beforeUnload: undefined }, deadline, epoch));
      return accepted && result && typeof result === 'object' ? { ...result as JsonObject, beforeUnload: 'accepted' } : result;
    }
    // initScript 只管这一次导航：派发前登记，调用返回（成功或失败）时撤销。见 init-script.ts。
    const script = typeof args.initScript === 'string' ? initScriptRegistration((method, params) => send(tabId, method, params)) : undefined;
    let navigated: JsonObject;
    try {
      navigated = await navigatePage({url:args.url as string|undefined,action:args.action as 'goto'|'back'|'forward'|'reload'|undefined,wait:args.wait!==false,deadline,
      prepare: script ? () => script.add(initScriptSource(String(args.initScript), guardOrigins(args))) : undefined,
      send:(method,params)=>send(tabId,method,params),tab:async()=>tabInfo(await chrome.tabs.get(tabId)),
      // 后退、前进、重新加载的目标来自历史记录，非管理员同样不能落到 file: 页面上。
      validateUrl:url=>{const origins=guardOrigins(args);if(origins&&isProtectedUrl(url,origins))throw protectedPage();if(origins&&isLocalFileUrl(url))throw new BrowserError('FILE_URL_NOT_ALLOWED',LOCAL_FILE_URL_MESSAGE,NOT_DISPATCHED);},
      assertActive:()=>{dialogs.assert(tabId);if(epoch!==controlEpoch)throw new BrowserError('CANCELLED','导航等待已取消；导航本身可能已生效。');},
      subscribe:listener=>{
        const event:Parameters<typeof chrome.debugger.onEvent.addListener>[0]=(source,method,params)=>{if(source.tabId===tabId&&!source.sessionId)listener(method,(params||{}) as JsonObject);};
        const detached=(source:chrome.debugger.Debuggee)=>{if(source.tabId===tabId)listener('connection.closed',{});};
        const updated=(id:number)=>{if(id===tabId)listener('tabs.updated',{});};
        chrome.debugger.onEvent.addListener(event);chrome.debugger.onDetach.addListener(detached);chrome.tabs.onUpdated.addListener(updated);
        return()=>{chrome.debugger.onEvent.removeListener(event);chrome.debugger.onDetach.removeListener(detached);chrome.tabs.onUpdated.removeListener(updated);};
      },
    });
    } catch (error) { await script?.remove(); throw error; }
    return script ? { ...navigated, initScript: { removed: await script.remove() } } : navigated;
  }
  if (operation === 'page.screenshot') return screenshot(tabId, args, deadline);
  if (operation === 'network.start') { await send(tabId, 'Network.enable', { maxTotalBufferSize: 100000000, maxResourceBufferSize: 20000000 }); return { capturing: true, note: '只包含启用后的请求；完整响应体用 chrome_network_body 读取。' }; }
  if (operation === 'network.stop') { await send(tabId, 'Network.disable'); return { capturing: false }; }
  if (operation === 'network.body') return send(tabId, 'Network.getResponseBody', { requestId: args.requestId }, sessionId);
  if (operation === 'page.dialog') return dialogs.respond(tabId, args);
  if (operation === 'page.cdp') {
    const method = String(args.method);
    // Target 的全局目标操作会破坏明确的 profile/tab 路由。
    if (/^(Browser|Target)\./.test(method) || Object.hasOwn((args.params || {}) as JsonObject, 'browserContextId')) throw new BrowserError('TARGET_SCOPE', '此命令越过标签页范围，请使用明确 profileId/tabId 的标签页和上下文工具。其他 Chrome 支持的 CDP 命令可直接执行。',{phase:'precondition',outcome:'not_dispatched'});
    const origins = guardOrigins(args);
    const run = () => origins ? guardedCdp(tabId, method, (args.params || {}) as JsonObject, sessionId, origins) : send(tabId, method, (args.params || {}) as JsonObject, sessionId);
    try {
      const result = await (method === 'Page.captureScreenshot' ? cursor.hidden(tabId, run) : run());
      if (method === 'Emulation.setFocusEmulationEnabled' && !sessionId) { if ((args.params as JsonObject | undefined)?.enabled === true) focusEmulated.add(tabId); else focusEmulated.delete(tabId); }
      return result;
    } catch (error) { const rejected = cdpRejection(error); if (rejected !== undefined) throw new BrowserError('CDP_COMMAND_REJECTED', `Chrome 拒绝了这条 CDP 命令，没有执行：${rejected}`, NOT_DISPATCHED); throw error; }
  }
  if (operation === 'page.upload') {
    const count=Array.isArray(args.fileIds)?args.fileIds.length:(args.paths as string[]).length;
    // 目标可以是文件框，也可以是看得见的上传按钮、区域（用它里面或最近的那个文件框，见 page-runtime 的 uploadTarget）。目标还没出现就等，和 chrome_action 一样。
    let prepared:{ref:string;input?:JsonObject;chooser?:ChooserTarget};
    for(;;){
      try{prepared=await evaluateInternal(tabId,elementExpression(args,`return FengPage.uploadTarget(element,${count},true);`),args,deadline) as typeof prepared;break;}
      catch(error){if(errorInfo(error).code!=='ELEMENT_NOT_FOUND'||Date.now()+UPLOAD_POLL_MS>=deadline-UPLOAD_RESERVE_MS)throw error;await sleep(UPLOAD_POLL_MS);}
    }
    // 附近几个文件框分不出用哪个：点一下目标，用页面自己打开的那个。点击发出以后，之后的失败都不是“未派发”。
    if(prepared.chooser){
      const chosen=await uploadByChooser(tabId,args,prepared.chooser,count,deadline,epoch);
      try{return await setUploadFiles(tabId,{...args,selector:undefined,locator:undefined,ref:chosen.ref},chosen,deadline,epoch);}
      catch(error){const info=errorInfo(error);if(info.outcome!=='not_dispatched')throw error;throw new BrowserError(info.code,`已经点了上传区，${info.message}`,{phase:'execution',outcome:'dispatched',...(info.detail?{detail:info.detail}:{})});}
    }
    return setUploadFiles(tabId,{...args,selector:undefined,locator:undefined,ref:prepared.ref},prepared,deadline,epoch);
  }
  if (operation === 'page.wait') {
    if (args.expression) await assertCompiles(tabId, String(args.expression), args, deadline);
    // 不带 readOnly 的条件表达式也先试跑；一旦碰到可能的副作用，之后每轮直接正常执行，不再试跑。
    let matchedSince:number|undefined,sideEffects=false;const readOnlyMemo={};
    const condition=async(expression:string)=>{if(args.readOnly===true)return evaluateReadOnly(tabId,expression,args,deadline,readOnlyMemo);if(!sideEffects){const checked=await evaluateChecked(tabId,expression,args,deadline);if(checked)return checked.value;sideEffects=true;}return evaluate(tabId,expression,args,deadline,{userGesture:true});};
    while (Date.now() < deadline) {
      if (epoch !== controlEpoch) throw new BrowserError('CANCELLED', '等待已取消。');
      try {
        const expression = args.expression ? String(args.expression) : conditionExpression(args);
        const value = args.expression ? await condition(expression) : await evaluateInternal(tabId, expression, args, deadline);
        if (value) {matchedSince??=Date.now();if(Date.now()-matchedSince>=Number(args.stableMs||0))return {matched:true,value,...(args.stableMs?{stableForMs:Date.now()-matchedSince}:{})};}
        else matchedSince=undefined;
      } catch (error) {
        // 等待本来就要跨过导航，上下文换代只算条件还没成立；调用方点名的 iframe 上下文等不回来，仍然报错。
        if (args.contextId === undefined && contextLost(error)) matchedSince = undefined;
        else if (!args.expression && readInterrupted(error) && Date.now() >= deadline) break;
        else {
          if (!(error instanceof BrowserError) || error.code !== 'ELEMENT_NOT_FOUND' || args.expression || args.state !== 'hidden') throw error;
          // 元素不存在只满足“纯隐藏”条件（与页面运行时的 onlyHidden 一致）；带 valueEquals、fileCount、attribute、文字的组合条件不能凭元素不存在就成立，继续等到超时。
          if (args.state === 'hidden') {
            if (args.valueEquals === undefined && args.fileCount === undefined && !args.attribute && !args.textContains && !args.textMatches) {
              matchedSince ??= Date.now();
              if (Date.now() - matchedSince >= Number(args.stableMs || 0)) return { matched: true, absent: true, ...(args.stableMs ? { stableForMs: Date.now() - matchedSince } : {}) };
            } else matchedSince = undefined;
          } else throw error;
        }
      }
      await sleep(100);
    }
    // 条件每一轮都执行完并返回了假值，没有“发没发出去”的不确定，超时不隔离标签页；表达式本身的副作用和成功时一样。
    // 顺带读一次现场（停在哪个页面、最接近的文字、元素有几个），读不到就只报超时。
    const context = await evaluateInternal(tabId, waitContextExpression(args), args, Date.now() + WAIT_CONTEXT_MS).catch(() => undefined) as JsonObject | undefined;
    throw new BrowserError('WAIT_TIMEOUT', `等待条件未成立，后续步骤未执行。${context ? waitScene(context) : ''}`,{phase:'postcondition',outcome:'not_dispatched',...(context?{detail:context}:{})});
  }
  if (operation === 'page.action') {
    const result = await action(tabId, args, deadline, epoch);
    if (!args.postcondition) return result;
    const condition = args.postcondition as JsonObject;
    try { return { ...result as JsonObject, postcondition: await postconditionCheck(tabId, args, condition, args, deadline, epoch) }; }
    catch (error) { throw postconditionFailed(error, condition, '动作', '这个动作', { action: result as JsonObject }); }
  }
  if (operation === 'page.batch') {
    const results: unknown[] = [];
    const steps = args.steps as { operation: string; args: JsonObject;postcondition?:JsonObject }[];
    // 后置条件没满足：动作本身已经做完了（结果在 failedStep 里），只是页面没到预期状态。这和“发没发出去不知道”不同，不暂停写入，
    // 但也不能重复这一步，先看页面。任务队列另有自己的处理（tasks.ts 仍按待核查）。
    let failedStep:JsonObject|undefined;
    const verify=async(step:typeof steps[number],index:number,result:unknown)=>{
      if(!step.postcondition)return undefined;
      try{return await postconditionCheck(tabId,step.args,step.postcondition,args,deadline,epoch);}
      catch(error){failedStep={index,operation:step.operation,result,postcondition:{matched:false}};throw postconditionFailed(error,step.postcondition,`第 ${index+1} 步的动作`,'这一步');}
    };
    const stepDeadline=(step:typeof steps[number])=>step.operation==='page.wait'&&step.args.timeoutMs!==undefined?Math.min(deadline,Date.now()+Number(step.args.timeoutMs)):deadline;
    for (let index = 0; index < steps.length; index++) {
      dialogs.progress(tabId,index,results);
      const step = steps[index]!;
      try {
        const next = steps[index+1];
        if (next?.operation === 'page.dialog' && ['page.action','page.evaluate'].includes(step.operation)) {
          const context = step.args.contextId !== undefined ? contexts.get(tabId)?.get(`${step.args.sessionId || ''}:${step.args.contextId}`) : undefined;
          if (step.args.contextId !== undefined && !context) throw new BrowserError('UNKNOWN_FRAME','预声明弹窗的执行上下文已失效。');
          const expectedFrameId = (context?.auxData as JsonObject)?.frameId || ((await send(tabId,'Page.getFrameTree',{},step.args.sessionId as string|undefined)).frameTree as any).frame.id;
          const pair = await dialogs.expected(tabId, { ...next.args, expectedFrameId }, () => dispatch(step.operation, { ...step.args, tabId, ...carryGuard(args) }, deadline, epoch));
          await verify(step,index,pair.result);await verify(next,index+1,pair.dialog);
          results.push({ index, operation: step.operation, result: pair.result },{ index:index+1,operation:'page.dialog',result:pair.dialog }); index++;
        } else {const {timeoutMs:_,...stepArgs}=step.args;const result=await dispatch(step.operation, { ...(step.operation==='page.wait'?stepArgs:step.args), tabId, ...carryGuard(args) }, stepDeadline(step), epoch);const checked=await verify(step,index,result);results.push({ index, operation: step.operation, result,...(checked?{postcondition:checked}:{}) });}
      }
      catch (error) {
        const info=errorInfo(error);
        return { completed: false, failedIndex: index, results, ...(failedStep?{failedStep}:{}), error: info, note: info.outcome==='dispatched'?'已完成步骤保留；失败的那一步动作已做完，不要重复它；剩余步骤未执行。':'已完成步骤保留；失败步骤不重试，剩余步骤未执行。' };
      }
    }
    return { completed: true, results };
  }
  throw new BrowserError('UNKNOWN_OPERATION', operation);
}

// 后置条件：动作做完后在页面上等条件成立，批次的每一步和单个 chrome_action 共用。满足时带上标签页现在的网址和标题，提交后跳到哪了不用再等一次；
// 管理页不带。条件自带 frame 时按它的，否则沿用动作的 frame。
async function postconditionCheck(tabId: number, stepArgs: JsonObject, condition: JsonObject, args: JsonObject, deadline: number, epoch: number): Promise<JsonObject> {
  const frame = condition.contextId !== undefined || condition.sessionId !== undefined ? {} : { contextId: stepArgs.contextId, sessionId: stepArgs.sessionId };
  await dispatch('page.wait', { ...frame, ...condition, tabId, ...carryGuard(args) }, Math.min(deadline, Date.now() + Number(condition.timeoutMs || 10000)), epoch);
  const tab = await chrome.tabs.get(tabId).catch(() => undefined), url = tab?.url || tab?.pendingUrl, origins = guardOrigins(args);
  if (!url || origins && isProtectedUrl(url, origins)) return { matched: true };
  return { matched: true, url: url.slice(0, 200), ...(tab?.title ? { title: tab.title.slice(0, 80) } : {}) };
}
// 后置条件没满足：动作本身已经做完了，只是页面没到预期状态。这和“发没发出去不知道”不同，不暂停写入，但也不能重复，先看页面。
function postconditionFailed(error: unknown, condition: JsonObject, lead: string, repeat: string, extra: JsonObject = {}) {
  const info = errorInfo(error), timedOut = info.code === 'WAIT_TIMEOUT', detail = { ...(info.detail || {}), ...extra };
  return new BrowserError(timedOut ? 'POSTCONDITION_TIMEOUT' : info.code, `${lead}已经做完，但后置条件${timedOut ? ` ${Number(condition.timeoutMs || 10000)} 毫秒内` : ''}没有满足（${info.message}）。动作不会重试，标签页照常可写；先看页面再决定下一步，不要重复${repeat}。`, { phase: 'postcondition', outcome: 'dispatched', ...(Object.keys(detail).length ? { detail } : {}) });
}

// 参数里直接出现管理页 origin（导航、DOMStorage/Storage 等）。
const mentions = (value: unknown, origins: readonly string[], depth = 0): boolean => {
  if (typeof value === 'string') { const text = value.toLowerCase(); return origins.some(origin => text.includes(origin.toLowerCase())); }
  return depth <= 8 && !!value && typeof value === 'object' && Object.values(value as object).some(item => mentions(item, origins, depth + 1));
};
// 非管理员主体的原始 CDP：Runtime 类方法在页内前缀保护下执行，“新文档脚本”套进一层带保护判断的函数；Debugger 域可在任意页面里执行代码，整体拒绝；
// 其余方法的参数直接引用管理页 origin 时拒绝。原始 CDP 不是安全沙箱：这些堵住的是直接路径，
// 不能阻止在“曾打开过管理页又被用户导航走”的标签页里刻意的多步调试器持久化手法。
async function guardedCdp(tabId: number, method: string, params: JsonObject, sessionId: string | undefined, origins: string[]) {
  const prefix = adminGuardPrefix(origins);
  let sent = params;
  if (/^Debugger\./.test(method)) throw new BrowserError('CDP_METHOD_RESTRICTED', 'Debugger 域可以在任意页面（包括本机管理页）里执行代码，此客户端不能使用。', { phase: 'precondition', outcome: 'not_dispatched' });
  if ((method === 'Runtime.evaluate' || method === 'Runtime.compileScript') && typeof params.expression === 'string') sent = { ...params, expression: prefix + params.expression };
  else if (method === 'Runtime.callFunctionOn' && typeof params.functionDeclaration === 'string') sent = { ...params, functionDeclaration: `function(){${prefix}return (${params.functionDeclaration}\n).apply(this,arguments);}` };
  // 新文档脚本套进一层函数、按 self.origin 判断（见 init-script.ts）：拼前缀挡不住顶层函数声明的提升，about:blank iframe 的 location.origin 也是 "null"。服务已确认 source 是合法的函数体。
  else if (method === 'Page.addScriptToEvaluateOnNewDocument' && typeof params.source === 'string') sent = { ...params, source: initScriptSource(params.source, origins) };
  else if (mentions(params, origins)) throw protectedPage();
  const result = await send(tabId, method, sent, sessionId);
  if (((result.exceptionDetails as JsonObject | undefined)?.exception as JsonObject | undefined)?.value === ADMIN_GUARD_MARKER) throw protectedPage();
  return result;
}

async function fullPageClip(tabId: number) {
  const metrics = await send(tabId, 'Page.getLayoutMetrics');
  const size = (metrics.cssContentSize || metrics.contentSize) as JsonObject;
  return { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
}

// 元素按它在页面里的位置（视口坐标加滚动距离）截，不滚动页面；clip 由调用方给页面坐标。都用 captureBeyondViewport，视口外的部分也截得到。
async function screenshotClip(tabId: number, args: JsonObject, deadline: number) {
  if (args.selector || args.ref || args.locator) {
    const box = await evaluateInternal(tabId, elementExpression(args, `const rect=element.getBoundingClientRect();if(!rect.width||!rect.height)FengPage.fail('ELEMENT_NOT_VISIBLE','元素没有尺寸，截不到。');return {x:rect.left+scrollX,y:rect.top+scrollY,width:rect.width,height:rect.height};`), args, deadline) as JsonObject;
    return { ...box, scale: 1 };
  }
  if (args.clip) return { ...(args.clip as JsonObject), scale: 1 };
  return args.fullPage === true ? fullPageClip(tabId) : undefined;
}
// 截图按 CSS 像素出图：缩放 125% 的 Windows 上原图是设备像素，比点击用的坐标大 1.25 倍，照着图点会点偏。
// 视口截图的图片坐标就是 click 的 x/y；整页、元素和 clip 截图带 area（图片左上角的页面坐标）和截图时的滚动位置，换算成视口坐标 = 图片坐标 + area - scroll。
// 比例用 Page.getLayoutMetrics 里截图实际用的设备像素 ÷ CSS 像素，不用页面的 devicePixelRatio：调试工具模拟设备时两者不一样（实测）。读不到就照原样截，不带坐标说明。
// clipViewport：clip 按视口坐标给，加上截图时的滚动距离换成页面坐标。scale：图片再按比例缩小，coordinates 带上它，图片坐标先除以它。
// 后台标签页截图要等一帧新画面，页面没变化时 Chrome 常常不出这一帧，截图就一直挂着（Chrome 154、156 实测，开着焦点模拟也一样；前台约 0.1 秒）。
// 后台截图期间开着 Page.startScreencast 让 Chrome 持续出帧，等待时再用 Overlay 交替画一个全透明的 1 像素方块逼重绘：两样都不进页面 DOM，
// 页面收不到事件，图上也看不出来；正式版 Chrome 156 带窗口 12 次都在 80–170ms 截到（只逼帧有一半要 1.2 秒，只开 screencast 无头要 1 秒）。
// 1.5 秒还没截到，才短暂切到前台把这一帧截完再切回去（用户这时已经切到别的标签页就不切回）。最小化的窗口 useViewport 已经恢复过了。
const NUDGE_MS = 60, BACKGROUND_CAPTURE_MS = 1500;
// 上传的目标还没出现时隔多久再找一次；留出余量给设置文件和读回。
const UPLOAD_POLL_MS = 100, UPLOAD_RESERVE_MS = 2000;
const screencasting = new Set<number>();
async function captureFrame(tabId: number, params: JsonObject): Promise<{ data: string }> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.active) return send(tabId, 'Page.captureScreenshot', params) as Promise<{ data: string }>;
  screencasting.add(tabId);
  let finished = false, shot: Promise<{ data: string }> | undefined;
  const waitFor = async (ms: number) => { for (const until = Date.now() + ms; !finished && Date.now() < until;) await sleep(10); return finished; };
  try {
    await send(tabId, 'Page.startScreencast', { format: 'jpeg', quality: 1, maxWidth: 32, maxHeight: 32 }).catch(() => {});
    shot = send(tabId, 'Page.captureScreenshot', params) as Promise<{ data: string }>;
    void shot.then(() => { finished = true; }, () => { finished = true; });
    if (await waitFor(NUDGE_MS)) return await shot;
    await send(tabId, 'DOM.enable').catch(() => {}); await send(tabId, 'Overlay.enable').catch(() => {});
    for (let i = 0, until = Date.now() + BACKGROUND_CAPTURE_MS; !finished && Date.now() < until; i++) {
      await send(tabId, 'Overlay.highlightRect', { x: i % 2, y: 0, width: 1, height: 1, color: { r: 0, g: 0, b: 0, a: 0 } }).catch(() => {});
      await waitFor(NUDGE_MS);
    }
    await send(tabId, 'Overlay.hideHighlight').catch(() => {});
  } finally {
    await send(tabId, 'Page.stopScreencast').catch(() => {});
    screencasting.delete(tabId);
  }
  if (finished) return shot;
  const previous = (await chrome.tabs.query({ windowId: tab.windowId, active: true }))[0];
  await chrome.tabs.update(tabId, { active: true });
  try {
    // 到了前台还是没回来就重截一张。
    return await Promise.race([shot, sleep(2000).then(() => finished ? shot : send(tabId, 'Page.captureScreenshot', params) as Promise<{ data: string }>)]);
  } finally {
    const current = (await chrome.tabs.query({ windowId: tab.windowId, active: true }).catch(() => []))[0];
    if (current?.id === tabId && previous?.id !== undefined && previous.id !== tabId) await chrome.tabs.update(previous.id, { active: true }).catch(() => {});
  }
}

async function screenshot(tabId: number, args: JsonObject, deadline: number) {
  const clip = await screenshotClip(tabId, args, deadline) as JsonObject | undefined, scale = Number(args.scale ?? 1);
  const metrics = await send(tabId, 'Page.getLayoutMetrics').catch(() => undefined) as { layoutViewport?: { clientWidth?: number }; cssLayoutViewport?: { pageX: number; pageY: number; clientWidth: number; clientHeight: number } } | undefined;
  const view = metrics?.cssLayoutViewport, device = Number(metrics?.layoutViewport?.clientWidth);
  if (clip && args.clipViewport === true) {
    const scroll = view ? { x: view.pageX, y: view.pageY } : await evaluateInternal(tabId, '({x:scrollX,y:scrollY})', args, deadline) as { x: number; y: number };
    clip.x = Number(clip.x) + scroll.x; clip.y = Number(clip.y) + scroll.y;
  }
  if (!view || !(view.clientWidth > 0) || !(device > 0)) {
    const region = clip ?? (scale !== 1 ? await evaluateInternal(tabId, '({x:scrollX,y:scrollY,width:innerWidth,height:innerHeight})', args, deadline) as JsonObject : undefined);
    return { mimeType: 'image/png', data: (await cursor.hidden(tabId, () => captureFrame(tabId, { format: 'png', captureBeyondViewport: !!clip, fromSurface: true, ...(region ? { clip: { ...region, scale } } : {}) }))).data };
  }
  const area = clip ? { x: Number(clip.x), y: Number(clip.y), width: Number(clip.width), height: Number(clip.height) } : { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight };
  // 图片超出视口时，固定在屏幕上的元素按截图时的位置画进图里（整页图的顶栏出现在中间）：截之前记下它们在图里的位置，写进 coordinates，不改页面。
  const beyond = !!clip && (area.x < view.pageX - 1 || area.y < view.pageY - 1 || area.x + area.width > view.pageX + view.clientWidth + 1 || area.y + area.height > view.pageY + view.clientHeight + 1);
  const fixed = beyond ? await evaluateInternal(tabId, `(()=>{return FengPage.fixedElements(${JSON.stringify(area)},${scale});})()`, args, deadline).catch(() => []) as JsonObject[] : [];
  const data = (await cursor.hidden(tabId, () => captureFrame(tabId, {
    format: 'png', captureBeyondViewport: !!clip, fromSurface: true, clip: { ...area, scale: view.clientWidth / device * scale },
  }))).data;
  const rounded = (point: { x: number; y: number }) => ({ x: Math.round(point.x), y: Math.round(point.y) });
  // 视口截图的图片坐标（除以 scale）就是 chrome_action 的 x/y，不带 area、scroll，免得被当成要加的偏移。其余的直接给换算用的 toViewport。
  const located = clip ? { area: Object.fromEntries(Object.entries(area).map(([key, value]) => [key, Math.round(value)])), scroll: rounded({ x: view.pageX, y: view.pageY }), toViewport: rounded({ x: area.x - view.pageX, y: area.y - view.pageY }), ...(fixed.length ? { fixed } : {}) } : { viewport: true };
  return { mimeType: 'image/png', data, coordinates: { cssPixels: true, ...located, ...(scale !== 1 ? { scale } : {}) } };
}

// 把文件设进已经确定的那个文件框（args.ref），读回文件名和大小。
async function setUploadFiles(tabId:number,args:JsonObject,prepared:{input?:JsonObject},deadline:number,epoch:number){
  const sessionId=args.sessionId as string|undefined;
  const remote = await evaluateInternal(tabId, elementExpression(args, 'return element;'), args, deadline, false) as JsonObject;
  if (!remote.objectId) throw new BrowserError('ELEMENT_NOT_FOUND', '未找到文件输入框。');
  try { dialogs.assert(tabId); if(epoch!==controlEpoch||Date.now()>deadline)throw new BrowserError('CANCELLED','控制已失效，未写入文件输入框。',NOT_DISPATCHED);
    if(args.fileIds){const result=await uploadContent(args.fileIds,String(remote.objectId),(method,params)=>send(tabId,method,params,sessionId),async()=>{dialogs.assert(tabId);if(epoch!==controlEpoch||Date.now()>deadline)throw new BrowserError('CANCELLED','控制已失效，未设置网页文件。',NOT_DISPATCHED);await assertNotAdminPage(tabId,args);});return prepared.input&&result&&typeof result==='object'?{...result as JsonObject,input:prepared.input}:result;}
    await send(tabId, 'DOM.setFileInputFiles', { files: args.paths, objectId: remote.objectId }, sessionId);
    // 本机路径由 Chrome 自己读：读回文件名和大小，对不上说明路径不在这台电脑或文件被换过，页面可能已经开始处理，按结果不明报告。
    const listed=await send(tabId,'Runtime.callFunctionOn',{objectId:remote.objectId,functionDeclaration:'function(){return Array.from(this.files||[],f=>({name:f.name,size:f.size}));}',returnByValue:true},sessionId).catch(()=>undefined) as JsonObject|undefined;
    const files=(listed?.result as JsonObject|undefined)?.value as {name:string;size:number}[]|undefined,expected=args.expectedFiles as {name:string;size:number}[]|undefined;
    if(expected&&files&&(files.length!==expected.length||files.some((file,index)=>file.name!==expected[index]!.name||file.size!==expected[index]!.size)))throw new BrowserError('UPLOAD_FILE_MISMATCH','Chrome 读到的文件和服务核对的不一致（名称或大小不同），浏览器可能不在服务这台电脑上。页面可能已开始处理，先核查页面，不要重复上传。',{phase:'execution',outcome:'unknown'});
    return {...(files?{files}:{}),...(prepared.input?{input:prepared.input}:{})}; }
  finally { await send(tabId, 'Runtime.releaseObject', { objectId: remote.objectId }, sessionId).catch(() => {}); }
}

interface ChooserTarget { target:string; candidates:JsonObject[]; total:number; text:string }
// 点完多久还没打开选择框就算没打开：页面一般在点击的处理函数里同步调 input.click()。
const CHOOSER_WAIT_MS=2000;
// 上传区里有几个文件框、分不出用哪个（例如 Semi Design 的 Upload 自带主框和替换框）：像用户一样点一下目标，看页面自己打开哪个文件框的选择框。
// 开着 CDP 的选择框拦截时 Chrome 不弹系统选择框，Page.fileChooserOpened 带着那个文件框的 backendNodeId；拦截只在这次点击前后开着。
// 点击走普通点击的整条路（可见、遮挡、拟人轨迹、后台标签页焦点模拟、同窗口排队）。没打开选择框就报出候选，不猜；点击已经发出，所以是“已派发”。
async function uploadByChooser(tabId:number,args:JsonObject,found:ChooserTarget,count:number,deadline:number,epoch:number):Promise<{ref:string;input:JsonObject}>{
  const sessionId=args.sessionId as string|undefined;
  let opened:JsonObject|undefined,notify=()=>{};
  const listener:Parameters<typeof chrome.debugger.onEvent.addListener>[0]=(source,method,params)=>{if(source.tabId===tabId&&(source.sessionId||undefined)===sessionId&&method==='Page.fileChooserOpened'&&!opened){opened=(params||{}) as JsonObject;notify();}};
  const ambiguous=(reason:string)=>new BrowserError('AMBIGUOUS_FILE_INPUT',`目标附近有 ${found.total} 个文件框，没有上传：${found.text}。${reason}定位到离要用的那个更近的按钮或区域，或用其中一个 ref。`,{...NOT_DISPATCHED,detail:{candidates:found.candidates,total:found.total}});
  try{await send(tabId,'Page.setInterceptFileChooserDialog',{enabled:true},sessionId);}
  catch(error){throw ambiguous(`Chrome 不让拦截文件选择框（${failureText(error)}），没法点上传区来判断。`);}
  chrome.debugger.onEvent.addListener(listener);
  let clicked:JsonObject;
  try{
    const click={...args,action:'click',selector:undefined,locator:undefined,ref:found.target,paths:undefined,fileIds:undefined,expectedFiles:undefined};
    const run=()=>action(tabId,click,deadline,epoch) as Promise<JsonObject>;
    clicked=await (viewportHeld.has(tabId)?run():withViewport(tabId,deadline,run));
    const until=Math.min(deadline,Date.now()+CHOOSER_WAIT_MS);
    if(!opened)await new Promise<void>(resolve=>{const timer=setTimeout(resolve,Math.max(0,until-Date.now()));notify=()=>{clearTimeout(timer);resolve();};});
  }finally{
    chrome.debugger.onEvent.removeListener(listener);
    await send(tabId,'Page.setInterceptFileChooserDialog',{enabled:false},sessionId).catch(()=>{});
  }
  const hit=clicked.hit as JsonObject|undefined,where=hit?`（落在 ${String(hit.selector)}${hit.name?`「${String(hit.name)}」`:hit.text?`「${String(hit.text)}」`:''}）`:'';
  const after={phase:'execution' as const,outcome:'dispatched' as const,detail:{candidates:found.candidates,total:found.total,click:{x:clicked.x,y:clicked.y,...(hit?{hit}:{})}}};
  if(!opened)throw new BrowserError('FILE_CHOOSER_NOT_OPENED',`点了目标${where}，页面没有打开文件选择框，没有上传。目标附近有 ${found.total} 个文件框：${found.text}。这次点击可能有别的效果，先看页面，再用其中一个 ref 上传；不要重复点击。`,after);
  if(typeof opened.backendNodeId!=='number')throw new BrowserError('FILE_CHOOSER_UNSUPPORTED',`点了目标${where}，页面打开的选择框不来自 input[type=file]（可能是 showOpenFilePicker），没法设文件，没有上传。先看页面，再用候选的 ref 上传：${found.text}。`,after);
  if(epoch!==controlEpoch||Date.now()>deadline)throw new BrowserError('CANCELLED','已经点了上传区，控制已失效，没有写入文件。先看页面。',after);
  let objectId:string|undefined;
  try{
    const resolved=await send(tabId,'DOM.resolveNode',{backendNodeId:opened.backendNodeId,executionContextId:await isolated.get(tabId,args,deadline)},sessionId);
    objectId=(resolved.object as JsonObject|undefined)?.objectId as string|undefined;
    if(!objectId)throw new Error('没有对象');
    const described=await send(tabId,'Runtime.callFunctionOn',{objectId,functionDeclaration:`function(){return FengPage.chosenUpload(this,${count},${JSON.stringify(found.target)});}`,returnByValue:true},sessionId);
    const value=(described.result as JsonObject|undefined)?.value as {ref?:string;input?:JsonObject;error?:{code:string;message:string}}|undefined;
    if(value?.error)throw new BrowserError(value.error.code,`点了目标${where}，${value.error.message}`,after);
    if(!value?.ref||!value.input)throw new Error('读不出文件框');
    return {ref:value.ref,input:value.input};
  }catch(error){
    if(error instanceof BrowserError)throw error;
    throw new BrowserError('FILE_CHOOSER_UNSUPPORTED',`点了目标${where}，页面打开了选择框，但找不到它所属的文件框（${failureText(error)}），没有上传。先看页面，再用候选的 ref 上传：${found.text}。`,after);
  }finally{if(objectId)await send(tabId,'Runtime.releaseObject',{objectId},sessionId).catch(()=>{});}
}

// 正在 withViewport 里跑的标签页：批次里有视觉动作时整批已经占着窗口队列，里面的上传再点击就不能再排一次队（队列不可重入）。
const viewportHeld=new Set<number>();
async function withViewport<T>(tabId: number, deadline: number, run: () => Promise<T>): Promise<T> {
  const tab = await chrome.tabs.get(tabId);
  return windowLocks.run(tab.windowId, deadline, () => useViewport(tabId, tab.windowId, deadline, run));
}

// 不切换窗口的当前标签页：用户可能正在同一窗口的别的标签页里操作，切过去页面会跳走，用户这时敲的键、点的鼠标也会落到 Agent 的标签页上。
// 后台标签页开着焦点模拟就出帧、收输入（正式版 Chrome 156 实测点击、逐键、中文、滚轮、指针拖拽和 HTML5 拖放都行）。
// 服务在视觉动作前已经开了焦点模拟、命令结束才关，等页面安静那段也还开着；没开的（直接 RPC 之类）这里补开，做完关掉。
async function useViewport<T>(tabId: number, windowId: number, deadline: number, run: () => Promise<T>): Promise<T> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId !== windowId) throw new BrowserError('TAB_MOVED', '排队期间标签页移到另一个窗口，请重新定位后再操作。', NOT_DISPATCHED);
  const window = await chrome.windows.get(tab.windowId);
  const restored = window.state === 'minimized';
  let emulated = false;
  try {
    // 最小化的窗口里截图会挂住（Chrome 156 实测，焦点模拟也没用），旧版 Chrome 还可能报告 0 × 0 视口：先恢复窗口，不抢焦点。
    if (restored) await chrome.windows.update(tab.windowId, { state: 'normal', focused: false });
    await ensure(tabId);
    if (!focusEmulated.has(tabId)) {
      try { await send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }); }
      catch (error) { throw new BrowserError('CDP_COMMAND_REJECTED', `Chrome 没有打开焦点模拟，动作未派发：${failureText(error)}`, NOT_DISPATCHED); }
      focusEmulated.add(tabId); emulated = true;
    }
    const readyBy = Math.min(deadline, Date.now() + 5000);
    let usable = false;
    while (Date.now() < readyBy) {
      usable = await evaluate(tabId, 'innerWidth > 0 && innerHeight > 0', {}, deadline) === true;
      if (usable) break;
      await sleep(50);
    }
    if (!usable) throw new BrowserError('NO_VIEWPORT', '窗口没有可用的画面区域。请恢复此 Chrome 窗口后再操作。', NOT_DISPATCHED);
    viewportHeld.add(tabId);
    try { return await run(); } finally { viewportHeld.delete(tabId); }
  } finally {
    if (emulated && attached.has(tabId)) await send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).then(() => focusEmulated.delete(tabId), () => {});
    if (restored) {
      const currentWindow = await chrome.windows.get(tab.windowId).catch(() => undefined);
      if (currentWindow && !currentWindow.focused && currentWindow.state === 'normal') {
        await chrome.windows.update(tab.windowId, { state: 'minimized' }).catch(() => {});
      }
    }
  }
}

// 鼠标移上去以后目标挪了位置：最多跟过去三次，前后最多等 1.5 秒。
const HOVER_FOLLOWS = 3, HOVER_SETTLE_MS = 1500;
async function action(tabId: number, args: JsonObject, deadline: number, epoch: number): Promise<unknown> {
  let dispatched=false;
  try{return await actionInput(tabId,args,deadline,epoch,()=>{dialogs.arm(tabId);dispatched=true;});}
  // 派发之后的失败一律按结果不明；choose 自己标了 dispatched 的（只点开了下拉，或点完选项核对没通过）保留。
  catch(error){if(dispatched){const info=errorInfo(error);if(info.outcome==='dispatched')throw error;throw new BrowserError(info.code,info.message,{phase:'execution',outcome:'unknown',...(info.detail?{detail:info.detail}:{})});}throw error;}
}

async function prepareTarget(tabId:number,args:JsonObject,deadline:number,epoch:number){
  let id:unknown;
  const pointer=['click','doubleClick','drag','setChecked','hover','scroll'].includes(String(args.action));let previous:Awaited<ReturnType<typeof elementPoint>>|undefined,last='ELEMENT_NOT_FOUND',lastInfo:ReturnType<typeof errorInfo>|undefined,scrolled:{x:number;y:number}|undefined;
  const retryable=new Set(['ELEMENT_NOT_FOUND','ELEMENT_NOT_VISIBLE','ELEMENT_DISABLED','NOT_EDITABLE','ELEMENT_OBSCURED','ELEMENT_UNSTABLE','OPTION_NOT_FOUND','OPTION_DISABLED']);
  // 光标关着时探针一个字节都不变；开着才顺带读目标的框。同进程 iframe 的框是 iframe 里的坐标，对不上 Overlay，不画。
  const framed=!pointer&&cursor.enabled&&args.contextId===undefined,sessionId=args.sessionId as string|undefined;
  const probe=elementExpression(args,`
    if(!state.visible)FengPage.notVisible(element);if(state.disabled)FengPage.fail('ELEMENT_DISABLED');
    if(['fill','type','press'].includes(${JSON.stringify(args.action)})&&state.readOnly)FengPage.fail('NOT_EDITABLE');
    if(['fill','type'].includes(${JSON.stringify(args.action)})&&!(element instanceof HTMLTextAreaElement)&&!element.isContentEditable&&!(element instanceof HTMLInputElement&&!['file','checkbox','radio','button','submit','reset','hidden'].includes(element.type)))FengPage.fail('NOT_TEXT_INPUT');
    if(${args.action==='select'}){if(!(element instanceof HTMLSelectElement))FengPage.fail('NOT_SELECT');const values=${JSON.stringify(args.values||[])};if(!element.multiple&&values.length>1)FengPage.fail('INVALID_OPTION_COUNT');for(const value of values){const option=[...element.options].find(o=>o.value===value);if(!option)FengPage.fail('OPTION_NOT_FOUND');if(option.disabled||option.parentElement instanceof HTMLOptGroupElement&&option.parentElement.disabled)FengPage.fail('OPTION_DISABLED');}}
    return {ref:FengPage.elementRef(element),documentId:FengPage.documentId()${framed?',box:(r=>({x:r.x,y:r.y,width:r.width,height:r.height}))(element.getBoundingClientRect())':''}};`);
  while(Date.now()<deadline){
    dialogs.assert(tabId);if(epoch!==controlEpoch)throw new BrowserError('CANCELLED','等待期间控制已取消，目标输入未派发。',{phase:'precondition',outcome:'not_dispatched'});
    try{
      const currentDocument=await evaluateInternal(tabId,documentExpression(),args,deadline);
      if(id===undefined)id=currentDocument;else if(currentDocument!==id)throw new BrowserError('DOCUMENT_CHANGED','等待期间页面已导航，目标输入未派发；重新读取。',{phase:'precondition',outcome:'not_dispatched'});
      const candidate=pointer?await elementPoint(tabId,args,deadline):await evaluateInternal(tabId,probe,args,deadline) as {ref:string;documentId:string};
      if(candidate.documentId!==id)throw new BrowserError('DOCUMENT_CHANGED','目标文档已变化。',{phase:'precondition',outcome:'not_dispatched'});
      // 动作不等光标：读到第一个落点就开始滑，接下来核对落点稳定的几十毫秒里正好滑过去。拖拽的起点终点由拖拽本身的鼠标事件驱动。
      const box=(candidate as {box?:CursorBox}).box;
      // 像真人一样操作时光标跟着轨迹走（每个 mouseMoved 都告诉它），这里不先滑过去。
      if(pointer&&args.action!=='drag'&&!args.aim)cursor.aim(tabId,sessionId,candidate as Awaited<ReturnType<typeof elementPoint>>);
      else if(framed&&box)cursor.frame(tabId,sessionId,box);
      // 第一次取点可能把目标滚进视口，之后核对稳定的几次不再滚：滚了多少记下来放进最后的落点。
      const moved=(candidate as {scrolled?:{x:number;y:number}}).scrolled;if(moved)scrolled={x:(scrolled?.x||0)+moved.x,y:(scrolled?.y||0)+moved.y};
      const withScroll=<T extends object>(point:T)=>scrolled&&(scrolled.x||scrolled.y)?{...point,scrolled}:point;
      if(!pointer||args.autoWait===false)return withScroll(candidate);
      const point=candidate as Awaited<ReturnType<typeof elementPoint>>;
      if(previous&&previous.ref===point.ref&&samePoint(previous,point))return withScroll(point);
      previous=point;last='ELEMENT_UNSTABLE';
    }catch(error){
      const read=beforeInput(error,args,deadline);if(read==='expired')break;
      if(read==='lost'){last='STALE_CONTEXT';previous=undefined;}
      else{const info=errorInfo(error);if(args.autoWait===false||!retryable.has(info.code)||info.outcome!=='not_dispatched')throw error;last=info.code;lastInfo=info;previous=undefined;}
    }
    await sleep(Math.min(50,Math.max(1,deadline-Date.now())));
  }
  // 最后一次的原因写进报错：看不见是哪一层、被谁挡住，调用方不用再查一遍。
  const why=lastInfo?.code===last&&lastInfo.message!==last?`：${lastInfo.message}`:'';
  throw new BrowserError('ACTIONABILITY_TIMEOUT',`目标未在时间内就绪（${last}${why}），目标输入未派发。`,{phase:'precondition',outcome:'not_dispatched',...(lastInfo?.code===last&&lastInfo.detail?{detail:{code:last,...lastInfo.detail}}:{})});
}

async function actionInput(tabId: number, args: JsonObject, deadline: number, epoch: number,markDispatched:()=>void): Promise<unknown> {
  const sessionId = args.sessionId as string | undefined;
  let inputStarted=false;const mark=markDispatched;markDispatched=()=>{inputStarted=true;mark();};
  const assertActive = () => { dialogs.assert(tabId);if(epoch!==controlEpoch||Date.now()>deadline)throw new BrowserError('CANCELLED','本次输入已取消或过期，后续输入未派发。',{phase:inputStarted?'execution':'precondition',outcome:inputStarted?'unknown':'not_dispatched'}); };
  const located=!!(args.selector||args.ref||args.locator);
  // 这一次动作是否像真人一样操作（开关中途变了也按开始时的）。鼠标类动作的落点偏离中心，比例这里定下，整个动作（含各次核对）都用它。
  const human=humanInput;
  if(human&&located&&['click','doubleClick','setChecked','hover','drag','scroll'].includes(String(args.action))&&!Array.isArray(args.aim))args={...args,aim:aimRatio()};
  // 非法键在聚焦目标前拒绝，避免把参数错误变成页面副作用。
  const keyDefinition=args.action==='press'?keyboardKey(String(args.key),Number(args.modifiers||0)):undefined;
  // 鼠标类动作（click/hover/scroll）的修饰键随每一个鼠标事件发送（press 的修饰键由 keyboardKey 处理）。为 0 时不带字段，事件体与以往逐字节相同。
  // 只是事件上的修饰键标志，不单独派发 Control/Shift 等键的 keydown/keyup；依赖键盘事件监听的页面请用 press。
  const withModifiers=Number.isInteger(args.modifiers)&&Number(args.modifiers)&15?{modifiers:Number(args.modifiers)&15}:{};
  // 鼠标事件都经过这里：先告诉光标（不等它画），记下鼠标停在哪，再原样发给页面。
  const mouse=(params:JsonObject)=>{cursor.input(tabId,sessionId,params);const x=Number(params.x),y=Number(params.y),key=pointerKey(tabId,sessionId);if(x>=0&&y>=0)pointers.set(key,{x,y});else pointers.delete(key);return send(tabId,'Input.dispatchMouseEvent',params,sessionId);};
  const wait=async(ms:number)=>{const until=Date.now()+ms;while(Date.now()<until){assertActive();await sleep(Math.min(25,until-Date.now()));}assertActive();};
  // 鼠标移到 point：像真人时从上一个位置沿轨迹移过去（这个会话里还没动过就从视口里一个随机位置出发），否则一步到位。
  const moveTo=async(point:PathPoint,extra:JsonObject={})=>{
    if(!human){await mouse({type:'mouseMoved',x:point.x,y:point.y,...extra});return;}
    const grid=await devicePixels(tabId,sessionId);let from=pointers.get(pointerKey(tabId,sessionId));
    if(!from){from=startPoint(grid.viewport,grid.ratio);assertActive();await mouse({type:'mouseMoved',x:from.x,y:from.y,...extra});}
    for(const step of mousePath(from,point,{grid:grid.ratio})){await wait(step.delayMs);await mouse({type:'mouseMoved',x:step.x,y:step.y,...extra});}
  };
  const readChecked=async()=>evaluateInternal(tabId,`(()=>{
    const element=FengPage.pageDom(${JSON.stringify({selector:args.selector,ref:args.ref,locator:args.locator,mode:'resolve',allowHidden:true})});const state=FengPage.elementState(element);
    const native=element instanceof HTMLInputElement&&['checkbox','radio'].includes(element.type);
    const role=native?element.type:element.getAttribute('role');
    const aria=element.getAttribute('aria-checked');
    if(!native&&(!['checkbox','radio','switch','menuitemcheckbox','menuitemradio'].includes(role)||!['true','false','mixed'].includes(aria)))FengPage.fail('NOT_CHECKABLE','目标不是 checkbox、radio 或有 aria-checked 的勾选控件。');
    return {checked:native?element.checked:aria==='true'?true:aria==='false'?false:null,indeterminate:native?element.indeterminate:aria==='mixed',radio:role==='radio'||role==='menuitemradio',readOnly:state.readOnly,ref:FengPage.elementRef(element),documentId:FengPage.documentId()};})()`,args,deadline) as Promise<{checked:boolean|null;indeterminate:boolean;radio:boolean;readOnly:boolean;ref:string;documentId:string}>;
  if(args.action==='setChecked'){
    let documentId:unknown;
    let current:Awaited<ReturnType<typeof readChecked>>|undefined;
    // 先读取状态以保留隐藏/禁用且已达目标的no-op；目标尚未出现时沿用有界autoWait，输入派发后不走此重试。
    while(Date.now()<deadline){
      assertActive();
      try{
        const currentDocument=await evaluateInternal(tabId,documentExpression(),args,deadline);
        if(documentId===undefined)documentId=currentDocument;else if(currentDocument!==documentId)throw new BrowserError('DOCUMENT_CHANGED','等待勾选控件期间页面已导航，未派发输入；请重新定位。',NOT_DISPATCHED);
        current=await readChecked();if(current.documentId!==documentId)throw new BrowserError('DOCUMENT_CHANGED','勾选控件所属文档已变化，未派发输入。',NOT_DISPATCHED);break;
      }catch(error){
        const read=beforeInput(error,args,deadline);if(read==='expired')break;
        if(!read){const info=errorInfo(error);if(args.autoWait===false||info.code!=='ELEMENT_NOT_FOUND'||info.outcome!=='not_dispatched')throw error;}
      }
      await sleep(Math.min(50,Math.max(1,deadline-Date.now())));
    }
    if(!current)throw new BrowserError('ACTIONABILITY_TIMEOUT','勾选控件未在时间内出现，尚未派发输入。',NOT_DISPATCHED);
    if(current.checked===args.checked&&!current.indeterminate)return {checked:args.checked,changed:false,verified:true};
    if(current.readOnly)throw new BrowserError('NOT_EDITABLE','勾选控件为只读，未派发点击。',NOT_DISPATCHED);
    if(current.radio&&args.checked===false)throw new BrowserError('RADIO_CANNOT_UNCHECK','不能通过点击取消 radio；请选择同组的另一个选项。',NOT_DISPATCHED);
    args={...args,selector:undefined,locator:undefined,ref:current.ref};
  }
  if(args.action==='choose')return choose(tabId,args,deadline,epoch,markDispatched,assertActive);
  const prepared=located?await prepareTarget(tabId,args,deadline,epoch):undefined;
  if(prepared)args={...args,ref:prepared.ref,selector:undefined,locator:undefined};
  if(args.action==='type'||args.action==='fill'&&args.fillMode!=='setValue'){
    // 像真人一样输入：字段还没有焦点时先像点击一样移过去点它一下，textInput 里再用键盘全选、逐键打。
    // 点不了（被挡住、不在视口里）就不点，退回直接聚焦；点击已经发出后出错照常抛出。
    let clicked=false;
    if(human&&prepared){
      const state=await evaluateInternal(tabId,elementExpression(args,'let active=document.activeElement;while(active?.shadowRoot?.activeElement)active=active.shadowRoot.activeElement;return {focused:active===element,editable:FengPage.browserEditable(element)};'),args,deadline) as {focused:boolean;editable:boolean};
      if(!state.focused&&state.editable){
        try{await actionInput(tabId,{action:'click',ref:prepared.ref,autoWait:false,contextId:args.contextId,sessionId:args.sessionId,...carryGuard(args)},deadline,epoch,()=>{clicked=true;markDispatched();});}
        catch(error){if(clicked)throw error;}
      }
    }
    const result=await textInput(args,{evaluate:(expression,frame)=>evaluateInternal(tabId,expression,frame,deadline),send:(method,params)=>send(tabId,method,params,sessionId),assertActive,mark:markDispatched,...(human?{human:{wait,deadline,clicked}}:{})});
    if(result!==undefined)return result;
  }
  if (args.action === 'scroll') {
    // 滚轮位置：元素定位时是该元素的中心（prepareTarget 已滚入视野并核对稳定与遮挡，滚动容器本身即使被禁用也可以滚动）；否则 x,y；都没有时是视口原点。
    // 滚动量：deltaX、deltaY 都没给时纵向滚 600；只给一个时另一个为 0（只想横向滚动时不再多滚 600）。
    const target = prepared as Awaited<ReturnType<typeof elementPoint>> | undefined, point = target ? { x: target.x, y: target.y } : { x: Number(args.x ?? 0), y: Number(args.y ?? 0) };
    const given = args.deltaX !== undefined || args.deltaY !== undefined, deltaX = Number(args.deltaX ?? 0), deltaY = Number(args.deltaY ?? (given ? 0 : 600));
    assertActive(); markDispatched();
    // 没给位置时滚轮落在视口原点，不在角上画光标，鼠标也不移过去。像真人一样操作时先把鼠标移到滚轮位置，滚动量按一格 100 拆开、格间停几十毫秒。
    const placed = !!target || args.x !== undefined || args.y !== undefined, notches = human ? wheelSteps(deltaX, deltaY) : [];
    if (placed && human) await moveTo(point, withModifiers);
    for (const [index, delta] of (notches.length ? notches : [{ deltaX, deltaY }]).entries()) {
      if (index) await wait(pause('wheelGapMs'));
      const wheel = { type: 'mouseWheel', ...point, ...delta, ...withModifiers };
      await (placed ? mouse(wheel) : send(tabId, 'Input.dispatchMouseEvent', wheel, sessionId));
    }
    return { scrolled: true, ...point, deltaX, deltaY, ...withModifiers };
  }
  if (args.action === 'press') {
    let target:InputTarget|undefined;
    if (located) {
      dialogs.arm(tabId);
      target=await evaluateInternal(tabId,elementExpression(args,"if (!state.visible || state.disabled || state.readOnly) FengPage.fail('NOT_EDITABLE'); __fengInputStarted=true; element.focus(); FengPage.assertFocused(element); return {ref:FengPage.elementRef(element),documentId:FengPage.documentId()};"),args,deadline) as InputTarget;
      markDispatched();
    }
    const focused=async()=>{assertActive();if(target)await evaluateInternal(tabId,inputTargetExpression(args,target),args,deadline);assertActive();};
    await focused();
    const {text,...params}=keyDefinition!;
    // 修饰键先按下、主键松开后再松开（大写字母、!? 这类隐含 Shift 也一样）；像真人时键之间停几十毫秒。
    const held:KeyboardKey[]=[];
    markDispatched();
    try {
      for(const modifier of modifierKeys(params.modifiers,params.key)){await send(tabId,'Input.dispatchKeyEvent',{type:'rawKeyDown',...modifier},sessionId);held.push(modifier);if(human)await wait(pause('modifierLeadMs'));}
      await send(tabId,'Input.dispatchKeyEvent',{type:'rawKeyDown',...params},sessionId);
      if(text!==undefined){await focused();await send(tabId,'Input.dispatchKeyEvent',{type:'char',...params,text,unmodifiedText:text},sessionId);}
      if(human)await wait(pause('keyHoldMs'));
      assertActive();
    } finally {
      let modifiers=params.modifiers&~modifierFlag(params.key);
      await send(tabId,'Input.dispatchKeyEvent',{type:'keyUp',...params,modifiers},sessionId);
      for(const modifier of held.reverse()){modifiers&=~modifierFlag(modifier.key);await send(tabId,'Input.dispatchKeyEvent',{type:'keyUp',...modifier,modifiers},sessionId);}
    }
    return {pressed:true};
  }
  if (args.action === 'fill') {assertActive();dialogs.arm(tabId);return evaluateInternal(tabId, elementExpression(args, `
    if (state.disabled || state.readOnly || !state.visible) FengPage.fail('NOT_EDITABLE');
    if (element instanceof HTMLInputElement && ['file','checkbox','radio','button','submit','reset','hidden'].includes(element.type)) FengPage.fail('NOT_TEXT_INPUT');
    __fengInputStarted=true; element.focus(); FengPage.assertFocused(element);
    const freshState=FengPage.elementState(element);if(freshState.disabled||freshState.readOnly||!freshState.visible)FengPage.fail('NOT_EDITABLE','聚焦后状态已变化，未继续填写。');
    const value = ${JSON.stringify(args.text || '')};
    if (element.isContentEditable) element.textContent = value;
    else {
      const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (!setter) FengPage.fail('NOT_EDITABLE');
      setter.call(element, value);
      if(element.value!==value)FengPage.fail('VALUE_REJECTED','浏览器未接受这个值，请核对字段格式和当前页面。');
    }
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    // 页面的 input/change 处理器可能截断、重排或掩码化；派发后回读最终值，对不上不报成功，也不重试。
    if((element.isContentEditable?element.textContent:element.value)!==value)FengPage.fail('EDIT_NOT_APPLIED','页面在 input/change 处理后改写了值，与请求不同；可能被页面截断或转换。先检查，不重试。');
    return { filled: true, mode:'setValue',verified:true,inputEventTrusted:false };`), args, deadline);}
  if (args.action === 'select') {assertActive();dialogs.arm(tabId);return evaluateInternal(tabId, elementExpression(args, `
    if (!(element instanceof HTMLSelectElement)) FengPage.fail('NOT_SELECT');
    if (state.disabled || state.readOnly || !state.visible) FengPage.fail('NOT_EDITABLE');
    const values = ${JSON.stringify(args.values || [])};
    for(const value of values){const option=[...element.options].find(o=>o.value===value);if(!option)FengPage.fail('OPTION_NOT_FOUND');if(option.disabled||option.parentElement instanceof HTMLOptGroupElement&&option.parentElement.disabled)FengPage.fail('OPTION_DISABLED');}
    __fengInputStarted=true;
    for (const option of element.options) option.selected = values.includes(option.value);
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { selected: Array.from(element.selectedOptions).map(option => option.value) };`), args, deadline);}
  if(args.action==='drag'){
    const target=args.to as JsonObject;
    const destination:JsonObject={...target,contextId:args.contextId,sessionId:args.sessionId,action:'drag',autoWait:args.autoWait,...carryGuard(args),...(args.aim?{aim:aimRatio()}:{})};
    const endLocated=!!(target.selector||target.ref||target.locator);
    const endPrepared=endLocated?await prepareTarget(tabId,destination,deadline,epoch):undefined;
    if(endPrepared){destination.ref=endPrepared.ref;destination.selector=undefined;destination.locator=undefined;}
    // 起终点必须同时可见。准备终点可能滚动页面；重新取点后从此不再滚动，避免鼠标按下期间移动页面。
    const source={...args,scrollIntoView:false},dest={...destination,scrollIntoView:false};
    const from=prepared?await elementPoint(tabId,source,deadline):{x:Number(args.x),y:Number(args.y)};
    const to=endPrepared?await elementPoint(tabId,dest,deadline):{x:Number(target.x),y:Number(target.y)};
    const documentId=await evaluateInternal(tabId,documentExpression(),args,deadline);
    const verifyDocuments=async()=>{if(await evaluateInternal(tabId,documentExpression(),args,deadline)!==documentId)throw new BrowserError('DOCUMENT_CHANGED','拖拽期间文档发生变化，已停止并释放鼠标；先检查页面。');};
    // 像真人一样操作时，没给段数、时长就按距离自己定；给了就按给的，只把直线换成曲线、匀速换成两头慢中间快。
    const grid=human?await devicePixels(tabId,sessionId):undefined;
    return dragPointer({from,to,steps:Number(args.steps??12),durationMs:Number(args.durationMs??300),button:String(args.button||'left'),modifiers:Number(args.modifiers||0),
      send:mouse,assertActive,mark:markDispatched,verifyDocuments,
      ...(grid?{human:{approach:point=>moveTo(point,withModifiers),settle:()=>pause('dragSettleMs'),wait,path:(start,end)=>mousePath(start,end,{grid:grid.ratio,...(args.steps!==undefined?{count:Number(args.steps)}:{}),...(args.durationMs!==undefined?{durationMs:Number(args.durationMs)}:{})})}}:{}),
      verifySource:async()=>{await verifyDocuments();if(prepared)assertPointUnchanged(from,await elementPoint(tabId,source,deadline),'拖拽起点已移动或被替换，未继续按下。');},
      verifyTarget:async()=>{await verifyDocuments();if(endPrepared)assertPointUnchanged(to,await elementPoint(tabId,{...dest,...(prepared?{dragSourceRef:prepared.ref}:{})},deadline),'拖拽终点已移动、被遮挡或被替换，已停止；先检查页面。');},
    });
  }
  if (args.action === 'click' || args.action === 'doubleClick' || args.action === 'setChecked' || args.action === 'hover') {
    let point: PointerPoint = args.x !== undefined && args.y !== undefined ? { x: Number(args.x), y: Number(args.y) }
      : prepared as Awaited<ReturnType<typeof elementPoint>>;
    const coordinates = {x:point.x,y:point.y};
    // frame 链校验到根视口；输入使用所属 renderer 的视口坐标（mouse 按 sessionId 发）。
    assertActive();
    // 悬停本身就是动作，移过去就算派发了；点击、勾选到按下那一刻才算，之前只移动过鼠标，失败都是未派发。
    if (args.action === 'hover') { markDispatched(); await moveTo(coordinates, withModifiers); return { hovered: true, ...withModifiers }; }
    await moveTo(coordinates, withModifiers);let arrived=Date.now();
    if (args.selector || args.ref || args.locator) {
      // 有的页面鼠标一移上去目标就挪位置（表头冒出筛选图标、按钮放大）。还是同一个元素、新位置停稳了，就把鼠标跟过去再按；
      // 一直不稳或者换了元素才放弃。到这里只移动过鼠标、没有按下，失败也是未派发，标签页照常可写。
      const until=Math.min(deadline,Date.now()+HOVER_SETTLE_MS);let last=point,follows=0;
      for(;;){
        // 挪过去以后被挡住、看不见了这类：同样还没按下。
        const fresh=await elementPoint(tabId,{...args,scrollIntoView:false},deadline).catch(error=>{const info=errorInfo(error);throw new BrowserError(info.code,info.message,{...NOT_DISPATCHED,...(info.detail?{detail:info.detail}:{})});});
        if(fresh.documentId!==point.documentId||fresh.ref!==point.ref)throw new BrowserError('ELEMENT_MOVED','鼠标移上去以后页面换了文档或目标被替换，没有按下；重新读取页面。',NOT_DISPATCHED);
        if(samePoint(point,fresh))break;
        if(samePoint(last,fresh)&&follows<HOVER_FOLLOWS){
          point=fresh;coordinates.x=fresh.x;coordinates.y=fresh.y;follows++;
          assertActive();await moveTo(coordinates,withModifiers);arrived=Date.now();continue;
        }
        if(Date.now()>=until||follows>=HOVER_FOLLOWS)throw new BrowserError('ELEMENT_MOVED','鼠标移上去以后目标一直在动，没有按下；重新读取页面。',NOT_DISPATCHED);
        last=fresh;await sleep(Math.min(50,Math.max(1,until-Date.now())));
      }
    }
    if(args.action==='setChecked'){
      const current=await readChecked();
      if(current.checked===args.checked&&!current.indeterminate)return {checked:args.checked,changed:false,verified:true};
      if(current.readOnly)throw new BrowserError('NOT_EDITABLE','悬停后勾选控件变为只读，未继续点击。',NOT_DISPATCHED);
    }
    const button = String(args.button || 'left');
    const buttons = button === 'right' ? 2 : button === 'middle' ? 4 : 1;
    // 按坐标点击：按下前读出落点上是什么，放进结果，点到空白处一眼看得出。只看顶层页面，读不到就不带。
    // 按 ref、locator 点击时落点上的元素在取点时就读好了（FengPage.actionPoint），跟着鼠标挪过去的就用最后那次。
    const hit = prepared ? (point as { hit?: JsonObject }).hit : args.contextId === undefined && !args.sessionId ? await evaluateInternal(tabId, `(()=>{return FengPage.pointTarget(${Number(coordinates.x)},${Number(coordinates.y)});})()`, args, deadline).catch(() => undefined) as JsonObject | null | undefined : undefined;
    const scrolled = (prepared as { scrolled?: JsonObject } | undefined)?.scrolled;
    assertActive();markDispatched();
    const count=args.action==='doubleClick'?2:1;
    for(let clickCount=1;clickCount<=count;clickCount++){
    if(clickCount>1&&prepared){const fresh=await elementPoint(tabId,{...args,scrollIntoView:false},deadline);assertPointUnchanged(point,fresh,'第一次点击后目标已变化，第二次点击未派发。');}
    // 像真人一样操作：停到目标上一会儿再按下，双击两次之间也隔一会儿；没给 holdMs 时按住几十到一百多毫秒。
    if(human)await wait(clickCount>1?pause('doubleGapMs'):Math.max(0,pause('hoverMs')-(Date.now()-arrived)));
    assertActive();let released=false;
    try {
      await mouse({ type: 'mousePressed', ...coordinates, button, buttons, clickCount, force: PRESSED_FORCE, ...withModifiers });
      const hold=args.holdMs!==undefined?Number(args.holdMs):human?pause('holdMs'):0;
      await wait(hold);
      // 默认拟人路径也按住几十毫秒，释放前同样要复核目标，不以是否显式传 holdMs 为条件。复核不滚动页面（鼠标正按着），
      // 容差 4 像素：按钮按下时下移一两像素很常见，不能因此取消点击；目标真被挪走（重排、遮挡）才拦。
      if(hold>0&&prepared){const fresh=await elementPoint(tabId,{...args,scrollIntoView:false},deadline);if(!nearPoint(point,fresh,4)||fresh.documentId!==prepared.documentId)throw new BrowserError('ELEMENT_MOVED','按住期间目标变化，已取消点击；先检查页面。');}
      await mouse({ type: 'mouseReleased', ...coordinates, button, buttons: 0, clickCount, ...withModifiers });
      released=true;
    } finally {if(!released){
      // mousedown 期间出现未预期弹窗时，只归还已按下的按钮，移出目标避免合成第二次点击。
      await mouse({type:'mouseMoved',x:-1,y:-1}).catch(()=>{});
      await mouse({type:'mouseReleased',x:-1,y:-1,button,buttons:0,clickCount:1}).catch(()=>{});
    }}}
    if(args.action==='setChecked'){
      while(Date.now()<deadline){assertActive();const current=await readChecked();if(current.checked===args.checked&&!current.indeterminate)return {checked:args.checked,changed:true,verified:true};await sleep(Math.min(50,Math.max(1,deadline-Date.now())));}
      throw new BrowserError('CHECK_STATE_NOT_APPLIED','点击已发出，但未确认达到 checked 目标状态；请检查页面，不会再次点击。');
    }
    const landed=(prepared as {landedOn?:JsonObject}|undefined)?.landedOn;
    return { clicked: true,...(count===2?{doubleClicked:true}:{}), ...coordinates, ...(hit?{hit}:{}), ...(scrolled?{scrolled}:{}), ...withModifiers, ...(landed?{landedOn:landed,note:'目标是容器，点击落在它中心的这个子元素上；要点别的子元素就定位那一个。'}:{}) };
  }
  throw new BrowserError('INVALID_ACTION', String(args.action));
}

// 选下拉项：点开触发器，等选项出现，点它，再读回触发器上显示的值。Semi、Antd 这类自定义下拉的选项常在页面末尾的弹层里，不在触发器里面。
// 只点开了下拉（选项没出现、有好几个同名的），或点完选项读回对不上，都是 dispatched：动作做完了，标签页照常可写，再选一次同一项没有副作用。
const OPTION_WAIT_MS = 10000, CHOICE_READBACK_MS = 1500;
async function choose(tabId: number, args: JsonObject, deadline: number, epoch: number, markDispatched: () => void, assertActive: () => void) {
  const option = String(args.option), frame: JsonObject = { contextId: args.contextId, sessionId: args.sessionId, ...carryGuard(args) };
  const page = (body: string) => evaluateInternal(tabId, `(()=>{${body}})()`, frame, deadline);
  const trigger: JsonObject = { ...args, action: 'click', option: undefined };
  const located = await prepareTarget(tabId, trigger, deadline, epoch) as { ref: string };
  const original = JSON.stringify({ selector: args.selector, ref: args.ref, locator: args.locator, mode: 'resolve' });
  // 触发器重新渲染后 ref 会失效，再按原来的定位找一次。
  const triggerElement = `(()=>{try{return FengPage.pageDom(${JSON.stringify({ ref: located.ref, mode: 'resolve' })});}catch(error){return FengPage.pageDom(${original});}})()`;
  const opened = !(await page(`return FengPage.choiceExpanded(${triggerElement});`));
  await page('return FengPage.markChoices();');
  if (opened) await actionInput(tabId, { ...trigger, ref: located.ref, selector: undefined, locator: undefined }, deadline, epoch, markDispatched);
  const after = (code: string, message: string, detail?: JsonObject) => new BrowserError(code, message, { phase: 'postcondition', outcome: opened ? 'dispatched' : 'not_dispatched', ...(detail ? { detail } : {}) });
  const until = Math.min(deadline - 300, Date.now() + OPTION_WAIT_MS);
  let found: { matches: JsonObject[]; total: number; options: string[] };
  for (;;) {
    assertActive();
    found = await page(`return FengPage.choiceCandidates(${triggerElement},${JSON.stringify(option)},${opened});`) as typeof found;
    if (found.total === 1) break;
    if (found.total > 1) throw after('AMBIGUOUS_OPTION', `下拉里有 ${found.total} 个「${option}」：${found.matches.map((item, index) => `${index}) ${item.selector}${item.name ? `「${item.name}」` : ''} ref ${item.ref}`).join('；')}。没有选任何项；用其中一个 ref 点它。`, { candidates: found.matches, total: found.total });
    if (Date.now() >= until) throw after('OPTION_NOT_FOUND', `${opened ? '下拉已经点开' : '下拉开着'}，${Math.round(OPTION_WAIT_MS / 1000)} 秒内没找到「${option}」。看得见的选项：${found.options.join('、') || '（没有）'}。没有选任何项；选项要滚动或搜索才出现时，先滚动或输入再 choose。`, { options: found.options });
    await sleep(100);
  }
  const target = found.matches[0]!;
  let clicked = false;
  try { await actionInput(tabId, { action: 'click', ref: target.ref, contextId: args.contextId, sessionId: args.sessionId, ...carryGuard(args) }, deadline, epoch, () => { clicked = true; markDispatched(); }); }
  catch (error) { if (clicked) throw error; const info = errorInfo(error); throw after(info.code, `${opened ? '下拉已经点开，' : ''}没点到「${option}」：${info.message}`, info.detail); }
  const readUntil = Math.min(deadline - 100, Date.now() + CHOICE_READBACK_MS);
  let shown: { text: string; shown: boolean } | undefined;
  for (;;) {
    shown = await page(`return FengPage.choiceShown(${triggerElement},${JSON.stringify(option)});`).catch(() => undefined) as typeof shown;
    if (shown?.shown || Date.now() >= readUntil) break;
    await sleep(100);
  }
  const chosen = String(target.name || option);
  if (!shown?.shown) throw new BrowserError('CHOICE_NOT_CONFIRMED', `已点选项「${chosen}」，但触发器上显示的是「${shown?.text ?? '（读不到）'}」。先看页面确认选中了什么，再决定要不要重选。`, { phase: 'postcondition', outcome: 'dispatched', detail: { chosen: target, triggerText: shown?.text ?? null } });
  return { chosen, triggerText: shown.text, verified: true, ...(opened ? {} : { alreadyOpen: true }) };
}

// 设备像素与 CSS 像素之比（含系统缩放和网页缩放）和视口大小：轨迹的中间点按它对齐，不知道鼠标在哪时在视口里找起点。读不到就按 1。
async function devicePixels(tabId: number, sessionId?: string) {
  const metrics = await send(tabId, 'Page.getLayoutMetrics', {}, sessionId).catch(() => ({})) as JsonObject;
  const device = Number((metrics.layoutViewport as JsonObject | undefined)?.clientWidth), view = (metrics.cssLayoutViewport || {}) as JsonObject, width = Number(view.clientWidth), height = Number(view.clientHeight);
  return { ratio: device > 0 && width > 0 ? device / width : 1, viewport: { width: width > 0 ? width : 800, height: height > 0 ? height : 600 } };
}

async function elementPoint(tabId: number, args: JsonObject, deadline: number) {
  return framePoint(tabId,args,deadline,{send,evaluate:(id,expression,frame,limit,byValue)=>evaluateInternal(id,expression,{...frame,...carryGuard(args)},limit,byValue),context:args=>isolated.get(tabId,args,deadline),contexts:()=>[...(contexts.get(tabId)?.values()||[])],sessions:()=>[...(childSessions.get(tabId)||[])]});
}
