import test from 'node:test';
import assert from 'node:assert/strict';
import {navigatePage} from '../extension/navigation.js';
import {BrowserError} from '../src/shared.js';

function fixture(){
 let listener:((method:string,params:any)=>void)|undefined,removed=0,cancelled=false,navigations=0;
 let frame:any={id:'main',loaderId:'old',url:'https://fixture.invalid/old'};
 let navigate=async()=>({frameId:'main',loaderId:'new'} as any);
 const emit=(method:string,params:any)=>listener?.(method,params);
 const options={url:'https://fixture.invalid/new',wait:true,deadline:Date.now()+1000,
  async send(method:string){if(method==='Page.getFrameTree')return {frameTree:{frame:{...frame}}};if(method==='Page.navigate'){navigations++;return navigate();}return {};},
  async tab(){return {tabId:1,status:'complete',url:frame.url};},
  subscribe(fn:typeof listener){listener=fn;return()=>{listener=undefined;removed++;};},
  assertActive(){if(cancelled)throw new BrowserError('CANCELLED','test cancellation');},
 };
 const loaded=(loader='new')=>{frame={...frame,loaderId:loader,url:options.url};emit('Page.frameNavigated',{frame});emit('Page.lifecycleEvent',{frameId:'main',loaderId:loader,name:'load'});};
 return {options,emit,loaded,get listeners(){return listener?1:0;},get removed(){return removed;},get navigations(){return navigations;},set navigate(fn:typeof navigate){navigate=fn;},cancel(){cancelled=true;},set frame(value:any){frame=value;}};
}
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));

test('navigation ignores old complete state and other frame/loader load events',async()=>{
 const f=fixture();let done=false;const pending=navigatePage(f.options).then(r=>{done=true;return r;});await pause(10);
 f.emit('Page.lifecycleEvent',{frameId:'main',loaderId:'old',name:'load'});f.emit('Page.lifecycleEvent',{frameId:'child',loaderId:'new',name:'load'});
 await pause(25);assert.equal(done,false);f.loaded();assert.equal((await pending).url,f.options.url);assert.equal(f.navigations,1);assert.equal(f.listeners,0);assert.equal(f.removed,1);
});
test('navigation captures load before the command reply and accepts explicit blank target',async()=>{
 const f=fixture();f.options.url='about:blank';f.navigate=async()=>{f.loaded();return {frameId:'main',loaderId:'new'};};assert.equal((await navigatePage(f.options)).url,'about:blank');assert.equal(f.listeners,0);
});
test('same-document reply needs no new load and keeps the previous loader',async()=>{
 const f=fixture();f.options.url='https://fixture.invalid/old#next';f.navigate=async()=>{f.frame={id:'main',loaderId:'old',url:f.options.url};return {frameId:'main'};};assert.equal((await navigatePage(f.options)).url,f.options.url);
});
test('a replacement loader cannot satisfy the original navigation',async()=>{
 const f=fixture();const pending=navigatePage(f.options);await pause(10);f.loaded('replacement');await assert.rejects(pending,(e:any)=>e.code==='NAVIGATION_CHANGED');assert.equal(f.listeners,0);
});
test('cancellation also interrupts a pending Page.navigate reply and removes observers',async()=>{
 const f=fixture();let reply!:(r:any)=>void;f.navigate=()=>new Promise(r=>{reply=r;});const pending=navigatePage(f.options);await pause(10);f.cancel();await assert.rejects(pending,(e:any)=>e.code==='CANCELLED');assert.equal(f.listeners,0);assert.equal(f.navigations,1);reply({frameId:'main',loaderId:'new'});await pause(10);assert.equal(f.navigations,1);
});
test('navigation timeout keeps unknown, cleans observers and never stops or repeats navigation',async()=>{
 const f=fixture();f.options.deadline=Date.now()+70;await assert.rejects(navigatePage(f.options),(e:any)=>e.code==='NAVIGATION_TIMEOUT'&&e.details.outcome==='unknown');assert.equal(f.listeners,0);assert.equal(f.navigations,1);
});
test('deadline before dispatch never starts navigation; wait=false needs no observer',async()=>{
 const f=fixture();f.options.deadline=Date.now()-1;await assert.rejects(navigatePage(f.options),(e:any)=>e.code==='DEADLINE_EXCEEDED'&&e.details.outcome==='not_dispatched');assert.equal(f.navigations,0);
 f.options.deadline=Date.now()+1000;f.options.wait=false;assert.equal((await navigatePage(f.options)).loaderId,'new');assert.equal(f.removed,0);assert.equal(f.listeners,0);
});
test('网络错误只有证明没经过重定向才算未派发，重定向后的失败保留结果不明',async()=>{
 for(const [finalUrl,outcome] of [['https://fixture.invalid/new','not_dispatched'],['https://other.invalid/redirected','unknown']] as const){
  const f=fixture();const send=f.options.send;
  f.options.send=async(method:string)=>{
   if(method==='Page.navigate')return {errorText:'net::ERR_CONNECTION_REFUSED'};
   if(method==='Page.getNavigationHistory')return {currentIndex:0,entries:[{id:1,url:finalUrl}]};
   return send(method);
  };
  await assert.rejects(navigatePage(f.options),(e:any)=>e.code==='NAVIGATION_FAILED'&&e.details.outcome===outcome);
 }
 // 读不到历史也不能证明，保留结果不明
 const g=fixture();const base=g.options.send;
 g.options.send=async(method:string)=>{if(method==='Page.navigate')return {errorText:'net::ERR_NAME_NOT_RESOLVED'};if(method==='Page.getNavigationHistory')throw new Error('gone');return base(method);};
 await assert.rejects(navigatePage(g.options),(e:any)=>e.details.outcome==='unknown');
});
test('失败后标签页换进程时暂时查不了历史，稍等再查仍能判出没经过重定向',async()=>{
 const f=fixture();const send=f.options.send;let tries=0;
 f.options.send=async(method:string)=>{
  if(method==='Page.navigate')return {errorText:'net::ERR_CONNECTION_REFUSED'};
  if(method==='Page.getNavigationHistory'){if(++tries<3)throw new Error('Not attached to an active page');return {currentIndex:0,entries:[{id:1,url:'https://fixture.invalid/new'}]};}
  return send(method);
 };
 await assert.rejects(navigatePage(f.options),(e:any)=>e.code==='NAVIGATION_FAILED'&&e.details.outcome==='not_dispatched');
 assert.equal(tries,3);assert.equal(f.listeners,0);
});
