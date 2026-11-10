import { profileLabel, needsExtensionRefresh, extensionRefreshInstruction, profileInitial, trialPrompt, canOfferAbandon, lastSeenText, ABANDON_AFTER_HOURS } from './identity.js';

const $ = selector => document.querySelector(selector);
const routes = { overview: '概览', accounts: '浏览器', agents:'Agent 连接', setup: '主机辅助配置', remote: '当前服务', tasks: '任务与流程', workflows: '任务与流程', access: '访问权限', activity: '操作记录' };
const routeName=()=>location.hash.slice(1).split('?')[0];
const copyTimers = new WeakMap();
export async function copyText(value, control) {
  try { await navigator.clipboard.writeText(value); }
  catch {
    const previous=document.activeElement,selection=previous&&'selectionStart' in previous?{start:previous.selectionStart,end:previous.selectionEnd}:null,area=document.createElement('textarea');
    try{area.value=value;area.setAttribute('readonly','');area.style.position='fixed';area.style.opacity='0';document.body.append(area);area.focus();area.select();if(!document.execCommand('copy'))throw new Error();}
    catch{throw new Error('浏览器未允许自动复制，请选中旁边的文字手动复制。');}
    finally{area.remove();if(previous?.isConnected){previous.focus?.();if(selection&&typeof previous.setSelectionRange==='function')previous.setSelectionRange(selection.start,selection.end);}}
  }
  // 原文案只记录一次：1.5 秒内再点时按钮上已经是“已复制”，不能把它当成原文案还原。
  control.dataset.label ??= control.textContent;
  control.textContent = '已复制';
  clearTimeout(copyTimers.get(control));
  copyTimers.set(control, setTimeout(() => { if (control.isConnected) control.textContent = control.dataset.label; }, 1500));
}
/**
 * 页面上所有按钮共用的 el/button/run。
 * run 点击后禁用控件，反馈写进控件所在对话框（没有则写全局状态栏），结束后恢复控件和键盘焦点。
 * 同一控件可能同时有多次运行（会话切换、重复触发）：只有最后结束的那次恢复它，旧请求不能把新请求的忙碌态冲掉；
 * 会话代际变化只影响“是否显示旧请求的错误”，不影响静态按钮的恢复（它们不会被重建）。
 */
export function createControls({ status, revision, authenticated, loginNotice }) {
  const states = new WeakMap();
  function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
  function button(label, action, className = 'secondary', canEnable = () => true) {
    const node = el('button', label, className); node.type = 'button';
    node.addEventListener('click', () => void run(node, () => action(node), canEnable)); return node;
  }
  async function run(control, action, canEnable = () => true) {
    const started = revision(), feedback = control.closest('dialog')?.querySelector('[data-feedback]') || status;
    const state = states.get(control) || { runs: 0, focused: false }; states.set(control, state);
    // 点击时按钮若有焦点，禁用后浏览器会把焦点移到 body；结束时据此还回去。
    state.runs++; state.focused ||= document.activeElement === control;
    control.disabled = true;
    feedback.dataset.error = 'false'; feedback.textContent = '';
    try { await action(); }
    catch (error) {
      if (error.code !== 'STALE_SESSION' && started === revision()) {
        feedback.dataset.error = 'true'; feedback.textContent = error.message;
        // 对话框可能很长，底部按钮的错误不能落在可视区之外。
        if (feedback !== status) feedback.scrollIntoView({ block: 'nearest' });
        if (!authenticated()) { const notice = loginNotice(); notice.textContent = error.message; notice.hidden = false; }
      }
    } finally {
      if (!--state.runs) {
        const wantsFocus = state.focused; state.focused = false;
        if (control.isConnected) {
          control.disabled = !canEnable();
          if (wantsFocus && !control.disabled && (!document.activeElement || document.activeElement === document.body)) control.focus({ preventScroll: true });
        }
      }
    }
  }
  return { el, button, run };
}
/**
 * 对话框关闭后把焦点还给打开它的控件。opener 必须在触发动作的同步阶段取得（button 的 action 会收到被点的节点）：
 * 执行器会立刻禁用被点的按钮，等 await 之后焦点已经丢了，showModal 也就记不到该还给谁。
 * 对话框开着时页面可能被重画（例如在流程版本里“恢复为新版本”会重建整个流程列表），opener 随之脱离文档：
 * 此时改用 replacement() 按稳定标识找回重建后的同一个入口（它也可以返回一个退而求其次的控件）；两者都用不了就不动焦点。
 * 焦点是在 close 事件里还回去的，而 Chromium 在下一个动画帧才派发 dialog 的 close 事件：对话框刚关上的那一刻读到的焦点还不是它。
 */
export function returnFocusOnClose(dialog, opener, replacement) {
  if (!opener && !replacement) return;
  dialog.addEventListener('close', () => { [opener, replacement?.()].find(node => node?.isConnected && !node.disabled)?.focus({ preventScroll: true }); }, { once: true });
}
/**
 * 待核查提示区的重绘依据：只含会改变显示内容的字段（unknown 计数、账号名称、在线状态、最后在线时间、能否放弃、过期状态）。
 * running 随 Agent 的在途操作波动，放进来会让提示区和按钮在每次轮询时被重建，打断键盘焦点和读屏。
 * “能否放弃”随时间变化（离线满 24 小时才提供），所以按服务端的检查时刻 checkedAt 算出来放进依据里，而不是放 checkedAt 本身（它每次轮询都变）。
 * @param {import('./contracts.js').ProtectionSummary | undefined} protection
 * @param {{ id: string; label: string }[]} profiles
 * @param {boolean} stale
 * @param {string} [checkedAt]
 */
export function protectionNoticeKey(protection, profiles, stale, checkedAt) {
  const items = (protection?.profiles || []).filter(item => item.unknown).map(item => [item.profileId, item.unknown, item.online, item.label, item.online === false ? item.lastSeen : undefined, canOfferAbandon(item, checkedAt)]);
  return JSON.stringify([protection?.unknown || 0, items, profiles.map(item => [item.id, item.label]), stale]);
}
export function initializeWorkspace({ el, button, run, onNavigate, onRefresh, onReview, onAbandon, onLock }) {
  let authenticated = false, summary, agents, stale = false, browserKey, choicesKey, protectionKey, current = routes[routeName()] ? routeName() : 'overview';
  function route() {
    current = routes[routeName()] ? routeName() : 'overview';
    for (const view of document.querySelectorAll('[data-view]')) view.hidden = !authenticated || !(view.id === current || ['tasks','workflows'].includes(current) && ['tasks','workflows'].includes(view.id));
    for (const link of document.querySelectorAll('[data-route]')) { const active = link.dataset.route === (current === 'workflows' ? 'tasks' : current); if (active) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current'); }
    if (['tasks','workflows','access','activity'].includes(current)) $('#advanced-nav').open = true;
    $('#view-label').textContent = routes[current];
    if (authenticated) { scrollTo(0, 0); const requested=current; void Promise.resolve(onNavigate(current)).then(()=>{if(requested==='workflows'&&current===requested)$('#workflows').scrollIntoView();}); }
  }
  function auth(value, message = '') {
    authenticated = value; $('#workspace').hidden = !value; $('#login').hidden = value;
    const pending = $('#login').classList.contains('auth-pending');
    $('#login').classList.remove('auth-pending'); $('#auth-opening').hidden = true;
    // 登录页载入时不显示，浏览器第一次绘制若早于这里，autofocus 就落空了：第一次显示时照原生规则补上（焦点还没被别处拿走才补）。
    if (pending && !value && (!document.activeElement || document.activeElement === document.body)) $('#login [autofocus]')?.focus();
    $('#login-message').hidden = !message; $('#login-message').textContent = message;
    if (!value) { for (const view of document.querySelectorAll('[data-view]')) view.hidden = true; scrollTo(0, 0); }
    else route();
  }
  function failure(message) {
    stale = true; $('#connection-alert').hidden = false; $('#connection-message').textContent = message;
    $('#service-state').textContent = '状态暂未更新'; $('#service-state').dataset.state = 'error';
    $('#last-updated').textContent = summary ? '以下为上次读取的状态' : '等待重新连接';
    renderOverview();
  }
  function update(data) {
    summary = data; stale = false; $('#connection-alert').hidden = true;
    $('#service-state').textContent = '服务在线'; $('#service-state').dataset.state = 'connected';
    $('#service-version').textContent = data.version; $('#last-updated').textContent = `${new Date(data.checkedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})} 已更新`;
    $('#extension-path').textContent = data.extensionDir;
    renderOverview();
  }
  function renderOverview() {
    if (!summary) return;
    const profiles = summary.profiles, online = profiles.filter(p => p.online), configured = summary.agents || (agents || []).filter(a => a.connection === 'configured');
    const outdated = online.filter(profile => needsExtensionRefresh(profile, summary.requiredExtensionCapability));
    const usable = online.filter(profile => !needsExtensionRefresh(profile, summary.requiredExtensionCapability));
    const remote = summary.remote, ready = summary.agents ? configured.some(a=>a.connectionState==='connected'||a.connectionState==='recent') : configured.length || remote.state === 'connected';
    const needsReview = !stale && !!summary.protection?.unknown;
    // 有 Agent 真的碰过浏览器（服务端记着上次使用），就不再摆“第一次使用”的试用卡片。
    const experienced = !!summary.agents?.some(a => a.lastUsedAt);
    $('.usage-panel').hidden = experienced;
    $('#overview-title').textContent = stale ? '连接状态需要更新。' : needsReview ? '有操作需要先核查。' : outdated.length ? '浏览器扩展需要更新。' : !profiles.length ? '先连接一个浏览器。' : !online.length ? '打开浏览器，继续连接。' : ready ? '浏览器已就绪。' : '浏览器连好了，接入 Agent 吧。';
    $('#overview-description').textContent = stale ? '先恢复管理页连接，再判断浏览器是否在线。' : needsReview ? '连接与任务记录已保留。请先检查对应浏览器的实际结果，确认后再继续操作。' : outdated.length ? `${outdated.length} 个在线浏览器仍在使用旧扩展。${extensionRefreshInstruction}` : !profiles.length ? '保留你熟悉的登录状态，让 Agent 在你指定的 Chrome 里工作。' : !online.length ? '打开这个 Chrome 会自动连上。扩展重装过的话，到“浏览器”里点“重新连接”。' : ready ? `有 ${online.length} 个浏览器在线。日常任务直接在 Agent 的聊天里提出。` : '为这台电脑上的 Agent 创建独立授权，再把配置导入它。Agent 要和服务在同一台电脑上。';
    const next = $('#overview-next'); next.href = !online.length ? '#accounts' : ready && !experienced ? '#overview' : '#agents'; next.firstChild.textContent = !online.length ? '连接浏览器 ' : !ready ? '接入 Agent ' : experienced ? '查看 Agent 连接 ' : '开始使用 ';
    if (outdated.length) { next.href = '#accounts'; next.firstChild.textContent = '查看扩展更新 '; }
    if (needsReview) { next.href = '#activity'; next.firstChild.textContent = '查看待核查操作 '; }
    next.onclick=event=>{if(needsReview){event.preventDefault();$('#protection-notice').scrollIntoView({block:'center'});$('#protection-notice button')?.focus({preventScroll:true});}else if(!outdated.length&&online.length&&ready&&!experienced){event.preventDefault();$('.usage-panel').scrollIntoView({block:'center'});$('#example-profile').focus({preventScroll:true});}};
    $('#journey-browser').classList.toggle('complete', usable.length > 0 && !outdated.length && !stale); $('#journey-agent').classList.toggle('complete', !!ready && !stale); $('#journey-use').classList.toggle('complete', experienced && !stale);
    $('#journey-browser-state').textContent = `${online.length} 个在线${outdated.length ? ` · ${outdated.length} 个扩展需更新` : ''}${profiles.length > online.length ? ` · ${profiles.length - online.length} 个未连接` : ''}`;
    $('#journey-agent-state').textContent = configured.length ? configured.length+' 个已授权 · '+configured.filter(a=>a.connectionState==='connected').length+' 个已连接' : '创建 Agent 授权并导入配置';
    const root = $('#overview-browsers'), nextBrowserKey=JSON.stringify([profiles.map(p=>[p.id,p.label,p.online,p.capabilities]),summary.requiredExtensionCapability,stale]);
    if(browserKey!==nextBrowserKey){root.replaceChildren();browserKey=nextBrowserKey;
    if (!profiles.length) { const empty = el('div', undefined, 'browser-empty'); empty.append(el('span','＋','empty-symbol'),el('h3','浏览器还没连接'),el('p','连接后，这里会显示你给每个 Chrome 起的名称。')); const link = el('a','连接第一个浏览器 →','text-link'); link.href='#accounts'; empty.append(link); root.append(empty); }
    for (const profile of profiles) {
      const row = el('div',undefined,'browser-summary'), icon = el('span',profileInitial(profile.label),'browser-avatar'), text = el('div'), link = el('a','管理 →','text-link');
      // 带上 profile：浏览器页会把这一个的卡片标出来并滚到眼前，和上面的“管理全部”区分开。
      link.href='#accounts?profile='+encodeURIComponent(profile.id); link.setAttribute('aria-label',`管理 ${profileLabel(profile, profiles)}`);
      const refreshNeeded = needsExtensionRefresh(profile, summary.requiredExtensionCapability);
      text.append(el('h3',profileLabel(profile, profiles)),el('p',stale ? '上次状态，等待更新' : refreshNeeded ? extensionRefreshInstruction : profile.online ? '已连接 · 保留此 Chrome 的登录状态' : '未连接 · 打开原 Chrome 后继续',profile.online && !refreshNeeded && !stale ? 'connected-text' : 'muted')); row.append(icon,text,link); root.append(row);
    }
    }
    const select = $('#example-profile'), previous = select.value, nextChoicesKey=JSON.stringify([profiles.map(p=>[p.id,p.label,p.online,p.capabilities]),summary.requiredExtensionCapability]);
    if(choicesKey!==nextChoicesKey){choicesKey=nextChoicesKey;select.replaceChildren(); const placeholder = el('option',usable.length ? '选择一个已连接的浏览器' : outdated.length ? '更新扩展后可试用' : '连接浏览器后可试用'); placeholder.value=''; select.append(placeholder);
    for (const p of profiles) { const refreshNeeded = needsExtensionRefresh(p,summary.requiredExtensionCapability),option = el('option',profileLabel(p, profiles)+(refreshNeeded?'（扩展需更新）':p.online?'':'（未连接）')); option.value=p.id; option.disabled=!p.online||refreshNeeded; select.append(option); }
    select.value=profiles.some(p=>p.id===previous)?previous:profiles.length===1&&online.length===1?online[0].id:'';}
    select.disabled=!usable.length||stale; updateExample();
    const connections = $('#connection-summary'); connections.replaceChildren();
    const service=el('div');service.append(el('strong','当前服务'),el('span',summary.serviceUrl||location.origin));connections.append(service);
    const agentLink=el('a','查看 Agent 连接与标签页占用 →','text-link');agentLink.href='#agents';connections.append(agentLink);
    connections.append(el('p','浏览器与 Agent 都接入这个服务；已授权不等于正在连接。','muted'));
    const protection = summary.protection, notice = $('#protection-notice');
    notice.hidden = !protection?.unknown;
    const nextProtectionKey = protectionNoticeKey(protection, profiles, stale, summary.checkedAt);
    if (nextProtectionKey !== protectionKey) {
      protectionKey = nextProtectionKey; notice.replaceChildren();
      if (protection?.unknown) {
        notice.append(el('strong', `有 ${protection.unknown} 条操作需要核查`), el('p', '这些操作可能已生效，对应目标暂时受到保护。先检查原页面，再确认结果；不会自动重复执行。'));
        for (const item of protection.profiles.filter(item=>item.unknown)) {
          const profile = profiles.find(p=>p.id===item.profileId), name = profile ? profileLabel(profile, profiles) : item.label ? `${item.label} · ${item.profileId.slice(0, 8)}` : item.profileId;
          const row = el('div', undefined, 'protection-profile'), control = button(`${name} · 核查 ${item.unknown} 条`, ()=>onReview(item.profileId), 'secondary', ()=>!stale);
          control.disabled = stale; row.append(control);
          // 离线的配置要回到原 Chrome 才能核查：说明现状，离线满 24 小时（或根本没有最后在线的记录）才多一个“放弃此配置…”。在线的配置仍只有上面的核查入口。
          if (item.online === false) {
            const offer = canOfferAbandon(item, summary.checkedAt);
            if (offer) { const abandon = button('放弃此配置…', node=>onAbandon(item.profileId, node), 'danger', ()=>!stale); abandon.setAttribute('aria-label', `放弃此配置…（${name}）`); abandon.disabled = stale; row.append(abandon); }
            row.append(el('small', `未连接，${lastSeenText(item, summary.checkedAt)}。${offer ? '如果这个配置已经不存在，可以放弃它的待核查记录；否则请打开原来的 Chrome 继续连接后再核查。' : `请打开原来的 Chrome 继续连接后再核查；超过 ${ABANDON_AFTER_HOURS} 小时没有出现，才可以放弃这个配置。`}`, 'protection-offline'));
          }
          notice.append(row);
        }
      }
    }
  }
  function updateExample() {
    const profile = summary?.profiles.find(p=>p.id===$('#example-profile').value&&p.online);
    const refreshNeeded = profile && needsExtensionRefresh(profile, summary.requiredExtensionCapability);
    const remoteOnly = !summary?.unified && !agents?.some(a=>a.connection==='configured') && summary?.remote.state === 'connected';
    const outsideRemoteScope = profile && remoteOnly && Array.isArray(summary.remote.profiles) && !summary.remote.profiles.includes(profile.id);
    $('#example-prompt').textContent = refreshNeeded ? extensionRefreshInstruction : outsideRemoteScope ? '此浏览器未授权给远程服务器。请到“远程服务器”明确选择允许的浏览器后再使用。' : profile ? trialPrompt(profile) : $('#example-profile').value ? '所选浏览器尚未连接。打开原 Chrome 后继续，这里不会自动切换到其他账号。' : '选择浏览器后，这里会生成可以直接发送给 Agent 的试用指令。';
    $('#copy-example').disabled=!profile||stale||!!outsideRemoteScope||!!refreshNeeded;
    $('#example-note').textContent=refreshNeeded?'刷新后，这里会自动恢复同一个浏览器的试用指令，无需重新配对。':profile?'指令包含所选浏览器的固定 ID，同名或改名时也能确认目标。这个任务只读取页面信息。':'还没有在线浏览器时，先完成左侧连接步骤。';
  }
  $('#example-profile').onchange=updateExample;
  $('#copy-example').onclick=e=>void run(e.currentTarget,()=>copyText($('#example-prompt').textContent,e.currentTarget),()=>{updateExample();return !$('#copy-example').disabled;});
  $('#copy-extension').onclick=e=>void run(e.currentTarget,()=>copyText(summary.extensionDir,e.currentTarget));
  for(const control of document.querySelectorAll('[data-copy]'))control.onclick=e=>void run(e.currentTarget,()=>copyText(control.dataset.copy,e.currentTarget));
  for(const id of ['refresh-all','retry-connection'])$('#'+id).onclick=e=>void run(e.currentTarget,onRefresh);
  $('#lock-dashboard').onclick=onLock;
  addEventListener('hashchange',route);
  return {auth,update,failure,active:()=>authenticated?current:null,setAgents(data){agents=data;renderOverview();},setRemote(data){if(summary){summary={...summary,remote:data};renderOverview();}}};
}
