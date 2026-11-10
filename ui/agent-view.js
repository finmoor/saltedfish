/** 客户端启动时 MCP 就连上了，所以有会话只算待命，“使用中”只看实际操作。 */
export function agentConnection(agent) {
  if (agent.connectionState === 'unavailable') return { label: '状态未知', tone: 'unavailable', detail: '暂时无法确认这个远程 Agent 的状态。' };
  if (working(agent)) return { label: '使用中', tone: 'active', detail: agent.activeOperations > 0 ? `${agent.activeOperations} 个操作正在执行。` : '占用着标签页，或刚操作过这个浏览器。' };
  if (agent.connectionState === 'connected') return { label: '待命', tone: 'standby', detail: '客户端连着，现在没有操作这个浏览器。' };
  return { label: '未连接', tone: 'disconnected', detail: '有访问授权，现在没有连接。' };
}
const working = agent => agent.working ?? agent.activeOperations > 0;
const moment = value => { const time = new Date(value); return Number.isNaN(time.getTime()) ? '' : time.toLocaleString('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}); };
export function agentLastUsed(agent) {
  if (agent.lastUsedAt) return `上次使用 ${moment(agent.lastUsedAt)}`;
  return agent.sessions ? '还没用过这个浏览器' : '';
}
export function groupState(group) {
  if (!group.online) return { label: '已断开', tone: 'disconnected', detail: '这条会话已经结束，标签组很快会解散，标签页留着。' };
  return group.working ? { label: '使用中', tone: 'active', detail: '正在操作这个标签组，或刚操作过。' } : { label: '待命', tone: 'standby', detail: '会话连着，现在没有操作。' };
}
export function sortAgents(agents,unified=false) {
  const rank=agent=>working(agent)?4:agent.connectionState==='connected'?3:agent.connectionState==='recent'?2:agent.connectionState==='disconnected'?1:0;
  return [...agents].sort((a,b)=>rank(b)-rank(a)||(unified?0:a.location.localeCompare(b.location))||a.label.localeCompare(b.label));
}
const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
function usableAddress(value) {
  if (typeof value !== 'string') return undefined;
  let address = value.trim().toLowerCase();
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  if (address.includes(':')) {
    if (!/^[0-9a-f:.]+$/.test(address)) return undefined;
    try { address = new URL(`http://[${address}]/`).hostname.slice(1, -1); } catch { return undefined; }
    const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(address);
    if (mapped) {
      const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
      return usableAddress([high >>> 8, high & 255, low >>> 8, low & 255].join('.'));
    }
    if (address === '::' || address === '::1' || (parseInt(address.split(':')[0], 16) & 0xffc0) === 0xfe80) return undefined;
    return { address, family: 6 };
  }
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return undefined;
  const octets = parts.map(Number);
  if (octets[0] === 0 || octets[0] === 127 || octets[0] === 169 && octets[1] === 254) return undefined;
  return { address: octets.join('.'), family: 4 };
}
function compactSourceAddress(source, preferredAddress) {
  const candidates = (Array.isArray(source.reportedAddresses) ? source.reportedAddresses : [])
    .map(value => ({ value, parsed: usableAddress(value) })).filter(item => item.parsed);
  // 来源和网关地址只能用于匹配该电脑实际登记过的地址，不能直接冒充 Agent IP。
  for (const preferred of [source.peerAddress, preferredAddress]) {
    const parsed = usableAddress(preferred), match = parsed && candidates.find(item => item.parsed.address === parsed.address);
    if (match) return match.value;
  }
  return (candidates.find(item => item.parsed.family === 4) || candidates[0])?.value;
}
export function agentCard(agent, options = {}) {
  const card = node('article', undefined, `agent-card${options.compact ? ' agent-compact' : ''}`); card.dataset.agentId = agent.id;
  const initial = (Array.from(agent.label || 'A')[0] || 'A').toUpperCase();
  const clientMark = /opencode/i.test(agent.label) ? 'OC' : /codex/i.test(agent.label) ? 'CX' : /claude/i.test(agent.label) ? 'CL' : initial;
  const identity = node('div', undefined, 'agent-identity'), name = node(options.compact ? 'h4' : 'h3', agent.label || '未命名 Agent'), mark = node('span', options.compact ? clientMark : initial, 'agent-avatar');
  mark.setAttribute('aria-hidden','true');
  const text = node('div'); text.append(name); const badges = node('div', undefined, 'agent-badges');
  if(!options.unified)badges.append(node('span', agent.location === 'remote' ? '远程' : '本机', `agent-source ${agent.location === 'remote' ? 'remote' : 'local'}`));
  badges.append(node('span', agent.readOnly ? '只读' : '允许操作', 'agent-permission'));
  text.append(badges);
  if(options.unified||agent.location==='remote'){
    const groups=new Map();
    for(const source of (Array.isArray(agent.sources)?agent.sources:[]).slice(0,8)){
      // 合并相同登记/来源的重复会话，只称“来源记录”，不据同一IP断言是同一台电脑。
      const addresses=Array.isArray(source.reportedAddresses)?source.reportedAddresses:[];
      const key=JSON.stringify([source.hostname||'',source.reportId||'',source.reportSource||'',options.compact?[...addresses].sort():source.reportedAddresses||[],source.peerAddress||'']),previous=groups.get(key);
      groups.set(key,{...source,connected:source.connected||previous?.connected,records:(previous?.records||0)+1});
    }
    const sources=[...groups.entries()],machines=node('div',undefined,'agent-machines');machines.setAttribute('aria-label','Agent 接入电脑');
    if(!sources.length&&agent.sessions?.some(session=>session.local))machines.append(node('span','在服务这台电脑上','agent-machine-unknown'));
    for(const [sourceKey,source] of sources.slice(0,8)){
      const line=node('div',undefined,'agent-machine');
      line.append(node('span',source.hostname||'机器名未上报','agent-machine-name'));
      const addresses=Array.isArray(source.reportedAddresses)?source.reportedAddresses:[];
      const evidence=[source.reportSource==='setup_report'?'接入时登记':source.reportSource==='runtime_report'?'连接时上报':'',agent.connectionState==='unavailable'?'来源状态暂不可确认':!source.connected?'上次接入':'',source.records>1?`${source.records} 条来源记录`:''].filter(Boolean).join(' · ');
      if(options.compact){
        const selected=compactSourceAddress(source,options.preferredAddress);
        line.append(node('span',selected?`登记 IP：${selected}`:addresses.length?'暂无可展示的登记 IP':'登记 IP 未上报','agent-machine-address'));
        const details=node('details',undefined,'agent-machine-details');details.dataset.sourceKey=JSON.stringify([agent.id,sourceKey]);
        details.append(node('summary','来源详情'));
        const content=node('div',undefined,'agent-machine-detail-content');
        content.append(node('span',addresses.length?`全部登记 IP：${addresses.join(' · ')}`:'登记 IP 未上报','agent-machine-addresses'));
        if(source.peerAddress)content.append(node('span',`服务观察到的连接来源 IP：${source.peerAddress}`,'agent-machine-peer'));
        if(evidence)content.append(node('span',evidence,'agent-machine-evidence'));
        content.append(node('span','登记地址由客户端报告；默认展示一个地址，不表示唯一 IP 或主网卡。','agent-machine-note'));
        details.append(content);line.append(details);
      }else{
        const addressText=addresses.length?`${source.reportSource==='setup_report'?'登记 IP':'上报 IP'}：${addresses.join(' · ')}`:source.peerAddress?`连接来源 IP：${source.peerAddress}`:'IP 未上报';
        const address=node('span',addressText,'agent-machine-address');
        if(source.peerAddress&&addresses.length)address.title=`服务观察到的连接来源 IP：${source.peerAddress}；登记地址由客户端所在电脑上报。`;
        line.append(address);
        if(evidence)line.append(node('span',evidence,'agent-machine-evidence'));
      }
      machines.append(line);
    }
    if(machines.children.length)text.append(machines);
  }
  if(agent.sessions?.length){
    const details=node('details',undefined,'agent-machine-details agent-sessions');details.dataset.sourceKey=JSON.stringify([agent.id,'sessions']);
    details.append(node('summary','会话详情'));
    const content=node('div',undefined,'agent-machine-detail-content');
    for(const session of agent.sessions)content.append(node('span',[`会话 ${session.id}`,sessionClient(session),`${moment(session.since)} 连接`].filter(Boolean).join(' · ')));
    details.append(content);text.append(details);
  }
  identity.append(mark, text);
  const connection = agentConnection(agent), state = node('div', undefined, 'agent-connection'), badge = node('span', connection.label, `agent-state ${connection.tone}`); badge.title = connection.detail;
  state.append(badge);
  const count = Number(agent.sessionCount) || 0;
  const usage = [count ? `${count} 个会话` : '', agentLastUsed(agent)].filter(Boolean).join(' · ');
  if (usage) state.append(node('small', usage));
  const work = node('div', undefined, 'agent-work'); const tabs = Array.isArray(agent.tabs) ? agent.tabs : [];
  if (!tabs.length && agent.activeOperations > 0) work.append(node('span', '正在执行浏览器操作', 'agent-work-empty'));
  for (const tab of tabs.slice(0, 8)) {
    const line = node('div', undefined, 'agent-tab'), label = options.tabTitles?.get(`${tab.profileId}:${tab.tabId}`) || `标签 ${tab.tabId}`;
    const profile = !options.currentProfileId && options.profileNames?.get(tab.profileId);
    line.append(node('span', `${profile ? `${profile} · ` : ''}${label}`, 'agent-tab-title'));
    const expires=tab.leaseExpiresAt?new Date(tab.leaseExpiresAt):undefined;
    line.append(node('small', [tab.claimed ? '已占用' : '执行中', tab.operation ? operationLabel(tab.operation) : '',expires&&!Number.isNaN(expires.getTime())?`占用至 ${expires.toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit',hour12:false})}`:''].filter(Boolean).join(' · '))); work.append(line);
  }
  if (tabs.length > 8) work.append(node('small', `另有 ${tabs.length - 8} 个标签页`));
  card.append(identity, state); if (work.children.length) card.append(work); return card;
}
const sessionClient = session => [session?.client, session?.version].filter(Boolean).join(' ');
function groupButton(label, title, action) {
  const button = node('button', label, 'secondary'); button.type = 'button'; button.title = title; button.addEventListener('click', () => action(button)); return button;
}
/** Agent 操作时卡片会频繁重建，键盘焦点要留在原来的按钮上。 */
export function replaceGroupCards(container, cards) {
  const active = document.activeElement, card = active?.closest?.('[data-group-id]'), index = card ? [...card.querySelectorAll('button')].indexOf(active) : -1;
  container.replaceChildren(...cards);
  if (index >= 0) cards.find(item => item.dataset.groupId === card.dataset.groupId)?.querySelectorAll('button')[index]?.focus({ preventScroll: true });
}
/** 标签组是 Agent 在浏览器里的工作范围：谁在用、连没连着、开了哪些标签页。 */
export function groupCard(group, options = {}) {
  const card = node('article', undefined, 'agent-card agent-compact group-card'); card.dataset.groupId = String(group.groupId);
  const identity = node('div', undefined, 'group-identity'), dot = node('span', undefined, `group-dot ${group.color || 'grey'}`), text = node('div'); dot.setAttribute('aria-hidden', 'true');
  text.append(node('h4', [options.profileName, group.title].filter(Boolean).join(' · ')));
  text.append(node('p', [`会话 ${group.sessionId}`, sessionClient(group.session), group.online ? '在线' : '已断开', group.session?.local ? '在服务这台电脑上' : ''].filter(Boolean).join(' · '), 'group-session'));
  text.append(node('p', [`${group.tabs.length} 个标签页`, group.lastUsedAt ? `上次操作 ${moment(group.lastUsedAt)}` : ''].filter(Boolean).join(' · '), 'group-usage'));
  identity.append(dot, text);
  const connection = groupState(group), state = node('div', undefined, 'agent-connection'), badge = node('span', connection.label, `agent-state ${connection.tone}`); badge.title = connection.detail; state.append(badge);
  const work = node('div', undefined, 'agent-work');
  for (const tab of group.tabs.slice(0, 8)) {
    const line = node('div', undefined, 'agent-tab'); line.append(node('span', tab.title || `标签 ${tab.tabId}`, 'agent-tab-title'));
    const notes = [tab.popup ? '弹窗' : '', tab.operation ? operationLabel(tab.operation) : ''].filter(Boolean).join(' · '); if (notes) line.append(node('small', notes)); work.append(line);
  }
  if (group.tabs.length > 8) work.append(node('small', `另有 ${group.tabs.length - 8} 个标签页`));
  const actions = node('div', undefined, 'group-actions');
  if (options.onShow) actions.append(groupButton('显示标签组', '切到这个标签组所在的窗口。', button => options.onShow(group, button)));
  if (options.onRelease) actions.append(groupButton('结束并释放', '解散标签组、释放占用，标签页留着。会话还连着的话，下次开标签页会再建一个组。', button => options.onRelease(group, button)));
  card.append(identity, state, work); if (actions.children.length) card.append(actions); return card;
}
function operationLabel(operation) {
  const labels = {'page.action':'操作网页','page.evaluate':'执行页面脚本','page.wait':'等待页面','page.navigate':'页面导航','page.upload':'上传文件','page.screenshot':'截图','page.inspect':'读取页面','page.cdp':'浏览器操作','page.batch':'批量操作','network.start':'捕获网络','network.body':'读取响应','downloads.start':'下载文件',
    chrome_action:'操作网页',chrome_evaluate:'执行页面脚本',chrome_wait:'等待页面',chrome_navigate:'页面导航',chrome_upload:'上传文件',chrome_screenshot:'截图',chrome_inspect:'读取页面',chrome_find:'查找页面元素',chrome_cdp:'浏览器操作',chrome_batch:'批量操作',chrome_network_start:'捕获网络',chrome_network_stop:'停止网络捕获',chrome_network_body:'读取响应',chrome_wait_response:'等待响应',chrome_download:'下载文件',chrome_downloads:'查询下载',chrome_wait_download:'等待下载',chrome_claim_tab:'占用标签页',chrome_release_tab:'释放标签页',chrome_tabs:'读取标签页',chrome_new_tab:'打开标签页',chrome_close_tab:'关闭标签页',chrome_focus_tab:'显示标签页',chrome_wait_tab:'等待新标签页',chrome_dialog:'处理网页弹窗',chrome_accessibility:'读取页面结构',chrome_contexts:'读取页面框架',chrome_profiles:'读取浏览器',chrome_events:'读取浏览器事件',chrome_read_result:'读取结果文件',chrome_file_begin:'准备传入文件',chrome_file_write:'接收文件',chrome_file_commit:'校验文件',chrome_file_read:'读取文件',chrome_file_export:'导出下载文件',chrome_file_status:'查询文件传输'};
  return labels[operation] || '浏览器操作';
}
