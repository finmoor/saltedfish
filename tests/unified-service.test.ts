import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {WebSocket} from 'ws';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {fixture,FAKE_CAPABILITIES,testDirectory,freePort} from './helpers.js';
import {startServer} from '../src/http-server.js';
import type {Config} from '../src/config.js';
import {bridgeProof,bridgeToken,extensionUpdateProof} from '../src/auth.js';
import {BRIDGE_PROTOCOL,type WireCommand} from '../src/shared.js';
import {serviceAddress,bridgeAddress,extensionOrigin} from '../src/service-address.js';
import {serviceNetwork} from '../src/service-network.js';
import {parseBrowserConnection} from '../src/browser-connection.js';
import {configureServer,serverOptions} from '../src/service-config.js';

const fresh=()=>fixture({},config=>startServer({...config,network:{host:'127.0.0.1',publicUrl:`http://127.0.0.1:${config.port}`}}));
async function browser(config:Config,pairing:{pairingId:string;token:string},id=randomUUID()){
 const origin=`chrome-extension://${'a'.repeat(32)}`,socket=new WebSocket(`ws://127.0.0.1:${config.port}/bridge`,{origin}),nonce=randomBytes(16).toString('hex'),instanceId=randomUUID();await once(socket,'open');
 let next=once(socket,'message');socket.send(JSON.stringify({type:'hello',protocol:BRIDGE_PROTOCOL,nonce,pairingId:pairing.pairingId}));const challenge=JSON.parse(String((await next)[0]));
 if(challenge.type==='challenge'){assert.equal(challenge.proof,bridgeProof(pairing.token,'server',nonce,challenge.nonce));next=once(socket,'message');socket.send(JSON.stringify({type:'auth',proof:bridgeProof(pairing.token,'client',nonce,challenge.nonce,id,instanceId),profile:{id,instanceId,label:'直连浏览器',version:'test',userAgent:'test',capabilities:FAKE_CAPABILITIES}}));}
 const ready=challenge.type==='challenge'?JSON.parse(String((await next)[0])):challenge;
 socket.on('message',data=>{const command=JSON.parse(String(data)) as WireCommand;if(command.type==='command')socket.send(JSON.stringify({type:'result',id:command.id,result:command.operation==='tabs.list'?[{tabId:7,url:'https://example.test/'}]:{ok:true}}));});
 return{id,instanceId,socket,ready};
}
const headers=(token:string)=>({authorization:'Bearer '+token,'content-type':'application/json'});

test('统一地址允许HTTPS与私网IP的HTTP，拒绝公网明文、凭据、路径和Origin变体',()=>{
 assert.equal(serviceAddress('https://service.example/'),'https://service.example');assert.equal(bridgeAddress('https://service.example'),'wss://service.example/bridge');assert.ok(extensionOrigin('chrome-extension://'+'a'.repeat(32)));assert.equal(extensionOrigin('chrome-extension://'+'a'.repeat(32)+'\n'),false);
 for(const value of ['http://192.168.1.10','http://10.0.0.1','http://172.16.0.1','http://172.31.255.254','http://[fd12::1]'])assert.equal(serviceAddress(value),new URL(value).origin);
 assert.equal(bridgeAddress('http://192.168.1.10:18445'),'ws://192.168.1.10:18445/bridge');
 for(const value of ['http://service.example','http://172.15.0.1','http://172.32.0.1','http://192.167.1.1','http://1.1.1.1','https://user:key@service.example','https://service.example/path','https://service.example/?token=x','https://service.example/#key',' https://service.example','https://service.example\\evil'])assert.throws(()=>serviceAddress(value));
 assert.throws(()=>serviceNetwork({port:17422,token:'a'.repeat(64),dataDir:'test',outputLimit:100,eventLimit:100,network:{host:'0.0.0.0',publicUrl:'https://service.example'}}));
 const config={port:18445,token:'a'.repeat(64),dataDir:'test',outputLimit:100,eventLimit:100,network:{host:'192.168.1.10',publicUrl:'http://192.168.1.10:18445'}};
 assert.throws(()=>serviceNetwork(config));assert.equal(serviceNetwork({...config,network:{...config.network,allowInsecureLan:true}}).host,'192.168.1.10');
 for(const host of ['0.0.0.0','1.1.1.1','192.168.1.11'])assert.throws(()=>serviceNetwork({...config,network:{...config.network,host,allowInsecureLan:true}}));
});

test('内网HTTP启动配置必须明确启用，拒绝公网或通配监听且失败不改配置文件',async t=>{
 const temp=await testDirectory();t.after(()=>temp.cleanup());const port=await freePort(),config:Config={port,token:randomBytes(32).toString('hex'),dataDir:temp.directory,outputLimit:24000,eventLimit:100,directConnections:true},file=path.join(temp.directory,'config.json');
 await writeFile(file,JSON.stringify(config));const before=await readFile(file,'utf8'),args=['--host','192.168.1.10','--url',`http://192.168.1.10:${port}`];
 await assert.rejects(()=>configureServer(config,args),/需明确启用/);assert.equal(await readFile(file,'utf8'),before);
 for(const host of ['0.0.0.0','1.1.1.1','192.168.1.11']){await assert.rejects(()=>configureServer(config,['--host',host,'--url',`http://192.168.1.10:${port}`,'--allow-insecure-lan']),/^Error: 跨机器HTTP需明确启用/);assert.equal(await readFile(file,'utf8'),before);}
 assert.throws(()=>serverOptions([...args,'--allow-insecure-lan','--allow-insecure-lan']));assert.throws(()=>serverOptions([...args,'--allow-insecure-lan','--cert','test.pem','--key','test.key']),/只能选择一种/);
 const configured=await configureServer(config,[...args,'--allow-insecure-lan']);assert.equal(configured.serviceUrl,`http://192.168.1.10:${port}`);const saved=JSON.parse(await readFile(file,'utf8'));assert.equal(saved.network.allowInsecureLan,true);assert.equal(saved.network.host,'192.168.1.10');
});

test('扩展更新信息只给已连接的配对浏览器，证明绑定版本、哈希和这次的随机数，更新包只放行扩展来源',async t=>{
 const f=await fresh();t.after(()=>f.cleanup());const p=await f.pairings.create({label:'A'}),a=await browser(f.config,p);t.after(()=>a.socket.terminate());
 assert.ok(typeof a.ready.extensionRelease?.version==='string','握手告诉扩展这个服务带的版本');
 const base=`http://127.0.0.1:${f.config.port}`,nonce=randomBytes(16).toString('hex'),address=(extra='',query=`profileId=${a.id}&instanceId=${a.instanceId}&pairingId=${p.pairingId}`)=>`${base}/extension/update?${query}${extra}`;
 const response=await fetch(address('&nonce='+nonce),{headers:headers(p.token)});assert.equal(response.status,200);const offer=await response.json();
 assert.equal(offer.proof,extensionUpdateProof(p.token,a.id,nonce,offer.version,offer.sha256));assert.notEqual(offer.proof,extensionUpdateProof(p.token,a.id,randomBytes(16).toString('hex'),offer.version,offer.sha256),'随机数变了证明就不一样');assert.equal(JSON.stringify(offer).includes(p.token),false);
 assert.equal((await fetch(address(),{headers:headers(p.token)})).status,400);assert.equal((await fetch(address('&nonce=short'),{headers:headers(p.token)})).status>=400,true);
 assert.equal((await fetch(address('&nonce='+nonce),{headers:headers('b'.repeat(64))})).status,401);
 const other=await f.pairings.create({label:'B'});assert.equal((await fetch(address('&nonce='+nonce,`profileId=${a.id}&instanceId=${a.instanceId}&pairingId=${other.pairingId}`),{headers:headers(other.token)})).status,401,'别的配对不能替这个浏览器取证明');
 const extension=`chrome-extension://${'a'.repeat(32)}`,download=await fetch(base+'/download/extension.zip',{headers:{origin:extension}});assert.equal(download.status,200);assert.equal(download.headers.get('access-control-allow-origin'),extension);
 assert.equal(createHash('sha256').update(Buffer.from(await download.arrayBuffer())).digest('hex'),offer.sha256,'下载到的包就是证明里的包');
 assert.equal((await fetch(base+'/download/extension.zip',{headers:{origin:'https://evil.example'}})).status,403);assert.equal((await fetch(base+'/download/extension.zip')).status,200,'没有来源的普通下载不变');
});

test('独立浏览器配对绑定原UUID，错误配对不能占用另一浏览器；部署地址不改变执行核心',async t=>{
 const f=await fresh();t.after(()=>f.cleanup());const p=await f.pairings.create({label:'A'}),a=await browser(f.config,p);t.after(()=>a.socket.terminate());assert.equal(a.ready.type,'ready');assert.equal(a.ready.unified,true);assert.equal(f.service.broker.profiles.get(a.id)?.info.connectionType,'direct');
 const wrong=await browser(f.config,p);t.after(()=>wrong.socket.terminate());assert.equal(wrong.ready.type,'rejected');assert.equal(f.service.broker.profiles.size,1);
 const summary=await fetch(`http://127.0.0.1:${f.config.port}/extension/agents?profileId=${a.id}&instanceId=${a.instanceId}&pairingId=${p.pairingId}`,{headers:headers(p.token)});assert.equal(summary.status,200);const data=await summary.json();assert.equal(data.profileId,a.id);assert.equal(data.canManage,false);assert.ok(!JSON.stringify(data).includes(p.token));
 const legacy=new WebSocket(`ws://127.0.0.1:${f.config.port}/bridge`,{origin:'chrome-extension://'+'a'.repeat(32)});t.after(()=>legacy.terminate());await once(legacy,'open');const answer=once(legacy,'message');legacy.send(JSON.stringify({type:'hello',protocol:BRIDGE_PROTOCOL,nonce:randomBytes(16).toString('hex')}));assert.equal(JSON.parse(String((await answer)[0])).code,'PAIRING_REQUIRED');
});

test('连接凭据不能签管理登录码，单独管理授权可撤销且立即使会话及未消费码失效',async t=>{
 const f=await fresh();t.after(()=>f.cleanup());const p=await f.pairings.create({label:'管理员浏览器',canManage:true}),a=await browser(f.config,p);t.after(()=>a.socket.terminate());const root=`http://127.0.0.1:${f.config.port}`;
 const open=(token:string)=>fetch(root+'/extension/session-code',{method:'POST',headers:headers(token),body:JSON.stringify({pairingId:p.pairingId,profileId:a.id,instanceId:a.instanceId,target:'agents?profile='+a.id+'&add=1'})});
 assert.equal((await open(p.token)).status,401);assert.equal((await open(bridgeToken(f.config))).status,401);
 const issued=await open(p.managerToken!);assert.equal(issued.status,200);const url=new URL((await issued.json()).url);assert.equal(url.origin,root);assert.equal(url.searchParams.get('target'),'agents');assert.equal(url.searchParams.get('profile'),a.id);assert.notEqual(url.hash.slice(1),f.config.token);
 const login=await fetch(root+'/session',{method:'POST',headers:headers(url.hash.slice(1))});assert.equal(login.status,200);const session=(await login.json()).token;assert.equal((await fetch(root+'/dashboard',{headers:headers(session)})).status,200);
 const unused=new URL((await (await open(p.managerToken!)).json()).url).hash.slice(1);
 const revoke=await fetch(root+'/browser-pairings/'+p.pairingId+'/management',{method:'DELETE',headers:headers(f.config.token)});assert.equal(revoke.status,200);
 assert.equal((await fetch(root+'/dashboard',{headers:headers(session)})).status,401);assert.equal((await fetch(root+'/session',{method:'POST',headers:headers(unused)})).status,401);assert.equal((await open(p.managerToken!)).status,401);assert.equal(f.service.broker.profiles.get(a.id)?.socket.readyState,WebSocket.OPEN);
});

test('服务重启后客户端带着旧会话回来：按原 ID 接上，owner 不变，不用重新初始化',async t=>{
 const f=await fresh();t.after(()=>f.cleanup());const page=await browser(f.config,await f.pairings.create({label:'A'}));t.after(()=>page.socket.terminate());
 const agent=f.service.state.createClient('one',[page.id]),other=f.service.state.createClient('two',[page.id]),id=randomUUID(),url=`http://127.0.0.1:${f.config.port}/mcp`;
 const post=(token:string,method:string,params:object,session:string=id)=>fetch(url,{method:'POST',headers:{...headers(token),'content-type':'application/json',accept:'application/json, text/event-stream','mcp-session-id':session},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
 const first=await post(agent.token,'tools/list',{});assert.equal(first.status,200);assert.equal((await first.json()).result.tools.length,46);assert.equal(first.headers.get('mcp-session-id'),id);
 const claimed=await post(agent.token,'tools/call',{name:'chrome_claim_tab',arguments:{profileId:page.id,tabId:7}});assert.equal((await claimed.json()).result.structuredContent.ok,true);
 const same=f.service.agents().find(p=>p.id===agent.id);assert.equal(same?.sessionCount,1);assert.equal(same?.sessions?.[0]?.local,true,'连接两端是同一台电脑');assert.equal(same?.sources,undefined);
 assert.equal((await post(other.token,'tools/list',{})).status,404,'另一个 Agent 接不到这条会话');
 assert.equal((await post(agent.token,'tools/list',{},'not-a-session')).status,404);
 assert.equal((await fetch(url,{method:'DELETE',headers:{...headers(agent.token),'mcp-session-id':randomUUID()}})).status,404,'结束不存在的会话不会新建一条');assert.equal(f.service.agents().find(p=>p.id===agent.id)?.sessionCount,1);
 assert.equal((await fetch(url,{method:'DELETE',headers:{...headers(agent.token),'mcp-session-id':id}})).status,200);assert.equal(f.service.agents().find(p=>p.id===agent.id)?.sessionCount,0);
});

test('HTTP MCP直接执行、共享租约和客户端授权：两Agent可见范围隔离，撤销后立即拒绝',async t=>{
 const f=await fresh();t.after(()=>f.cleanup());const first=await browser(f.config,await f.pairings.create({label:'A'})),second=await browser(f.config,await f.pairings.create({label:'B'}));t.after(()=>{first.socket.terminate();second.socket.terminate();});
 const one=f.service.state.createClient('one',[first.id]),two=f.service.state.createClient('two',[first.id,second.id]);
 const connect=async(token:string)=>{const sdk=new Client({name:'direct-http-test',version:'1'}),transport=new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${f.config.port}/mcp`),{requestInit:{headers:headers(token)}});await sdk.connect(transport);t.after(async()=>{await transport.terminateSession().catch(()=>{});await sdk.close();});return sdk;};
 const a=await connect(one.token),b=await connect(two.token);assert.equal((await a.listTools()).tools.length,46);
 const call=async(client:Client,name:string,args={})=>(await client.callTool({name,arguments:args})).structuredContent as any;
 assert.deepEqual((await call(a,'chrome_profiles')).data.profiles.map((p:any)=>p.id),[first.id]);assert.equal((await call(b,'chrome_profiles')).data.profiles.length,2);
 assert.equal((await call(a,'chrome_claim_tab',{profileId:first.id,tabId:7})).ok,true);assert.equal((await call(b,'chrome_claim_tab',{profileId:first.id,tabId:7})).ok,false);
 const agents=f.service.agents();assert.equal(agents.find(p=>p.id===one.id)?.connectionEvidence,'mcp_session');assert.equal(agents.find(p=>p.id===one.id)?.sessions?.[0]?.local,true);
 f.service.state.revokeClient(one.id);await assert.rejects(()=>a.listTools());assert.equal((await b.listTools()).tools.length,46);
 assert.equal((await fetch(`http://127.0.0.1:${f.config.port}/mcp`,{headers:{...headers(two.token),origin:'https://foreign.example'}})).status,403);
});

test('配对撤销断开指定插件并持久保存，另一浏览器连接保持',async t=>{
 const f=await fresh();t.after(()=>f.cleanup());const p=await f.pairings.create({label:'A'}),a=await browser(f.config,p),b=await browser(f.config,await f.pairings.create({label:'B'}));t.after(()=>{a.socket.terminate();b.socket.terminate();});const closed=once(a.socket,'close');
 assert.equal((await fetch(`http://127.0.0.1:${f.config.port}/browser-pairings/${p.pairingId}`,{method:'DELETE',headers:headers(f.config.token)})).status,200);await closed;assert.equal(b.socket.readyState,WebSocket.OPEN);assert.equal(f.pairings.get(p.pairingId),undefined);
});

async function disconnect(f:Awaited<ReturnType<typeof fresh>>,target:{id:string;socket:WebSocket}){target.socket.terminate();for(let i=0;i<100&&f.service.broker.profiles.has(target.id);i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.service.broker.profiles.has(target.id),false);}

test('重新连接：离线浏览器换发配对码，原令牌作废、管理授权沿用；在线的不能被顶掉',async t=>{
 const f=await fresh();t.after(()=>f.cleanup());const root=`http://127.0.0.1:${f.config.port}`,p=await f.pairings.create({label:'A',canManage:true}),a=await browser(f.config,p);t.after(()=>a.socket.terminate());
 const pair=(body:object)=>fetch(root+'/browser-pairings',{method:'POST',headers:headers(f.config.token),body:JSON.stringify(body)}),code=async(response:Response)=>{assert.equal(response.status,400);return(await response.json()).error.code;};
 assert.equal(await code(await pair({label:'A',profileId:a.id,replace:true})),'PROFILE_ONLINE');assert.ok(f.pairings.get(p.pairingId),'在线的配对不受影响');assert.equal(a.socket.readyState,WebSocket.OPEN);
 assert.equal(await code(await pair({label:'A',replace:true})),'PROFILE_REQUIRED');await disconnect(f,a);
 assert.equal(await code(await pair({label:'A',profileId:a.id})),'PROFILE_ALREADY_PAIRED','不带 replace 仍然拒绝');assert.ok(f.pairings.get(p.pairingId));
 const response=await pair({label:'A',profileId:a.id,replace:true});assert.equal(response.status,201);const next=await response.json();
 assert.equal(f.pairings.get(p.pairingId),undefined,'原配对作废');assert.ok(next.managerToken,'管理授权沿用');
 const parsed=parseBrowserConnection(next.connectionCode);assert.equal(parsed.profileId,a.id);assert.equal(parsed.pairingId,next.pairingId);assert.equal(parsed.token,next.token);
 const stale=await browser(f.config,p,a.id);t.after(()=>stale.socket.terminate());assert.equal(stale.ready.type,'rejected','原令牌连不上');
 const back=await browser(f.config,next,a.id);t.after(()=>back.socket.terminate());assert.equal(back.ready.type,'ready','同一身份用新配对连上');assert.equal(f.pairings.list().filter(item=>!item.revoked).length,1);
});

test('移除离线浏览器时配对一起作废，原扩展回来也连不上',async t=>{
 const f=await fresh();t.after(()=>f.cleanup());const root=`http://127.0.0.1:${f.config.port}`,p=await f.pairings.create({label:'A'}),a=await browser(f.config,p);t.after(()=>a.socket.terminate());await disconnect(f,a);
 const removed=await fetch(root+'/profiles/abandon',{method:'POST',headers:headers(f.config.token),body:JSON.stringify({profileId:a.id,expectedUnknown:0,confirm:true})});assert.equal(removed.status,200);
 assert.equal(f.pairings.get(p.pairingId),undefined);assert.equal(f.service.listProfiles({admin:true} as never).some(item=>item.id===a.id),false);
 const back=await browser(f.config,p,a.id);t.after(()=>back.socket.terminate());assert.equal(back.ready.type,'rejected');
});

test('高级工具开关：每个 Agent 一份，改完新会话生效，只影响目录不影响调用',async()=>{
 const f=await fresh();const admin=headers(f.config.token),base=`http://127.0.0.1:${f.config.port}`;
 const catalog=async(token:string)=>{const client=new Client({name:'advanced-switch',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+token}}}));try{return (await client.listTools()).tools.map(tool=>tool.name);}finally{await client.close();}};
 try{
  const created=await(await fetch(base+'/clients',{method:'POST',headers:admin,body:JSON.stringify({label:'工具开关'})})).json() as any;assert.equal(created.advancedTools,false);
  const settings=async()=>(await(await fetch(base+'/client-settings',{headers:headers(created.token)})).json() as any).advancedTools;
  assert.equal(await settings(),false);assert.equal((await catalog(created.token)).length,46);
  const denied=await fetch(`${base}/clients/${created.id}`,{method:'PATCH',headers:headers(created.token),body:JSON.stringify({advancedTools:true})});assert.notEqual(denied.status,200,'Agent 不能改自己的开关');
  const changed=await fetch(`${base}/clients/${created.id}`,{method:'PATCH',headers:admin,body:JSON.stringify({advancedTools:true})});assert.deepEqual(await changed.json(),{updated:true,advancedTools:true});
  assert.equal(await settings(),true);const full=await catalog(created.token);assert.equal(full.length,64);assert.ok(full.includes('chrome_task_submit'));
  const listed=(await(await fetch(base+'/agents',{headers:admin})).json() as any).agents.find((agent:any)=>agent.id===created.id);assert.equal(listed.advancedTools,true);
  assert.equal((await catalog(created.token)).length,64,'重连后仍然生效');
  const preset=await(await fetch(base+'/clients',{method:'POST',headers:admin,body:JSON.stringify({label:'新建时打开',advancedTools:true})})).json() as any;assert.equal((await catalog(preset.token)).length,64);
  const missing=await fetch(`${base}/clients/${randomUUID()}`,{method:'PATCH',headers:admin,body:JSON.stringify({advancedTools:true})});assert.deepEqual(await missing.json(),{updated:false,advancedTools:true});
 }finally{await f.cleanup();}
});
