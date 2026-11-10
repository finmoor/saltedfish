import { initializeProduct } from './product.js';
import {initializeConnections} from './connections.js';
import { initializeWorkspace, createControls, copyText } from './workspace.js';
import { initializeActivity } from './activity.js';
import { initializeAgents } from './agents.js';
import { profileLabel, needsExtensionRefresh, extensionRefreshInstruction, extensionUpdateInstruction, accessScopeLabel } from './identity.js';
import { desktopSettingsHref, managementReturnTarget, settingsTarget } from './desktop-link.js';
import {randomId} from './random-id.js';
// 管理页只在 sessionStorage 里保留有期限、可撤销、服务重启即失效的会话令牌；长期管理员密钥和一次性登录码都只用来换会话，不落盘。
// 刷新页面不丢登录（会话令牌还在），退出或过期后可用本机应用入口重新打开；命令登录保留作备用方式。
const SESSION_KEY = 'chrome-mcp-session', LEGACY_KEY = 'chrome-mcp-token';
const storage = {
  get(key) { try { return sessionStorage.getItem(key) || ''; } catch { return ''; } },
  set(key, value) { try { sessionStorage.setItem(key, value); } catch { /* 无痕或禁用存储时只在当前页面内存里保持登录。 */ } },
  remove(key) { try { sessionStorage.removeItem(key); } catch { /* 同上。 */ } },
};
function takeLoginLink() {
  const value = location.hash.slice(1); if (!/^[a-f0-9]{64}$/.test(value)) return '';
  history.replaceState(null, '', location.pathname + '#' + managementReturnTarget(location.search)); return value;
}
let credential = takeLoginLink();
// 在已打开的页面粘贴链接不会重新加载，只触发 hashchange。要排在 workspace 的路由监听之前，地址里的登录码才不会被当成页面。
addEventListener('hashchange', () => { const secret = takeLoginLink(); if (secret && !authenticated) loginWith(secret, document.querySelector('#connect')); });
// 旧版把长期管理员密钥放在这里：换成会话后立即删除，页面脚本不再能读到它。
const legacyCredential = storage.get(LEGACY_KEY); storage.remove(LEGACY_KEY);
if (!credential && /^[a-f0-9]{64}$/.test(legacyCredential)) credential = legacyCredential;
let token = credential ? '' : storage.get(SESSION_KEY);
const owner = `dashboard:${randomId()}`;
const status = document.querySelector('#status');
const profilesRoot = document.querySelector('#profiles');
let profiles = [];
let requiredExtensionCapability, extensionRelease;
let newConfiguration;
let productUI;
let connectionsUI;
let activityUI;
let agentsUI;
let workspace, authenticated = false, rendering, renderRevision, renderForce = false, sessionRevision=0, profileSignature = '', checkedAt;
const { el, button, run } = createControls({ status, revision: () => sessionRevision, authenticated: () => authenticated, loginNotice: () => document.querySelector('#login-message') });
function disconnect(message = '', revoke = false) {
  if (revoke && token) void fetch('/session', { method: 'DELETE', headers: { authorization: `Bearer ${token}` }, keepalive: true }).catch(() => {});
  sessionRevision++; authenticated = false; token = ''; storage.remove(SESSION_KEY); storage.remove(LEGACY_KEY);productUI?.reset();connectionsUI?.reset();activityUI?.reset();agentsUI?.reset();newConfiguration=undefined;
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  document.querySelector('#client-created').hidden = true;
  workspace.auth(false, message); void checkService();
}
async function signIn(secret) {
  let response;
  try { response = await fetch('/session', { method: 'POST', signal: AbortSignal.timeout(8000), headers: { authorization: `Bearer ${secret}` } }); }
  catch { throw new Error('暂时无法访问服务。确认 SaltedFish 正在运行，然后重试。'); }
  if (!response.ok) throw new Error(response.status === 401 ? '登录码不对或已失效，重新运行上面的命令拿一个新的。用管理员密钥登录时，请检查密钥。' : `登录未完成（HTTP ${response.status}）。`);
  const session = await response.json();
  token = session.token; storage.set(SESSION_KEY, token);
}
let healthRevision=0,desktopLaunch=false,desktopAvailable;
function updateDesktopLaunch(){
  const target=settingsTarget(location.hash.slice(1)||'overview'),href=target===null?'':desktopSettingsHref(Number(location.port),target),available=desktopLaunch&&!!href;
  const section=document.querySelector('#desktop-login'),link=document.querySelector('#open-desktop-settings'),alternative=document.querySelector('#login-command-alternative');
  section.hidden=!available;alternative.querySelector('summary').hidden=!available;
  if(available)link.setAttribute('href',href);else link.removeAttribute('href');
  if(available!==desktopAvailable){alternative.open=!available;document.querySelector('#desktop-login-status').textContent='';desktopAvailable=available;}
}
async function checkService() {
  const revision=++healthRevision,output=document.querySelector('#login-service'),control=document.querySelector('#check-login-service');
  control.disabled=true;output.dataset.state='checking';
  try {
    const response = await fetch('/health', { signal: AbortSignal.timeout(4000),cache:'no-store' }); if (!response.ok) throw new Error(); const data = await response.json();
    if(revision!==healthRevision)return;output.dataset.state='connected';output.textContent=`服务运行中 · ${data.version}`;desktopLaunch=data.desktopLaunch===true;updateDesktopLaunch();
  }catch{if(revision===healthRevision){output.dataset.state='error';output.textContent='暂时无法连接服务，请确认 SaltedFish 正在运行后重试。';desktopLaunch=false;updateDesktopLaunch();}}
  finally{if(revision===healthRevision)control.disabled=false;}
}
// Windows 安装包的命令直接打开已登录的页面，不打印登录码。
function loginNextStep(){
  const native=document.querySelector('#login-native').getAttribute('aria-pressed')==='true';
  document.querySelector('#login-next-step').textContent=native?'命令会在这台电脑的浏览器里打开已登录的管理页。配对码不能用来登录。':'命令会给出一个登录链接和 4 位登录码。在当前浏览器打开链接，或者在这里输入登录码。配对码不能用来登录。';
  document.querySelector('#login-code-form').hidden=native;
}
function loginDestination(){
  const names={remote:'当前服务',agents:'Agent 连接',accounts:'浏览器',setup:'主机辅助配置',tasks:'任务与流程',workflows:'任务与流程',access:'访问权限',activity:'操作记录'};
  const route=location.hash.slice(1).split('?')[0],name=Object.hasOwn(names,route)?names[route]:undefined;
  document.querySelector('#login-target').textContent=name?`本次要设置：${name}`:'本次要打开：管理概览';
  document.querySelector('#login-description').textContent='当前管理页属于 '+location.origin+'。获准管理的Chrome可从扩展直接进入；首次登录按下面两步。';
  loginNextStep();
  updateDesktopLaunch();
}
function loginMethod(method){
  const native=method==='native';
  document.querySelector('#login-native').setAttribute('aria-pressed',String(native));document.querySelector('#login-npm').setAttribute('aria-pressed',String(!native));
  const command=native?'.\\SaltedFish.exe dashboard':'saltedfish dashboard',button=document.querySelector('#copy-login-command');
  document.querySelector('#login-command').textContent=command;button.dataset.copy=command;button.textContent='复制命令';button.dataset.label='复制命令';
  document.querySelector('#login-instruction').textContent=native?'在服务所在电脑的 SaltedFish 安装文件夹中打开 PowerShell，粘贴下面命令并按 Enter。':'在服务所在电脑打开安装了 SaltedFish 的终端，粘贴下面命令并按 Enter。';
  document.querySelector('#login-copy-status').textContent='';loginNextStep();
}
async function request(route, method = 'GET', value, binary = false) {
  const revision=sessionRevision,ensureCurrent=()=>{if(revision!==sessionRevision){const error=new Error('连接已变化，已忽略旧请求的返回。');error.code='STALE_SESSION';throw error;}};
  let response;
  try { response = await fetch(route, { method, signal: AbortSignal.timeout(route==='/dashboard'?6000:45000), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) }); }
  catch { ensureCurrent(); throw new Error('暂时无法访问服务。确认 SaltedFish 正在运行，然后重试。'); }
  ensureCurrent();
  if (!response.ok) { const failure = await response.json().catch(() => ({}));ensureCurrent(); const message = response.status === 401 ? '管理页登录已失效或密钥不正确。请重新打开管理页，浏览器连接不会因此被清除。' : failure.error?.message || `请求未完成（HTTP ${response.status}）。`; if (response.status === 401 || response.status === 403 && route === '/dashboard') disconnect(message); throw Object.assign(new Error(message), typeof failure.error?.code === 'string' ? { code: failure.error.code } : {}); }
  const result=binary?await response.blob():await response.json();ensureCurrent();return binary?URL.createObjectURL(result):result;
}
async function call(name, args = {}) {
  const result = await request('/rpc', 'POST', { name, args, owner });
  if (!result.ok) throw Object.assign(new Error(result.error.message), typeof result.error.code === 'string' ? { code: result.error.code } : {});
  if (result.data?.saved && result.data.artifactId) {
    let text = '', offset = 0;
    do { const page = await request('/rpc', 'POST', { name: 'chrome_read_result', args: { artifactId: result.data.artifactId, offset, limit: 100000 }, owner }); if (!page.ok) throw new Error(page.error.message); text += page.data.text; offset = page.data.nextOffset; if (text.length > 4000000) throw new Error('结果太大，请缩小查询范围。'); } while (offset !== null);
    return JSON.parse(text);
  }
  return result.data;
}
function table(headers) {
  const node = el('table'); const head = el('thead'); const row = el('tr');
  for (const text of headers) row.append(el('th', text)); head.append(row); node.append(head);
  const body = el('tbody'); node.append(body); return { node, body };
}
async function loadTabs(profile, article) {
  const data = await call('chrome_tabs', { profileId: profile.id, limit: 1000 });
  article.querySelector('table')?.remove();
  const list = table(['窗口 / 标签', '页面', '操作']);
  for (const tab of data.items) {
    const row = el('tr'), page = el('td'), actions = el('td');
    page.append(el('div', tab.title || '(无标题)'), el('div', tab.url || '', 'url'));
    actions.append(button('定位窗口', () => call('chrome_focus_tab', { profileId: profile.id, tabId: tab.tabId })));
    row.append(el('td', `${tab.windowId} / ${tab.tabId}`), page, actions); list.body.append(row);
  }
  article.append(list.node);
}
// 没有待核查记录的离线浏览器确认一下就能移除；有记录的走放弃对话框，核对数量。
async function removeProfile(profile, opener) {
  const preview = await request('/profiles/abandon?profileId=' + encodeURIComponent(profile.id));
  if (preview.unknown) return activityUI.abandon(profile.id, opener);
  if (!confirm(`移除“${profile.label}”？它的配对会作废，以后要用得重新配对。Chrome 里的登录和数据不受影响。`)) return;
  await request('/profiles/abandon', 'POST', { profileId: profile.id, expectedUnknown: 0, confirm: true }); await render(true);
}
// 概览里单个浏览器的“管理”链接带着 #accounts?profile=…：标出那一张卡片，换到别的链接或重画后按地址重新标。
function markLinkedProfile() {
  const id = new URLSearchParams(location.hash.slice(1).split('?')[1] || '').get('profile'); let target;
  for (const card of profilesRoot.querySelectorAll('.profile-card')) {
    const on = !!id && card.dataset.profileId === id; card.classList.toggle('targeted', on);
    // 只给标出的那张加 tabindex，键盘用户落在它上面；别的卡片点空白处不该抢走焦点。
    if (on) { card.setAttribute('tabindex', '-1'); target = card; } else card.removeAttribute('tabindex');
  }
  return target;
}
async function renderProfiles() {
  profilesRoot.replaceChildren();
  for (const select of [document.querySelector('#client-profile'), document.querySelector('#activity-profile')]) {
    const previous = select.value; select.replaceChildren();
    const option = el('option', select.id === 'client-profile' ? '所有已配对账号' : '选择浏览器'); option.value = select.id === 'client-profile' ? '*' : ''; select.append(option);
    for (const profile of profiles) { const option = el('option', profileLabel(profile, profiles)); option.value = profile.id; select.append(option); }
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
  }
  document.querySelector('#add-browser > summary').textContent=profiles.length?'＋ 连接另一个 Chrome':'连接第一个 Chrome';
  if (!profiles.length) { profilesRoot.append(el('p', '还没有浏览器连接。按下面三个步骤接入你的第一个 Chrome。', 'empty')); document.querySelector('#add-browser').open = true; }
  for (const profile of profiles) {
    // 文件已是新版、后台还在跑旧代码时，缺的能力是没换上，不是没更新：先让用户重新加载。
    const reloadNeeded = !!(profile.online && profile.extensionReload), refreshNeeded = !reloadNeeded && needsExtensionRefresh(profile, requiredExtensionCapability);
    const article = el('article',undefined,'profile-card'), heading = el('div', undefined, 'profile-heading'), title = el('h3', profileLabel(profile, profiles));
    article.dataset.profileId = profile.id;
    title.append(el('span', reloadNeeded ? '扩展需要重新加载' : refreshNeeded ? '扩展需要更新' : profile.online ? '已连接' : '未连接', profile.online && !refreshNeeded && !reloadNeeded ? 'badge' : 'badge offline'));
    const actions = el('div', undefined, 'row-actions');
    if (!profile.online) actions.append(button('重新连接', async () => { await connectionsUI.reconnect(profile); await renderProfiles(); document.querySelector('.reconnect-panel button')?.focus(); }));
    actions.append(button('改名', async () => { const label = prompt('这个浏览器叫什么？例如：个人、工作', profile.label); if (label) { await call('chrome_rename_profile', { profileId: profile.id, label }); await render(true); } }));
    if (profile.online) actions.append(button('查看标签页', () => loadTabs(profile, article)));
    if (profile.online && profile.capabilities?.includes('pause-control')) actions.append(button('暂停控制', async () => { await call('chrome_pause_profile', { profileId: profile.id }); status.textContent = '此浏览器已暂停。需要继续时，在它的 SaltedFish 扩展中点击继续连接。'; await render(true); }, 'danger'));
    else if (profile.online) actions.append(el('small', '新功能需更新扩展'));
    if (!profile.online) actions.append(button('移除…', node => removeProfile(profile, node), 'danger'));
    heading.append(title, actions); const info = el('details'); info.append(el('summary','连接详情'),el('p',`配置 ID：${profile.id} · 扩展 ${profile.version}`,'identity'));
    article.append(heading,el('p',reloadNeeded ? profile.extensionReload : refreshNeeded ? extensionRefreshInstruction : extensionUpdateInstruction(profile, extensionRelease) || (profile.online ? 'Agent 会使用这个 Chrome 配置现有的登录状态。' : '打开这个 Chrome 会自动连上。连不上或扩展重装过，点“重新连接”。'),'profile-description'),info); const panel = connectionsUI.reconnectPanel(profile); if (panel) article.append(panel); profilesRoot.append(article);
  }
  markLinkedProfile();
}
async function renderClients() {
  const root = document.querySelector('#clients');
  try {
    const data = await request('/clients'); root.replaceChildren();
    if (!data.clients.length) root.append(el('p', '还没有客户端授权。', 'empty'));
    for (const client of data.clients) {
      const row = el('div', undefined, 'client-row'), name = el('div', client.label);
      name.append(el('div', client.revoked ? '已撤销' : client.readOnly ? '只读' : '允许操作', 'state'));
      row.append(name, el('small', accessScopeLabel(client.profiles, profiles)));
      if (!client.revoked) row.append(button('撤销授权', async () => { await request(`/clients/${client.id}`, 'DELETE'); await renderClients(); status.textContent = `${client.label} 的后续调用已停用。`; }, 'danger'));
      root.append(row);
    }
  } catch (error) { root.replaceChildren(el('p', `暂时无法读取访问权限。${error.message}`, 'empty')); }
}
async function renderOperations() {
  return activityUI.load();
}
async function activate(route) {
  if (!authenticated) return;
  try { if(route==='agents')await agentsUI.activate();else if(route==='accounts'){const card=markLinkedProfile();if(card){card.scrollIntoView({block:'center'});card.focus({preventScroll:true});}await connectionsUI.refresh();}else if (route === 'access') await renderClients(); else if (route === 'activity') { if(document.querySelector('#activity-profile').value)await renderOperations(); } else if (['tasks','workflows','setup'].includes(route)) await productUI.activate(route); }
  catch(error) { if(error.code!=='STALE_SESSION'){status.textContent=error.message; status.dataset.error='true';} }
}
async function render(force = false) {
  if (!token) { workspace.auth(false); void checkService(); return; }
  const revision=sessionRevision,sessionToken=token;
  if (rendering&&renderRevision===revision) {
    const pending = rendering, needsDetection = force && !renderForce;
    await pending;
    if (needsDetection && revision === sessionRevision && authenticated && workspace.active()==='setup') await productUI.ensureClients(true);
    return;
  }
  renderRevision=revision;
  renderForce=force;
  rendering = (async()=>{
    try {
      const data = await request('/dashboard'), nextProfileSignature = JSON.stringify([data.profiles, data.requiredExtensionCapability, data.extensionRelease]), changed = profileSignature !== nextProfileSignature;
      if(revision!==sessionRevision)return;
      profiles = data.profiles; requiredExtensionCapability = data.requiredExtensionCapability; extensionRelease = data.extensionRelease; profileSignature = nextProfileSignature; checkedAt = data.checkedAt;
      if (changed || force) await renderProfiles();
      if(revision!==sessionRevision)return;
      workspace.update(data);connectionsUI.update(data);
      const first = !authenticated; authenticated = true; storage.set(SESSION_KEY, sessionToken);
      if (first) workspace.auth(true);
      if (changed || force || first) await productUI.refreshProfiles();
      if ((first || force)&&workspace.active()==='setup') await productUI.ensureClients(force);
      if(workspace.active()==='accounts')await connectionsUI.refresh();
      agentsUI.profiles();if(workspace.active()==='agents')await agentsUI.refresh(force);
    } catch (error) { if(revision===sessionRevision){if(authenticated) workspace.failure(error.message); else {workspace.auth(false,error.message);void checkService();}} }
    finally { if(renderRevision===revision)rendering = undefined; }
  })(); return rendering;
}
function loginWith(secret, control) { sessionRevision++; token = ''; void run(control, async () => { await signIn(secret); await render(true); }); }
document.querySelector('#login-form').onsubmit = event => { event.preventDefault(); const secret = document.querySelector('#token').value.trim(); document.querySelector('#token').value = ''; loginWith(secret, document.querySelector('#connect')); };
document.querySelector('#login-code-form').onsubmit = event => {
  event.preventDefault(); const field = document.querySelector('#login-code'), secret = field.value.normalize('NFKC').replace(/\s/g, '').toUpperCase();
  // 看错字母不值得用掉一次尝试：这些字符根本不会出现在登录码里。
  if (!/^[2-9A-HJKMNP-Z]{4}$/.test(secret)) { workspace.auth(false, '登录码是 4 位字母和数字，再核对一下。'); return; }
  field.value = ''; loginWith(secret, document.querySelector('#login-code-submit'));
};
document.querySelector('#refresh').onclick = event => void run(event.currentTarget, () => render(true));
document.querySelector('#client-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  void run(form.querySelector('button[type=submit]'), async () => {
    const profileId = document.querySelector('#client-profile').value;
    const created = await request('/clients', 'POST', { label: document.querySelector('#client-label').value.trim(), profiles: profileId === '*' ? '*' : [profileId], readOnly: document.querySelector('#client-readonly').checked });
    newConfiguration = created.httpConfiguration||created.configuration; document.querySelector('#client-created').hidden = false;
    await renderClients(); status.textContent = '客户端授权已创建。';
  });
});
document.querySelector('#download-config').onclick = () => {
  if (!newConfiguration) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(newConfiguration, null, 2)], { type: 'application/json' }));
  const link = el('a'); link.href = url; link.download = 'saltedfish-mcp-config.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
// 放弃配置之后要立刻看到最新状态。若放弃时恰好有一次轮询在途，它读到的是放弃之前的数据（render 会直接等它结束），所以等它结束后再读一次。
async function renderAfterChange() { const inflight = rendering; await render(false); if (inflight) await render(false); }
activityUI = initializeActivity({call,request,el,button,run,status,getProfiles:()=>profiles,getCheckedAt:()=>checkedAt,onRecovered:()=>render(false),onAbandoned:renderAfterChange});
workspace = initializeWorkspace({el,button,run,onNavigate:activate,onRefresh:()=>render(true),onReview:profileId=>activityUI.open(profileId),onAbandon:(profileId,opener)=>activityUI.abandon(profileId,opener),onLock:()=>disconnect('已退出管理页。浏览器和 Agent 的连接保持不变。', true)});
productUI = initializeProduct({ call, request, el, button, run, status, getProfiles: () => profiles, onReview:profileId=>activityUI.open(profileId), isActive:()=>workspace.active(), onClients:data=>workspace.setAgents(data) });
connectionsUI=initializeConnections({request,el,button,run,status,getProfiles:()=>profiles});
agentsUI = initializeAgents({request,el,run,getProfiles:()=>profiles,isActive:()=>workspace.active()==='agents'});
document.querySelector('#login-native').onclick=()=>loginMethod('native');document.querySelector('#login-npm').onclick=()=>loginMethod('npm');
document.querySelector('#check-login-service').onclick=()=>void checkService();
document.querySelector('#open-desktop-settings').onclick=event=>{if(!event.currentTarget.getAttribute('href')){event.preventDefault();return;}document.querySelector('#desktop-login-status').textContent='请允许浏览器打开 SaltedFish，然后在应用打开的新页面继续。';};
document.querySelector('#copy-login-command').onclick=event=>{
  const control=event.currentTarget,command=control.dataset.copy;
  void run(control,async()=>{await copyText(command,control);if(control.dataset.copy===command)document.querySelector('#login-copy-status').textContent=command.startsWith('.\\')?'已复制。请在 SaltedFish 安装文件夹的 PowerShell 中粘贴并回车。':'已复制。请在终端粘贴并回车。';else control.textContent='复制命令';});
};
loginMethod('npm');loginDestination();
addEventListener('hashchange',()=>{loginDestination();if(!authenticated)void checkService();});
addEventListener('focus',()=>{if(!authenticated)void checkService();});
let startupError = '';
if (credential) { try { await signIn(credential); } catch (error) { startupError = error.message; } credential = ''; }
if (startupError) { workspace.auth(false, startupError); void checkService(); } else await render(true);
setInterval(()=>{if(authenticated&&!document.hidden)void render(false);},5000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden){if(authenticated)void render(false);else void checkService();}});
