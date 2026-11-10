import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mountApp, createServer, uuid, defer } from './fake-app.js';
import { choose, FakeEvent, installDom } from './fake-dom.js';
import { agentConnection, agentCard, groupCard, groupState } from '../ui/agent-view.js';

const profile=(id:number,label:string)=>({id:uuid(id),label,online:true,version:'0.2.12',capabilities:['interaction-v5']});
const agent=(id:number,label:string,extra={})=>({id:uuid(id),label,location:'local',connectionState:'disconnected',connectionEvidence:'configuration',sessionCount:0,activeOperations:0,readOnly:false,tabs:[],...extra});
const payload=(agents:any[],profileId?:string)=>({version:'0.2.0-beta.24',profileId,agents,remote:{enabled:true,state:'connected',url:'https://gateway.example:18443',deviceId:uuid(90)}});
const source=(extra={})=>({id:uuid(51),hostname:'workstation-A',reportedAddresses:['192.0.2.30'],reportId:uuid(61),reportedAt:'2026-10-28T00:00:00Z',reportSource:'setup_report',observedAt:'2026-10-28T01:00:00Z',connected:true,...extra});
function sourceCards(t:TestContext){
 const dom=installDom('<!doctype html><html><head></head><body><main id="cards"></main></body></html>');t.after(()=>dom.uninstall());
 return (sources:any[],options:{compact?:boolean;preferredAddress?:string}={compact:true})=>{
  const host=dom.doc.querySelector('#cards')!;host.replaceChildren(agentCard(agent(12,'远程 Codex',{location:'remote',sources}) as any,options) as any);
  return host.children[0]!;
 };
}

test('compact优先展示与peer一致的登记IP，所有原地址与登记说明保留在原生详情中',t=>{
 const render=sourceCards(t),addresses=['127.0.0.1','169.254.2.3','10.1.2.3','192.0.2.30'];
 const card=render([source({reportedAddresses:addresses,peerAddress:'192.0.2.30'})],{compact:true,preferredAddress:'10.1.2.3'});
 assert.equal(card.querySelector('.agent-machine-address')!.textContent,'登记 IP：192.0.2.30');
 const details=card.querySelector('details.agent-machine-details')!;assert.equal(details.open,false);assert.equal(details.children[0]!.localName,'summary');
 for(const address of addresses)assert.ok(details.querySelector('.agent-machine-addresses')!.textContent.includes(address));
 assert.match(details.textContent,/连接来源 IP：192.0.2.30.*接入时登记.*不表示唯一 IP 或主网卡/);
 assert.equal(details.querySelectorAll('button').length,0);assert.ok(details.dataset.sourceKey);
});

test('compact仅在登记地址中匹配preferredAddress，外部peer或网关地址不能成为Agent登记IP',t=>{
 const render=sourceCards(t),entry=source({reportedAddresses:['10.1.2.3','192.0.2.30'],peerAddress:'198.51.100.7'});
 let card=render([entry],{compact:true,preferredAddress:'192.0.2.30'});assert.equal(card.querySelector('.agent-machine-address')!.textContent,'登记 IP：192.0.2.30');
 card=render([entry],{compact:true,preferredAddress:'203.0.113.99'});assert.equal(card.querySelector('.agent-machine-address')!.textContent,'登记 IP：10.1.2.3');
 assert.match(card.querySelector('.agent-machine-peer')!.textContent,/198.51.100.7/);assert.doesNotMatch(card.textContent,/203\.0\.113\.99/);
 card=render([entry],{compact:true,preferredAddress:'gateway.example'});assert.equal(card.querySelector('.agent-machine-address')!.textContent,'登记 IP：10.1.2.3');
});

test('compact跳过IPv4/IPv6回环和链路本地地址，优先可用IPv4并支持IPv6hostname格式',t=>{
 const render=sourceCards(t),blocked=['127.9.0.1','169.254.2.3','::1','fe80::1','febf::8','::ffff:127.0.0.1','::ffff:169.254.1.2','0.0.0.0','::'];
 let card=render([source({reportedAddresses:[...blocked,'fd00::42','192.0.2.30'],peerAddress:'127.9.0.1'})],{compact:true,preferredAddress:'fe80::1'});
 assert.equal(card.querySelector('.agent-machine-address')!.textContent,'登记 IP：192.0.2.30');
 card=render([source({reportedAddresses:['2001:db8::5','192.0.2.30']})],{compact:true,preferredAddress:'[2001:0db8:0:0:0:0:0:5]'});
 assert.equal(card.querySelector('.agent-machine-address')!.textContent,'登记 IP：2001:db8::5');
 card=render([source({reportedAddresses:[...blocked,'fd00::42']})]);assert.equal(card.querySelector('.agent-machine-address')!.textContent,'登记 IP：fd00::42');
 card=render([source({reportedAddresses:blocked})]);assert.equal(card.querySelector('.agent-machine-address')!.textContent,'暂无可展示的登记 IP');
 assert.equal(card.querySelector('.agent-machine-addresses')!.textContent,'全部登记 IP：'+blocked.join(' · '));
});

test('compact缺失机器或登记地址时明确未知，只有peer也只放在详情',t=>{
 const render=sourceCards(t);let card=render([]);assert.doesNotMatch(card.textContent,/设备信息待上报|未占用标签页/);assert.equal(card.querySelectorAll('details').length,0);
 card=render([source({hostname:undefined,reportedAddresses:[],peerAddress:'198.51.100.7',connected:false})]);
 assert.equal(card.querySelector('.agent-machine-name')!.textContent,'机器名未上报');assert.equal(card.querySelector('.agent-machine-address')!.textContent,'登记 IP 未上报');
 assert.match(card.querySelector('details')!.textContent,/登记 IP 未上报.*连接来源 IP：198.51.100.7.*上次接入/);
});

test('compact多来源分别选择IP；重复会话合并，稳定来源key不跟随轮询时间和地址顺序变化',t=>{
 const render=sourceCards(t),a=source({reportedAddresses:['192.0.2.30','10.1.2.3'],peerAddress:'192.0.2.30'}),b=source({id:uuid(53),hostname:'workstation-B',reportId:uuid(62),reportedAddresses:['198.51.100.8'],peerAddress:'198.51.100.8'});
 let card=render([a,{...a,id:uuid(52),reportedAddresses:[...a.reportedAddresses].reverse()},b]);
 assert.equal(card.querySelectorAll('.agent-machine').length,2);const details=card.querySelectorAll('.agent-machine-details'),keys=details.map(item=>item.dataset.sourceKey);
 assert.equal(new Set(keys).size,2);assert.match(details[0]!.textContent,/2 条来源记录/);
 assert.deepEqual(card.querySelectorAll('.agent-machine-address').map(item=>item.textContent),['登记 IP：192.0.2.30','登记 IP：198.51.100.8']);
 card=render([{...b,id:uuid(54),observedAt:'2026-10-28T03:00:00Z',connected:false},{...a,id:uuid(55),reportedAddresses:[...a.reportedAddresses].reverse(),reportedAt:'2026-10-28T02:00:00Z'}]);
 assert.deepEqual(card.querySelectorAll('.agent-machine-details').map(item=>item.dataset.sourceKey),[keys[1],keys[0]]);
});

test('非compact管理页仍完整显示原有上报地址，不应用单地址偏好或折叠详情',t=>{
 const render=sourceCards(t),entry=source({reportedAddresses:['192.0.2.30','10.1.2.3'],reportSource:'runtime_report',peerAddress:'198.51.100.7',connected:false});
 const card=render([entry],{preferredAddress:'10.1.2.3'});
 assert.equal(card.querySelector('.agent-machine-address')!.textContent,'上报 IP：192.0.2.30 · 10.1.2.3');
 assert.match(card.querySelector('.agent-machine-address')!.title,/198.51.100.7/);assert.match(card.querySelector('.agent-machine-evidence')!.textContent,/连接时上报.*上次接入/);
 assert.equal(card.querySelectorAll('details').length,0);
});

test('远程Agent展示各自电脑登记与peer来源，历史和未知信息不冒充网关机器',async t=>{
 const source={id:uuid(51),hostname:'workstation-A',reportedAddresses:['192.0.2.30'],reportId:uuid(61),reportedAt:'2026-10-28T00:00:00Z',reportSource:'setup_report',peerAddress:'198.51.100.7',observedAt:'2026-10-28T01:00:00Z',connected:false};
 const server=createServer({profiles:[profile(1,'个人')]});
 server.hooks['GET /agents']=()=>({status:200,body:payload([agent(12,'远程Codex',{location:'remote',sources:[source,{...source,id:uuid(52)},{id:uuid(53),reportedAddresses:[],peerAddress:'198.51.100.8',observedAt:source.observedAt,connected:false}]})])});
 const app=await mountApp(t,{server});await app.navigate('agents');
 const text=app.text('#agent-list');assert.match(text,/workstation-A.*登记 IP：192.0.2.30.*接入时登记.*上次接入.*2 条来源记录/);assert.match(text,/机器名未上报.*连接来源 IP：198.51.100.8/);
 assert.equal(app.$$('.agent-machine').length,2);assert.doesNotMatch(text,/gateway.example/);
});

test('有会话只算待命，使用中只看实际操作；没连接的只有授权',async t=>{
 const server=createServer({profiles:[profile(1,'个人')]});
 server.hooks['GET /agents']=()=>({status:200,body:payload([
  agent(11,'本机 Codex',{connectionState:'connected',connectionEvidence:'heartbeat',sessionCount:1,sessions:[{id:'a3f9c2',client:'codex',version:'1.0',since:'2026-11-01T07:10:00Z',local:true}],lastUsedAt:'2026-11-01T07:13:00Z'}),
  agent(12,'远程 Claude',{location:'remote',connectionState:'connected',connectionEvidence:'mcp_session',sessionCount:2}),
  agent(13,'仅授权 OpenCode'),agent(14,'旧客户端',{connectionState:'recent',connectionEvidence:'recent_request'}),
 ])});
 const app=await mountApp(t,{server});await app.navigate('agents');
 assert.equal(app.$$('.agent-card').length,4);assert.equal(app.text('#agents-total'),'4');assert.equal(app.text('#agents-active-total'),'0');
 assert.match(app.text('#agent-list'),/本机 Codex.*在服务这台电脑上.*会话 a3f9c2 · codex 1\.0.*待命.*1 个会话 · 上次使用/);assert.match(app.text('#agent-list'),/远程 Claude.*待命/);
 assert.match(app.text('#agent-list'),/仅授权 OpenCode.*未连接/);assert.match(app.text('#agent-list'),/旧客户端.*未连接/);
 assert.doesNotMatch(app.text('#agent-list'),/在线|会话已建立|最近使用|未占用/);assert.equal(app.text('#agents-connected-total'),'2');
 assert.equal(agentConnection(agent(1,'未知',{location:'remote',connectionState:'unavailable',activeOperations:1}) as any).label,'状态未知');
 assert.equal(agentConnection(agent(2,'旧客户端',{connectionState:'recent',connectionEvidence:'recent_request',activeOperations:1}) as any).label,'使用中','旧适配器的真实在途操作也是事实，不等待心跳才展示');
 assert.equal(agentConnection(agent(3,'占用中',{connectionState:'connected',working:true}) as any).label,'使用中','占用着标签页或刚操作过也算在用');
});

test('切换浏览器后迟到的旧Agent列表不会覆盖新范围',async t=>{
 const a=profile(1,'个人'),b=profile(2,'工作'),server=createServer({profiles:[a,b]}),slow=defer<any>();
 server.hooks['GET /agents']=()=>({status:200,body:payload([])});
 server.hooks['GET /agents?profileId='+a.id]=()=>slow.promise;
 server.hooks['GET /agents?profileId='+b.id]=()=>({status:200,body:payload([agent(20,'工作专用')],b.id)});
 const app=await mountApp(t,{server});await app.navigate('agents');
 choose(app.$('#agent-profile'),a.id);await app.flush();choose(app.$('#agent-profile'),b.id);await app.flush();
 assert.match(app.text('#agent-list'),/工作专用/);slow.resolve({status:200,body:payload([agent(21,'个人秘密名称')],a.id)});await app.flush();
 assert.match(app.text('#agent-list'),/工作专用/);assert.doesNotMatch(app.text('#agent-list'),/个人秘密/);
});

test('权限拒绝清掉旧连接卡片，明确未知而不是显示全部离线',async t=>{
 const server=createServer({profiles:[profile(1,'个人')]});let denied=false;
 server.hooks['GET /agents']=()=>denied?{status:403,body:{error:{code:'FORBIDDEN',message:'此会话没有读取权限'}}}:{status:200,body:payload([agent(11,'A')])};
 const app=await mountApp(t,{server});await app.navigate('agents');assert.equal(app.$$('.agent-card').length,1);
 denied=true;app.click('#refresh-agents');await app.flush();assert.equal(app.$$('.agent-card').length,0);assert.match(app.text('#agent-list-status'),/没有读取权限/);assert.equal(app.text('#agents-total'),'—');
});

test('扩展深链接打开新增引导并限定原浏览器；本机接入复用已有setup',async t=>{
 const p=profile(1,'个人'),server=createServer({profiles:[p]});server.hooks['GET /agents?profileId='+p.id]=()=>({status:200,body:payload([],p.id)});
 const app=await mountApp(t,{server,login:'session',hash:'#agents?add=1&profile='+p.id});
 assert.equal(app.$('#agents').hidden,false);assert.equal(app.$('#agent-add-dialog').open,true);assert.equal(app.$('#new-agent-profile').value,p.id);
 assert.equal(app.$('#new-agent-client').value,'codex');assert.equal(app.$('#new-agent-profile').disabled,false);
 assert.deepEqual(app.$$('#new-agent-client option').map(option=>option.value),['codex','opencode','claude','pi','agy','claude-desktop','codebuddy','workbuddy']);
 app.click('#close-agent-add');await app.flush();await app.tick();assert.equal(app.$('#agent-add-dialog').open,false,'定时刷新不能再次弹出新增窗口');
});

test('新增Agent明确选择浏览器，通过授权API取得配置，名称按数据传递且不执行shell',async t=>{
 const p=profile(1,'个人'),server=createServer({profiles:[p]});server.hooks['GET /agents']=()=>({status:200,body:payload([])});
 server.hooks['POST /clients']=request=>({status:200,body:{id:uuid(77),configurations:{codex:'url = "https://service.example/mcp"',opencode:'{"type":"remote"}',claude:'{"type":"http"}'}}});
 const app=await mountApp(t,{server});await app.navigate('agents');app.click('#add-agent');choose(app.$('#new-agent-profile'),p.id);app.$('#new-agent-name').value="name $(whoami)";app.click('#create-agent');await app.flush();
 assert.deepEqual(server.log.find(r=>r.path==='/clients'&&r.method==='POST')!.body,{label:'name $(whoami)',profiles:[p.id],readOnly:false});assert.match(app.$('#new-agent-configuration').value,/https:\/\/service.example\/mcp/);app.click('#copy-agent-configuration');await app.flush();assert.equal(app.copied.at(-1),app.$('#new-agent-configuration').value);
 choose(app.$('#new-agent-client'),'opencode');assert.equal(app.$('#new-agent-configuration').value,'{"type":"remote"}');app.click('#close-agent-add');assert.equal(app.$('#new-agent-configuration').value,'');
});

test('新增Agent默认不授予全部浏览器，明确全选后才可创建；重开窗口恢复浏览器选择',async t=>{
 const server=createServer({profiles:[profile(1,'个人')]});server.hooks['GET /agents']=()=>({status:200,body:payload([])});server.hooks['POST /clients']=()=>({status:200,body:{configurations:{codex:'synthetic'}}});
 const app=await mountApp(t,{server});await app.navigate('agents');app.click('#add-agent');app.$('#new-agent-name').value='测试';app.click('#create-agent');await app.flush();assert.equal(server.log.some(r=>r.path==='/clients'&&r.method==='POST'),false);
 app.$('#new-agent-all').click();app.$('#new-agent-all').dispatchEvent(new FakeEvent('change'));assert.equal(app.$('#new-agent-profile').disabled,true);app.click('#create-agent');await app.flush();assert.equal(server.log.find(r=>r.path==='/clients'&&r.method==='POST')!.body.profiles,'*');app.click('#close-agent-add');app.click('#add-agent');assert.equal(app.$('#new-agent-all').checked,false);assert.equal(app.$('#new-agent-profile').disabled,false);
});

test('标签组卡片显示会话、连接状态和标签页，按钮带着组信息回调',t=>{
 const dom=installDom('<!doctype html><html><head></head><body><main id="cards"></main></body></html>');t.after(()=>dom.uninstall());
 const base={profileId:uuid(1),groupId:5,windowId:2,title:'Claude Code',color:'purple',startedAt:'2026-11-01T07:10:00Z',agentId:'a',sessionId:'a3f9c2',online:true,working:true,session:{id:'a3f9c2',client:'claude-code',version:'2.1',since:'2026-11-01T07:10:00Z',local:true},lastUsedAt:'2026-11-01T07:13:00Z',tabs:[{tabId:1,title:'订单',active:true,operation:'chrome_action'},{tabId:2,title:'登录',active:true,popup:true}]};
 const pressed:string[]=[],card=groupCard(base as any,{onShow:group=>pressed.push('show'+group.groupId),onRelease:group=>pressed.push('release'+group.groupId)}) as any;
 assert.match(card.textContent,/Claude Code.*会话 a3f9c2 · claude-code 2\.1 · 在线 · 在服务这台电脑上.*2 个标签页 · 上次操作.*使用中.*订单.*操作网页.*登录.*弹窗/);
 assert.ok(card.querySelector('.group-dot.purple'));
 for(const button of card.querySelectorAll('button'))button.dispatchEvent(new FakeEvent('click'));assert.deepEqual(pressed,['show5','release5']);
 assert.equal(groupState({...base,working:false} as any).label,'待命');
 const offline=groupCard({...base,online:false,session:undefined} as any) as any;assert.match(offline.textContent,/会话 a3f9c2 · 已断开.*已断开/);assert.equal(offline.querySelectorAll('button').length,0,'没给操作就不显示按钮');
});

test('管理页列出标签组，显示和释放都调对接口',async t=>{
 const server=createServer({profiles:[profile(1,'个人')]}),calls:any[]=[];
 const group={profileId:uuid(1),groupId:5,windowId:2,title:'Codex',startedAt:'2026-11-01T07:10:00Z',agentId:uuid(11),sessionId:'a3f9c2',online:true,working:false,tabs:[{tabId:1,title:'订单',active:true}]};
 server.hooks['GET /agents']=()=>({status:200,body:{...payload([agent(11,'Codex')]),groups:[group]}});
 for(const route of ['show','release'])server.hooks['POST /agent-groups/'+route]=(request:any)=>{calls.push([route,request.body]);return{status:200,body:{}};};
 const app=await mountApp(t,{server});await app.navigate('agents');
 assert.equal(app.text('#agents-groups-total'),'1');assert.match(app.text('#group-list'),/个人 · Codex.*会话 a3f9c2.*待命.*订单/);
 const buttons=app.$$('#group-list button');assert.equal(buttons.length,2);await app.click(buttons[0]!);await app.click(buttons[1]!);
 assert.deepEqual(calls,[['show',{profileId:uuid(1),groupId:5}],['release',{profileId:uuid(1),groupId:5}]]);
});

test('Agent来源详情在刷新后保持展开和焦点',async t=>{
 const server=createServer();server.hooks['GET /agents']=()=>({status:200,body:payload([agent(12,'codex',{sources:[source()]})])});const app=await mountApp(t,{server});await app.navigate('agents');const details=app.$('.agent-machine-details');details.open=true;details.querySelector('summary')!.focus();app.click('#refresh-agents');await app.flush();assert.equal(app.$('.agent-machine-details').open,true);assert.equal(app.doc.activeElement.localName,'summary');
});

test('退出管理页关闭新增窗口并清除Agent信息，旧列表不能回填',async t=>{
 const server=createServer();let slow:ReturnType<typeof defer<any>>|undefined;
 server.hooks['GET /agents']=()=>slow?slow.promise:{status:200,body:payload([agent(1,'A')])};
 const app=await mountApp(t,{server});await app.navigate('agents');app.click('#add-agent');slow=defer();app.click('#refresh-agents');await app.flush();
 app.click('#lock-dashboard');await app.flush();slow.resolve({status:200,body:payload([agent(2,'迟到信息')])});await app.flush();
 assert.equal(app.$('#agent-add-dialog').open,false);assert.equal(app.text('#agent-list'),'');assert.equal(app.$('#workspace').hidden,true);
});
