export {};
import { agentConnection, groupCard, replaceGroupCards, type AgentGroup, type AgentSummary } from '../ui/agent-view.js';
import { serviceSettingsLoginUrl, settingsTarget } from '../ui/desktop-link.js';
const form = document.querySelector<HTMLFormElement>('#settings')!;
const status = document.querySelector<HTMLElement>('#status')!;
let enabled = true;
let serviceUrl = '';
import {serviceAddress,serviceTransportLabel} from '../src/service-address';
import {parseBrowserConnection} from '../src/browser-connection';
import {loopbackAddress,privateAddress} from '../src/service-address';
import {reachable} from './service-probe';
import {filesUpdated,updateExtension,UpdateError} from './self-update';
import {isNewerVersion} from '../ui/extension-version.js';

let agentsRevision = 0;
let currentProfileId = '';
let groupsKey='';
let agentsLoading = '';
let openingWorkbench = false;
let refreshRevision = 0;
let savedName = '';
let loadedProfileId = '';
let nameAvailable = false;
let nameEditing = false;
let nameSaving = false;
let nameEditProfile = '';
let activeOperations = 0;
const nameForm = document.querySelector<HTMLFormElement>('#name-form')!;
const nameInput = document.querySelector<HTMLInputElement>('#profile-name-input')!;
const editName = document.querySelector<HTMLButtonElement>('#edit-name')!;
const saveName = document.querySelector<HTMLButtonElement>('#save-name')!;
const cancelName = document.querySelector<HTMLButtonElement>('#cancel-name')!;
const nameResult = document.querySelector<HTMLElement>('#name-result')!;


const saveResult = document.querySelector<HTMLElement>('#save-result')!;
const setup = document.querySelector<HTMLElement>('#setup')!;
const workspace = document.querySelector<HTMLElement>('#workspace')!;
const setupAddress = document.querySelector<HTMLInputElement>('#setup-address')!;
const setupCode = document.querySelector<HTMLInputElement>('#setup-code')!;
const setupOpen = document.querySelector<HTMLButtonElement>('#setup-open')!;
const setupOpenResult = document.querySelector<HTMLElement>('#setup-open-result')!;
const setupResult = document.querySelector<HTMLElement>('#setup-result')!;
let setupActive = false;
function setupError(target:HTMLElement,text:string){target.dataset.error=String(!!text);target.textContent=text;}
const unreachableMessage=(address:string)=>`连不上 ${address}。确认服务已启动，地址和端口没写错。`;
// 用户多半只填 IP 和端口；协议按地址类型补上，内网和本机用 HTTP，其他用 HTTPS。
function typedAddress(value:string){
  const text=value.trim();if(!text)throw new Error('请填写服务地址。');
  if(/^[a-z][a-z0-9+.-]*:\/\//i.test(text))return serviceAddress(text);
  const host=text.split(/[:/]/)[0]!;
  return serviceAddress((loopbackAddress(host)||privateAddress(host)?'http://':'https://')+text);
}
// 保存结果必须看得见：后台对不合格的配对密钥是静默丢弃的，失败也只体现在返回值里。
function report(message: string, failed: boolean) { saveResult.dataset.error = String(failed); saveResult.textContent = message; }
function reportName(message:string,failed=false){nameResult.dataset.error=String(failed);nameResult.textContent=message;}
function nameView(){
  nameForm.hidden=!nameEditing;document.querySelector<HTMLElement>('#name-display')!.hidden=nameEditing;
  editName.disabled=nameSaving||!nameAvailable;
  saveName.disabled=nameSaving||!nameAvailable||activeOperations>0||nameEditProfile!==loadedProfileId;
  cancelName.disabled=nameSaving;
  document.querySelector('#name-editor-hint')!.textContent=activeOperations>0?'Agent 正在操作，操作结束后可保存名称。':'保存名称会短暂重新连接，浏览器身份保持不变。';
}
editName.addEventListener('click',()=>{
  if(!nameAvailable||nameSaving)return;
  nameEditing=true;nameEditProfile=loadedProfileId;nameInput.value=savedName;reportName('');nameView();nameInput.focus();nameInput.select?.();
});
function cancelRename(){if(nameSaving)return;nameEditing=false;nameInput.value='';reportName('');nameView();editName.focus();}
cancelName.addEventListener('click',cancelRename);
nameForm.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();cancelRename();}});
nameForm.addEventListener('submit',event=>{
  event.preventDefault();if(nameSaving||!nameEditing)return;
  const label=nameInput.value.trim();
  if(!label||label.length>100){reportName('请输入 1–100 个字符的浏览器名称。',true);nameInput.focus();return;}
  nameSaving=true;reportName('');nameView();
  void(async()=>{
    const current=await chrome.runtime.sendMessage({type:'settings.get'});
    if(!current?.settings||current.settings.profileId!==nameEditProfile)throw new Error('浏览器身份已变化，请取消后重新修改名称。');
    if(current.activities?.length)throw new Error('Agent 正在操作，请等操作结束后保存。');
    if(label!==current.settings.label)await save({label});
    savedName=label;document.querySelector('#profile-name')!.textContent=label;nameEditing=false;reportName('名称已保存。');
    await refresh().catch(()=>reportName('名称已保存，状态暂时无法刷新，请重新打开页面。'));
  })().catch(error=>reportName(reason(error),true)).finally(()=>{nameSaving=false;nameView();if(!nameEditing)editName.focus();});
});

async function save(settings: Record<string, unknown>) {
  const response = await chrome.runtime.sendMessage({ type: 'settings.save', ...settings });
  // 后台把异常转成 String(error)，开头带 "Error: "，对用户是噪音。
  if (response?.error || !response?.saved) throw new Error(response?.error ? String(response.error).replace(/^Error:\s*/, '') : '设置未保存，请检查连接状态后重试。');
}
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
interface SettingsSnapshot {settings:{profileId:string;port:number;serviceUrl?:string;enabled:boolean;pausedReason?:string;autoResume?:boolean;resumeAt?:number;showCursor?:boolean;humanInput?:boolean};instanceId:string;status?:{state:string}}
async function groupAction(type:string,group:AgentGroup,button:HTMLButtonElement){
  const message=document.querySelector<HTMLElement>('#agents-status')!;
  button.disabled=true;
  try{const result=await chrome.runtime.sendMessage({type,groupId:group.groupId});if(result?.error)throw new Error(String(result.error).replace(/^Error:\s*/,''));}
  catch(error){message.textContent=reason(error);message.dataset.error='true';}
  finally{button.disabled=false;}
}
const groupNote=(text:string)=>{const note=document.createElement('p');note.className='agent-group-empty';note.textContent=text;return note;};
async function refreshAgents(response:SettingsSnapshot){
  const requestKey=JSON.stringify([response.settings.profileId,response.instanceId,serviceUrl,response.settings.enabled,response.status?.state]);
  if(agentsLoading===requestKey)return;agentsLoading=requestKey;
  const revision=++agentsRevision,profileId=response.settings.profileId;
  const message=document.querySelector<HTMLElement>('#agents-status')!,groupList=document.querySelector<HTMLElement>('#group-list')!;
  const clear=(text:string,error=false)=>{groupList.replaceChildren();groupsKey='';message.textContent=text;message.dataset.error=String(error);};
  currentProfileId=profileId;
  if(!serviceUrl){clear('服务地址无效，请重新填写连接设置。',true);agentsLoading='';return;}
  if(!response.settings.enabled||response.status?.state!=='connected'){clear(response.settings.enabled?'连接服务后，这里会显示正在用这个浏览器的 Agent。':'浏览器已暂停。继续连接后可查看 Agent 状态。');agentsLoading='';return;}
  try{
    const data=await chrome.runtime.sendMessage({type:'service.summary'}) as {error?:string;profileId?:string;agents?:AgentSummary[];groups?:AgentGroup[];version?:string};
    if(revision!==agentsRevision||profileId!==currentProfileId)return;
    if(data.error)throw new Error(data.error);
    if(data.profileId!==profileId||!Array.isArray(data.agents))throw new Error('返回的浏览器身份不匹配，未显示其他浏览器的 Agent。');
    const agents=data.agents,groups=data.groups||[];
    // 读页面不用开组，只看标签组会以为它没在用。
    const outside=agents.filter(agent=>agentConnection(agent).tone==='active'&&!groups.some(group=>group.agentId===agent.id)).map(agent=>agent.label);
    message.dataset.error='false';message.textContent='';
    document.querySelector('#service-version')!.textContent=data.version?'服务 '+data.version:'';
    const nextGroups=JSON.stringify([groups,outside,agents.length>0]);
    if(nextGroups!==groupsKey){
      groupsKey=nextGroups;
      replaceGroupCards(groupList,groups.map(item=>groupCard(item,{onShow:(group,button)=>groupAction('group.show',group,button),onRelease:(group,button)=>groupAction('group.release',group,button)})));
      if(outside.length)groupList.append(groupNote(outside.join('、')+' 正在用这个浏览器，没有开标签组。'));
      else if(!groups.length)groupList.append(groupNote(agents.length?'现在没有 Agent 在用这个浏览器。':'还没有 Agent 获准使用这个浏览器，到管理页授权。'));
    }
  }catch(error){if(revision===agentsRevision&&profileId===currentProfileId)clear(reason(error),true);}
  finally{if(revision===agentsRevision)agentsLoading='';}
}
function workbenchReady(){return!!serviceUrl&&!!currentProfileId;}
function workbenchTarget(link:HTMLAnchorElement){return link.dataset.settingsTarget||'overview';}
function workbenchButtons(){for(const link of document.querySelectorAll<HTMLAnchorElement>('a[data-settings-target]')){const target=settingsTarget(workbenchTarget(link)),ready=!openingWorkbench&&workbenchReady()&&target!==null;link.setAttribute('aria-disabled',String(!ready));link.setAttribute('tabindex',ready?'0':'-1');if(ready)link.setAttribute('href',serviceUrl+'/#'+target);else link.removeAttribute('href');}}
const launchResult=document.querySelector<HTMLElement>('#settings-launch-result')!,launchMessage=document.querySelector<HTMLElement>('#settings-launch-message')!,launchFallback=document.querySelector<HTMLAnchorElement>('#settings-launch-fallback')!;
let fallbackTarget:{origin:string;route:string;profile:string}|null=null;
function launchFeedback(text:string,error=false){launchResult.hidden=false;launchResult.dataset.error=String(error);launchMessage.textContent=text;}
async function openManagementTab(origin:string,url:string){const pages=await chrome.tabs.query({});const existing=pages.find(tab=>{try{const p=new URL(tab.url||'');return p.origin===origin&&p.pathname==='/'&&!/^[a-f0-9]{64}$/.test(p.hash.slice(1));}catch{return false;}});if(existing?.id!==undefined){await chrome.tabs.update(existing.id,{active:true,url});await chrome.windows.update(existing.windowId,{focused:true});}else await chrome.tabs.create({url,active:true});}
document.addEventListener('click',event=>{
  const link=(event.target as Element|null)?.closest<HTMLAnchorElement>('a[data-settings-target]');if(!link)return;event.preventDefault();
  if(openingWorkbench||!workbenchReady()||link.getAttribute('aria-disabled')==='true')return;
  const route=settingsTarget(workbenchTarget(link));if(route===null)return;const origin=serviceUrl,profile=currentProfileId;
  launchFallback.hidden=true;fallbackTarget=null;openingWorkbench=true;workbenchButtons();launchFeedback('正在打开当前服务的管理页…');
  void(async()=>{const result=await chrome.runtime.sendMessage({type:'service.open',target:route});if(origin!==serviceUrl||profile!==currentProfileId)throw new Error('连接已变化，请重新打开。');if(result?.error)throw new Error(result.error);if(result?.unreachable){launchFeedback(unreachableMessage(origin),true);return;}if(!result?.ok)throw new Error('服务未返回有效的管理入口。');const url=serviceSettingsLoginUrl(result.url,origin,route,result.authenticated===true);if(!url)throw new Error('管理页地址与当前服务不一致，已停止跳转。');await openManagementTab(origin,url);launchFeedback(result.authenticated?'已打开当前服务的管理页。':'已打开当前服务的管理页；请使用管理员身份登录。');})()
    .catch(error=>{launchFeedback(reason(error),true);if(origin===serviceUrl&&profile===currentProfileId){fallbackTarget={origin,route,profile};launchFallback.setAttribute('href',origin+'/#'+route);launchFallback.hidden=false;}})
    .finally(()=>{openingWorkbench=false;workbenchButtons();});
});
launchFallback.addEventListener('click',event=>{event.preventDefault();const target=fallbackTarget;if(openingWorkbench||!target||target.origin!==serviceUrl||target.profile!==currentProfileId)return;openingWorkbench=true;workbenchButtons();void openManagementTab(target.origin,target.origin+'/#'+target.route).then(()=>launchFeedback('已打开当前服务的登录页。')).catch(()=>launchFeedback('无法打开管理页，请核对服务地址。',true)).finally(()=>{openingWorkbench=false;workbenchButtons();});});

const updateStrip=document.querySelector<HTMLElement>('#update-strip')!,updateTitle=document.querySelector<HTMLElement>('#update-title')!,updateDetail=document.querySelector<HTMLElement>('#update-detail')!,updateResult=document.querySelector<HTMLElement>('#update-result')!;
const updateButton=document.querySelector<HTMLButtonElement>('#update-button')!,updateFolder=document.querySelector<HTMLButtonElement>('#update-folder')!;
let updating=false,updateVersion='',updateFilesReady=false;
function reportUpdate(text:string,failed=false){updateResult.dataset.error=String(failed);updateResult.textContent=text;}
// 只有服务带的扩展比当前新才显示；更新结束后设置页会被重载关掉，#updated 是后台重新打开的那一页。
async function refreshUpdate(response:{service?:{extensionRelease?:{version:string;versionName:string}};activities?:unknown[]}){
  const release=response.service?.extensionRelease;
  if(!release||!isNewerVersion(release.version,chrome.runtime.getManifest().version)){
    if(globalThis.location?.hash==='#updated'){updateStrip.hidden=false;updateTitle.textContent='已更新到 '+chrome.runtime.getManifest().version_name;updateDetail.textContent='配对和设置都保留了，Agent 重连后就能继续用。';updateButton.hidden=true;}
    else updateStrip.hidden=true;
    return;
  }
  if(updateVersion!==release.version){updateVersion=release.version;updateFilesReady=await filesUpdated(release.version);}
  const busy=!!response.activities?.length,tab=await chrome.tabs.getCurrent();
  updateStrip.hidden=false;updateButton.hidden=false;updateTitle.textContent='有新版本 '+release.versionName;
  updateDetail.textContent=busy?'Agent 正在操作，结束后再更新。':updateFilesReady?'文件已经是新版本，重新加载后生效。Agent 的连接会断开几秒，之后自动重连。':tab?'更新时 Agent 的连接会断开几秒，之后自动重连。第一次要选扩展所在的文件夹，Chrome 会问是否允许编辑，选允许。':'更新时 Agent 的连接会断开几秒，之后自动重连。';
  updateButton.textContent=updateFilesReady?'重新加载':'更新';updateButton.disabled=updating||busy;updateFolder.hidden=!tab||updateFilesReady;
}
updateFolder.addEventListener('click',()=>void chrome.tabs.create({url:'chrome://extensions/?id='+chrome.runtime.id}));
updateButton.addEventListener('click',()=>{
  if(updating)return;updating=true;updateButton.disabled=true;reportUpdate('');
  void(async()=>{
    if(!updateFilesReady){
      // 工具栏弹窗里走不完文件夹选择，换到标签页再点一次。
      if(!await chrome.tabs.getCurrent()){await chrome.tabs.create({url:chrome.runtime.getURL('options.html')});window.close();return;}
      reportUpdate('正在更新…');
      if(!await updateExtension()){reportUpdate('');return;}
    }
    reportUpdate('正在重新加载…');
    const result=await chrome.runtime.sendMessage({type:'extension.update.restart'});
    if(result?.error)throw new Error(String(result.error).replace(/^Error:\s*/,''));
  })().catch(error=>{reportUpdate(reason(error),true);if(error instanceof UpdateError&&error.wrongFolder)updateFolder.hidden=false;}).finally(()=>{updating=false;updateButton.disabled=false;});
});

async function refresh(fill = false) {
  const revision=++refreshRevision;
  const response = await chrome.runtime.sendMessage({ type: 'settings.get' });
  if(revision!==refreshRevision)return;
  const unpaired=response?.status?.state==='unpaired';setup.hidden=!unpaired;workspace.hidden=unpaired;
  const activity = document.querySelector<HTMLElement>('#activity')!, toggle = document.querySelector<HTMLButtonElement>('#pause-toggle')!;
  if (!response?.settings) { status.textContent = '未能读取账号设置，请关闭弹窗后重试。'; status.dataset.state='error';activity.textContent='';toggle.disabled=true;nameAvailable=false;nameView();return; }
  enabled = response.settings.enabled;
  const state = !enabled ? 'paused' : response.error ? 'error' : String(response.status?.state ?? 'unknown');
  const activities = Array.isArray(response.activities) ? response.activities : [];
  activeOperations=activities.length;nameAvailable=true;loadedProfileId=response.settings.profileId;savedName=response.settings.label||'当前浏览器';nameView();
  const paused = response.settings.pausedReason === 'debugging-canceled' ? (response.settings.resumeAt ? '在 Chrome 提示条里取消了调试 · 稍后自动恢复' : '在 Chrome 提示条里取消了调试 · 已暂停所有 Agent') : '已暂停所有 Agent · 可手动使用';
  (document.querySelector('#auto-resume') as HTMLInputElement).checked = response.settings.autoResume === true;
  (document.querySelector('#show-cursor') as HTMLInputElement).checked = response.settings.showCursor !== false;
  (document.querySelector('#human-input') as HTMLInputElement).checked = response.settings.humanInput !== false;
  status.textContent = !enabled ? paused : state === 'connected'
    ? `可供 Agent 使用 · ${activities.length ? `正在执行 ${activities.length} 项操作` : '当前空闲'}`
    : response.status?.message || response.error || '正在确认浏览器连接状态…';
  // 连接出错（握手被拒、服务与扩展版本不一致……）时状态条换成醒目的红色系，不能和“已连接”长得一样；旧后台也是这样返回 state 的。
  status.dataset.state = state;
  document.querySelector('#profile-name')!.textContent=savedName;
  document.querySelector('#browser-scope-note')!.textContent=`改名、暂停和恢复只针对“${savedName}”，不会暂停其他浏览器。`;
  toggle.disabled=false;toggle.textContent = enabled ? '暂停所有 Agent' : '继续连接';
  toggle.setAttribute('aria-label',`${enabled ? '暂停所有' : '恢复'} Agent 对“${savedName}”的使用`);
  activity.textContent = state==='connected' ? activities.map((item: { tabId?: number; operation: string }) => `标签 ${item.tabId ?? '—'} · ${item.operation}`).join('\n') : '';
  document.querySelector('#identity')!.textContent = `配置 ID：${response.settings.profileId}`;
  try{serviceUrl=serviceAddress(response.settings.serviceUrl||'http://127.0.0.1:'+response.settings.port);}catch{serviceUrl='';}
  currentProfileId=response.settings.profileId;
  document.querySelector('#service-address')!.textContent=serviceUrl||'尚未设置服务';
  document.querySelector('#service-connection-state')!.textContent=(state==='connected'?'已连接':state==='paused'?'已暂停':state==='connecting'?'连接中':'未连接')+(serviceUrl?' · '+serviceTransportLabel(serviceUrl):'');
  if(fill||setupActive&&!unpaired)(form.elements.namedItem('serviceUrl') as HTMLInputElement).value=serviceUrl;
  if(unpaired&&!setupActive){if(response.serviceKnown)setupAddress.value=serviceUrl;(setupAddress.value?setupCode:setupAddress).focus();}
  setupActive=unpaired;

  void refreshAgents(response);
  void refreshUpdate(response).catch(()=>{});
  workbenchButtons();
}
const settingsToggle=document.querySelector<HTMLButtonElement>('#settings-toggle')!,settingsPanel=document.querySelector<HTMLElement>('#browser-settings')!;
settingsToggle.addEventListener('click',()=>{settingsPanel.hidden=!settingsPanel.hidden;settingsToggle.setAttribute('aria-expanded',String(!settingsPanel.hidden));});
form.addEventListener('submit',event=>{
  event.preventDefault();void(async()=>{report('',false);const data=new FormData(form),url=String(data.get('serviceUrl')||'').trim(),connectionCode=String(data.get('connectionCode')||'').trim();
    // 和首次连接页一样，只填 IP 和端口也行，协议由 typedAddress 补上；后面都用规范化后的地址。
    const normalized=url?typedAddress(url):'';if(!url&&!connectionCode)throw new Error('请填写服务地址和浏览器配对码。');
    if(connectionCode){const paired=parseBrowserConnection(connectionCode);if(normalized&&normalized!==paired.serviceUrl)throw new Error('服务地址与配对码不一致。');}
    await save({serviceUrl:normalized,...(connectionCode?{connectionCode}:{})});(form.elements.namedItem('connectionCode') as HTMLInputElement).value='';report('连接设置已保存，正在连接服务。',false);await refresh();
  })().catch(error=>report('保存失败：'+reason(error),true));
});

setupOpen.addEventListener('click',()=>{
  setupError(setupOpenResult,'');
  void(async()=>{
    const address=typedAddress(setupAddress.value);setupOpen.disabled=true;
    if(!await reachable(address))throw new Error(unreachableMessage(address));
    await save({serviceUrl:address});await openManagementTab(address,address+'/#accounts');
  })().catch(error=>setupError(setupOpenResult,reason(error))).finally(()=>{setupOpen.disabled=false;});
});
document.querySelector('#setup-form')!.addEventListener('submit',event=>{
  event.preventDefault();setupError(setupResult,'');
  void(async()=>{
    // 配对码里已经带着服务地址，这里不用再核对上面的输入框。
    const code=setupCode.value.trim();if(!code)throw new Error('请先粘贴配对码。');
    parseBrowserConnection(code);
    await save({connectionCode:code});setupCode.value='';await refresh();
  })().catch(error=>setupError(setupResult,reason(error)));
});

document.querySelector('#identity-reset')!.addEventListener('click', () => {
  const button = document.querySelector<HTMLButtonElement>('#identity-reset')!;
  const result = document.querySelector<HTMLElement>('#identity-result')!;
  button.disabled = true;
  void (async () => {
    const current = await chrome.runtime.sendMessage({ type: 'settings.get' });
    if (!current?.settings?.profileId) throw new Error('无法读取当前身份，请稍后重试。');
    if (current.activities?.length) throw new Error('此浏览器还有操作进行中，请等待完成或暂停后再重建身份。');
    const oldId = current.settings.profileId;
    const accepted = window.confirm(`重建“${current.settings.label}”的配置 ID？\n\n当前 ID：${oldId}\n\n此操作会断开并以新身份重新连接。原 ID 绑定的授权、任务和流程不会自动转移；原记录仍保留。\n\n重建后需要为新身份重新配对服务。浏览器名称与网站登录不会改变。`);
    if (!accepted) return;
    const response = await chrome.runtime.sendMessage({ type: 'settings.save', resetIdentity: true, expectedProfileId: oldId });
    if (response?.error || !response?.saved) throw new Error(response?.error || '身份未保存，请检查连接状态。');
    await refresh();
    result.textContent = `已更换身份。原 ID：${oldId}；新 ID：${response.profileId}。请在服务管理页为新身份生成配对信息并检查授权。`;
  })().catch(error => { result.textContent = String(error.message || error); }).finally(() => { button.disabled = false; });
});
for (const [selector, type] of [['#auto-resume', 'settings.autoResume'], ['#show-cursor', 'settings.showCursor'], ['#human-input', 'settings.humanInput']] as const) document.querySelector(selector)!.addEventListener('change', event => {
  const input = event.currentTarget as HTMLInputElement, feedback = document.querySelector<HTMLElement>('#control-result')!; feedback.textContent = '';
  void chrome.runtime.sendMessage({ type, enabled: input.checked }).then(result => { if (result?.error) throw new Error(String(result.error)); return refresh(); })
    .catch(error => { input.checked = !input.checked; feedback.textContent = reason(error); });
});
document.querySelector('#pause-toggle')!.addEventListener('click', () => {
  const next = !enabled,feedback=document.querySelector<HTMLElement>('#control-result')!;feedback.textContent='';
  void save({ enabled: next }).then(() => refresh())
    .catch(error => {feedback.dataset.error='true';feedback.textContent=`${next ? '继续连接' : '暂停'}失败：${reason(error)}`;});
});
void refresh(true);
setInterval(() => void refresh(), 2000);
