import { BrowserError, NOT_DISPATCHED, type BrowserEvent, type JsonObject } from './shared.js';
import { compactEvent } from './observations.js';
import type { ResponseWaitArgs, DownloadWaitArgs } from './event-wait-tools.js';

export interface EventSnapshot {
  events: BrowserEvent[];
  latestSequence: number;
  droppedBefore: number;
}

export interface EventWaitSource {
  snapshot(profileId: string, tabId: number | undefined, since: number): EventSnapshot;
  subscribe(listener: (event: BrowserEvent) => void): () => void;
  // 绑定原连接，并复查当前授权；不可在重连后默默继续。
  assertActive(): void;
  // 页面读取在开始和交付结果前再核对目标，防止等待期间进入受保护页。
  assertAllowed?(): Promise<void>;
}

export interface DownloadWaitSource extends EventWaitSource {
  queryDownload(downloadId: number): Promise<unknown>;
}

const fail = (code: string, message: string) => new BrowserError(code, message, NOT_DISPATCHED);
const object = (value: unknown): JsonObject | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
const boundedString = (value: unknown, limit: number) => typeof value === 'string' ? value.slice(0, limit) : undefined;
const eventKey = (event: BrowserEvent) => JSON.stringify([event.params.sessionId ?? '', event.params.requestId]);

// 等待器只保留最小请求元数据，不保留请求头、正文或整个事件。
interface Request {
  method?: string;
  matched: boolean;
  response?: JsonObject;
}

function lifecycleEvent(event: BrowserEvent, profileId: string, tabId?: number) {
  if (event.profileId !== profileId) return;
  if (event.method === 'bridge.disconnected' || event.method === 'bridge.connected') throw fail('CONNECTION_CHANGED', '等待期间浏览器连接已变化；未在新连接继续等待。');
  if (event.tabId === tabId && tabId !== undefined && ['tabs.removed', 'debugger.detached', 'bridge.userPaused', 'network.captureStopped'].includes(event.method)) {
    throw fail(event.method === 'tabs.removed' ? 'TAB_NOT_FOUND' : 'NETWORK_CAPTURE_STOPPED', '目标标签已关闭或网络调试连接已停止；不会重新接管。');
  }
}

function watch<T>(source: EventWaitSource, profileId: string, tabId: number | undefined, deadline: number, timeoutCode: string,
  update: (event?: BrowserEvent) => T | undefined | Promise<T | undefined>): Promise<T> {
  return new Promise((resolve, reject) => {
    let finished = false, running = false, dirty = false, unsubscribe = () => {};
    let timeout: NodeJS.Timeout | undefined, authorization: NodeJS.Timeout | undefined;
    const cleanup = () => { unsubscribe(); if (timeout) clearTimeout(timeout); if (authorization) clearInterval(authorization); };
    const settle = (error?: unknown, value?: T) => {
      if (finished) return;
      finished = true; cleanup();
      if (error !== undefined) reject(error); else resolve(value!);
    };
    const check = () => {
      source.assertActive();
      if (Date.now() >= deadline) throw fail(timeoutCode, '等待超时；没有重新发送请求或下载。可先查看网络事件或下载状态。');
    };
    const pump = async (event?: BrowserEvent) => {
      try {
        check();
        if (event) lifecycleEvent(event, profileId, tabId);
        if (running) { dirty = true; return; }
        running = true;
        do {
          dirty = false;
          await source.assertAllowed?.();
          if (finished) return;
          check();
          const result = await update(event);
          if (finished) return;
          check();
          if (result !== undefined) { await source.assertAllowed?.(); check(); settle(undefined, result); return; }
          event = undefined;
        } while (dirty && !finished);
      } catch (error) { settle(error); }
      finally { running = false; }
    };
    try {
      check();
      // 先订阅再读快照：初始化查询期间完成的请求/下载不会落在缝隙里。
      unsubscribe = source.subscribe(event => {
        if (event.profileId === profileId && (tabId === undefined || event.tabId === tabId || event.tabId === undefined)) void pump(event);
      });
      if (finished) { unsubscribe(); return; }
      timeout = setTimeout(() => settle(fail(timeoutCode, '等待超时；没有重新发送请求或下载。可先查看网络事件或下载状态。')), Math.max(1, deadline - Date.now()));
      // 撤销授权未必生成浏览器事件；只做本地身份检查，不轮询网页或下载 API。
      authorization = setInterval(() => { try { check(); } catch (error) { settle(error); } }, 100);
      void pump();
    } catch (error) { settle(error); }
  });
}

export async function waitForResponse(source: EventWaitSource, profileId: string, tabId: number, args: ResponseWaitArgs, deadline: number) {
  let cursor = args.since;
  const requests = new Map<string, Request>();
  const matchesUrl = (url: unknown) => typeof url === 'string' && (args.url !== undefined ? url === args.url : args.urlContains !== undefined ? url.includes(args.urlContains) : true);
  const matchesMethod = (method: unknown) => args.method === undefined || typeof method === 'string' && method.toUpperCase() === args.method.toUpperCase();
  return watch(source, profileId, tabId, deadline, 'RESPONSE_WAIT_TIMEOUT', () => {
    const snapshot = source.snapshot(profileId, tabId, cursor);
    if (cursor > snapshot.latestSequence) throw fail('EVENT_CURSOR_INVALID', '网络游标超出当前事件序列；服务可能已重启，请重新捕获流量并保存动作前游标。');
    if (snapshot.droppedBefore > 0 && cursor < snapshot.droppedBefore - 1) throw fail('EVENT_HISTORY_LOST', '等待所需事件已超出缓存；无法可靠判断该请求，请检查实际页面与网络记录，不要重放业务动作。');
    for (const event of snapshot.events) {
      cursor = event.sequence;
      lifecycleEvent(event, profileId, tabId);
      if (!event.method.startsWith('Network.')) continue;
      const params = event.params;
      if (params.adminPage === true) continue;
      if (args.sessionId !== undefined && params.sessionId !== args.sessionId) continue;
      if (args.requestId !== undefined && params.requestId !== args.requestId) continue;
      if (params.omitted === true && ['Network.requestWillBeSent', 'Network.responseReceived'].includes(event.method)) throw fail('EVENT_CONTENT_UNAVAILABLE', '所需网络事件超出缓存预算，字段已省略；请用更精确的请求条件或检查原始网络结果。');
      if (typeof params.requestId !== 'string') continue;
      const key = eventKey(event);
      if (event.method === 'Network.requestWillBeSent') {
        const request = object(params.request);
        if (!request) continue;
        const matched = matchesUrl(request.url) && matchesMethod(request.method);
        // redirect 同一个 requestId 进入下一跳，前一跳的响应状态不作为最终响应。
        if (!matched) { requests.delete(key); continue; }
        requests.set(key, { method: boundedString(request.method, 30), matched });
      } else if (event.method === 'Network.responseReceived') {
        const response = object(params.response);
        if (!response || !matchesUrl(response.url)) continue;
        const request = requests.get(key);
        // 响应虽在游标之后到达，但请求可能在动作之前已经发出，不能误当作这次动作的结果。
        if (!request) continue;
        if (!matchesMethod(request?.method)) continue;
        const status = response.status;
        if (typeof status !== 'number') continue;
        if (args.status !== undefined && status !== args.status) throw fail('RESPONSE_STATUS_MISMATCH', `匹配请求返回 HTTP ${status}，期望 ${args.status}；不会重发请求。`);
        const safeResponse = object(compactEvent(event).params.response) ?? {};
        const result: JsonObject = {
          matched: true, requestId: params.requestId,
          ...(typeof params.sessionId === 'string' ? { sessionId: params.sessionId } : {}),
          ...safeResponse, ...(request?.method ? { method: request.method } : {}),
          finished: false, sequence: event.sequence,
        };
        if (args.waitFor === 'response') return result;
        requests.set(key, { ...request, matched: true, response: result });
      } else if (event.method === 'Network.loadingFailed') {
        if (requests.get(key)?.matched) throw fail('NETWORK_REQUEST_FAILED', `匹配请求失败：${boundedString(params.errorText, 200) ?? '网络加载失败'}；不会重发请求。`);
      } else if (event.method === 'Network.loadingFinished') {
        const response = requests.get(key)?.response;
        requests.delete(key);
        if (response) return { ...response, finished: true, sequence: event.sequence, ...(typeof params.encodedDataLength === 'number' ? { encodedDataLength: params.encodedDataLength } : {}) };
      }
      if (requests.size > 1024) throw fail('WAIT_CAPACITY', '匹配请求超过 1024 个，请缩小 URL 条件或按 requestId 等待；不会丢弃匹配后继续猜测。');
    }
    cursor = snapshot.latestSequence;
    return undefined;
  });
}

// 查一次下载的实际状态：完成返回结果，还在下载返回 undefined，中断或文件没了明确失败。
async function finishedDownload(source: DownloadWaitSource, downloadId: number) {
  const value = await source.queryDownload(downloadId);
  const item = Array.isArray(value) ? value.map(object).find(record => record?.id === downloadId) : undefined;
  if (!item) throw fail('DOWNLOAD_NOT_FOUND', '指定账号中没有这个 downloadId，记录可能已被移除；不会改查其他下载。');
  if (item.state === 'interrupted') throw fail('DOWNLOAD_INTERRUPTED', `下载已中断：${boundedString(item.error, 150) ?? '浏览器未提供原因'}；不会自动恢复或重复下载。`);
  if (item.exists === false) throw fail('DOWNLOAD_FILE_MISSING', '下载文件已被删除或移动，不能视为可用的完成结果。');
  if (item.state !== 'complete') return undefined;
  const result: JsonObject = { matched: true, downloadId, state: 'complete' };
  for (const key of ['bytesReceived', 'totalBytes', 'fileSize']) if (typeof item[key] === 'number') result[key] = item[key];
  if (typeof item.filename === 'string') result.filename = item.filename.slice(0, 32768);
  if (typeof item.endTime === 'string') result.endTime = item.endTime.slice(0, 80);
  if (typeof item.exists === 'boolean') result.exists = item.exists;
  return result;
}

export async function waitForDownload(source: DownloadWaitSource, profileId: string, args: DownloadWaitArgs, deadline: number) {
  return watch(source, profileId, undefined, deadline, 'DOWNLOAD_WAIT_TIMEOUT', async event => {
    // 其他下载和页面事件无需查询；并发到达的相关变化由 watch 的 dirty 循环补查。
    if (event && !(event.method === 'downloads.changed' && event.params.id === args.downloadId)) return undefined;
    return finishedDownload(source, args.downloadId);
  });
}

export interface TabDownloadWaitSource extends DownloadWaitSource {
  // 网站当前的自动下载设置（allow/ask/block），超时时用来判断是不是被 Chrome 拦了；查不到返回 undefined。
  automaticDownloads?(): Promise<string | undefined>;
}
// 点击和开始等待之间下载可能已经开始，不给游标时往回认 15 秒。
const RECENT_DOWNLOAD_MS = 15000;

/** 等这个标签页的下一次下载：扩展把页面触发的下载配上标签页后发 downloads.created，找到后按 downloadId 等完成。 */
export async function waitForTabDownload(source: TabDownloadWaitSource, profileId: string, tabId: number, args: { since?: number }, deadline: number) {
  const floor = args.since ?? (() => {
    const earlier = source.snapshot(profileId, undefined, 0).events.filter(event => Date.parse(event.time) < Date.now() - RECENT_DOWNLOAD_MS).at(-1);
    return earlier?.sequence ?? 0;
  })();
  let downloadId: number | undefined, sequence = 0;
  try {
    return await watch(source, profileId, undefined, deadline, 'DOWNLOAD_WAIT_TIMEOUT', async event => {
      if (downloadId === undefined) {
        const snapshot = source.snapshot(profileId, tabId, floor);
        // 和 waitForResponse 一样先确认游标有效、历史没丢：首笔下载事件被缓存淘汰时，剩下的第二笔不能当成“下一次下载”。
        if (floor > snapshot.latestSequence) throw fail('EVENT_CURSOR_INVALID', '事件游标超出当前事件序列；服务可能已重启，请重新取游标。没有重新触发下载。');
        if (snapshot.droppedBefore > 0 && floor < snapshot.droppedBefore - 1) throw fail('EVENT_HISTORY_LOST', '等待所需的下载事件已超出缓存；无法可靠判断哪一笔是下一次下载，请用 chrome_downloads 核对实际下载，不要重新触发。');
        const created = snapshot.events.find(item => item.method === 'downloads.created' && typeof item.params.id === 'number');
        // 还没认定哪一笔下载时，目标标签页被关掉就没有下一次下载了；已认定的下载继续等它完成。不整体绑定 tabId，免得 debugger.detached 之类误中止下载等待。
        if (!created) {
          if (snapshot.events.some(item => item.method === 'tabs.removed')) throw fail('TAB_NOT_FOUND', '等待期间目标标签页已关闭，不会有这个标签页的新下载；不会重新接管。');
          return undefined;
        }
        downloadId = Number(created.params.id); sequence = created.sequence;
      } else if (event && !(event.method === 'downloads.changed' && event.params.id === downloadId)) return undefined;
      const result = await finishedDownload(source, downloadId);
      return result && { ...result, tabId, sequence };
    });
  } catch (error) {
    if (!(error instanceof BrowserError) || error.code !== 'DOWNLOAD_WAIT_TIMEOUT') throw error;
    if (downloadId !== undefined) throw fail('DOWNLOAD_WAIT_TIMEOUT', `下载 ${downloadId} 已开始，等待期间没有完成；用 chrome_wait_download 的 downloadId 继续等，不要重新触发。`);
    // 自动下载设置只拦同一页面第二个起的下载：这个标签页之前没下载过（且事件没丢），原因就不在它。
    const history = source.snapshot(profileId, tabId, 0), console = consoleProblems(source.snapshot(profileId, tabId, floor).events);
    // droppedBefore 是缓存里最早一条的序号（从 1 起），大于 1 说明更早的事件已经丢了，没法确定没下载过。
    const seen = history.events.some(event => event.method === 'downloads.created'), downloadedBefore = seen || history.droppedBefore > 1;
    const setting = downloadedBefore ? await source.automaticDownloads?.().catch(() => undefined) : undefined;
    const reasons = [
      ...(setting && setting !== 'allow' ? [`这个标签页之前${seen ? '' : '可能'}下载过，网站的自动下载设置是 ${setting}：第二个起的下载会被 Chrome 拦下、等用户在地址栏点允许，工具看不到被拦的下载。可以用 chrome_site_permission 设成 allow 后再触发。`] : []),
      ...(console.length ? [`这段时间页面报了错：${console.map(text => JSON.stringify(text)).join('；')}。`] : []),
      '页面要是等接口返回才打开下载链接，Chrome 会当弹窗拦下（chrome_site_permission 的 popups 可设 allow）；也可能接口根本没给文件，用 chrome_wait_response 看导出接口的返回。',
    ];
    throw new BrowserError('DOWNLOAD_WAIT_TIMEOUT', `等待期间这个标签页没有开始新的下载。${reasons.join('')}没有重新触发下载。`, { ...NOT_DISPATCHED, detail: { downloadedBefore, ...(setting ? { automaticDownloads: setting } : {}), ...(console.length ? { console } : {}) } });
  }
}

// 页面这段时间的报错和警告（最近 3 条），等待超时时一起给出，常常就是原因（导出失败、弹窗被拦）。
function consoleProblems(events: BrowserEvent[]) {
  const texts: string[] = [];
  for (const event of events) {
    const params = event.params as JsonObject;
    if (event.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(String(params.type))) {
      const args = Array.isArray(params.args) ? params.args.map(object) : [];
      texts.push(args.map(arg => String(arg?.value ?? arg?.description ?? '')).filter(Boolean).join(' '));
    } else if (event.method === 'Runtime.exceptionThrown') {
      const details = object(params.exceptionDetails);
      texts.push(String(object(details?.exception)?.description ?? details?.text ?? ''));
    }
  }
  return texts.filter(Boolean).slice(-3).map(text => text.slice(0, 200));
}
