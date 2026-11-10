import {agentCard,groupCard,replaceGroupCards,sortAgents} from './agent-view.js';
import {copyText,returnFocusOnClose} from './workspace.js';
import {clientImportHint} from './client-hints.js';
const $=selector=>document.querySelector(selector);
export function initializeAgents({request,el,run,getProfiles,isActive}){
  let revision=0,loading,currentKey='',profileKey='',consumedAdd='',created,groupsKey;
  const select=$('#agent-profile'),dialog=$('#agent-add-dialog');
  for(const [value,label] of [['claude-desktop','Claude Desktop'],['codebuddy','CodeBuddy'],['workbuddy','WorkBuddy']]){const option=el('option',label);option.value=value;$('#new-agent-client').append(option);}
  const importHint=el('p',undefined,'muted');importHint.id='agent-import-hint';$('#agent-created').prepend(importHint);
  function preserveList(list){
    const opened=new Set([...list.querySelectorAll('details[open]')].map(item=>item.getAttribute('data-source-key'))),active=document.activeElement;
    const agent=active?.closest('[data-agent-id]')?.getAttribute('data-agent-id'),source=active?.closest('details')?.getAttribute('data-source-key'),button=active?.matches('[data-action="revoke"]');
    return()=>{for(const item of list.querySelectorAll('details')){const key=item.getAttribute('data-source-key');item.open=opened.has(key);if(source===key&&active?.matches('summary'))item.querySelector('summary')?.focus({preventScroll:true});}if(agent&&button)for(const card of list.querySelectorAll('[data-agent-id]'))if(card.getAttribute('data-agent-id')===agent)card.querySelector('button')?.focus({preventScroll:true});};
  }
  function profiles(){const items=getProfiles(),key=JSON.stringify(items.map(p=>[p.id,p.label,p.online]));if(key===profileKey)return;profileKey=key;for(const control of[select,$('#new-agent-profile')]){const old=control.value;control.replaceChildren();const empty=el('option',control===select?'所有浏览器':'请选择允许使用的浏览器');empty.value='';control.append(empty);for(const item of items){const option=el('option',item.label+(item.online?'':'（未连接）'));option.value=item.id;control.append(option);}if(items.some(p=>p.id===old))control.value=old;}}
  function advancedToggle(agent){
    const label=el('label',undefined,'agent-advanced'),box=document.createElement('input');box.type='checkbox';box.checked=agent.advancedTools===true;box.dataset.action='advanced';
    label.title='列出任务和流程工具，每次请求会多带约 1.7 万 token。已打开的会话要重连才生效。';label.append(box,el('span','高级工具'));
    box.onchange=()=>void run(box,async()=>{await request('/clients/'+agent.id,'PATCH',{advancedTools:box.checked});await refresh(true);});
    return label;
  }
  function renderGroups(groups,names,showProfile){
    const key=JSON.stringify([groups,showProfile]);if(key===groupsKey)return;groupsKey=key;
    const action=(route,group,button)=>void run(button,async()=>{await request('/agent-groups/'+route,'POST',{profileId:group.profileId,groupId:group.groupId});await refresh(true);});
    const box=$('#group-list');replaceGroupCards(box,groups.map(group=>groupCard(group,{profileName:showProfile?names.get(group.profileId):undefined,onShow:(item,button)=>action('show',item,button),onRelease:(item,button)=>action('release',item,button)})));
    if(!groups.length)box.append(el('p','现在没有 Agent 在用浏览器。','empty'));
  }
  async function refresh(force=false){
    if(!isActive())return;profiles();const profileId=select.value;if(loading&&currentKey===profileId&&!force)return loading;currentKey=profileId;const seq=++revision;
    loading=(async()=>{try{const data=await request('/agents'+(profileId?'?profileId='+encodeURIComponent(profileId):''));if(seq!==revision||profileId!==select.value||!isActive())return;if(!Array.isArray(data.agents))throw new Error('Agent列表不完整，请刷新重试。');
      const agents=sortAgents(data.agents,true),groups=Array.isArray(data.groups)?data.groups:[],working=agents.filter(a=>a.working??a.activeOperations>0),standby=agents.filter(a=>a.connectionState==='connected'&&!working.includes(a));
      $('#agents-total').textContent=String(agents.length);$('#agents-connected-total').textContent=String(standby.length);$('#agents-active-total').textContent=String(working.length);$('#agents-groups-total').textContent=String(groups.length);
      const names=new Map(getProfiles().map(p=>[p.id,p.label]));renderGroups(groups,names,!profileId);
      const list=$('#agent-list'),restore=preserveList(list);list.replaceChildren();
      for(const agent of agents){const card=agentCard(agent,{profileNames:names,unified:true,compact:true});card.setAttribute('role','listitem');const actions=el('div',undefined,'agent-admin-actions'),revoke=el('button','撤销授权','secondary');revoke.type='button';revoke.dataset.action='revoke';if(agent.id.startsWith('remote:')){revoke.disabled=true;revoke.title='旧连接的授权在原网关管理。';}else if(agent.id!=='admin')actions.append(advancedToggle(agent));revoke.onclick=event=>void run(event.currentTarget,async()=>{if(!confirm('撤销“'+agent.label+'”的浏览器访问授权？后续请求将被拒绝。'))return;await request('/clients/'+agent.id,'DELETE');await refresh(true);});actions.append(revoke);card.append(actions);list.append(card);}
      if(!agents.length)list.append(el('p','还没有 Agent 授权。新增后把配置导入服务所在电脑上的 Agent。','empty'));
      restore();$('#agent-list-status').textContent='';$('#agent-list-status').dataset.error='false';$('#agent-channel-note').textContent='所有 Agent 通过当前服务接入；机器信息仅用于辨认来源，权限由各自的授权决定。';
    }catch(error){if(seq===revision){$('#agent-list').replaceChildren();$('#group-list').replaceChildren();groupsKey=undefined;for(const id of ['agents-total','agents-connected-total','agents-active-total','agents-groups-total'])$('#'+id).textContent='—';$('#agent-list-status').textContent=error.message;$('#agent-list-status').dataset.error='true';}}finally{if(seq===revision)loading=undefined;}})();return loading;
  }
  function showConfiguration(){const key=$('#new-agent-client').value,text=created?.configurations?.[key]||'';$('#new-agent-configuration').value=text;$('#copy-agent-configuration').disabled=!text;$('#agent-created').hidden=!created;importHint.textContent=clientImportHint(key);}
  function openAdd(opener){profiles();created=undefined;$('#new-agent-profile').value=select.value;$('#new-agent-profile').disabled=false;$('#new-agent-name').value='';$('#new-agent-client').value='codex';$('#new-agent-all').checked=false;$('#new-agent-readonly').checked=false;$('#agent-add-feedback').textContent='';showConfiguration();$('#create-agent').disabled=false;if(!dialog.open){returnFocusOnClose(dialog,opener,()=>$('#add-agent'));dialog.showModal();$('#new-agent-name').focus();}}
  $('#create-agent').onclick=event=>void run(event.currentTarget,async()=>{const label=$('#new-agent-name').value.trim(),profileId=$('#new-agent-profile').value,all=$('#new-agent-all').checked;if(!label||label.length>100)throw new Error('请输入1–100个字符的Agent名称。');if(!all&&!profileId)throw new Error('请选择一个浏览器，或明确允许使用所有浏览器。');created=await request('/clients','POST',{label,profiles:all?'*':[profileId],readOnly:$('#new-agent-readonly').checked});showConfiguration();$('#agent-add-feedback').textContent='授权已创建。将下方配置导入目标Agent，再重载MCP。';await refresh(true);},()=>!created);
  $('#copy-agent-configuration').onclick=event=>void run(event.currentTarget,()=>copyText($('#new-agent-configuration').value,event.currentTarget),()=>!!created);
  $('#new-agent-client').onchange=showConfiguration;
  $('#new-agent-all').onchange=()=>{$('#new-agent-profile').disabled=$('#new-agent-all').checked;};
  $('#add-agent').onclick=event=>openAdd(event.currentTarget);$('#close-agent-add').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{created=undefined;$('#new-agent-configuration').value='';});
  select.addEventListener('change',()=>{revision++;void refresh(true);});$('#refresh-agents').onclick=event=>void run(event.currentTarget,()=>refresh(true));
  return{refresh,profiles,async activate(){profiles();const params=new URLSearchParams(location.hash.slice(1).split('?')[1]||''),id=params.get('profile');if(id!==null)select.value=getProfiles().some(p=>p.id===id)?id:'';await refresh();if(params.get('add')==='1'&&consumedAdd!==location.hash){consumedAdd=location.hash;openAdd($('#add-agent'));}},reset(){revision++;loading=undefined;created=undefined;currentKey='';profileKey='';consumedAdd='';$('#agent-list').replaceChildren();$('#new-agent-configuration').value='';if(dialog.open)dialog.close();}};
}
