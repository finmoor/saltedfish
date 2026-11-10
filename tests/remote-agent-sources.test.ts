import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {fixture,fakeProfile,freePort} from './helpers.js';
import {startGateway} from '../src/remote-gateway.js';
import {bridgeToken} from '../src/auth.js';
import {REMOTE_MACHINE_HEADER,RemoteAgents,encodeRemoteMachineReport,parseRemoteMachineReport,normalizePeerAddress,type RemoteMachineReportValue} from '../src/remote-protocol.js';

const report=(hostname='worker-A'):RemoteMachineReportValue=>({hostname,reportedAddresses:['10.40.0.12','2001:db8::12'],reportId:randomUUID(),reportedAt:new Date().toISOString(),reportSource:'setup_report'});
async function until(check:()=>boolean|Promise<boolean>){const end=Date.now()+6000;while(!await check()){if(Date.now()>end)throw new Error('Condition timed out');await new Promise(resolve=>setTimeout(resolve,20));}}
async function clientAt(url:string,token:string,header?:string){
 const transport=new StreamableHTTPClientTransport(new URL(url+'/mcp'),{requestInit:{headers:{authorization:`Bearer ${token}`,'x-forwarded-for':'198.51.100.77',forwarded:'for=198.51.100.78',...(header!==undefined?{[REMOTE_MACHINE_HEADER]:header}:{})}}});
 const client=new Client({name:'source-test',version:'1'});await client.connect(transport);
 return{client,transport,async close(){await transport.terminateSession().catch(()=>{});await client.close();}};
}
async function scoped(f:Awaited<ReturnType<typeof fixture>>,profileId:string){
 const instanceId=f.service.broker.capture(profileId).info.instanceId;
 const response=await fetch(`http://127.0.0.1:${f.config.port}/extension/agents?profileId=${profileId}&instanceId=${instanceId}`,{headers:{authorization:`Bearer ${bridgeToken(f.config)}`}});
 assert.equal(response.status,200);return await response.json() as any;
}

test('机器报告是有界展示输入，错误头不抛异常，peer地址不信任转发头',()=>{
 const value=report();assert.deepEqual(parseRemoteMachineReport(encodeRemoteMachineReport(value)),value);
 const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
 for(const invalid of [undefined,[],123,'not-json','a'.repeat(2049),encode({...value,hostname:'a\nb'}),encode({...value,hostname:'a'.repeat(129)}),encode({...value,reportedAddresses:['not-ip']}),encode({...value,reportedAddresses:['fe80::1%eth0']}),encode({...value,reportedAddresses:Array(9).fill('10.1.1.1')}),encode({...value,reportId:'invalid'}),encode({...value,reportedAt:'yesterday'}),encode({...value,token:'secret'}),encode({...value,peerAddress:'1.2.3.4'}),encode({...value,reportSource:'verified'})])assert.equal(parseRemoteMachineReport(invalid),undefined);
 assert.equal(normalizePeerAddress('::ffff:127.0.0.1'),'127.0.0.1');assert.equal(normalizePeerAddress('2001:db8::5'),'2001:db8::5');assert.equal(normalizePeerAddress('hostname.invalid'),undefined);
 const old={type:'agents',agents:[{id:randomUUID(),label:'old',profiles:'*',readOnly:false,sessionCount:0,activeOperations:0}]};assert.equal(RemoteAgents.safeParse(old).success,true);
});

test('真实远程会话分别显示报告机器与socket来源；旧/错误报告兼容，断开保留上次来源',async()=>{
 const f=await fixture();let gateway:Awaited<ReturnType<typeof startGateway>>|undefined;const clients:Awaited<ReturnType<typeof clientAt>>[]=[];
 try{
  const p=await fakeProfile(f.config,'A'),q=await fakeProfile(f.config,'B'),device={id:randomUUID(),label:'A',token:randomBytes(32).toString('hex')},otherDevice={...device,id:randomUUID(),label:'B',token:randomBytes(32).toString('hex')};
  const a={id:randomUUID(),label:'shared Agent',deviceId:device.id,token:randomBytes(32).toString('hex'),profiles:[p.id],readOnly:false},b={...a,id:randomUUID(),label:'other profile',profiles:[q.id],token:randomBytes(32).toString('hex')},c={...a,id:randomUUID(),label:'other device',deviceId:otherDevice.id,token:randomBytes(32).toString('hex')};
  const port=await freePort(),url=`http://127.0.0.1:${port}`;gateway=await startGateway({host:'127.0.0.1',port,devices:[device,otherDevice],agents:[a,b,c]});
  await f.remote.configure({enabled:true,url,token:device.token,profiles:'*',readOnly:false});await until(()=>f.remote.status().state==='connected');
  const reports=[report('worker-A'),report('worker-B')];
  for(const value of reports)clients.push(await clientAt(url,a.token,encodeRemoteMachineReport(value)));
  clients.push(await clientAt(url,a.token));clients.push(await clientAt(url,a.token,'a'.repeat(2049)));
  clients.push(await clientAt(url,b.token,encodeRemoteMachineReport(report('hidden-profile'))));clients.push(await clientAt(url,c.token,encodeRemoteMachineReport(report('hidden-device'))));
  await until(()=>f.service.agents(p.id)[0]?.sources?.length===4);
  const response=await scoped(f,p.id),row=response.agents[0],sources=row.sources;
  assert.equal(response.agents.length,1);assert.equal(row.sessionCount,4);assert.equal(new Set(sources.map((source:any)=>source.id)).size,4);
  assert.deepEqual(sources.map((source:any)=>source.hostname),['worker-A','worker-B',undefined,undefined]);
  for(const source of sources){assert.equal(source.peerAddress,'127.0.0.1');assert.equal(source.connected,true);assert.ok(!clients.some(client=>client.transport.sessionId===source.id));}
  assert.deepEqual(sources[0].reportedAddresses,reports[0]!.reportedAddresses);assert.equal(sources[0].reportSource,'setup_report');assert.equal(sources[0].reportId,reports[0]!.reportId);
  const text=JSON.stringify(response);for(const secret of [a.token,b.token,c.token,'198.51.100.77','198.51.100.78','hidden-profile','hidden-device'])assert.ok(!text.includes(secret));
  assert.equal((await clients[3]!.client.callTool({name:'chrome_profiles',arguments:{}})).isError,false);
  const closedSource=sources[0].id;await clients[0]!.close();await until(()=>f.service.agents(p.id)[0]?.sessionCount===3);
  const afterClose=(await scoped(f,p.id)).agents[0];assert.equal(afterClose.sources.find((source:any)=>source.id===closedSource).connected,false);assert.equal(afterClose.sources.filter((source:any)=>source.connected).length,3);
  (f.remote as any).socket.terminate();await until(()=>f.service.agents(p.id)[0]?.connectionState==='unavailable');
  const unavailable=(await scoped(f,p.id)).agents[0];assert.equal(unavailable.sessionCount,0);assert.ok(unavailable.sources.every((source:any)=>source.connected===false));
 }finally{for(const client of clients)await client.close();await gateway?.close();await f.cleanup();}
});

test('来源历史容量受限，授权范围/设备/身份变化清空旧来源且不能复活',async()=>{
 const f=await fixture();let gateway:Awaited<ReturnType<typeof startGateway>>|undefined;let client:Awaited<ReturnType<typeof clientAt>>|undefined;
 try{
  const p=await fakeProfile(f.config,'A'),q=await fakeProfile(f.config,'B'),device={id:randomUUID(),label:'A',token:randomBytes(32).toString('hex')},otherDevice={...device,id:randomUUID(),label:'B',token:randomBytes(32).toString('hex')};
  const a={id:randomUUID(),label:'Agent',deviceId:device.id,token:randomBytes(32).toString('hex'),profiles:'*' as '*'|string[],readOnly:false},port=await freePort(),url=`http://127.0.0.1:${port}`;
  gateway=await startGateway({host:'127.0.0.1',port,devices:[device,otherDevice],agents:[a]});await f.remote.configure({enabled:true,url,token:device.token,profiles:'*',readOnly:false});await until(()=>f.remote.status().state==='connected');
  for(let i=0;i<10;i++){client=await clientAt(url,a.token,encodeRemoteMachineReport(report(`old-${i}`)));await client.close();client=undefined;}
  await until(()=>f.service.agents(p.id)[0]?.sources?.length===8);const histories=f.service.agents(p.id)[0]!.sources!;assert.ok(histories.every(source=>!source.connected));assert.equal(histories.some(source=>source.hostname==='old-0'),false);
  client=await clientAt(url,a.token,encodeRemoteMachineReport(report('active-before-scope')));await until(()=>f.service.agents(p.id)[0]?.sessionCount===1);
  await gateway.reloadAgents([{...a,profiles:[q.id]}]);await until(()=>f.service.agents(p.id).length===0&&f.service.agents(q.id)[0]?.sources?.length===0);
  await client.close();client=undefined;assert.equal(f.service.agents(q.id)[0]!.sources!.length,0);
  client=await clientAt(url,a.token,encodeRemoteMachineReport(report('old-device')));await until(()=>f.service.agents(q.id)[0]?.sessionCount===1);
  await gateway.reloadAgents([{...a,deviceId:otherDevice.id}]);await until(()=>f.service.agents().length===0);await client.close();client=undefined;
  await f.remote.configure({enabled:true,url,token:otherDevice.token,profiles:'*',readOnly:false});await until(()=>f.service.agents(p.id).length===1);assert.deepEqual(f.service.agents(p.id)[0]!.sources,[]);
  const replacement={...a,id:randomUUID(),deviceId:otherDevice.id};await gateway.reloadAgents([replacement]);await until(()=>f.service.agents(p.id)[0]?.id===`remote:${replacement.id}`);assert.deepEqual(f.service.agents(p.id)[0]!.sources,[]);
 }finally{await client?.close();await gateway?.close();await f.cleanup();}
});
