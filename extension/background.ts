import { execute, detachAll, attachEvents, isTabBusy, hasActiveOperations, cancelOperations, setAdminOrigins, setCursorShown, setHumanInput } from './executor';
import { BrowserError, errorInfo, adminOrigins, extensionCapabilities, EXTENSION_REQUIRES_SERVER, type JsonObject, type WireCommand } from '../src/shared';
import { STORE_BUILD } from './build-target';
import { BridgeHandshake, extensionUpdateProof, newNonce, sameProof } from './bridge-auth';
import {serviceAddress,bridgeAddress} from '../src/service-address';
import {isNewerVersion} from '../ui/extension-version.js';
import {VERSION} from '../src/version';
import {parseBrowserConnection} from '../src/browser-connection';
import {settingsTarget} from '../ui/desktop-link.js';
import {FILE_CHUNK_BYTES} from '../src/file-limits';
import {migratedConnection,type ConnectionSettings,type PauseReason} from './connection-migration';
import {reachable} from './service-probe';
import {attachGroupEvents,dissolveGroups,groupCommand,showGroup} from './tab-groups';

type Settings=ConnectionSettings;
const address=(config:Settings)=>serviceAddress(config.serviceUrl||`http://127.0.0.1:${config.port}`);
const PAIRING_KEY = /^[a-f0-9]{64}$/;
let socket: WebSocket | undefined;
let connecting = false;
let retry: ReturnType<typeof setTimeout> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let handshake: ReturnType<typeof setTimeout> | undefined;
let retryMs = 1000;
const instanceId = crypto.randomUUID();
let status = { state: 'starting', message: '' };
let compatibleServer = false;
let connectedService:{serviceId?:string;canManage:boolean;extensionRelease?:{version:string;versionName:string}}={canManage:false};
// 每条连接各自的握手状态：握手完成前不发送事件、不执行命令。
const bridges = new WeakMap<WebSocket, BridgeHandshake>();
const activities = new Map<string, { operation: string; tabId?: number; startedAt: string }>();
async function updateActivity() {
  const config = await settings(), release = connectedService.extensionRelease, updateReady = !STORE_BUILD && status.state === 'connected' && !!release && isNewerVersion(release.version, chrome.runtime.getManifest().version);
  await chrome.action.setBadgeText({ text: !config.enabled ? 'OFF' : activities.size ? String(activities.size) : updateReady ? 'NEW' : status.state === 'connected' ? 'ON' : '' });
  // 角标：蓝是连着，橙是 Agent 正在操作（和弹窗、管理页同一套颜色）
  await chrome.action.setBadgeBackgroundColor({ color: activities.size ? '#c24100' : '#1d2fe0' });
  await chrome.action.setTitle({ title: `${config.label} · ${activities.size ? `${activities.size} 个操作进行中` : updateReady ? `有新版本 ${release.versionName}，点开更新` : status.message || status.state}` });
}
// 重载会关掉设置页，换一个新标签告诉用户更新好了。
async function announceUpdate() {
  const { selfUpdate } = await chrome.storage.local.get('selfUpdate');
  if (!selfUpdate) return;
  await chrome.storage.local.remove('selfUpdate');
  await chrome.tabs.create({ url: chrome.runtime.getURL('options.html#updated') });
}
// Chrome 有时沿用旧的后台脚本：共用的扩展文件夹在这个配置关着时被另一个配置更新过，再打开时 manifest 是新的、
// 跑的还是存下的旧代码，重启也不换。manifest 比代码新就重载一次，Chrome 会从文件夹重新注册；
// 同一对版本只试一次，还不行就照常连上，握手带的 codeVersion 让管理页提示用户手动重新加载。
async function reloadIfStale() {
  const manifest = chrome.runtime.getManifest().version;
  if (!isNewerVersion(manifest, VERSION)) return false;
  const attempt = `${manifest}<${VERSION}`, { staleReload } = await chrome.storage.local.get('staleReload');
  if (staleReload === attempt) return false;
  await chrome.storage.local.set({ staleReload: attempt });
  chrome.runtime.reload(); return true;
}
const reloading = reloadIfStale().catch(() => false);

let settingsPromise: Promise<Settings> | undefined;
// 光标和“像真人一样操作”两个开关都默认开，执行器按设置切换，不用断开重连。
function applyDisplay(config: Settings) { setCursorShown(config.showCursor !== false); setHumanInput(config.humanInput !== false); }
let settingsUpdates: Promise<unknown> = Promise.resolve();
function settings(): Promise<Settings> {
  settingsPromise ||= loadSettings().then(config => { applyDisplay(config); return config; });
  return settingsPromise;
}
function changeSettings(change: (config: Settings) => void): Promise<Settings> {
  const update = settingsUpdates.then(async () => {
    const config = { ...await settings() };
    change(config);
    await chrome.storage.local.set({ settings: config });
    settingsPromise = Promise.resolve(config); applyDisplay(config);
    return config;
  });
  settingsUpdates = update.then(() => undefined, () => undefined);
  return update;
}
const defaultLabel = (profileId: string) => `Chrome ${profileId.slice(0, 6)}`;
async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(['settings']);
  const defaults = await fetch(chrome.runtime.getURL('pairing.json')).then(response => response.json()).catch(() => ({ port: 17422, token: '' }));
  if(stored.settings){
    const current=stored.settings as Settings,next=await migratedConnection(current,defaults.migration);
    if(next){await chrome.storage.local.set({settings:next,connectionBeforeMigration:{migrationId:next.migrationId,settings:current}});return next;}
    return current;
  }
  const profileId = crypto.randomUUID();
  const value: Settings = {port:Number.isInteger(defaults.port)&&defaults.port>=1024&&defaults.port<=65535?defaults.port:17422,token:typeof defaults.token==='string'&&PAIRING_KEY.test(defaults.token)?defaults.token:'',...(typeof defaults.serviceUrl==='string'?{serviceUrl:serviceAddress(defaults.serviceUrl)}:{}),...(typeof defaults.pairingId==='string'?{pairingId:defaults.pairingId}:{}),...(typeof defaults.managerToken==='string'&&PAIRING_KEY.test(defaults.managerToken)?{managerToken:defaults.managerToken}:{}), profileId, label: defaultLabel(profileId), enabled: true };
  await chrome.storage.local.set({ settings: value });
  return value;
}

function emit(method: string, params: JsonObject, tabId?: number) {
  if (socket?.readyState === WebSocket.OPEN && bridges.get(socket)?.ready) socket.send(JSON.stringify({ type: 'event', method, params, tabId }));
  if (method === 'bridge.userPaused') void pauseFromBrowser('debugging-canceled');
}
// 取消调试后自动恢复是用户在设置页里打开的；默认保持暂停，尊重用户点的“取消”。
const AUTO_RESUME_MS = 60_000;
attachEvents(emit);
const groupReleased=(owner:string,tabIds:number[])=>emit('group.released',{owner,tabIds});
attachGroupEvents(groupReleased);

async function pauseFromBrowser(reason: PauseReason) {
  const config = await changeSettings(config => { config.enabled = false; config.pausedReason = reason; if (reason === 'debugging-canceled' && config.autoResume) config.resumeAt = Date.now() + AUTO_RESUME_MS; else delete config.resumeAt; });
  // 断开前告诉服务原因，chrome_profiles 才能说清这个浏览器为什么离线、怎么恢复。
  if (reason !== 'debugging-canceled') emit('bridge.paused', { reason });
  const old = socket; socket = undefined; old?.close();
  activities.clear();
  if (retry) clearTimeout(retry); if (heartbeat) clearInterval(heartbeat); if (handshake) clearTimeout(handshake);
  await detachAll();
  status = { state: 'paused', message: config.resumeAt ? '在 Chrome 提示条里取消了调试，1 分钟后自动恢复连接。' : '此配置已暂停，调试连接已释放。点击继续连接后才能重新接管。' };
  if (config.resumeAt) retry = setTimeout(() => void connect(), AUTO_RESUME_MS + 1000);
  await chrome.action.setBadgeText({ text: 'OFF' });
}

// 没有 identity 权限（旧清单、测试替身）时就不报账号。
async function signedInAccount() {
  try { return (await chrome.identity.getProfileUserInfo({ accountStatus: chrome.identity.AccountStatus.ANY })).email || undefined; } catch { return undefined; }
}

async function connect(): Promise<void> {
  if (await reloading) return;
  if (connecting || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  connecting = true;
  try {
    let config = await settings();
    // 自动恢复的时间到了就打开连接；Service Worker 睡着时由每 30 秒的 alarm 叫醒这里。
    if (!config.enabled && config.resumeAt && Date.now() >= config.resumeAt) config = await changeSettings(next => { next.enabled = true; delete next.resumeAt; delete next.pausedReason; });
    if (!config.enabled) { status = { state: 'paused', message: config.resumeAt ? '在 Chrome 提示条里取消了调试，稍后自动恢复连接。' : '已暂停连接' }; return; }
    if (!config.token) { status = { state: 'unpaired', message: '请填写服务管理页生成的浏览器配对码。' }; return; }
    status = { state: 'connecting', message: '' };
    setAdminOrigins([...new Set([...adminOrigins(config.port),address(config),...(config.protectedServices||[])])]);
    // 配对密钥只作 HMAC 密钥：第一帧只带随机数，服务先证明自己，核对通过后扩展才发出自己的证明和身份。
    // Chrome 登录的 Google 账号，帮用户分清是哪个 Chrome 配置；没登录 Chrome 就没有，不代表网站账号。
    // 账号查询要在建 WebSocket 之前做完：建好后到绑定事件之间不能有 await，否则连接很快时 open/close 会漏掉。
    const account = await signedInAccount();
    const current = new WebSocket(bridgeAddress(address(config)));
    socket = current;
    const bridge = new BridgeHandshake(config.token, { id: config.profileId, label: config.label, instanceId, version: chrome.runtime.getManifest().version, codeVersion: VERSION, userAgent: navigator.userAgent, capabilities: extensionCapabilities(STORE_BUILD), ...(account ? { account } : {}) },undefined,config.pairingId);
    bridges.set(current, bridge);
    handshake = setTimeout(() => { if (socket === current && status.state !== 'connected') current.close(); }, 8000);
    current.onopen = () => current.send(bridge.hello());
    current.onmessage = event => {
      if (socket !== current) return;
      void receive(current, String(event.data)).catch(error => { status = { state: 'error', message: String(error) }; });
    };
    current.onerror = () => { /* close 事件统一处理重连。 */ };
    current.onclose = () => {
      if (socket !== current) return;
      socket = undefined;
      connectedService={canManage:false};
      activities.clear();
      cancelOperations();
      if (heartbeat) clearInterval(heartbeat);
      if (handshake) clearTimeout(handshake);
      if (status.state !== 'error') status = { state: 'offline', message: '服务尚未连接，将自动重试。请核对地址、网络及服务器证书。' };
      retry = setTimeout(() => void connect(), retryMs);
      retryMs = Math.min(retryMs * 2, 30000);
    };
  } finally { connecting = false; }
}

async function connected(current: WebSocket, capabilities: string[],frame:JsonObject) {
  if (handshake) clearTimeout(handshake);
  compatibleServer = EXTENSION_REQUIRES_SERVER.every(item => capabilities.includes(item));
  const release=frame.extensionRelease as {version?:unknown;versionName?:unknown}|undefined;
  connectedService={canManage:frame.canManage===true,...(typeof frame.serviceId==='string'?{serviceId:frame.serviceId}:{}),...(typeof release?.version==='string'&&typeof release.versionName==='string'?{extensionRelease:{version:release.version,versionName:release.versionName}}:{})};
  status = compatibleServer ? { state: 'connected', message: '已连接服务' } : { state: 'error', message: '服务与扩展版本不兼容：更新两者为同一版本，或刷新回滚后的扩展。' }; retryMs = 1000;
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = setInterval(() => { if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: 'ping' })); }, 20000);
  await chrome.action.setBadgeText({ text: 'ON' });
  await chrome.action.setBadgeBackgroundColor({ color: '#1d2fe0' });
  await updateActivity();
}

async function receive(current: WebSocket, raw: string) {
  const frame = JSON.parse(raw) as JsonObject;
  const bridge = bridges.get(current);
  if (!bridge) return;
  if (!bridge.ready) {
    // 握手阶段只处理握手帧；握手完成前不会执行任何命令。
    const step = await bridge.receive(frame);
    if (socket !== current) return;
    if (step.kind === 'send') current.send(step.frame);
    else if (step.kind === 'ready') await connected(current, step.capabilities,frame);
    else { status = { state: 'error', message: step.message }; retryMs = 30000; current.close(); }
    return;
  }
  if (frame.type === 'rejected') {
    status = { state: 'error', message: String(frame.message) }; retryMs = 30000;
    current.close();
  } else if (frame.type === 'command') {
    const command = frame as unknown as WireCommand;
    if (command.operation === 'profile.pause') {
      await changeSettings(config => {
        if (socket !== current) throw new BrowserError('CANCELLED', '连接已变化，未修改新连接的设置。', { phase: 'precondition', outcome: 'not_dispatched' });
        config.enabled = false;
      });
      current.send(JSON.stringify({ type: 'result', id: command.id, result: { paused: true, resume: '请在此配置的扩展里点击继续连接。' } }));
      await pauseFromBrowser('agent'); return;
    }
    let result: unknown;
    let error: ReturnType<typeof errorInfo> | undefined;
    // 标签组命令是几毫秒的协调，管理页还会轮询，不能让徽标闪动，也不算 Agent 在操作。
    const grouping = command.operation.startsWith('group.');
    try {
      if (!grouping) {
        activities.set(command.id, { operation: command.operation, tabId: command.args.tabId as number | undefined, startedAt: new Date().toISOString() });
        void updateActivity().catch(() => {});
      }
      // 服务和浏览器常在两台电脑上，时钟不一定一致，到期时间按收到命令时的本机时钟算；旧服务只发 deadline。
      const deadline = typeof command.timeoutMs === 'number' ? Date.now() + command.timeoutMs : command.deadline;
      if (Date.now() > deadline) throw new BrowserError('DEADLINE_EXCEEDED','命令已过期，未执行。',{phase:'precondition',outcome:'not_dispatched'});
      if (!compatibleServer) throw new BrowserError('SERVICE_UPDATE_REQUIRED','当前扩展的执行修复需要新版服务；请更新服务或刷新回滚后的扩展，未执行动作。',{phase:'precondition',outcome:'not_dispatched'});
      if (command.operation === 'profile.rename') {
        const config = await changeSettings(config => {
          if (socket !== current) throw new BrowserError('CANCELLED', '连接已变化，未修改新连接的设置。', { phase: 'precondition', outcome: 'not_dispatched' });
          config.label = String(command.args.label);
        });
        result = { label: config.label };
      } else if(command.operation==='downloads.file.read'){
        const id=command.args.downloadId,offset=command.args.offset,length=command.args.length;
        if(!Number.isSafeInteger(id)||Number(id)<0||!Number.isSafeInteger(offset)||Number(offset)<0||!Number.isSafeInteger(length)||Number(length)<1||Number(length)>FILE_CHUNK_BYTES)throw new BrowserError('FILE_TRANSFER_CHUNK','下载读取范围无效。',{phase:'precondition',outcome:'not_dispatched'});
        const download=(await chrome.downloads.search({id:Number(id)}))[0];
        if(!download||download.id!==id||download.state!=='complete'||download.exists===false||download.error)throw new BrowserError('FILE_DOWNLOAD_NOT_READY','此浏览器中的下载尚未完成或已不可用。',{phase:'precondition',outcome:'not_dispatched'});
        const config=await settings();let response;
        try{response=await chrome.runtime.sendNativeMessage(`com.saltedfish.settings.p${config.port}`,{action:'read-download',path:download.filename,offset,length,...(command.args.snapshot?{snapshot:command.args.snapshot}:{})});}
        catch{throw new BrowserError('BROWSER_HELPER_REQUIRED','导出浏览器电脑上的下载文件需要可选的 SaltedFish 本机助手。普通网页操作不受影响。',{phase:'precondition',outcome:'not_dispatched'});}
        if(!response?.ok||!response.file){const code=['LOCAL_FILE_ACCESS_DENIED','LOCAL_FILE_CHANGED'].includes(response?.error?.code)?response.error.code:'BROWSER_HELPER_REQUIRED';throw new BrowserError(code,code==='LOCAL_FILE_CHANGED'?'下载文件已变化，请先核对。':code==='LOCAL_FILE_ACCESS_DENIED'?'下载文件不在本机助手允许读取的目录中。':'请安装或更新浏览器电脑上的 SaltedFish 本机助手后重试。',{phase:'precondition',outcome:'not_dispatched'});}
        const currentDownload=(await chrome.downloads.search({id:Number(id)}))[0];if(currentDownload?.filename!==download.filename||currentDownload.state!=='complete'||currentDownload.exists===false)throw new BrowserError('LOCAL_FILE_CHANGED','下载记录在读取期间变化。',{phase:'precondition',outcome:'not_dispatched'});
        result=response.file;
      } else if (command.operation === 'tab.recover') {
        if (isTabBusy(Number(command.args.tabId))) throw new Error('标签页仍有未结束的操作，暂时不能恢复。');
        result = { idle: true };
      } else if (grouping) result = await groupCommand(command.operation, command.args);
      else result = await execute(command.operation, command.args, deadline, command.id);
    } catch (reason) { error = errorInfo(reason); }
    if (!grouping) { activities.delete(command.id); void updateActivity().catch(() => {}); }
    if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: 'result', id: command.id, result, error }));
  }
}

chrome.runtime.onMessage.addListener((message: JsonObject, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  void (async () => {
    if (message.type === 'settings.get') {
      const config = await settings();
      return { settings: { ...config,serviceUrl:address(config), token: undefined,managerToken:undefined },serviceKnown:!!config.serviceUrl,status,service:connectedService, instanceId, activities: [...activities.values()] };
    }
    if(message.type==='service.summary'){
      const config=await settings();if(status.state!=='connected')throw new Error('浏览器尚未连接服务。');
      const url=new URL(address(config)+'/extension/agents');url.searchParams.set('profileId',config.profileId);url.searchParams.set('instanceId',instanceId);if(config.pairingId)url.searchParams.set('pairingId',config.pairingId);
      const response=await fetch(url,{headers:{authorization:'Bearer '+config.token},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(5000)});
      if(!response.ok)throw new Error(response.status===404?'服务尚不支持Agent摘要，请更新服务。':response.status===401||response.status===403?'浏览器配对已失效或无权读取此摘要。':'暂时无法读取Agent连接。');
      if((await settings()).profileId!==config.profileId||address(await settings())!==address(config))throw new Error('连接已变化，请稍后重试。');return await response.json();
    }
    if(message.type==='extension.update.offer'){
      if(STORE_BUILD)throw new Error('应用商店版由 Chrome 自动更新。');
      const config=await settings();if(status.state!=='connected')throw new Error('连上服务后才能更新。');if(activities.size||hasActiveOperations())throw new Error('Agent 正在操作，结束后再更新。');
      const nonce=newNonce(),base=address(config),url=new URL(base+'/extension/update');url.searchParams.set('profileId',config.profileId);url.searchParams.set('instanceId',instanceId);url.searchParams.set('nonce',nonce);if(config.pairingId)url.searchParams.set('pairingId',config.pairingId);
      const response=await fetch(url,{headers:{authorization:'Bearer '+config.token},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error(response.status===404?'这个服务还不支持一键更新，请先升级服务。':'暂时拿不到更新信息，请稍后重试。');
      const offer=await response.json() as {version?:unknown;versionName?:unknown;sha256?:unknown;proof?:unknown};
      if(typeof offer.version!=='string'||typeof offer.sha256!=='string'||typeof offer.proof!=='string'||!sameProof(offer.proof,await extensionUpdateProof(config.token,config.profileId,nonce,offer.version,offer.sha256)))throw new Error('更新信息校验失败，已停止，文件没有改动。');
      return{version:offer.version,versionName:String(offer.versionName||offer.version),sha256:offer.sha256,serviceUrl:base};
    }
    if(message.type==='group.show')return await showGroup(Number(message.groupId));
    if(message.type==='group.release'){
      const ended=await dissolveGroups({groupId:Number(message.groupId)});
      for(const item of ended)groupReleased(item.owner,item.tabIds);
      return{released:ended.length>0};
    }
    if(message.type==='extension.update.restart'){
      if(STORE_BUILD)throw new Error('应用商店版由 Chrome 自动更新。');
      if(activities.size||hasActiveOperations())throw new Error('Agent 正在操作，结束后再重新加载。');
      await chrome.storage.local.set({selfUpdate:{from:chrome.runtime.getManifest().version}});
      setTimeout(()=>chrome.runtime.reload(),100);return{restarting:true};
    }
    if(message.type==='service.open'){
      const config=await settings(),target=settingsTarget(typeof message.target==='string'?message.target:'overview');if(target===null)throw new Error('设置目标无效。');const base=address(config);
      if(config.pairingId&&config.managerToken&&connectedService.canManage){
        const response=await fetch(base+'/extension/session-code',{method:'POST',headers:{authorization:'Bearer '+config.managerToken,'content-type':'application/json'},body:JSON.stringify({pairingId:config.pairingId,profileId:config.profileId,instanceId,target}),redirect:'error',signal:AbortSignal.timeout(5000)});
        if(!response.ok)throw new Error('管理授权不可用，请在服务管理页重新授权或登录。');const data=await response.json();const latest=await settings();if(latest.profileId!==config.profileId||latest.pairingId!==config.pairingId||address(latest)!==base)throw new Error('连接已变化，请重新打开管理页。');return{ok:true,url:data.url,authenticated:true};
      }
      if(!config.pairingId&&base===`http://127.0.0.1:${config.port}`&&typeof chrome.runtime.sendNativeMessage==='function'){
        try{const result=await chrome.runtime.sendNativeMessage(`com.saltedfish.settings.p${config.port}`,{action:'open-settings',target});if(result?.ok)return{...result,authenticated:true};}catch{/* 本机助手可选，未安装时正常打开当前服务登录页。 */}
      }
      // 走到这里只能直接打开地址；连不上就不开，免得落到浏览器的报错页。
      if(!await reachable(base))return{unreachable:true};
      return{ok:true,url:base+'/#'+target,authenticated:false};
    }
    // 只改开关，不像 settings.save 那样断开重连，Agent 正在做的操作不受影响。
    if (message.type === 'settings.showCursor') {
      if (typeof message.enabled !== 'boolean') throw new Error('开关值无效。');
      const enabled = message.enabled === true, config = await changeSettings(next => { next.showCursor = enabled; });
      return { saved: true, showCursor: config.showCursor !== false };
    }
    if (message.type === 'settings.humanInput') {
      if (typeof message.enabled !== 'boolean') throw new Error('开关值无效。');
      const enabled = message.enabled === true, config = await changeSettings(next => { next.humanInput = enabled; });
      return { saved: true, humanInput: config.humanInput !== false };
    }
    if (message.type === 'settings.autoResume') {
      if (typeof message.enabled !== 'boolean') throw new Error('开关值无效。');
      const enabled = message.enabled === true, config = await changeSettings(next => { next.autoResume = enabled; if (!enabled) delete next.resumeAt; });
      return { saved: true, autoResume: config.autoResume === true };
    }
    if (message.type === 'settings.save') {
      // 配对密钥是握手 HMAC 的 key，必须与本机服务生成的字符串完全一致：64 位小写十六进制（弹窗已在提交前规范化）。
      // 后台自己把关，不依赖弹窗：带了 token 字段就必须合格，否则整条保存都不执行并明确报错，既不静默丢弃也不写入无效密钥。
      if (message.token !== undefined && !(typeof message.token === 'string' && PAIRING_KEY.test(message.token))) return { error: '配对密钥应是 64 位十六进制字符（0-9、a-f，须为小写）；这次没有保存任何设置。' };
      // 多个设置页同时提交时串行更新，旧身份确认不能覆盖已完成的重建。
      const update = settingsUpdates.then(async () => {
        const config = { ...await settings() };
        if(message.connectionCode!==undefined){
          if(typeof message.connectionCode!=='string')throw new Error('浏览器配对码格式无效。');
          if(activities.size||hasActiveOperations())throw new Error('浏览器仍有操作进行中，请结束操作后更换服务。');
          const connection=parseBrowserConnection(message.connectionCode.trim());
          // 扩展重装后身份是新生成的，管理页的“重新连接”把原身份放在配对码里，没配对的扩展接过去。已配对的扩展不能被一个码换掉身份。
          if(config.token&&connection.profileId&&connection.profileId!==config.profileId)throw new Error('此配对属于另一浏览器，当前浏览器身份没有改变。');
          if(typeof message.serviceUrl==='string'&&message.serviceUrl.trim()&&serviceAddress(message.serviceUrl.trim())!==connection.serviceUrl)throw new Error('服务地址与配对码不一致，请核对目标服务。');
          config.protectedServices=[...new Set([...(config.protectedServices||[]),address(config)])].slice(-32);
          config.serviceUrl=connection.serviceUrl;config.pairingId=connection.pairingId;config.token=connection.token;config.managerToken=connection.managerToken;
          // 管理页填的名称只替换自动生成的名称，用户在扩展里改过的不动。
          if(connection.label&&config.label===defaultLabel(config.profileId))config.label=connection.label;
          if(connection.profileId)config.profileId=connection.profileId;
        }else if(typeof message.serviceUrl==='string'&&serviceAddress(message.serviceUrl.trim())!==address(config)){
          // 没配对时地址只是记下来，下次打开不用重填；配对之后换服务必须带新配对码。
          if(config.token)throw new Error('更换服务需要填写该服务生成的浏览器配对码。');
          config.serviceUrl=serviceAddress(message.serviceUrl.trim());
        }
        if (message.resetIdentity === true) {
          if (message.expectedProfileId !== config.profileId) throw new Error('配置身份已变化或尚未确认，请重新打开重建确认。');
          if (activities.size || hasActiveOperations()) throw new Error('此浏览器仍有操作进行中，请等待完成或暂停后再重建身份。');
        }
        if(config.pairingId&&(message.port!==undefined||message.token!==undefined))throw new Error('此浏览器已使用独立配对，请用服务地址和配对码修改连接。');
        if (typeof message.label === 'string' && message.label.trim()) config.label = message.label.trim().slice(0, 100);
        if (typeof message.port === 'number' && Number.isInteger(message.port) && message.port >= 1024 && message.port <= 65535) { config.port = message.port; setAdminOrigins(adminOrigins(config.port)); }
        if (typeof message.token === 'string') config.token = message.token;
        // 用户自己暂停：断开前告诉服务原因；继续连接时清掉暂停记录。
        if (typeof message.enabled === 'boolean') { if (config.enabled && !message.enabled) { config.pausedReason = 'user'; emit('bridge.paused', { reason: 'user' }); } if (message.enabled) { delete config.pausedReason; delete config.resumeAt; } config.enabled = message.enabled; }
        if (message.resetIdentity === true) {config.profileId = crypto.randomUUID();if(config.pairingId){delete config.pairingId;delete config.managerToken;config.token='';}}
        await chrome.storage.local.set({ settings: config });
        settingsPromise = Promise.resolve(config);
        if (retry) clearTimeout(retry);
        if (heartbeat) clearInterval(heartbeat);
        if (handshake) clearTimeout(handshake);
        const old = socket; socket = undefined; old?.close();
        cancelOperations();
        if (!config.enabled) await detachAll();
        await chrome.action.setBadgeText({ text: config.enabled ? '' : 'OFF' });
        await connect(); return { saved: true, profileId: config.profileId };
      });
      settingsUpdates = update.then(() => undefined, () => undefined);
      return update;
    }
    return { error: '未知设置操作' };
  })().then(respond).catch(error => respond({ error: String(error) }));
  return true;
});
chrome.alarms.onAlarm.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => { void connect(); void announceUpdate().catch(() => {}); });
void chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
void connect();
