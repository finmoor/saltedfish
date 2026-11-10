import { mkdir, stat, open, readFile, rm, realpath } from 'node:fs/promises';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Config } from './config.js';
import { Broker, type CommandController, type Connection } from './broker.js';
import { BrowserError, errorInfo, validationMessage, unknownResult, pageItems, hideAdminTabs, isProtectedUrl, isLocalFileUrl, LOCAL_FILE_URL_MESSAGE, hiddenTabTitle, CAPABILITY, NOT_DISPATCHED, type JsonObject } from './shared.js';
import { ZodError } from 'zod';
import { toolMap, functionBodyError } from './tools.js';
import { StateStore } from './state-store.js';
import { adminPrincipal, allowsProfile, type Principal } from './auth.js';
import { TaskManager } from './tasks.js';
import { compactAccessibility, compactEvents, filterRequests, hideRawAccessibility, hideRawEvent } from './observations.js';
import { ResultReader } from './result-reader.js';
import { needsViewportOperation } from './interaction-policy.js';
import { checkUploadFile, cdpUploadPaths, filePolicy, remotePathRefused } from './upload-policy.js';
import { waitForResponse, waitForDownload, waitForTabDownload } from './event-waits.js';
import type { ResponseWaitArgs, DownloadWaitArgs } from './event-wait-tools.js';
import { FileTransferManager, type DownloadForExport } from './file-transfer.js';
import { AgentPresence } from './agent-presence.js';
import { AgentGroups } from './agent-groups.js';
import { isDesktopSettingsUrl } from './desktop-links.js';
import {serviceNetwork} from './service-network.js';
import {stageBrowserUploads} from './browser-upload.js';
import { IMAGE_OUTPUT, TEXT_OUTPUT, resolveOutputFile, writeOutputFile, type OutputTarget } from './output-files.js';
import { jobFinishedExpression, jobStatusExpression } from './page-jobs.js';
import { staleCodeHint } from '../ui/extension-version.js';

const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;
interface UploadRecord { step?: number; name: string; size: number; path: string }
const sha256File = async (file: string) => { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer); return hash.digest('hex'); };
// 字符串结果写进 .txt/.csv/.md/.html 时按原文写，其余写成缩进的 JSON。
const outputText = (value: unknown, file: string) => typeof value === 'string' && path.extname(file).toLowerCase() !== '.json' ? value : JSON.stringify(value ?? null, null, 2);
// chrome_downloads 原样返回会带完整的 url、finalUrl、referrer，一次性下载链接动辄上万字；网址截到 300 字并标出来，文件位置、状态这些照旧完整。
const DOWNLOAD_URL_CHARS = 300;
const shortDownload = (item: unknown) => {
  if (!item || typeof item !== 'object') return item;
  const result: JsonObject = { ...item as JsonObject };
  for (const key of ['url', 'finalUrl', 'referrer']) if (typeof result[key] === 'string' && (result[key] as string).length > DOWNLOAD_URL_CHARS) { result[key] = (result[key] as string).slice(0, DOWNLOAD_URL_CHARS); result[`${key}Truncated`] = true; }
  return result;
};
export interface ResultEnvelope { ok: boolean; data?: unknown; operationId?: string; artifact?:{artifactId:string;type:'png'|'json'}; warnings?: ReturnType<typeof errorInfo>[]; error?: ReturnType<typeof errorInfo>; batch?:{completed:false;completedSteps:number;failedIndex:number;error:ReturnType<typeof errorInfo>}; image?: { data: string; mimeType: string } }

// 截图结果里怎么把图片坐标换成 chrome_action 的 x/y。视口截图除以 scale 就是；整页、元素和 clip 截图用扩展给的 toViewport（area 减截图时的滚动距离，扩展 0.3.26 起），
// 旧扩展只给 area、scroll。fixed：图片超出视口时，固定在屏幕上的元素是按截图时的滚动位置画进去的（整页图里顶栏出现在中间），说清在图里哪个高度。
function screenshotNote(coordinates: JsonObject) {
  const scale = typeof coordinates.scale === 'number' ? coordinates.scale : 1, divide = scale !== 1 ? ` ÷ ${scale}` : '';
  const lead = scale !== 1 ? `图片缩小到 ${scale} 倍` : '图片 1 像素 = 1 CSS 像素';
  let note = coordinates.viewport ? `${lead}：图片坐标${divide} 就是 chrome_action 的 x/y。`
    : coordinates.toViewport ? `${lead}；chrome_action 的 x = 图片 x${divide} + toViewport.x，y 同理。页面滚动以后这个偏移就不对了，要重新截图。`
      : `${lead}；视口坐标 = 图片坐标${divide} + area.x/y - scroll.x/y。`;
  const fixed = Array.isArray(coordinates.fixed) ? coordinates.fixed as { selector?: string; box?: number[] }[] : [];
  if (fixed.length) {
    const scrolled = Number((coordinates.scroll as JsonObject | undefined)?.y || 0) > 0;
    note += `固定在屏幕上的 ${fixed.map(item => `${item.selector} 画在图片 y≈${item.box?.[1]}`).join('、')}：它们是按截图时的位置画进图里的，不在页面原来的位置${scrolled ? '。要它们在最上面，先用 chrome_action 的 scroll 滚到顶再截' : ''}。`;
  }
  return note;
}

export class BrowserService {
  readonly broker: Broker;
  readonly state: StateStore;
  readonly tasks: TaskManager;
  readonly transfers: FileTransferManager;
  readonly presence: AgentPresence;
  readonly groups: AgentGroups;
  private inFlight = new Set<Promise<ResultEnvelope>>();
  private principalInFlight = new Map<string, number>();
  private pendingByPrincipal = new Map<string, number>();
  private pathPattern?: RegExp;
  private pendingResultBytes = 0;
  private untrackedResultBytes = 0;
  readonly resultReader = new ResultReader();
  constructor(readonly config: Config) {
    this.transfers = new FileTransferManager(config);
    this.broker = new Broker(config.eventLimit, config.eventByteLimit, config.maxTabLeases); this.state = new StateStore(config.dataDir,serviceNetwork(config).legacyBridge?1:3);
    this.presence = new AgentPresence(id=>id==='admin'?adminPrincipal:this.state.principal(id),Date.now,{list:()=>this.state.agentUsage(),record:(agentId,profileId,at)=>this.state.recordAgentUsage(agentId,profileId,at)});
    this.groups = new AgentGroups(this.broker,this.presence);
    try {
      const folder = path.join(config.dataDir, 'results');
      for (const file of readdirSync(folder, { withFileTypes: true })) {
        const match = /^([0-9a-f-]{36})\.(json|png)$/.exec(file.name);
        if (file.isFile() && match && !this.state.artifact(match[1]!)) this.untrackedResultBytes += statSync(path.join(folder, file.name)).size;
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.state.close(); throw error; } }
    this.tasks = new TaskManager(this.state, (name, args, owner, principal, expected) => this.invoke(name, args, owner, principal, expected), profileId => { const connection = this.broker.profiles.get(profileId); return connection?.socket.readyState === 1 ? connection : undefined; },
      async (profileId, connection) => { const tabs = await this.broker.command(profileId, 'tabs.list', {}, 30000, connection) as { tabId: number }[]; return tabs.map(tab => tab.tabId); },config.token);
  }

  stats() { return { ...this.broker.stats(), ...this.tasks.stats(), ...this.resultReader.stats(), ...this.transfers.stats(), ...this.presence.stats(), inFlight: this.inFlight.size, pendingResultBytes: this.pendingResultBytes, resultBytes: this.state.resultBytes() + this.untrackedResultBytes, untrackedResultBytes: this.untrackedResultBytes }; }

  agents(profileId?:string) { return this.presence.snapshot(this.state.listClients(),this.broker.leaseSnapshot(),profileId); }

  listProfiles(principal: Principal = adminPrincipal) {
    const online = this.broker.listProfiles().map(profile => { const extensionReload = staleCodeHint(profile); return extensionReload ? { ...profile, extensionReload } : profile; }), ids = new Set(online.map(profile => profile.id));
    return [...online, ...this.state.knownProfiles().filter(profile => !ids.has(profile.id)).map(profile => { const offline = this.broker.offlineReason(profile.id); return offline ? { ...profile, offline } : profile; })].filter(profile => allowsProfile(principal, profile.id));
  }

  // 授权复查只会发生在某次派发之前，所以三个拒绝都明确带 not_dispatched：即使它们发生在操作记录已经开始、焦点模拟等待之后，
  // 也记为 failed，不制造假的 unknown，也不隔离标签页（撤销之后不会再首次派发的保护不变，见 perform() 里派发前的复查）。
  private isOnline(profileId: string) { return this.broker.profiles.get(profileId)?.socket.readyState === 1; }

  // 管理页的待核查汇总：在 state.protection() 之上补每个配置的在线状态、名称和最后在线时间，让管理员分得清“暂时离线”和“很久没出现”。
  protection() {
    const base = this.state.protection(), known = new Map(this.state.knownProfiles().map(profile => [profile.id, profile]));
    return { ...base, profiles: base.profiles.map(item => {
      const live = this.broker.profiles.get(item.profileId), online = this.isOnline(item.profileId), remembered = known.get(item.profileId);
      return { ...item, online, label: live?.info.label ?? remembered?.label, lastSeen: online ? live?.info.connectedAt : remembered?.lastSeen };
    }) };
  }

  // 永远不会再连接的配置（重建了配置 ID、卸载重装扩展、删除了 Chrome 配置）上的 unknown 无法按常规流程解除：确认需要回到原配置核查页面，而它已经不存在。
  // 出路是管理员明确声明放弃：先预览要放弃的记录，再带着看到的数量确认。常规的离线保护（chrome_recover_operation 要求配置在线）保持不变。
  abandonPreview(profileId: string) {
    const online = this.isOnline(profileId), known = this.state.knownProfiles().find(profile => profile.id === profileId), pending = this.state.pendingOperations(profileId);
    if (!online && !known && !pending.unknown && !pending.running) throw new BrowserError('PROFILE_NOT_FOUND', '没有这个配置，也没有它的待核查记录。', NOT_DISPATCHED);
    return { profileId, label: this.broker.profiles.get(profileId)?.info.label ?? known?.label ?? null, online, lastSeen: online ? this.broker.profiles.get(profileId)?.info.connectedAt ?? null : known?.lastSeen ?? null,
      unknown: pending.unknown, running: pending.running, canAbandon: !online && pending.running === 0,
      operations: pending.items.map(({ id, tabId, tool, state, startedAt, errorCode }) => ({ id, tabId, tool, state, startedAt, errorCode })),
      note: online ? '该配置当前在线，不能放弃；请在原页面核查后用“解除保护”确认。' : '放弃只在数据库里确认这些记录并把这个配置从列表移除：不连接浏览器，不重放任何操作。若配置只是暂时离线，请回到原 Chrome 配置核查页面，不要放弃。' };
  }
  abandonProfile(profileId: string, expectedUnknown: number) {
    if (this.isOnline(profileId)) throw new BrowserError('PROFILE_ONLINE', '该配置当前在线，不能放弃。请在原页面核查后用“解除保护”确认。', NOT_DISPATCHED);
    const { acknowledged, forgotten } = this.state.abandonProfile(profileId, expectedUnknown);
    this.broker.releaseProfile(profileId);
    return { abandoned: true, profileId, acknowledged, forgotten, replayed: false };
  }

  private assertRemotePrincipal(principal: Principal, deadline = Infinity) {
    if (principal.id.startsWith('remote:') && this.state.remotePrincipals.get(principal.id) !== principal) throw new BrowserError('REMOTE_CONNECTION_CHANGED', '远程连接或授权已变化，后续操作未派发。先检查操作记录，不要自动重试。', NOT_DISPATCHED);
    if (!principal.admin && !principal.id.startsWith('remote:')) {
      const current = this.state.principal(principal.id);
      const scopeStillAllowed = current && (current.profiles === '*' || principal.profiles !== '*' && principal.profiles.every(id => allowsProfile(current, id)));
      if (!current || current.readOnly && !principal.readOnly || !scopeStillAllowed) {
        throw new BrowserError('CLIENT_AUTHORIZATION_FAILED', '客户端授权已撤销或变化，此次操作未派发。', NOT_DISPATCHED);
      }
    }
    if (Date.now() > deadline) throw new BrowserError('REMOTE_REQUEST_EXPIRED', '远程请求在等待期间已过期，后续操作未派发。', NOT_DISPATCHED);
  }

  // 全局上限保持；在此之上，非管理员主体各自最多占 1/8，并为管理员保留 1/8 的名额，
  // 这样单个失控或被诱导的客户端（只读也一样）占不满服务，管理员的恢复操作始终能启动。
  private busy(principal: Principal) {
    const cap = this.config.maxPendingRequests ?? 128, size = this.inFlight.size, gate = { phase: 'precondition' as const, outcome: 'not_dispatched' as const };
    if (size >= cap) return { code: 'SERVER_BUSY', message: '并发任务已达配置上限，此次操作未开始。', ...gate };
    if (principal.admin) return undefined;
    const share = Math.max(1, Math.floor(cap / 8));
    if (size >= cap - (cap >= 2 ? share : 0)) return { code: 'SERVER_BUSY', message: '并发任务已接近配置上限，剩余名额保留给管理员的恢复操作；此次操作未开始，请稍后重试。', ...gate };
    if ((this.principalInFlight.get(principal.id) ?? 0) >= share) return { code: 'PRINCIPAL_BUSY', message: `此客户端同时进行的操作已达上限（${share}），此次操作未开始。请等待已有操作结束；其他客户端和管理员不受影响。`, ...gate };
    return undefined;
  }

  // 非管理员主体看不到本机数据目录的绝对路径（错误与警告里的文件系统报错也一样）。
  private hidePaths(text: string) {
    this.pathPattern ??= new RegExp([this.config.dataDir, this.config.dataDir.replaceAll('\\', '/')].map(item => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), process.platform === 'win32' ? 'gi' : 'g');
    return text.replace(this.pathPattern, '<数据目录>');
  }
  private scrub(envelope: ResultEnvelope): ResultEnvelope {
    const clean = <T extends ReturnType<typeof errorInfo> | undefined>(info: T): T => (info ? { ...info, message: this.hidePaths(info.message) } as T : info);
    return { ...envelope, ...(envelope.error ? { error: clean(envelope.error) } : {}), ...(envelope.warnings ? { warnings: envelope.warnings.map(clean) } : {}),
      ...(envelope.batch ? { batch: { ...envelope.batch, error: clean(envelope.batch.error) } } : {}) };
  }

  invoke(name: string, input: unknown, owner: string, principal: Principal = adminPrincipal, expectedConnection?: Connection, deadline = Infinity): Promise<ResultEnvelope> {
    const busy = ['chrome_task_control', 'chrome_pause_profile', 'chrome_release_tab', 'chrome_dialog'].includes(name) ? undefined : this.busy(principal);
    if (busy) return Promise.resolve({ ok: false, error: busy });
    const tracked = this.invokeTracked(name, input, owner, principal, expectedConnection, deadline);
    const promise = principal.admin ? tracked : tracked.then(envelope => this.scrub(envelope));
    this.inFlight.add(promise); this.principalInFlight.set(principal.id, (this.principalInFlight.get(principal.id) ?? 0) + 1);
    void promise.finally(() => {
      this.inFlight.delete(promise);
      const left = (this.principalInFlight.get(principal.id) ?? 1) - 1;
      if (left > 0) this.principalInFlight.set(principal.id, left); else this.principalInFlight.delete(principal.id);
    });
    return promise;
  }

  private async invokeTracked(name: string, input: unknown, owner: string, principal: Principal, expectedConnection?: Connection, deadline = Infinity): Promise<ResultEnvelope> {
    const execution: { operationId?: string; warnings: ReturnType<typeof errorInfo>[]; uploadReleases?: (()=>void|Promise<void>)[]; uploadedByPath?: { name: string; size: number }[]; uploads?: UploadRecord[]; output?: OutputTarget; returnImage?: boolean } = { warnings: [] };
    const releaseUploads=async()=>{for(const release of execution.uploadReleases?.splice(0)||[])try{await release();}catch{execution.warnings.push({code:'UPLOAD_CLEANUP_FAILED',message:'网页操作不会重试；浏览器暂存将随连接关闭或到期释放。'});}};
    let finishActivity: (()=>void)|undefined;
    try {
      this.assertRemotePrincipal(principal, deadline);
      const tool = toolMap.get(name);
      if (!tool) throw new BrowserError('UNKNOWN_TOOL', name);
      const args = tool.schema.parse(input) as JsonObject;
      if (principal.readOnly && !tool.readOnly) throw new BrowserError('CLIENT_READ_ONLY', '此客户端只获准读取；需要由本机用户调整授权。');
      if (typeof args.profileId === 'string' && !allowsProfile(principal, args.profileId)) throw new BrowserError('PROFILE_NOT_AUTHORIZED', '此客户端没有该账号配置的授权。');
      if (typeof args.toProfileId === 'string' && !allowsProfile(principal, args.toProfileId)) throw new BrowserError('PROFILE_NOT_AUTHORIZED', '此客户端没有目标账号的授权，未复制流程。');
      if (name === 'chrome_recover_operation') {
        const record = this.state.get(String(args.operationId));
        if (record && !allowsProfile(principal, record.profileId)) throw new BrowserError('PROFILE_NOT_AUTHORIZED', '不能访问其他账号的操作记录。');
      }
      if (name === 'chrome_read_result' && !principal.admin) {
        const artifact = this.state.artifact(String(args.artifactId));
        if (!artifact || typeof artifact.profileId !== 'string' || !allowsProfile(principal, artifact.profileId)) throw new BrowserError('RESULT_NOT_AUTHORIZED', '此结果不属于客户端获准访问的账号。');
      }
      finishActivity=this.presence.observe(principal,owner,name,typeof args.profileId==='string'?args.profileId:undefined,typeof args.tabId==='number'?args.tabId:undefined);
      const data = await this.perform(name, args, owner, execution, principal, expectedConnection, deadline);
      await releaseUploads();
      const batchFailed = name === 'chrome_batch' && !!data && typeof data === 'object' && (data as JsonObject).completed === false;
      const metadata = { ...(execution.operationId ? { operationId: execution.operationId } : {}), ...(execution.warnings.length ? { warnings: execution.warnings } : {}),...(batchFailed?{batch:{completed:false as const,completedSteps:(data as any).results?.length||0,failedIndex:(data as any).failedIndex,error:{...(data as any).error,message:String((data as any).error?.message||'步骤失败').slice(0,2000)}}}:{}) };
      if (name === 'chrome_read_result' && (data as { image?: unknown }).image) {
        const { image, ...saved } = data as { image: { data: string; mimeType: string } };
        return { ok: true, ...metadata, data: saved, image };
      }
      if (name === 'chrome_screenshot') {
        // coordinates 说明图片坐标怎么换成点击坐标（扩展 0.3.17 起图片按 CSS 像素出），放进文字结果，不放进图片内容。
        const { coordinates, ...image } = data as { data: string; mimeType: string; coordinates?: JsonObject }, inline = execution.returnImage === false ? {} : { image }, bytes = Buffer.from(image.data, 'base64');
        const located = coordinates ? { coordinates: { ...coordinates, note: screenshotNote(coordinates) } } : {};
        // 指定了文件就只写文件；写不进去再退回保存原图，截图不白拍。
        if (execution.output) {
          try { return { ok: true, ...metadata, data: { saved: await writeOutputFile(this.config, principal, execution.output, bytes, IMAGE_OUTPUT), ...located }, ...inline }; }
          catch (error) { execution.warnings.push({ code: 'OUTPUT_SAVE_FAILED', message: `截图成功，但没写进指定文件：${errorInfo(error).message}` }); }
        }
        const warnings = execution.warnings.length ? { warnings: execution.warnings } : {};
        try {
          const artifact = await this.save(bytes, 'png', args.profileId as string, owner, principal);
          return { ok: true, ...metadata, ...warnings, data: { ...artifact, ...located }, artifact:{artifactId:artifact.artifactId,type:'png'}, ...inline };
        } catch (error) {
          // returnImage:false 时照样不回图：调用方明确不要图，存不下就只说没存下。
          return { ok: true, ...metadata, ...(execution.returnImage === false ? { data: { saved: false, ...located } } : {}), ...inline, warnings: [...execution.warnings, { code: 'RESULT_STORAGE_FAILED', message: `截图成功但原图未落盘：${errorInfo(error).message}` }] };
        }
      }
      const json = JSON.stringify(data ?? null);
      const outputLimit=['chrome_accessibility','chrome_events'].includes(name)?Math.min(this.config.outputLimit,Number(args.maxCharacters)):this.config.outputLimit;
      const previewLimit=Math.min(outputLimit,2048);
      if (json.length > outputLimit && !['chrome_read_result','chrome_file_read'].includes(name)) {
        let artifact;
        try { artifact = await this.save(json, 'json', args.profileId as string | undefined, owner, principal); }
        catch (error) {
          return { ok: !batchFailed, ...metadata, ...(batchFailed ? { error: { code: 'BATCH_FAILED', message: '任务中途停止，业务动作不可重放。',phase:(data as any).error?.phase,outcome:(data as any).error?.outcome } } : {}), data: { saved: false, truncated: true, preview: json.slice(0, previewLimit), totalCharacters: json.length }, warnings: [...execution.warnings, { code: 'RESULT_STORAGE_FAILED', message: `操作已结束，但完整结果未保存。不要重复业务动作：${errorInfo(error).message}` }] };
        }
        return { ok: !batchFailed, ...metadata, artifact:{artifactId:artifact.artifactId,type:'json'}, ...(batchFailed ? { error: { code: 'BATCH_FAILED', message: '批量任务中途停止，请读取完整结果检查已完成步骤。',phase:(data as any).error?.phase,outcome:(data as any).error?.outcome } } : {}), data: { ...artifact, saved: true, totalCharacters: json.length, preview: json.slice(0, previewLimit), note: '完整结果已保存，使用 chrome_read_result 分页读取。' } };
      }
      if (batchFailed) return { ok: false, ...metadata, data, error: { code: 'BATCH_FAILED', message: '批量任务中途停止。先检查已完成步骤，禁止整批自动重放。',phase:(data as any).error?.phase,outcome:(data as any).error?.outcome } };
      return { ok: true, ...metadata, data };
    } catch (error) {
      const info=error instanceof ZodError?{code:'INVALID_ARGUMENT',message:validationMessage(error.issues),phase:'precondition' as const,outcome:'not_dispatched' as const}:errorInfo(error);
      // 没开始操作记录就失败的都在派发前，包括被“上一条结果未确认”（RESULT_UNKNOWN）挡下的：那条旧操作的保护在数据库里，这次调用本身没有派发。
      if(!info.outcome){info.outcome=execution.operationId?'unknown':'not_dispatched';info.phase=execution.operationId?'execution':'precondition';}
      return { ok: false, ...(execution.operationId ? { operationId: execution.operationId } : {}), error: info, ...(execution.warnings.length ? { warnings: execution.warnings } : {}) };
    } finally {
      finishActivity?.();
      await releaseUploads();
    }
  }

  private async perform(name: string, args: JsonObject, owner: string, execution: { operationId?: string; warnings: ReturnType<typeof errorInfo>[]; uploadReleases?: (()=>void|Promise<void>)[]; uploadedByPath?: { name: string; size: number }[]; uploads?: UploadRecord[]; output?: OutputTarget; returnImage?: boolean }, principal: Principal, expectedConnection?: Connection, deadline = Infinity): Promise<unknown> {
    const { broker } = this;
    const profileId = String(args.profileId || ''); const tabId = Number(args.tabId);
    // 非管理员主体不得读取或操作本机管理页：命令里附带管理页 origin，由扩展按标签页当前 URL 逐步核对（见 extension/executor.ts）。
    const restricted = !principal.admin, origins = [...serviceNetwork(this.config).origins];
    const guarded = (wire: JsonObject): JsonObject => restricted && wire.tabId !== undefined ? { ...wire, adminGuard: origins } : wire;
    // 扩展页和这个扩展保护的其他服务只有扩展自己知道，标签列表要由它一起隐藏。
    const listed = (wire: JsonObject): JsonObject => restricted ? { ...wire, hideProtected: true } : wire;
    // 租约、标签页互斥和弹窗归属按“调用方身份”比较。远程调用的 owner 前缀已经是跨重连稳定的 submissionScope（见 remote-connector.ts），弹窗归属同样改用它；
    // principal.id 每次重连都会变，只用于授权、并发配额和旧任务控制，这样自动重连不会把同一个 Agent 锁在自己的租约外面。
    const caller = principal.submissionScope ?? principal.id;
    // 本机管理员可以越过远程 Agent 的租约：远程调用方可能已经不在了，而租约要到期（最长一天）才会自行释放。本机调用方之间仍然互斥。
    // 任务收尾（owner 形如 …:task:<id>，以管理员身份释放）只释放它自己的租约，不能借此删掉别人在它的租约过期后占用的标签页。
    const takeOverRemote = principal.admin && !/:task:[0-9a-f-]{36}$/i.test(owner) ? (holder: string) => /^remote(-submission)?:/.test(holder) : undefined;
    const assertConnection = () => { this.assertRemotePrincipal(principal, deadline); if (expectedConnection && broker.profiles.get(profileId) !== expectedConnection) throw new BrowserError('CONNECTION_CHANGED', '任务的原连接已变化，未向新连接派发后续命令。', NOT_DISPATCHED); };
    assertConnection();
    if (name.startsWith('chrome_file_')) {
      const context = { principal, profileId, assertActive: assertConnection };
      let result:unknown;
      if(name==='chrome_file_begin')result=await this.transfers.begin(context,args as any);
      else if(name==='chrome_file_write')result=await this.transfers.write(context,String(args.transferId),Number(args.offset),String(args.base64));
      else if(name==='chrome_file_commit')result=await this.transfers.commit(context,String(args.transferId));
      else if(name==='chrome_file_status')result=await this.transfers.status(context,String(args.transferId));
      else if(name==='chrome_file_read')result=await this.transfers.read(context,String(args.transferId),Number(args.offset),Number(args.length));
      else if(name==='chrome_file_export') {
        const existing=await this.transfers.lookupExport(context,args as any);
        if(existing){assertConnection();return existing;}
        const connection=broker.capture(profileId);
        const downloads=await broker.command(profileId,'downloads.list',{downloadId:args.downloadId,limit:1},30000,connection) as DownloadForExport[];
        assertConnection();if(broker.profiles.get(profileId)!==connection)throw new BrowserError('CONNECTION_CHANGED','查询下载期间连接已变化，未导出文件。',NOT_DISPATCHED);
        const download=downloads.find(item=>item.id===args.downloadId);
        if(!download)throw new BrowserError('DOWNLOAD_NOT_FOUND','这个账号没有指定下载；未读取文件。',NOT_DISPATCHED);
        if(connection.info.connectionType==='direct'){
          if(!connection.info.capabilities?.includes(CAPABILITY.browserFileReadV1))throw new BrowserError('EXTENSION_UPDATE_REQUIRED','直连下载导出需要新版扩展及可选本机助手。',NOT_DISPATCHED);
          const active=()=>{assertConnection();if(broker.profiles.get(profileId)!==connection)throw new BrowserError('CONNECTION_CHANGED','下载导出期间连接已变化。',NOT_DISPATCHED);};
          result=await this.transfers.exportBrowserDownload({...context,assertActive:active},args as any,download,(offset,length,snapshot)=>broker.command(profileId,'downloads.file.read',{downloadId:args.downloadId,offset,length,...(snapshot?{snapshot}:{})},30000,connection));
        }else result=await this.transfers.exportDownload(context,args as any,download);
      }
      assertConnection();return result;
    }
    if (name==='chrome_wait_response'||name==='chrome_wait_download') {
      const connection=broker.capture(profileId),waitDeadline=Math.min(deadline,Date.now()+Number(args.timeoutMs));
      const active=()=>{assertConnection();if(broker.profiles.get(profileId)!==connection||connection.socket.readyState!==1)throw new BrowserError('CONNECTION_CHANGED','等待期间原浏览器连接已断开或变化。',NOT_DISPATCHED);};
      const source={snapshot:(p:string,t:number|undefined,s:number)=>broker.events(p,t,s),subscribe:(listener:(event:import('./shared.js').BrowserEvent)=>void)=>broker.subscribeEvents(listener),assertActive:active};
      const queryDownload=(downloadId:number)=>broker.command(profileId,'downloads.list',{downloadId,limit:1},Math.max(1,Math.min(30000,waitDeadline-Date.now())),connection);
      if(name==='chrome_wait_download'&&args.tabId!==undefined){
        if(!connection.info.capabilities?.includes(CAPABILITY.downloadsV2))throw new BrowserError('EXTENSION_UPDATE_REQUIRED','按标签页等下载需要新版扩展；可以先用 chrome_downloads 找到 downloadId 再等。',NOT_DISPATCHED);
        // 超时时才查网站设置：管理页这类受保护标签页的地址被隐藏，查不到就不提示。
        const automaticDownloads=async()=>{const tabs=await broker.command(profileId,'tabs.list',listed({}),5000,connection) as JsonObject[];const url=tabs.find(tab=>tab.tabId===tabId)?.url;if(typeof url!=='string'||!/^https?:/.test(url))return undefined;return String((await broker.command(profileId,'site.permission',{url},5000,connection) as JsonObject).setting);};
        return waitForTabDownload({...source,queryDownload,automaticDownloads},profileId,tabId,{since:args.since as number|undefined},waitDeadline);
      }
      if(name==='chrome_wait_download')return waitForDownload({...source,queryDownload},profileId,args as unknown as DownloadWaitArgs,waitDeadline);
      const allowed=async()=>{
        if(restricted&&!connection.info.capabilities?.includes(CAPABILITY.adminOriginV1))throw new BrowserError('EXTENSION_UPDATE_REQUIRED','请更新扩展以检查受保护页面。',NOT_DISPATCHED);
        // 走扩展的实时目标保护，避免只靠先前缓存的URL判断。
        await broker.command(profileId,'contexts.list',guarded({tabId}),Math.max(1,Math.min(5000,waitDeadline-Date.now())),connection);
        active();
      };
      return waitForResponse({...source,assertAllowed:allowed},profileId,tabId,args as unknown as ResponseWaitArgs,waitDeadline);
    }
    if (name === 'chrome_profiles') {
      return { profiles: this.listProfiles(principal), note: '名称是用户别名，并非网站账号验证。online=false 时不执行或切换账号，等待原配置重新连接；offline 说明离线原因和恢复办法；extensionReload 说明扩展后台还在跑旧代码，新功能用不了，转告用户按它说的重新加载。' };
    }
    if (name === 'chrome_operations') return this.state.list(profileId, args.state as string | undefined, Number(args.offset), Number(args.limit), args.acknowledged as boolean | undefined);
    if (name === 'chrome_task_submit') { const { profileId: _, tabId: __,submissionId,...plan } = args; return this.state.asSubmitter(principal, () => this.tasks.submit(profileId, tabId, plan, principal,undefined,submissionId as string|undefined)); }
    if (name === 'chrome_tasks') return this.tasks.list(profileId, Number(args.offset), Number(args.limit), args.status as string | undefined, String(args.query || ''));
    if (name === 'chrome_task') return this.tasks.get(profileId, String(args.taskId));
    if (name === 'chrome_task_control') return this.tasks.control(profileId, String(args.taskId), String(args.action), principal);
    if (name === 'chrome_task_diagnostics') return this.tasks.diagnostics(profileId, String(args.taskId));
    if (name === 'chrome_task_recovery') return this.tasks.recoveryDraft(profileId, String(args.taskId), Number(args.fromStep));
    if (name === 'chrome_workflows') return this.tasks.workflows(profileId, Number(args.offset), Number(args.limit), args.archived === true, args.summary === true);
    if (name === 'chrome_workflow_save') return this.tasks.saveWorkflow(profileId, args.definition, args.workflowId as string | undefined, args.expectedRevision as string | undefined);
    if (name === 'chrome_workflow_get') return this.tasks.getWorkflow(profileId, String(args.workflowId), args.revision as string | undefined);
    if (name === 'chrome_workflow_history') return this.tasks.workflowHistory(profileId, String(args.workflowId));
    if (name === 'chrome_workflow_copy') return this.tasks.copyWorkflow(profileId, String(args.workflowId), String(args.toProfileId || profileId), String(args.name));
    if (name === 'chrome_workflow_archive') return this.tasks.archiveWorkflow(profileId, String(args.workflowId), String(args.expectedRevision), args.archived === true);
    if (name === 'chrome_workflow_restore') return this.tasks.restoreWorkflow(profileId, String(args.workflowId), String(args.revision), String(args.expectedRevision));
    if (name === 'chrome_workflow_remove') return this.state.removeWorkflow(String(args.workflowId), profileId, String(args.expectedRevision));
    if (name === 'chrome_workflow_preview') return this.tasks.preview(profileId, String(args.workflowId), args.parameters as Record<string, string>, args.revision as string | undefined);
    if (name === 'chrome_workflow_run') return this.state.asSubmitter(principal, () => this.tasks.runWorkflow(profileId, tabId, String(args.workflowId), String(args.revision), args.parameters as Record<string, string>, principal,args.submissionId as string|undefined));
    if (name === 'chrome_pause_profile') {
      if (!broker.capture(profileId).info.capabilities?.includes(CAPABILITY.pauseControl)) throw new BrowserError('EXTENSION_UPDATE_REQUIRED', '此配置的扩展需要更新并刷新才能远程暂停；当前可在扩展内手动暂停。');
      try { this.tasks.pauseProfile(profileId, 'USER_PAUSED'); } catch (error) { execution.warnings.push(errorInfo(error)); }
      const paused = await broker.command(profileId, 'profile.pause', {});
      broker.notePaused(profileId, 'agent'); // 旧扩展暂停前不报原因，这里补上。
      return paused;
    }
    if (name === 'chrome_recover_operation') {
      const record = this.state.get(String(args.operationId));
      if (!record) throw new BrowserError('OPERATION_NOT_FOUND', '操作记录不存在。');
      // 配置只是暂时离线时必须回到原 Chrome 配置核查页面，这条保护是有意的；配置已经永久消失的出路是 abandonProfile（管理员二次确认，只改数据库）。
      const offline = (error: unknown): never => { throw errorInfo(error).code === 'PROFILE_OFFLINE' ? new BrowserError('PROFILE_OFFLINE', `配置 ${record.profileId} 未连接，无法在原页面核查这条记录。如果只是暂时离线，请打开该 Chrome 配置继续连接后再确认；如果这个配置已经不存在（重建了配置 ID、卸载重装扩展或删除了 Chrome 配置），本机管理员可以在二次确认后放弃它的待核查记录（管理接口 POST /profiles/abandon，先 GET 同一路径预览）。`, NOT_DISPATCHED) : error; };
      if (record.tabId !== null) { await broker.command(record.profileId, 'tab.recover', { tabId: record.tabId }).catch(offline); broker.recover(record.profileId, record.tabId, owner, takeOverRemote); }
      else { try { broker.capture(record.profileId); } catch (error) { offline(error); } }
      this.state.acknowledge(record.id);
      return { acknowledged: true, operationId: record.id, replayed: false };
    }
    if (name === 'chrome_claim_tab') {
      const tabs = await broker.command(profileId, 'tabs.list', {}, 30000, expectedConnection) as JsonObject[];
      assertConnection();
      if (!tabs.some(tab => tab.tabId === tabId)) throw new BrowserError('TAB_NOT_FOUND', '该标签页不属于指定配置，或已关闭。');
      await this.groups.assertClaimable(principal, owner, profileId, tabId);
      const claimed = broker.claim(profileId, tabId, owner, Number(args.seconds),principal.remoteAgentId?`remote:${principal.remoteAgentId}`:principal.id);
      const joined = await this.groups.join(principal, owner, profileId, tabId, true);
      return joined?.grouped ? { ...claimed, group: joined.group } : claimed;
    }
    if (name === 'chrome_release_tab') {
      const released = broker.release(profileId, tabId, owner, takeOverRemote);
      await this.groups.leave(principal, owner, profileId, tabId);
      return released;
    }
    if (name === 'chrome_recover_tab') { await broker.command(profileId, 'tab.recover', { tabId }); const result = broker.recover(profileId, tabId, owner, takeOverRemote); this.state.acknowledgeTab(profileId, tabId); return result; }
    if (name === 'chrome_events') {
      const history = broker.events(profileId, args.tabId as number | undefined, Number(args.since), args.method as string | undefined);
      const filter = { urlContains: args.urlContains as string | undefined, resourceType: args.resourceType as string | undefined };
      const picked = filter.urlContains || filter.resourceType ? filterRequests(history.events, broker.events(profileId, args.tabId as number | undefined, 0).events, filter) : history.events;
      const events = restricted ? picked.map(event => event.method.startsWith('tabs.') && isProtectedUrl(event.params.url, origins) ? { ...event, params: { ...event.params, url: '', title: hiddenTabTitle, adminPage: true } } : event) : picked;
      if(args.mode==='summary')return compactEvents(events,Number(args.offset),Number(args.limit),Number(args.maxCharacters),Number(args.since),history.latestSequence,history.droppedBefore);
      const page=pageItems(events.map(hideRawEvent), Number(args.offset), Number(args.limit));
      return { ...page,mode:'raw', latestSequence: page.items.at(-1)?.sequence??Number(args.since),headSequence:history.latestSequence,droppedBefore: history.droppedBefore };
    }
    if (name === 'chrome_read_result') {
      if (this.state.artifact(String(args.artifactId))?.extension === 'png') {
        const bytes = await readFile(path.join(this.config.dataDir, 'results', `${args.artifactId}.png`));
        if (bytes.length > MAX_INLINE_IMAGE_BYTES) throw new BrowserError('RESULT_TOO_LARGE', '截图超过 10 MiB，不能直接返回；请在管理页查看。', NOT_DISPATCHED);
        return { artifactId: args.artifactId, bytes: bytes.length, image: { mimeType: 'image/png', data: bytes.toString('base64') } };
      }
      const file = path.join(this.config.dataDir, 'results', `${args.artifactId}.json`);
      return this.resultReader.read(file, Number(args.offset), Number(args.limit));
    }
    if (name === 'chrome_save_result') {
      const artifact = this.state.artifact(String(args.artifactId));
      if (!artifact) throw new BrowserError('RESULT_NOT_FOUND', '没有这个结果，可能已被管理员删除。', NOT_DISPATCHED);
      if (!principal.admin && (typeof artifact.profileId !== 'string' || !allowsProfile(principal, artifact.profileId))) throw new BrowserError('RESULT_NOT_AUTHORIZED', '此结果不属于客户端获准访问的账号。', NOT_DISPATCHED);
      const extension = artifact.extension === 'png' ? 'png' : 'json', content = await readFile(path.join(this.config.dataDir, 'results', `${args.artifactId}.${extension}`));
      return { artifactId: args.artifactId, saved: await writeOutputFile(this.config, principal, { path: String(args.path), overwrite: args.overwrite === true }, content, extension === 'png' ? IMAGE_OUTPUT : TEXT_OUTPUT) };
    }
    if (name === 'chrome_job_status') {
      const connection = broker.capture(profileId), id = String(args.jobId), target = args.savePath ? { path: String(args.savePath), overwrite: args.overwrite === true } : undefined;
      if (!connection.info.capabilities?.includes(CAPABILITY.readOnlyEvalV1) || restricted && !connection.info.capabilities?.includes(CAPABILITY.adminOriginV1)) throw new BrowserError('EXTENSION_UPDATE_REQUIRED', '此配置的扩展尚不支持只读读取作业状态，请在 Chrome 扩展管理页刷新已更新的扩展。', NOT_DISPATCHED);
      if (target) await resolveOutputFile(this.config, principal, target, TEXT_OUTPUT);
      const waitMs = Number(args.waitMs || 0);
      if (waitMs > 0) {
        try { await broker.command(profileId, 'page.wait', guarded({ tabId, expression: jobFinishedExpression(id), readOnly: true, timeoutMs: waitMs }), waitMs, connection); }
        catch (error) { if (errorInfo(error).code !== 'WAIT_TIMEOUT') throw error; }
        assertConnection();
      }
      const status = await broker.command(profileId, 'page.evaluate', guarded({ tabId, expression: jobStatusExpression(id), readOnly: true, timeoutMs: 30000 }), 30000, connection) as JsonObject;
      assertConnection();
      if (!target || status?.state !== 'done') return status;
      const { value, ...rest } = status;
      return { ...rest, saved: await writeOutputFile(this.config, principal, target, outputText(value, target.path), TEXT_OUTPUT) };
    }
    // 缺 dialog-control 的旧扩展不能走通用派发：那样会跳过弹窗归属、去重和占用检查（全局评审 U54）。
    if (name === 'chrome_dialog' && !broker.capture(profileId).info.capabilities?.includes(CAPABILITY.dialogControl)) throw new BrowserError('EXTENSION_UPDATE_REQUIRED', `${staleCodeHint(broker.capture(profileId).info) || '此配置的扩展太旧，不支持 chrome_dialog，请在 Chrome 扩展管理页更新扩展。'}未响应弹窗。`, NOT_DISPATCHED);
    if (name === 'chrome_dialog') {
      if (restricted && !broker.capture(profileId).info.capabilities?.includes(CAPABILITY.adminOriginV1)) throw new BrowserError('EXTENSION_UPDATE_REQUIRED', '此配置的扩展尚不支持管理页保护，请在 Chrome 扩展管理页刷新已更新的扩展。未响应弹窗。');
      return broker.respondDialog(profileId, tabId, owner, caller, args.dialogId, async (dialogId, connection, trigger) => {
        assertConnection();
        execution.operationId = this.state.begin(profileId, tabId, owner, name);
        const finishDialog = (state: 'succeeded'|'failed'|'unknown', code?: string) => { try { this.state.finish(execution.operationId!, state, code); } catch { execution.warnings.push({code:'OPERATION_JOURNAL_FAILED',message:'弹窗结果未能写入日志；先核查当前状态，不重复发送响应。'}); } };
        try {
          const result = await broker.command(profileId, 'page.dialog', guarded({ ...args, dialogId }), 5000, connection, { owner, principalId: caller });
          finishDialog('succeeded');
          if (!trigger?.operationId) return result;
          // 框是这次操作弹出的、同一调用方答的：动作发出去了，下一步是看页面，不用再解除保护。隔离由 exclusive 按数据库自动撤销；这个标签页上别的未知操作照旧拦着。
          const answered = result as JsonObject | undefined;
          const settle = trigger.settle === 'byAnswer' ? (answered?.type === 'beforeunload' ? (answered.accept === true ? 'succeeded' : 'failed') : undefined) : trigger.settle;
          try { if (settle) this.state.settleDialog(trigger.operationId, settle); }
          catch { execution.warnings.push({code:'OPERATION_JOURNAL_FAILED',message:'弹窗已响应，但原操作的状态未能更新；标签页继续暂停写入，核对页面后用 chrome_recover_tab。'}); }
          return { ...result as JsonObject, writable: !this.state.hasOpenOperation(profileId, tabId) };
        } catch (error) { finishDialog(unknownResult(errorInfo(error)) ? 'unknown' : 'failed', errorInfo(error).code); throw error; }
      }); // 只绕过被该弹窗阻塞的互斥；不解除账号授权，也不解除别的操作的 unknown 和隔离。
    }
    if (restricted) {
      const protectedDestination=(url:unknown)=>isProtectedUrl(url,origins)||isDesktopSettingsUrl(url);
      const target = name === 'chrome_navigate' || name === 'chrome_new_tab' ? args.url : name === 'chrome_cdp' && String(args.method).toLowerCase() === 'page.navigate' ? (args.params as JsonObject | undefined)?.url
        : name === 'chrome_batch' ? (args.steps as { operation: string; args: JsonObject }[]).find(step => step.operation === 'page.navigate' && protectedDestination(step.args.url))?.args.url : undefined;
      if (protectedDestination(target)) throw new BrowserError('ADMIN_PAGE_PROTECTED', '这是 SaltedFish 本机管理入口，非管理员客户端不能打开或导航到它。请让用户自己打开，或使用管理员凭据。尚未向浏览器派发。', { phase: 'precondition', outcome: 'not_dispatched' });
      // 本机文件网址：导航、新标签页、下载、批次导航，以及原始 CDP 参数里任何字符串（Page.navigate、Target.createTarget、Network.loadNetworkResource 等）。
      const strings = (value: unknown, depth = 0): string[] => typeof value === 'string' ? [value] : depth < 8 && value && typeof value === 'object' ? Object.values(value).flatMap(item => strings(item, depth + 1)) : [];
      const fileTargets = name === 'chrome_cdp' ? strings(args.params) : ['chrome_navigate', 'chrome_new_tab', 'chrome_download'].includes(name) ? [args.url] : name === 'chrome_batch' ? (args.steps as { operation: string; args: JsonObject }[]).filter(step => step.operation === 'page.navigate').map(step => step.args.url) : [];
      if (fileTargets.some(isLocalFileUrl)) throw new BrowserError('FILE_URL_NOT_ALLOWED', LOCAL_FILE_URL_MESSAGE, NOT_DISPATCHED);
      // 原始 CDP 登记的新文档脚本：扩展把它套进一层函数，落到管理页、扩展页面时整段不执行（extension/init-script.ts）。
      // 以前只在前面拼一句判断，顶层的函数声明照样先被提升进管理页的全局，about:blank iframe 也认不出。要套函数，它单独就得是合法的函数体，否则能闭合外层、跑到判断外面。
      const newDocumentSource = name === 'chrome_cdp' && args.method === 'Page.addScriptToEvaluateOnNewDocument' ? (args.params as JsonObject | undefined)?.source : undefined;
      const sourceError = typeof newDocumentSource === 'string' ? functionBodyError(newDocumentSource) : undefined;
      if (sourceError) throw new BrowserError('INVALID_ARGUMENT', `params.source: 这个客户端经 chrome_cdp 登记的新文档脚本按函数体执行（外面套一层函数，本机管理页上不执行），这段脚本单独不是合法的函数体：${sourceError}。导航时装钩子可以用 chrome_navigate、chrome_new_tab 的 initScript，调用返回时自动撤销。`, NOT_DISPATCHED);
    }
    // 带 initScript 的新标签页：先开空白页（照常进组），再在它上面带脚本导航到 url。脚本要在页面脚本之前登记，直接开 url 就来不及了。
    // 两步各写各的操作记录；结果不明的只会是导航那一步，它带着 tabId，保护落在这个标签页上。
    if (name === 'chrome_new_tab' && typeof args.initScript === 'string') {
      if (!broker.capture(profileId).info.capabilities?.includes(CAPABILITY.initScriptV1)) throw new BrowserError('EXTENSION_UPDATE_REQUIRED', `${staleCodeHint(broker.capture(profileId).info) || '此配置的扩展太旧，不支持 initScript，请在 Chrome 扩展管理页更新扩展。'}没有开标签页。`, NOT_DISPATCHED);
      const { initScript, url, timeoutMs, ...rest } = args, created = { warnings: [] as ReturnType<typeof errorInfo>[] };
      const opened = await this.perform('chrome_new_tab', { ...rest, url: 'about:blank' }, owner, created, principal, expectedConnection, deadline) as JsonObject;
      execution.warnings.push(...created.warnings);
      const openedTab = Number(opened.tabId);
      try {
        const navigated = await this.perform('chrome_navigate', { profileId, tabId: openedTab, action: 'goto', url, wait: true, initScript, timeoutMs: timeoutMs ?? 30000 }, owner, execution, principal, expectedConnection, deadline) as JsonObject;
        return { ...navigated, ...(opened.group !== undefined ? { group: opened.group } : {}) };
      } catch (error) {
        const info = errorInfo(error);
        throw new BrowserError(info.code, `${info.message}（新标签页已经开好，tabId ${openedTab}，停在${unknownResult(info) ? '不确定的页面上，先看页面再决定' : '空白页，可以对它重新 chrome_navigate'}。）`, { ...(info.phase ? { phase: info.phase } : {}), ...(info.outcome ? { outcome: info.outcome } : {}), detail: { ...(info.detail || {}), tabId: openedTab } });
      }
    }
    const definition = toolMap.get(name)!;
    // 写文件的参数只在服务这边用，不发给扩展。会改页面的 evaluate 先查好能不能写，免得脚本跑完才发现存不下。
    if ((name === 'chrome_evaluate' || name === 'chrome_screenshot') && args.savePath !== undefined) {
      execution.output = { path: String(args.savePath), overwrite: args.overwrite === true };
      await resolveOutputFile(this.config, principal, execution.output, name === 'chrome_screenshot' ? IMAGE_OUTPUT : TEXT_OUTPUT);
    }
    if (name === 'chrome_screenshot') execution.returnImage = args.returnImage !== false;
    // find 的 selector 是 locator.inside 的简写：Agent 照着 chrome_action 的习惯写它，客户端又会悄悄丢掉 schema 里没有的参数。扩展的 selector 是“目标本身”，所以这里换掉再发。
    if (name === 'chrome_find' && args.selector !== undefined) { args.locator = { ...(args.locator as JsonObject), inside: args.selector }; delete args.selector; }
    delete args.savePath; delete args.overwrite; delete args.returnImage;
    const jobId = name === 'chrome_job_start' ? randomUUID() : undefined;
    if (jobId) args.jobId = jobId;
    const inspectionControl = name === 'chrome_focus_tab' || name === 'chrome_keep_tab';
    // 结构化等待和声明只读的表达式不改页面，暂停写入时也能用来核对结果。readOnly 由 Chrome 的 throwOnSideEffect 强制，不靠调用方自觉。
    const verifying = name === 'chrome_wait' && !args.expression || (name === 'chrome_evaluate' || name === 'chrome_wait') && args.readOnly === true || name === 'chrome_site_permission' && !args.setting;
    const writes = !definition.readOnly && !inspectionControl && !verifying;
    // 放在传文件、开焦点模拟和写日志之前：被拒绝的写操作不该碰用户的标签页，也不留操作记录。
    if (writes && args.tabId !== undefined) { const rejoined = await this.groups.assertWritable(principal, owner, profileId, tabId); if (rejoined) execution.warnings.push({ code: 'TAB_REJOINED', message: rejoined }); }
    // 上传了哪个文件记进操作记录（文件名、大小、SHA-256，不存内容）：中断后从记录就能确认，不用翻会话。
    const noteUploads=async(paths:string[],step?:number)=>{(execution.uploads??=[]).push(...await Promise.all(paths.map(async file=>({...(step!==undefined?{step}:{}),name:path.basename(file),size:(await stat(file)).size,path:file}))));};
    // 上传的连接在第一次异步预检之前就定下：预检期间 Chrome 重启、同一配置重连，同号 tabId 已经是另一个标签页，不能发过去（全局评审 U56）。
    const uploadConnection = name === 'chrome_upload' || name === 'chrome_batch' && (args.steps as { operation: string }[]).some(step => step.operation === 'page.upload') ? broker.capture(profileId) : undefined;
    const sameUploadConnection = () => { if (uploadConnection && broker.profiles.get(profileId) !== uploadConnection) throw new BrowserError('CONNECTION_CHANGED', '准备上传期间浏览器连接已变化，未设置网页文件。核对标签页后再上传。', NOT_DISPATCHED); };
    const prepareUpload=async(input:JsonObject,step?:number)=>{
      const leased=!!input.transferIds;
      if(input.transferIds){const lease=await this.transfers.leaseUploads({principal,profileId,assertActive:assertConnection},input.transferIds as string[]);(execution.uploadReleases??=[]).push(lease.release);input.paths=lease.paths;delete input.transferIds;}
      else await this.checkFiles(input.paths as string[],principal);
      assertConnection();sameUploadConnection();
      const connection=uploadConnection!;
      // 同一台电脑上的 Chrome 自己读文件：不经过服务，也就没有内容传送的大小上限。路径换成检查过的真实路径，新扩展设置后核对文件名和大小。
      if(this.uploadsByPath(connection)){
        const files=await this.localUploadFiles(input.paths as string[],leased?undefined:principal);assertConnection();sameUploadConnection();
        input.paths=files.map(file=>file.path);input.expectedFiles=files.map(({name,size})=>({name,size}));(execution.uploadedByPath??=[]).push(...files.map(({name,size})=>({name,size})));
        (execution.uploads??=[]).push(...files.map(file=>({...(step!==undefined?{step}:{}),...file})));
        return;
      }
      await noteUploads(input.paths as string[],step).catch(()=>{});
      if(connection.info.connectionType==='direct'){
        if(!connection.info.capabilities?.includes(CAPABILITY.fileContentV1))throw new BrowserError('EXTENSION_UPDATE_REQUIRED','此浏览器需要新版扩展才能接收服务端文件内容。',NOT_DISPATCHED);
        const until=Math.min(deadline,Date.now()+Number(args.timeoutMs||30000));
        const assertUpload=()=>{assertConnection();if(broker.profiles.get(profileId)!==connection)throw new BrowserError('CONNECTION_CHANGED','文件传送期间浏览器连接已变化，未设置网页文件。',NOT_DISPATCHED);if(Date.now()>until)throw new BrowserError('DEADLINE_EXCEEDED','文件准备超时，未设置网页文件。',NOT_DISPATCHED);};
        const send=(operation:string,value:JsonObject)=>broker.command(profileId,operation,value,Math.max(1,Math.min(10000,until-Date.now())),connection);
        const staged=await stageBrowserUploads(input.paths as string[],send,assertUpload);(execution.uploadReleases??=[]).push(()=>broker.profiles.get(profileId)===connection?broker.command(profileId,'file.stage.drop',{ids:staged.ids},3000,connection).then(()=>{}):Promise.resolve());input.fileIds=staged.ids;delete input.paths;
      }
    };
    if (name === 'chrome_upload') await prepareUpload(args);
    if (name === 'chrome_batch') for (const [index, step] of (args.steps as { operation: string; args: JsonObject }[]).entries()) if (step.operation === 'page.upload') await prepareUpload(step.args, index);
    // DOM.setFileInputFiles 等同样把本机文件交给页面，必须与 chrome_upload 使用同一套路径校验，不能成为绕过入口。
    if (name === 'chrome_cdp') { const files = cdpUploadPaths(String(args.method), args.params),connection=broker.capture(profileId);if(files?.length&&connection.info.connectionType==='direct'&&!this.uploadsByPath(connection))throw new BrowserError('FILE_LOCATION_REQUIRED','这个浏览器和服务不在同一台电脑，不能把服务主机路径当作浏览器路径。请使用 chrome_upload 的 transferIds 或服务端路径，由服务传送文件内容。',NOT_DISPATCHED);if (files?.length&&restricted) await this.checkFiles(files, principal); }
    if (name === 'chrome_new_tab' && args.windowId === undefined) { const windowId = await this.groups.windowOf(principal, owner, profileId); if (windowId !== undefined) args.windowId = windowId; }
    const connection = broker.capture(profileId);
    assertConnection();sameUploadConnection();
    const requiredCapabilities: string[] = [];
    const interactionV7=(operation:string,input:JsonObject)=>operation==='page.action'&&['doubleClick','drag','setChecked'].includes(String(input.action))||operation==='page.navigate'&&!!input.action&&input.action!=='goto';
    if(interactionV7(definition.operation||'',args)||name==='chrome_batch'&&(args.steps as any[]).some(step=>interactionV7(step.operation,step.args)))requiredCapabilities.push(CAPABILITY.interactionV7);
    const depthOperation=(operation:string)=>['page.action','page.inspect','page.find','page.wait','page.upload'].includes(operation);
    if(depthOperation(definition.operation||'')||definition.operation==='page.screenshot'||name==='chrome_batch')requiredCapabilities.push(CAPABILITY.executionV3,CAPABILITY.interactionV4,CAPABILITY.interactionV5);
    const elementState = (operation: string, input: JsonObject) => ['page.inspect','page.find'].includes(operation) || ['page.action','page.wait'].includes(operation) && !!(input.selector || input.ref || input.locator);
    const frameInput = (operation: string, input: JsonObject) => operation === 'page.action' && ['click','hover'].includes(String(input.action)) && (input.contextId !== undefined || !!input.sessionId);
    if (elementState(definition.operation || '', args) || name === 'chrome_batch' && (args.steps as any[]).some(step=>elementState(step.operation,step.args))) requiredCapabilities.push(CAPABILITY.elementStateV2);
    if (frameInput(definition.operation || '', args) || name === 'chrome_batch' && (args.steps as any[]).some(step=>frameInput(step.operation,step.args))) requiredCapabilities.push(CAPABILITY.frameCoordinatesV2);
    if (name === 'chrome_find' || args.locator || (name === 'chrome_batch' && (args.steps as any[]).some(step => step.args.locator))) requiredCapabilities.push(CAPABILITY.semanticLocators);
    // interaction-v6：click/hover/scroll 的 modifiers 随鼠标事件发送；scroll 支持元素定位；scroll 只给 deltaX 时 deltaY 为 0。
    // 旧扩展会静默按旧语义执行（丢掉修饰键、在视口原点滚动、仍默认纵向 600），所以只有请求真的用到这些语义时才要求它，普通动作不强制刷新扩展。
    const pointerV6 = (operation: string, input: JsonObject) => operation === 'page.action' && (input.action !== 'press' && Number(input.modifiers || 0) > 0 || input.action === 'scroll' && (!!(input.selector || input.ref || input.locator) || input.deltaX !== undefined && input.deltaY === undefined));
    if (pointerV6(definition.operation || '', args) || name === 'chrome_batch' && (args.steps as any[]).some(step => pointerV6(step.operation, step.args))) requiredCapabilities.push(CAPABILITY.interactionV6);
    if ((name === 'chrome_wait' && (args.urlContains || args.textContains || args.state === 'hidden')) || (name === 'chrome_batch' && (args.steps as any[]).some(step => step.operation === 'page.wait' && (step.args.urlContains || step.args.textContains || step.args.state === 'hidden')))) requiredCapabilities.push(CAPABILITY.structuredWait);
    if (name === 'chrome_wait_tab') requiredCapabilities.push(CAPABILITY.popupWait);
    // 旧扩展会忽略 readOnly 照常执行；批次里的 evaluate、wait 一样要求（全局评审 U57）。
    if ((name === 'chrome_evaluate' || name === 'chrome_wait') && args.readOnly === true || name === 'chrome_batch' && (args.steps as { operation: string; args: JsonObject }[]).some(step => ['page.evaluate', 'page.wait'].includes(step.operation) && step.args.readOnly === true)) requiredCapabilities.push(CAPABILITY.readOnlyEvalV1);
    if (name === 'chrome_job_start' || name === 'chrome_evaluate' && args.replMode === true || name === 'chrome_batch' && (args.steps as any[]).some(step => step.operation === 'page.evaluate' && step.args.replMode === true)) requiredCapabilities.push(CAPABILITY.evaluateV2);
    if (name === 'chrome_screenshot' && (args.selector || args.ref || args.locator || args.clip)) requiredCapabilities.push(CAPABILITY.screenshotV2);
    if (name === 'chrome_screenshot' && (args.clipViewport === true || args.scale !== undefined && args.scale !== 1)) requiredCapabilities.push(CAPABILITY.screenshotV3);
    if (name === 'chrome_site_permission') requiredCapabilities.push(args.permission === 'popups' ? CAPABILITY.sitePermissionV2 : CAPABILITY.downloadsV2);
    if (name === 'chrome_keep_tab') requiredCapabilities.push(CAPABILITY.tabKeepV1);
    if (name === 'chrome_navigate' && args.initScript !== undefined) requiredCapabilities.push(CAPABILITY.initScriptV1);
    // interaction-v8 的新字段：旧扩展会忽略它们照旧执行，结果看着成功其实不是调用方要的。
    const interactionV8 = (operation: string, input: JsonObject) => operation === 'page.action' && input.action === 'choose' || [input.locator, (input.to as JsonObject | undefined)?.locator].some(value => (value as JsonObject | undefined)?.nth !== undefined) || input.scopeRef !== undefined || input.match === 'any' || input.match === 'all';
    const stepV8 = (step: { operation: string; args: JsonObject; postcondition?: JsonObject }) => interactionV8(step.operation, step.args) || step.operation === 'page.wait' && step.args.timeoutMs !== undefined || !!step.postcondition && interactionV8('page.wait', step.postcondition);
    if (interactionV8(definition.operation || '', args) || name === 'chrome_batch' && (args.steps as { operation: string; args: JsonObject; postcondition?: JsonObject }[]).some(stepV8)) requiredCapabilities.push(CAPABILITY.interactionV8);
    // interaction-v9：条件的 textMatches、chrome_action 的 postcondition。旧扩展忽略它们：只给 textMatches 的等待立刻算成立，动作不核对就报成功。
    const conditionV9 = (input: unknown) => !!input && (input as JsonObject).textMatches !== undefined;
    const stepV9 = (step: { operation: string; args: JsonObject; postcondition?: JsonObject }) => step.operation === 'page.wait' && conditionV9(step.args) || conditionV9(step.postcondition);
    if (name === 'chrome_action' && args.postcondition !== undefined || name === 'chrome_wait' && conditionV9(args) || name === 'chrome_batch' && (args.steps as { operation: string; args: JsonObject; postcondition?: JsonObject }[]).some(stepV9)) requiredCapabilities.push(CAPABILITY.interactionV9);
    // interaction-v10：locator.inside、条件的 state:"attached"。旧扩展忽略 inside 会在整页里找、点到范围外的同名元素，attached 当成 visible 一直等。动作、等待、批次步骤和后置条件里的都算。
    const usesV10 = (value: unknown, depth = 0): boolean => { if (!value || typeof value !== 'object' || depth > 6) return false; const record = value as JsonObject; if ((record.locator as JsonObject | undefined)?.inside !== undefined || record.state === 'attached') return true; return Object.values(record).some(item => usesV10(item, depth + 1)); };
    if (definition.operation && usesV10(args)) requiredCapabilities.push(CAPABILITY.interactionV10);
    if (restricted && args.tabId !== undefined && definition.operation) requiredCapabilities.push(CAPABILITY.adminOriginV1);
    if (name === 'chrome_batch' && (args.steps as any[]).some(step => step.operation === 'page.dialog')) requiredCapabilities.push(CAPABILITY.dialogControl);
    if (requiredCapabilities.some(capability => !connection.info.capabilities?.includes(capability))) throw new BrowserError('EXTENSION_UPDATE_REQUIRED', `${staleCodeHint(connection.info) || '此配置的扩展尚不支持该功能，请在 Chrome 扩展管理页刷新已更新的扩展。'}未执行页面动作。`);
    const needsFocus = needsViewportOperation(definition.operation, args);
    const focus = (enabled: boolean) => broker.command(profileId, 'page.cdp', guarded({
      tabId, method: 'Emulation.setFocusEmulationEnabled', params: { enabled },
    }), 5000, connection);
    const finish = (state: 'succeeded' | 'failed' | 'unknown', code?: string) => {
      if (!execution.operationId) return;
      try { this.state.finish(execution.operationId, state, code); }
      catch {
        // 已发送的业务动作不能因日志故障被误报为未执行；running 记录继续阻止后续写入。
        execution.warnings.push({ code: 'OPERATION_JOURNAL_FAILED', message: '业务结果已返回，但完成状态无法写入操作日志。不要重复执行；先核查页面，修复存储并重启服务后显式确认恢复。' });
      }
    };
    // 准入检查：此前的操作仍在执行或结果待核查时拒绝写入。它必须发生在 exclusive 的互斥检查之后、占用标签页之前，并且在 run() 之外：
    // 这个拒绝不是“本次动作的结果”，如果抛在 run() 里，exclusive 会把它当成结果未知而隔离一个根本没碰过的标签页。与 begin() 在同一个同步段里，检查和登记之间不会插入别的操作。
    const admit = () => this.state.assertWritable(profileId, args.tabId as number | undefined);
    const run = async () => {
      let dialogPending = false, refused = false;
      const trigger: CommandController = { owner, principalId: caller };
      assertConnection();
      // 普通 Windows Chrome 的后台页面可能接收移动却丢弃按下/释放事件。
      // 使用浏览器提供的焦点模拟，避免抢占用户当前应用；动作结束归还状态。
      if (writes) {
        // 日志写不进去时业务命令一定还没发出，明确标记未派发，免得把一个没碰过的标签页隔离。
        try { trigger.operationId = execution.operationId = this.state.begin(profileId, args.tabId as number | undefined, owner, name); }
        catch (error) { throw new BrowserError('OPERATION_JOURNAL_FAILED', `操作日志无法写入，业务命令尚未发出，页面没有任何改动：${errorInfo(error).message}`, NOT_DISPATCHED); }
        if (execution.uploads?.length) this.recordUploads(execution.operationId, execution.uploads);
      }
      try {
        if (needsFocus) { try { await focus(true); } catch (error) { refused = errorInfo(error).code === 'ADMIN_PAGE_PROTECTED'; throw error; } }
        assertConnection();
        const data = await broker.command(profileId, definition.operation!, definition.operation === 'tabs.list' ? listed(args) : guarded(args), Number(args.timeoutMs || 30000), connection, trigger);
        if (execution.operationId) {
          const failed = name === 'chrome_batch' && !!data && typeof data === 'object' && (data as JsonObject).completed === false;
          const code = failed ? String(((data as JsonObject).error as JsonObject | undefined)?.code || 'BATCH_FAILED') : undefined;
          dialogPending = code === 'DIALOG_OPEN' || code === 'DIALOG_MISMATCH';
          // 批次没走完记 failed：中断的那一步发出了，后面的步骤没有运行。脚本弹出的框不算，答完脚本还在接着跑，结果仍然不明。
          if (dialogPending && unknownResult((data as any).error) && (args.steps as { operation: string }[])[Number((data as any).failedIndex)]?.operation === 'page.action') trigger.settle = 'failed';
          finish(failed ? (unknownResult((data as any).error) ? 'unknown' : 'failed') : 'succeeded', code);
        }
        return name === 'chrome_downloads' && Array.isArray(data) ? data.map(shortDownload) : data;
      } catch (error) {
        dialogPending = ['DIALOG_OPEN','DIALOG_MISMATCH'].includes(errorInfo(error).code);
        if (dialogPending && name === 'chrome_action' && unknownResult(errorInfo(error))) trigger.settle = 'succeeded';
        if (dialogPending && (name === 'chrome_navigate' || name === 'chrome_close_tab') && unknownResult(errorInfo(error))) trigger.settle = 'byAnswer';
        finish(unknownResult(errorInfo(error)) ? 'unknown' : 'failed', errorInfo(error).code);
        // 0.3.25 及更早的扩展只认文件框本身，按上传按钮、区域定位会报 NOT_FILE_INPUT（消息就是错误码）。
        if (errorInfo(error).code === 'NOT_FILE_INPUT' && !connection.info.capabilities?.includes(CAPABILITY.interactionV10)) throw new BrowserError('NOT_FILE_INPUT', `目标不是文件框。${staleCodeHint(connection.info) || '扩展更新到 0.3.26 以后，可以按看得见的上传按钮或区域定位，用它里面或最近的文件框；'}现在只能直接定位 input[type=file]。`, NOT_DISPATCHED);
        throw error;
      } finally {
        if (needsFocus && !dialogPending && !refused) await focus(false).catch(error => execution.warnings.push({ code: 'FOCUS_CLEANUP_FAILED', message: `业务动作不会重试；页面焦点状态未能恢复：${errorInfo(error).message}` }));
      }
    };
    const bound = (!definition.readOnly || needsFocus) && args.tabId !== undefined;
    if (!bound && writes) admit();
    const result = bound ? await broker.exclusive(profileId, tabId, owner, run, !writes, { admit, stillOpen: () => this.state.hasOpenOperation(profileId, tabId) }) : await run();
    if(name==='chrome_network_start')return {...result as JsonObject,since:broker.events(profileId,tabId,0).latestSequence};
    // 撤销失败：这个标签页之后的新文档可能还会跑这段脚本，直到调试连接断开（chrome_detach_tab 或关掉标签页）。
    if (name === 'chrome_navigate' && ((result as JsonObject | undefined)?.initScript as JsonObject | undefined)?.removed === false) execution.warnings.push({ code: 'INIT_SCRIPT_NOT_REMOVED', message: '导航已完成，但 initScript 没能撤销：这个标签页之后打开的新文档可能还会跑它。不要紧就照常用；要确保不再跑，用 chrome_detach_tab 断开调试连接（登记随连接一起消失）。' });
    if(name==='chrome_network_stop')broker.addEvent(profileId,tabId,'network.captureStopped',{});
    if(name==='chrome_accessibility')return args.mode==='summary'?compactAccessibility(result,Number(args.offset),Number(args.limit),Number(args.maxCharacters)):hideRawAccessibility(result);
    // 标签页信息（列表、新建、聚焦、导航、批次里的导航结果）指向管理页时隐藏 URL 和标题，但标签页本身仍可见。
    const visible = restricted && ['tabs.list', 'tabs.create', 'tabs.focus', 'tabs.wait', 'page.navigate', 'page.batch'].includes(definition.operation || '') ? hideAdminTabs(result, origins) : result;
    if (name === 'chrome_tabs') {
      const query = String(args.query || '').toLocaleLowerCase();
      const tabs = (visible as JsonObject[]).filter(tab => !query || `${tab.url} ${tab.title}`.toLocaleLowerCase().includes(query));
      return { profileId, ...pageItems(tabs, Number(args.offset), Number(args.limit)) };
    }
    if (name === 'chrome_new_tab') {
      const opened = Number((result as JsonObject).tabId), joined = await this.groups.join(principal, owner, profileId, opened, false);
      if (joined?.grouped) return { ...visible as JsonObject, group: joined.group };
      // 本会话开的标签页没进组也得能写：改成占用，和 claim_tab 对固定标签页一样，并说明原因，不交回一个写不了的标签页。
      if (joined) {
        try { broker.claim(profileId, opened, owner, 600, principal.remoteAgentId ? `remote:${principal.remoteAgentId}` : principal.id); execution.warnings.push({ code: 'TAB_NOT_GROUPED', message: `新标签页没能放进本会话的标签组（${joined.reason}），已改为占用 10 分钟，可以直接写；还要更久就 chrome_claim_tab 续期。` }); }
        catch (error) { execution.warnings.push({ code: 'TAB_NOT_GROUPED', message: `新标签页没能放进本会话的标签组（${joined.reason}），也没能占用：${errorInfo(error).message} 写之前先 chrome_claim_tab。` }); }
      }
      return visible;
    }
    if (jobId) return { jobId, state: 'running', note: '用 chrome_job_status 查看进度和结果；页面导航或刷新会丢失作业。' };
    if (name === 'chrome_evaluate' && execution.output) {
      try { return { saved: await writeOutputFile(this.config, principal, execution.output, outputText(visible, execution.output.path), TEXT_OUTPUT) }; }
      catch (error) { execution.warnings.push({ code: 'OUTPUT_SAVE_FAILED', message: `脚本已执行，但结果没写进文件：${errorInfo(error).message}。不要为了保存重跑脚本。` }); return visible; }
    }
    // 同机上传时旧扩展只回一个空对象，文件名和大小用服务刚核对过的。
    if (name === 'chrome_upload' && execution.uploadedByPath) return { ...(visible as JsonObject), files: (visible as JsonObject | undefined)?.files ?? execution.uploadedByPath, transport: 'path' };
    if (name === 'chrome_rename_profile') {
      const connection = broker.profiles.get(profileId); if (connection) { connection.info.label = String(args.label); this.state.rememberProfile(connection.info); }
    }
    return visible;
  }

  /** 先记文件名和大小；SHA-256 在后台算完再补上，几百 MB 的视频不拖慢上传。记录写不进去只是少这段信息。 */
  private recordUploads(operationId: string, uploads: UploadRecord[]) {
    const files = uploads.map(({ path: _, ...file }) => file);
    try { this.state.setDetail(operationId, { files }); } catch { return; }
    void Promise.all(uploads.map(async ({ path: file, ...item }) => ({ ...item, ...await sha256File(file).then(sha256 => ({ sha256 }), () => ({})) })))
      .then(hashed => { try { this.state.setDetail(operationId, { files: hashed }); } catch { /* 服务正在关闭或记录已被回收。 */ } });
  }

  // 旧网关连接（legacy）本来就在浏览器那台电脑上执行路径上传，不在这里判断。
  private uploadsByPath(connection: Connection) { return connection.info.connectionType === 'direct' && connection.info.sameMachine === true && (this.config.uploadByPath ?? 'auto') === 'auto'; }

  /** 交给 Chrome 的真实路径和大小。受限主体按真实路径再查一次（不在数据目录里），检查和取路径之间换掉的联接也挡得住。 */
  private async localUploadFiles(files: string[], principal?: Principal) {
    if (principal?.remoteAgentId) throw remotePathRefused('upload');
    const policy = principal && !principal.admin ? filePolicy(this.config) : undefined;
    return Promise.all(files.map(async file => {
      let real: string, info;
      try { real = await realpath(file); info = await stat(real); }
      catch (error) { throw new BrowserError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'FILE_NOT_FOUND' : 'FILE_UNAVAILABLE', '上传文件不存在或无法访问，尚未向浏览器派发。', NOT_DISPATCHED); }
      if (policy) await checkUploadFile(real, policy);
      if (!info.isFile()) throw new BrowserError('NOT_A_FILE', file, NOT_DISPATCHED);
      return { path: real, name: path.basename(real), size: info.size };
    }));
  }

  private async checkFiles(files: string[], principal: Principal) {
    if (principal.remoteAgentId) throw remotePathRefused('upload');
    if (!principal.admin) { const policy = filePolicy(this.config); for (const file of files) await checkUploadFile(file, policy); return; }
    for (const file of files) {
      if (!path.isAbsolute(file)) throw new BrowserError('ABSOLUTE_PATH_REQUIRED', `上传必须使用绝对路径：${file}`);
      let info;try{info=await stat(file);}catch(error){throw new BrowserError((error as NodeJS.ErrnoException).code==='ENOENT'?'FILE_NOT_FOUND':'FILE_UNAVAILABLE','上传文件不存在或无法访问，尚未向浏览器派发。',{phase:'precondition',outcome:'not_dispatched'});}
      if (!info.isFile()) throw new BrowserError('NOT_A_FILE', file,{phase:'precondition',outcome:'not_dispatched'});
    }
  }

  private async save(content: string | Buffer, extension: string, profileId: string | undefined, owner: string, principal: Principal) {
    const size = Buffer.byteLength(content), limit = this.config.resultByteLimit ?? 1024 * 1024 * 1024;
    const used = this.state.resultBytes() + this.untrackedResultBytes + this.pendingResultBytes;
    // 非管理员主体：总量留 1/10 给管理员，单个主体最多占 1/4；管理员只受全局上限约束。
    if (used + size > (principal.admin ? limit : limit - Math.floor(limit / 10))) throw new BrowserError('RESULT_QUOTA', principal.admin ? '结果文件已达到配置容量。请管理结果文件或调整 resultByteLimit；诊断中的 untrackedResultBytes 表示未登记的崩溃残留。' : '结果文件已接近配置容量，剩余部分保留给管理员。请通知管理员清理结果文件（results list / results remove）或调整 resultByteLimit。', { phase: 'precondition', outcome: 'not_dispatched' });
    const mine = principal.admin ? 0 : this.state.principalResultBytes(principal.id, principal.submissionScope) + (this.pendingByPrincipal.get(principal.id) ?? 0), ownLimit = Math.max(Math.min(limit, 65536), Math.floor(limit / 4));
    if (!principal.admin && mine + size > ownLimit) throw new BrowserError('RESULT_QUOTA', `此客户端保存的结果文件已达配额（${ownLimit} 字节）。请由管理员清理其旧结果（results list / results remove）；其他客户端不受影响。`, { phase: 'precondition', outcome: 'not_dispatched' });
    this.pendingResultBytes += size; if (!principal.admin) this.pendingByPrincipal.set(principal.id, (this.pendingByPrincipal.get(principal.id) ?? 0) + size);
    try {
      const artifactId = randomUUID(); const folder = path.join(this.config.dataDir, 'results');
      await mkdir(folder, { recursive: true });
      const file = path.join(folder, `${artifactId}.${extension}`);
      let created = false;
      try {
        const handle = await open(file, 'wx', 0o600); created = true;
        try { await handle.writeFile(content); } finally { await handle.close(); }
        this.state.addArtifact(artifactId, profileId, owner, extension, size);
      } catch (error) {
        if (created) try { await rm(file, { force: true }); } catch { this.untrackedResultBytes += await stat(file).then(item => item.size, () => size); }
        throw error;
      }
      // 本机绝对路径只给管理员；其他主体用 artifactId + chrome_read_result 读取，拿不到数据目录的位置。
      return { artifactId, filename: path.basename(file), ...(principal.admin ? { path: file } : {}) };
    } finally {
      this.pendingResultBytes -= size;
      if (!principal.admin) { const left = (this.pendingByPrincipal.get(principal.id) ?? size) - size; if (left > 0) this.pendingByPrincipal.set(principal.id, left); else this.pendingByPrincipal.delete(principal.id); }
    }
  }

  async close() {
    this.groups.close();
    this.tasks.stopScheduling();
    this.broker.close();
    await this.tasks.drain();
    await Promise.allSettled([...this.inFlight]);
    await this.transfers.close();
    this.state.close();
  }
}
