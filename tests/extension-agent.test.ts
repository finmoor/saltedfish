import test, { mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectDir } from '../src/config.js';
import { installDom, readExtension, flush } from './fake-dom.js';
import { defer, uuid } from './fake-app.js';

let instance=0;
const record=(id:number,label:string,extra={})=>({id:uuid(id),label,location:'local',connectionState:'disconnected',connectionEvidence:'configuration',sessionCount:0,activeOperations:0,readOnly:false,tabs:[],...extra});
const group=(title:string,profileId:string,extra={})=>({profileId,groupId:5,windowId:2,title,startedAt:'2026-11-01T07:10:00Z',agentId:'a',sessionId:'a3f9c2',online:true,working:true,tabs:[{tabId:1,title:'订单',active:true}],...extra});
async function mount(t:TestContext){
 const state={settings:{profileId:uuid(1),label:'工作 Chrome',port:17422,serviceUrl:'https://service.example',enabled:true},instanceId:'test-instance',status:{state:'connected',message:'已连接本机服务'},activities:[]};
 const requests:any[]=[],titles:number[]=[],opened:any[]=[],focus:any[]=[],nativeCalls:any[]=[];
 let handler:(id:string)=>unknown=profileId=>({status:200,body:{profileId,agents:[]}});
 const chrome={runtime:{sendMessage:async(message:any)=>{if(message.type==='settings.get')return structuredClone(state);if(message.type==='service.summary'){requests.push({profileId:state.settings.profileId,instanceId:state.instanceId});const response:any=await handler(state.settings.profileId);return response.status===200?response.body:{error:response.status===404?'请更新服务':response.status===403?'没有读取权限':'服务不可访问'};}if(message.type==='service.open'){nativeCalls.push(message);const[route,query]=message.target.split('?');return{ok:true,authenticated:true,url:'https://service.example/?target='+route+(query?'&'+query:'')+'#'+'b'.repeat(64)};}throw new Error('unexpected message');},sendNativeMessage:async(host:string,message:{action:string;target:string})=>{nativeCalls.push({host,message});const[route,query]=message.target.split('?');return{ok:true,url:`https://service.example/?target=${route}${query?'&'+query:''}#${'b'.repeat(64)}`};}},storage:{local:{get:async()=>({settings:{token:'a'.repeat(64)}})}},tabs:{get:async(id:number)=>{titles.push(id);return{title:'合成标签 '+id};},query:async()=>[{id:42,windowId:3,url:'https://service.example/#overview'}],update:async(id:number,args:any)=>{opened.push({id,...args});},create:async(args:any)=>{opened.push(args);}},windows:{update:async(id:number,args:any)=>{focus.push({id,...args});}}};
 mock.timers.enable({apis:['setTimeout','setInterval']});
 const dom=installDom(readExtension('options.html'),{chrome,window:{close:()=>{},confirm:()=>false},fetch:async(value:any,options:any)=>{const url=new URL(String(value));requests.push({url,options});const response:any=url.pathname==='/extension/agents'?await handler(url.searchParams.get('profileId')!):{status:200,body:{enabled:false,allowed:true,state:'disconnected',version:'test'}};return{ok:response.status===200,status:response.status,json:async()=>response.body};}});
 t.after(()=>{dom.uninstall();mock.timers.reset();});
 await import(pathToFileURL(path.join(projectDir,'extension/options.ts')).href+'?agents='+ ++instance);await flush();
 const $=(selector:string)=>{const element=dom.doc.querySelector(selector);if(!element)throw Error('Missing '+selector);return element;};
 return{state,requests,titles,opened,focus,nativeCalls,$,has:(selector:string)=>!!dom.doc.querySelector(selector),setHandler(value:typeof handler){handler=value;},async tick(){mock.timers.tick(2000);await flush();},flush};
}

test('标签组按组显示，按钮交给后台，轮询不重建按钮',async t=>{
 const m=await mount(t),id=m.state.settings.profileId;
 m.setHandler(()=>({status:200,body:{profileId:id,agents:[record(11,'Codex',{connectionState:'connected',connectionEvidence:'heartbeat',sessionCount:1})],groups:[group('Codex',id)]}}));
 await m.tick();assert.match(m.$('#group-list').textContent,/Codex.*会话 a3f9c2.*使用中.*订单/);
 const button=m.$('#group-list').querySelectorAll('button')[0]!;await m.tick();assert.equal(m.$('#group-list').querySelectorAll('button')[0],button,'内容没变不重建，焦点才不会丢');
});

test('扩展只看谁在用，授权和接入留给管理页',async t=>{
 const m=await mount(t),id=m.state.settings.profileId;
 assert.equal(m.has('#add-agent'),false);assert.equal(m.has('#agent-list'),false);
 m.setHandler(()=>({status:200,body:{profileId:id,agents:[record(11,'本机 Codex',{connectionState:'connected',connectionEvidence:'heartbeat',sessionCount:1}),record(12,'配置过的Claude')]}}));
 await m.tick();const text=m.$('#group-list').textContent;
 assert.match(text,/现在没有 Agent 在用这个浏览器/);assert.doesNotMatch(text,/本机 Codex|配置过的Claude/);assert.deepEqual(m.titles,[]);
 assert.ok(m.requests.every(r=>r.profileId===id&&r.instanceId===m.state.instanceId&&!JSON.stringify(r).includes('aaaa')));
 m.setHandler(()=>({status:200,body:{profileId:id,agents:[]}}));await m.tick();assert.match(m.$('#group-list').textContent,/还没有 Agent 获准使用这个浏览器，到管理页授权/);
});

test('读页面不开组的Agent也算在用，不能说没人在用',async t=>{
 const m=await mount(t),id=m.state.settings.profileId;
 m.setHandler(()=>({status:200,body:{profileId:id,agents:[record(11,'读页面的Codex',{connectionState:'connected',working:true}),record(12,'开了组的Claude',{connectionState:'connected',working:true})],groups:[group('开了组的Claude',id,{agentId:uuid(12)})]}}));
 await m.tick();const text=m.$('#group-list').textContent;
 assert.match(text,/读页面的Codex 正在用这个浏览器，没有开标签组/);assert.doesNotMatch(text,/开了组的Claude 正在用/);assert.doesNotMatch(text,/现在没有 Agent/);
});

test('打开管理页经当前服务通信复用当前配置管理页，只带一次码',async t=>{
 const m=await mount(t);m.$('#open-workbench').click();await m.flush();
 assert.deepEqual(m.nativeCalls,[{type:'service.open',target:'overview'}]);
 assert.equal(m.opened.length,1);assert.equal(m.opened[0].id,42);const url=new URL(m.opened[0].url);assert.equal(url.hash,'#'+'b'.repeat(64));const query=url.searchParams;assert.equal(query.get('target'),'overview');assert.equal(query.size,1);assert.doesNotMatch(url.href,/aaaa/);assert.deepEqual(m.focus,[{id:3,focused:true}]);
});

test('暂停或切换配置使旧响应失效，不能在新配置下展示旧Agent',async t=>{
 const m=await mount(t),slow=defer<any>();m.setHandler(()=>slow.promise);await m.tick();
 m.state.settings.enabled=false;m.state.status.state='disconnected';await m.tick();slow.resolve({status:200,body:{profileId:uuid(1),agents:[record(1,'迟到的Agent')],groups:[group('迟到的Agent',uuid(1))]}});await m.flush();
 assert.equal(m.$('#group-list').textContent,'');assert.match(m.$('#agents-status').textContent,/已暂停/);
});

test('超过轮询间隔的请求仍可完成，身份不匹配或权限拒绝明确清空',async t=>{
 const m=await mount(t),slow=defer<any>();m.setHandler(()=>slow.promise);await m.tick();const before=m.requests.length;await m.tick();assert.equal(m.requests.length,2,'在途同身份请求不重复发起');
 slow.resolve({status:200,body:{profileId:m.state.settings.profileId,agents:[record(11,'慢响应')],groups:[group('慢响应',m.state.settings.profileId)]}});await m.flush();assert.match(m.$('#group-list').textContent,/慢响应/);
 m.setHandler(()=>({status:200,body:{profileId:uuid(99),agents:[record(12,'另一个浏览器')]}}));await m.tick();assert.equal(m.$('#group-list').textContent,'');assert.match(m.$('#agents-status').textContent,/身份不匹配/);
 m.setHandler(()=>({status:403,body:{}}));await m.tick();assert.match(m.$('#agents-status').textContent,/读取权限/);assert.equal(m.$('#agents-status').dataset.error,'true');assert.ok(before>0);
});

test('旧服务没有Agent端点时说明升级，浏览器名称和基础设置仍可见',async t=>{
 const m=await mount(t);m.setHandler(()=>({status:404,body:{}}));await m.tick();
 assert.match(m.$('#agents-status').textContent,/更新服务/);assert.equal(m.$('#profile-name').textContent,'工作 Chrome');assert.equal(m.$('#browser-settings').hidden,true);assert.equal(m.$('#settings').elements.namedItem('label'),null);
});

test('服务地址无效时不请求Agent摘要',async t=>{
 const m=await mount(t);const before=m.requests.length;m.state.settings.serviceUrl='http://invalid.example';await m.tick();
 assert.equal(m.requests.length,before);assert.match(m.$('#agents-status').textContent,/服务地址无效/);
});
