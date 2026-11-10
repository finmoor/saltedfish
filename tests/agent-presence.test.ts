import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AgentPresence, AGENT_SESSION_TTL_MS, stdioOwner, stdioSessionId } from '../src/agent-presence.js';
import { bridgeToken, type Principal } from '../src/auth.js';
import { CAPABILITY } from '../src/shared.js';
import { fixture, fakeProfile, freePort, FAKE_CAPABILITIES } from './helpers.js';
import { startGateway } from '../src/remote-gateway.js';
import { projectDir } from '../src/config.js';
import {RemoteOnboarding} from '../src/remote-protocol.js';

async function until(check:()=>boolean|Promise<boolean>,ms=6000){const end=Date.now()+ms;while(!await check()){if(Date.now()>end)throw new Error('Condition timed out');await new Promise(r=>setTimeout(r,20));}}
const principal=(id:string,profiles:'*'|string[]='*'):Principal=>({id,label:`Agent ${id}`,profiles,readOnly:false,admin:false});
const grant=(p:Principal)=>({...p,revoked:false});
async function api(f:Awaited<ReturnType<typeof fixture>>,route:string,token:string,method='GET',input?:unknown,origin?:string){const r=await fetch(`http://127.0.0.1:${f.config.port}${route}`,{method,headers:{authorization:`Bearer ${token}`,...(input?{'content-type':'application/json'}:{}),...(origin?{origin}:{})},...(input?{body:JSON.stringify(input)}:{})});return{status:r.status,body:await r.json() as any};}
async function remoteClient(url:string,token:string){const transport=new StreamableHTTPClientTransport(new URL(url+'/mcp'),{requestInit:{headers:{authorization:`Bearer ${token}`}}});const client=new Client({name:'presence-test',version:'1'});await client.connect(transport);return{client,async close(){await transport.terminateSession().catch(()=>{});await client.close();}};}

test('有会话不算在用：碰过标签页才记使用时间，30 秒后回到待命；查询类调用不算',()=>{
 let now=100000;const a=principal('a'),saved:string[][]=[],presence=new AgentPresence(id=>id==='a'?a:undefined,()=>now,{list:()=>[{agentId:'a',profileId:'old',lastUsedAt:new Date(5000).toISOString()}],record:(...row)=>saved.push(row)}),id=randomUUID(),view=(profile='p')=>presence.snapshot([grant(a)],[],profile)[0]!;
 presence.heartbeat(a,{sessionId:id,owner:'a:mcp:x',clientInfo:{name:'codex',version:'1.2'}});
 let item=view();assert.equal(item.working,false);assert.equal(item.lastUsedAt,undefined);assert.deepEqual(item.sessions,[{id:id.slice(0,6),client:'codex',version:'1.2',since:new Date(100000).toISOString(),local:true}]);
 presence.observe(a,'a:mcp:x','chrome_tabs','p')();presence.observe(a,'a:mcp:x','chrome_profiles')();assert.equal(view().lastUsedAt,undefined,'启动时的探测不算用过');assert.equal(saved.length,0);
 now+=1000;presence.observe(a,'a:mcp:x','chrome_new_tab','p')();item=view();assert.equal(item.working,true);assert.equal(item.lastUsedAt,new Date(now).toISOString());
 assert.equal(presence.snapshot([grant(a)],[],'other')[0]!.working,false,'使用时间按浏览器分开');
 now+=30000;presence.heartbeat(a,{sessionId:id,owner:'a:mcp:x'});item=view();assert.equal(item.working,false);assert.equal(item.connectionState,'connected');assert.equal(item.sessions[0]!.since,new Date(100000).toISOString(),'心跳不改连接时间');
 assert.equal(presence.ownerView('a:mcp:x').usedAt,new Date(101000).toISOString());
 presence.observe(a,'a:mcp:x','chrome_action','p',3)();assert.equal(saved.length,1,'一分钟内只写一次');now+=60000;presence.heartbeat(a,{sessionId:id,owner:'a:mcp:x'});presence.observe(a,'a:mcp:x','chrome_action','p',3)();assert.equal(saved.length,2);
 assert.equal(view('old').lastUsedAt,new Date(5000).toISOString(),'重启后从库里读回');
 const leases=[{profileId:'p',tabId:1,owner:'a:mcp:x',expires:now+600000}];now+=60000;presence.heartbeat(a,{sessionId:id,owner:'a:mcp:x'});assert.equal(presence.snapshot([grant(a)],leases,'p')[0]!.working,true,'占用着标签页算在用');
});

test('只有客户端明确结束才通知，心跳超时交给对账',()=>{
 let now=100000;const a=principal('a'),ended:string[]=[],presence=new AgentPresence(id=>id==='a'?a:undefined,()=>now),id=randomUUID();presence.onEnded=owner=>ended.push(owner);
 presence.heartbeat(a,{sessionId:id,owner:'a:mcp:x'});assert.ok(presence.isSession(a,'a:mcp:x'));assert.equal(presence.isSession(a,'a:mcp:x:task:1'),false,'任务不是会话');assert.equal(presence.isSession(principal('b'),'a:mcp:x'),false);
 now+=AGENT_SESSION_TTL_MS;assert.deepEqual([...presence.liveOwners()],[]);assert.deepEqual(ended,[]);
 presence.heartbeat(a,{sessionId:id,owner:'a:mcp:x'});presence.remove(a,{sessionId:id,owner:'a:mcp:x'});assert.deepEqual(ended,['a:mcp:x']);
 presence.remove(a,{sessionId:id,owner:'a:mcp:x'});assert.equal(ended.length,1,'重复结束不重复通知');
});

test('授权不等于连接；心跳过期与撤销即时反映，旧客户端仅显示最近使用',()=>{
 let now=100000;const a=principal('a'),b=principal('b'),live=new Map([[a.id,a],[b.id,b]]),presence=new AgentPresence(id=>live.get(id),()=>now),id=randomUUID();
 assert.equal(presence.snapshot([grant(a)],[])[0]!.connectionState,'disconnected');
 const stop=presence.observe(a,'a:mcp:old','chrome_inspect','p',1);
 let item=presence.snapshot([grant(a)],[],'p')[0]!;assert.equal(item.connectionState,'recent');assert.equal(item.connectionEvidence,'recent_request');assert.equal(item.activeOperations,1);stop();
 presence.heartbeat(a,{sessionId:id,owner:'a:mcp:new',clientInfo:{name:'spoofed-other-agent'}});
 item=presence.snapshot([grant(a)],[],'p')[0]!;assert.equal(item.label,a.label);assert.equal(item.connectionState,'connected');assert.equal(item.connectionEvidence,'heartbeat');
 now+=AGENT_SESSION_TTL_MS;assert.equal(presence.snapshot([grant(a)],[])[0]!.connectionState,'recent');
 presence.heartbeat(a,{sessionId:id,owner:'a:mcp:new'});live.delete(a.id);assert.equal(presence.snapshot([grant(a)],[])[0]!.connectionState,'disconnected');
});

test('会话绑定调用者和owner，有界；profile只显示自己的活动与租约',()=>{
 const a=principal('a',['A']),b=principal('b',['B']),presence=new AgentPresence(id=>id==='a'?a:b),id=randomUUID();
 presence.heartbeat(a,{sessionId:id,owner:'a:mcp:1'});assert.throws(()=>presence.heartbeat(a,{sessionId:id,owner:'a:mcp:2'}),{code:'AGENT_SESSION_CONFLICT'});
 assert.equal(presence.remove(b,{sessionId:id,owner:'b:mcp:1'}).removed,false);assert.equal(presence.snapshot([grant(a)],[])[0]!.sessionCount,1);
 const stop=presence.observe(a,'a:mcp:1','chrome_action','A',5);
 presence.observe(b,'b:mcp:2','chrome_evaluate','B',6)();
 const rows=presence.snapshot([grant(a),grant(b)],[{profileId:'A',tabId:5,owner:'a:mcp:1',expires:Date.now()+1000},{profileId:'B',tabId:6,owner:'b:mcp:2',expires:Date.now()+1000}],'A');
 assert.equal(rows.length,1);assert.equal(rows[0]!.tabs[0]!.claimed,true);assert.equal(rows[0]!.tabs[0]!.operation,'chrome_action');assert.ok(!JSON.stringify(rows).includes('chrome_evaluate'));stop();
 const global=presence.observe(a,'a:mcp:1','chrome_profiles');assert.equal(presence.snapshot([grant(a)],[],'A')[0]!.activeOperations,0);assert.equal(presence.snapshot([grant(a)],[])[0]!.activeOperations,1);global();
 for(let i=0;i<15;i++)presence.heartbeat(a,{sessionId:randomUUID(),owner:`a:${i}`});assert.throws(()=>presence.heartbeat(a,{sessionId:randomUUID(),owner:'a:overflow'}),{code:'AGENT_SESSION_CAPACITY'});
});

test('扩展Agent目录只读且绑定在线profile/instance，普通凭据无权读取全目录',async()=>{
 const f=await fixture();try{
  const p=await fakeProfile(f.config,'A'),q=await fakeProfile(f.config,'B');const a=f.service.state.createClient('visible',[p.id]),b=f.service.state.createClient('hidden',[q.id]);
  const session={sessionId:randomUUID(),owner:'mcp:'+randomUUID(),clientInfo:{name:'do-not-trust-display-name',version:'1'}};
  assert.equal((await api(f,'/agent-sessions',a.token,'POST',session)).status,200);
  const all=await api(f,'/agents',f.config.token);assert.equal(all.status,200);assert.equal(all.body.agents.find((r:any)=>r.id===a.id).connectionState,'connected');
  assert.equal((await api(f,'/agents',a.token)).status,403);assert.equal((await api(f,'/agents',bridgeToken(f.config))).status,401);
  const instance=f.service.broker.capture(p.id).info.instanceId,route=`/extension/agents?profileId=${p.id}&instanceId=${instance}`,origin='chrome-extension://'+'a'.repeat(32);
  const scoped=await api(f,route,bridgeToken(f.config),'GET',undefined,origin);assert.equal(scoped.status,200);assert.deepEqual(scoped.body.agents.map((r:any)=>r.id),[a.id]);
  assert.ok(!JSON.stringify(scoped.body).includes(b.label));assert.ok(!JSON.stringify(scoped.body).includes(a.token));assert.equal(scoped.body.remote.deviceId,undefined);
  assert.equal((await api(f,route,bridgeToken(f.config),'POST',{},origin)).status,405);
  assert.equal((await api(f,route.replace(instance,randomUUID()),bridgeToken(f.config),'GET',undefined,origin)).status,403);
  f.service.state.revokeClient(a.id);assert.equal((await api(f,'/agent-sessions',a.token,'POST',session)).status,401);assert.equal((await api(f,'/agents',f.config.token)).body.agents.some((r:any)=>r.id===a.id),false);
 }finally{await f.cleanup();}
});

test('真实stdio SDK初始化才登记，EOF关闭注销；没有浏览器调用也能显示连接',async()=>{
 const f=await fixture();let client:Client|undefined;try{
  const p=await fakeProfile(f.config,'A',command=>command.operation==='tabs.list'?[{tabId:7}]:{});
  const a=f.service.state.createClient('Real Codex',[p.id]);const config=path.join(f.config.dataDir,'config.json'),tokenFile=path.join(f.config.dataDir,'client.token');await writeFile(config,JSON.stringify(f.config));await writeFile(tokenFile,a.token);
  const expression=`import {readFile} from 'node:fs/promises';import {runMcp} from './src/mcp.ts';await runMcp(JSON.parse(await readFile(process.env.PRESENCE_CONFIG,'utf8')));`;
  const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx','--input-type=module','-e',expression],cwd:projectDir,env:{...process.env,PRESENCE_CONFIG:config,CHROME_MCP_TOKEN_FILE:tokenFile},stderr:'pipe'});
  client=new Client({name:'codex-fixture',version:'1'});await client.connect(transport);
  await until(()=>f.service.agents().some(a=>a.label==='Real Codex'&&a.connectionEvidence==='heartbeat'));
  assert.equal(f.service.agents().find(a=>a.label==='Real Codex')!.activeOperations,0);
  const claimed=await client.callTool({name:'chrome_claim_tab',arguments:{profileId:p.id,tabId:7}});assert.equal(claimed.isError,false);
  const route=`/extension/agents?profileId=${p.id}&instanceId=${f.service.broker.capture(p.id).info.instanceId}`;
  const scoped=await api(f,route,bridgeToken(f.config));assert.equal(scoped.body.agents.find((r:any)=>r.id===a.id).tabs[0].claimed,true);assert.equal(scoped.body.agents.find((r:any)=>r.id===a.id).tabs[0].tabId,7);
  await client.callTool({name:'chrome_release_tab',arguments:{profileId:p.id,tabId:7}});
  await client.close();client=undefined;
  await until(()=>f.service.agents().find(a=>a.label==='Real Codex')!.sessionCount===0);
 }finally{await client?.close();await f.cleanup();}
});

test('调用也算心跳：没登记就登记，已登记只续期、不动客户端信息；只认 stdio 适配器的 owner',()=>{
 let now=100000;const a=principal('a'),presence=new AgentPresence(id=>id==='a'?a:undefined,()=>now),id=randomUUID(),owner='a:'+stdioOwner(id);
 assert.equal(stdioSessionId(stdioOwner(id)),id);assert.equal(stdioSessionId('mcp-http:'+id),undefined);assert.equal(stdioSessionId('same-owner'),undefined);assert.equal(stdioSessionId(stdioOwner(id)+':task:1'),undefined);
 presence.touch(a,{sessionId:id,owner});assert.ok(presence.isSession(a,owner));
 presence.heartbeat(a,{sessionId:id,owner,clientInfo:{name:'claude-code'}});now+=30000;presence.touch(a,{sessionId:id,owner});now+=30000;
 assert.ok(presence.isSession(a,owner),'调用续期');assert.equal(presence.ownerView(owner).session?.client,'claude-code');
});

test('服务刚重启、stdio 适配器还没发心跳就调用：new_tab 照样进本会话的组，心跳到了以后接着能写',async()=>{
 const f=await fixture();try{
  let next=30,join:unknown={grouped:true,groupId:8,title:'A'};const members=new Set<number>();
  const p=await fakeProfile(f.config,'A',command=>{
   const tabId=Number(command.args.tabId);
   if(command.operation==='tabs.create')return{tabId:++next,windowId:1,groupId:-1};
   if(command.operation==='group.window')return{};
   if(command.operation==='group.join'){if((join as {grouped:boolean}).grouped)members.add(tabId);return join;}
   if(command.operation==='group.check')return{member:members.has(tabId),takenBack:false};
   return 1;
  },undefined,{capabilities:[...FAKE_CAPABILITIES,CAPABILITY.tabGroupsV1]});
  const a=f.service.state.createClient('A',[p.id]),sessionId=randomUUID(),owner=stdioOwner(sessionId);
  const call=async(name:string,args:Record<string,unknown>)=>(await api(f,'/rpc',a.token,'POST',{name,args:{profileId:p.id,...args},owner})).body;
  const opened=await call('chrome_new_tab',{});
  assert.equal(opened.ok,true,JSON.stringify(opened.error));assert.deepEqual(opened.data.group,{groupId:8,title:'A'},'没等心跳也进组');
  assert.equal((await api(f,'/agent-sessions',a.token,'POST',{sessionId,owner})).status,200);
  const wrote=await call('chrome_evaluate',{tabId:opened.data.tabId,expression:'1'});assert.equal(wrote.ok,true,JSON.stringify(wrote.error));
  // 进不了组（例如所在窗口是弹窗）：改成占用，照样能写，并说明原因。
  join={grouped:false,reason:'popup'};
  const loose=await call('chrome_new_tab',{});
  assert.equal(loose.ok,true);assert.equal(loose.data.group,undefined);assert.equal(loose.warnings?.[0]?.code,'TAB_NOT_GROUPED');assert.match(loose.warnings[0].message,/弹窗/);
  const looseWrite=await call('chrome_evaluate',{tabId:loose.data.tabId,expression:'1'});assert.equal(looseWrite.ok,true,JSON.stringify(looseWrite.error));
 }finally{await f.cleanup();}
});

test('两个普通主体使用相同RPC owner也不会相互冒认标签占用',async()=>{
 const f=await fixture();try{
  const p=await fakeProfile(f.config,'A',command=>command.operation==='tabs.list'?[{tabId:7}]:{}),a=f.service.state.createClient('A',[p.id]),b=f.service.state.createClient('B',[p.id]);
  const input={name:'chrome_claim_tab',args:{profileId:p.id,tabId:7},owner:'same-owner'};
  assert.equal((await api(f,'/rpc',a.token,'POST',input)).body.ok,true);
  assert.equal((await api(f,'/rpc',b.token,'POST',input)).body.error.code,'TAB_CLAIMED');
  const rows=(await api(f,'/agents?profileId='+p.id,f.config.token)).body.agents;assert.equal(rows.find((r:any)=>r.id===a.id).tabs[0].claimed,true);assert.equal(rows.find((r:any)=>r.id===b.id).tabs.length,0);
 }finally{await f.cleanup();}
});

test('远程SDK逻辑会话及断线可见，同device/profile过滤且不泄露token',async()=>{
 const f=await fixture();let gateway:Awaited<ReturnType<typeof startGateway>>|undefined,c:Awaited<ReturnType<typeof remoteClient>>|undefined;
 try{
  const p=await fakeProfile(f.config,'A',command=>command.operation==='tabs.list'?[{tabId:7}]:{}),q=await fakeProfile(f.config,'B');
  const device={id:randomUUID(),label:'machine',token:randomBytes(32).toString('hex')},otherDevice={id:randomUUID(),label:'elsewhere',token:randomBytes(32).toString('hex')};
  const a={id:randomUUID(),label:'Remote Codex',profiles:[p.id],readOnly:false,token:randomBytes(32).toString('hex'),deviceId:device.id},b={...a,id:randomUUID(),label:'Other profile',profiles:[q.id],token:randomBytes(32).toString('hex')},other={...a,id:randomUUID(),label:'Other machine',deviceId:otherDevice.id,token:randomBytes(32).toString('hex')};
  const onboarding={platform:'linux' as const,command:['/private/runtime/node','/private/release/gateway-cli.js'],suffix:['--data-dir','/private/gateway']};
  const port=await freePort(),url=`http://127.0.0.1:${port}`;gateway=await startGateway({host:'127.0.0.1',port,devices:[device,otherDevice],agents:[a,b,other]},{onboarding});
  await f.remote.configure({enabled:true,url,token:device.token,profiles:'*',readOnly:false});await until(()=>f.service.agents(p.id).length===1);
  assert.equal(f.service.agents(p.id)[0]!.connectionState,'disconnected');assert.equal(f.remote.status().deviceId,device.id);
  const admin=await api(f,'/agents',f.config.token);assert.deepEqual(admin.body.remote.onboarding,onboarding);
  const scoped=await api(f,`/extension/agents?profileId=${p.id}&instanceId=${f.service.broker.capture(p.id).info.instanceId}`,bridgeToken(f.config));assert.equal(scoped.body.remote.onboarding,undefined);assert.equal(scoped.body.remote.deviceId,undefined);assert.ok(!JSON.stringify(scoped.body).includes('/private/'));
  c=await remoteClient(url,a.token);await until(()=>f.service.agents(p.id)[0]!.sessionCount===1);
  const row=f.service.agents(p.id)[0]!;assert.equal(row.connectionState,'connected');assert.equal(row.connectionEvidence,'mcp_session');
  assert.ok(!JSON.stringify(f.service.agents()).includes(other.label));assert.ok(!JSON.stringify(row).includes(a.token));
  await c.client.callTool({name:'chrome_claim_tab',arguments:{profileId:p.id,tabId:7}});await until(()=>f.service.agents(p.id)[0]!.tabs.some(tab=>tab.claimed&&tab.tabId===7));
  await c.close();c=undefined;await until(()=>f.service.agents(p.id)[0]!.sessionCount===0);
  (f.remote as any).socket.terminate();await until(()=>f.service.agents(p.id)[0]!.connectionState==='unavailable');
 }finally{await c?.close();await gateway?.close();await f.cleanup();}
});

test('远程新增命令元数据有界且拒绝换行/额外字段',()=>{
 assert.equal(RemoteOnboarding.safeParse({platform:'linux',command:['/bin/node','a\nb'],suffix:[]}).success,false);
 assert.equal(RemoteOnboarding.safeParse({platform:'linux',command:Array(7).fill('node'),suffix:[]}).success,false);
 assert.equal(RemoteOnboarding.safeParse({platform:'linux',command:['node'],suffix:[],token:'must-not-serialize'}).success,false);
});

test('远程SDK队列任务占用按可信Agent身份显示，执行结束释放且客户端不能伪造归属',async()=>{
 const f=await fixture();let gateway:Awaited<ReturnType<typeof startGateway>>|undefined,c:Awaited<ReturnType<typeof remoteClient>>|undefined;let release!:()=>void,entered=false;
 const gate=new Promise<void>(resolve=>release=resolve);
 try{
  const p=await fakeProfile(f.config,'A',async command=>{if(command.operation==='tabs.list')return[{tabId:7}];if(command.operation==='page.evaluate'){entered=true;await gate;}return{};});
  const device={id:randomUUID(),label:'machine',token:randomBytes(32).toString('hex')},agent={id:randomUUID(),label:'Task owner',profiles:[p.id],readOnly:false,token:randomBytes(32).toString('hex'),deviceId:device.id};
  const other={...agent,id:randomUUID(),label:'Not owner',token:randomBytes(32).toString('hex')},port=await freePort(),url=`http://127.0.0.1:${port}`;
  gateway=await startGateway({host:'127.0.0.1',port,devices:[device],agents:[agent,other]});
  await f.remote.configure({enabled:true,url,token:device.token,profiles:'*',readOnly:false});await until(()=>f.service.agents(p.id).length===2);c=await remoteClient(url,agent.token);
  const task=(await c.client.callTool({name:'chrome_task_submit',arguments:{profileId:p.id,tabId:7,name:'claimed task',captureOnFailure:false,steps:[{operation:'page.evaluate',args:{expression:'blocking fixture'}}]}})).structuredContent as any;
  assert.equal(task.ok,true);await until(()=>entered);
  const route=`/extension/agents?profileId=${p.id}&instanceId=${f.service.broker.capture(p.id).info.instanceId}`;
  const during=(await api(f,route,bridgeToken(f.config))).body.agents;
  const row=during.find((item:any)=>item.id===`remote:${agent.id}`),otherRow=during.find((item:any)=>item.id===`remote:${other.id}`);
  assert.equal(row.activeOperations,1);assert.equal(row.tabs.length,1);assert.equal(row.tabs[0].tabId,7);assert.equal(row.tabs[0].claimed,true);assert.ok(Date.parse(row.tabs[0].leaseExpiresAt)>Date.now());assert.deepEqual(otherRow.tabs,[]);
  const forged=await c.client.callTool({name:'chrome_claim_tab',arguments:{profileId:p.id,tabId:7,agentKey:`remote:${other.id}`}});assert.equal(forged.isError,true);
  release();await until(()=>f.service.tasks.get(p.id,task.data.id).status==='succeeded'&&f.service.stats().activeTaskProfiles===0);
  assert.equal(f.service.broker.stats().leases,0);const after=(await api(f,route,bridgeToken(f.config))).body.agents;assert.equal(after.find((item:any)=>item.id===`remote:${agent.id}`).activeOperations,0);assert.deepEqual(after.find((item:any)=>item.id===`remote:${agent.id}`).tabs,[]);
 }finally{release();await c?.close();await gateway?.close();await f.cleanup();}
});

test('热载授权收窄/只读/换token使旧principal永久失效，旧任务尾步不复活',async()=>{
 const f=await fixture();let gateway:Awaited<ReturnType<typeof startGateway>>|undefined,c:Awaited<ReturnType<typeof remoteClient>>|undefined,next:Awaited<ReturnType<typeof remoteClient>>|undefined;let release!:()=>void,writes=0;
 const gate=new Promise<void>(r=>release=r);
 try{
  const p=await fakeProfile(f.config,'A',async command=>{if(command.operation==='tabs.list')return[{tabId:7}];if(command.operation==='page.evaluate'){writes++;if(writes===1)await gate;}return{};});
  const device={id:randomUUID(),label:'machine',token:randomBytes(32).toString('hex')},agent={id:randomUUID(),label:'Remote Codex',profiles:'*' as const,readOnly:false,token:randomBytes(32).toString('hex'),deviceId:device.id};
  const port=await freePort(),url=`http://127.0.0.1:${port}`;gateway=await startGateway({host:'127.0.0.1',port,devices:[device],agents:[agent]});await f.remote.configure({enabled:true,url,token:device.token,profiles:'*',readOnly:false});await until(()=>f.remote.status().state==='connected');
  c=await remoteClient(url,agent.token);const submitted=(await c.client.callTool({name:'chrome_task_submit',arguments:{profileId:p.id,tabId:7,name:'no resurrection',captureOnFailure:false,steps:[{operation:'page.evaluate',args:{expression:'first'}},{operation:'page.evaluate',args:{expression:'tail'}}]}})).structuredContent as any;
  await until(()=>writes===1);const old=[...f.service.state.remotePrincipals.values()][0]!;
  const replacement={...agent,token:randomBytes(32).toString('hex')};await gateway.reloadAgents([replacement]);await until(()=>!f.service.state.remotePrincipals.has(old.id));
  next=await remoteClient(url,replacement.token);await next.client.callTool({name:'chrome_profiles',arguments:{}});assert.ok([...f.service.state.remotePrincipals.values()].every(p=>p.id!==old.id));
  assert.equal((await f.service.invoke('chrome_profiles',{},'old',old)).error?.code,'REMOTE_CONNECTION_CHANGED');release();
  await until(()=>['failed','needs_review'].includes(f.service.tasks.get(p.id,submitted.data.id).status));assert.equal(writes,1);
  await next.close();next=undefined;
  await gateway.reloadAgents([{...replacement,readOnly:true,profiles:[p.id]}]);next=await remoteClient(url,replacement.token);
  const denied=(await next.client.callTool({name:'chrome_action',arguments:{profileId:p.id,tabId:7,action:'click',x:1,y:1}})).structuredContent as any;assert.equal(denied.error.code,'CLIENT_READ_ONLY');assert.equal(writes,1);
 }finally{release();await next?.close();await c?.close();await gateway?.close();await f.cleanup();}
});

test('gateway只热加载agents，非法设备/TLS变更保留有效授权并报告脱敏错误',async()=>{
 const f=await fixture();let gateway:Awaited<ReturnType<typeof startGateway>>|undefined;try{
  const device={id:randomUUID(),label:'machine',token:randomBytes(32).toString('hex')},a={id:randomUUID(),label:'A',profiles:'*',readOnly:false,token:randomBytes(32).toString('hex'),deviceId:device.id};
  const config={host:'127.0.0.1',port:await freePort(),devices:[device],agents:[a]},file=path.join(f.config.dataDir,'gateway.json');await writeFile(file,JSON.stringify(config));gateway=await startGateway(config,{agentConfigFile:file});
  const b={...a,id:randomUUID(),label:'B',token:randomBytes(32).toString('hex')};await writeFile(file,JSON.stringify({...config,agents:[a,b]}));await until(()=>gateway!.config.agents.length===2);
  await writeFile(file,JSON.stringify({...config,port:config.port+1,agents:[a]}));await until(()=>!!gateway!.stats().agentReloadError);assert.equal(gateway.config.agents.length,2);assert.ok(!JSON.stringify(gateway.stats()).includes(a.token));
  await writeFile(file,JSON.stringify({...config,agents:[b]}));await until(()=>gateway!.config.agents.length===1&&!gateway!.stats().agentReloadError);assert.equal(gateway.config.agents[0]!.label,'B');
 }finally{await gateway?.close();await f.cleanup();}
});
