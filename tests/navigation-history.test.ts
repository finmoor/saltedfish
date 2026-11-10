import test from 'node:test';
import assert from 'node:assert/strict';
import {navigatePage} from '../extension/navigation.js';
import {BrowserError,type JsonObject} from '../src/shared.js';

function fixture(action:'back'|'forward'|'reload'){
 const entries=[{id:10,url:'https://example.test/one'},{id:20,url:'https://example.test/two'},{id:30,url:'https://example.test/three'}];
 let currentIndex=1,frame={id:'main',loaderId:'old',url:entries[1]!.url},listener:((method:string,params:JsonObject)=>void)|undefined;
 const sent:{method:string;params?:JsonObject}[]=[];
 let dispatch:()=>Promise<JsonObject>=async()=>({});
 const options={action,wait:true,deadline:Date.now()+1000,validateUrl:(_url:string)=>{},assertActive:()=>{},
  send:async(method:string,params?:JsonObject)=>{sent.push({method,params});if(method==='Page.getNavigationHistory')return {currentIndex,entries};if(method==='Page.getFrameTree')return {frameTree:{frame:{...frame}}};if(['Page.reload','Page.navigateToHistoryEntry'].includes(method))return dispatch();return {};},
  tab:async()=>({status:'complete',url:frame.url}),subscribe:(fn:typeof listener)=>{listener=fn;return()=>{listener=undefined;};},
 };
 const emit=(method:string,params:JsonObject)=>listener?.(method,params);
 return {options,sent,entries,emit,get listeners(){return listener?1:0;},set dispatch(fn:typeof dispatch){dispatch=fn;},set index(value:number){currentIndex=value;},
  complete(index:number,loader='new',restored=false){currentIndex=index;frame={...frame,loaderId:loader,url:entries[index]!.url};emit('Page.frameNavigated',{frame:{...frame},...(restored?{type:'BackForwardCacheRestore'}:{})});if(!restored)emit('Page.lifecycleEvent',{frameId:'main',loaderId:loader,name:'load'});},
  sameDocument(index:number){currentIndex=index;frame={...frame,url:entries[index]!.url};emit('Page.navigatedWithinDocument',{frameId:'main',url:frame.url});},
 };
}
const pause=(ms=10)=>new Promise(resolve=>setTimeout(resolve,ms));
test('back and forward dispatch exactly the adjacent entry once and wait for its completed document',async()=>{
 for(const [action,index] of [['back',0],['forward',2]] as const){const f=fixture(action);let done=false;const pending=navigatePage(f.options).then(r=>{done=true;return r;});await pause();assert.equal(done,false);f.complete(index);assert.equal((await pending).url,f.entries[index]!.url);assert.deepEqual(f.sent.filter(x=>x.method==='Page.navigateToHistoryEntry').map(x=>x.params),[{entryId:f.entries[index]!.id}]);assert.equal(f.listeners,0);}
});
test('history handles BFCache restore and same-document navigation without waiting for a nonexistent load event',async()=>{
 const restored=fixture('back');restored.dispatch=async()=>{restored.complete(0,'bfcache-old-loader',true);return {};};assert.equal((await navigatePage(restored.options)).url,restored.entries[0]!.url);
 const same=fixture('back');same.dispatch=async()=>{same.sameDocument(0);return {};};assert.equal((await navigatePage(same.options)).url,same.entries[0]!.url);
});
test('reload ignores the old complete tab state and waits for a newly committed loader',async()=>{
 const f=fixture('reload');let done=false;const pending=navigatePage(f.options).then(r=>{done=true;return r;});await pause();f.emit('Page.lifecycleEvent',{frameId:'main',loaderId:'old',name:'load'});await pause();assert.equal(done,false);f.complete(1);assert.equal((await pending).action,'reload');assert.equal(f.sent.filter(x=>x.method==='Page.reload').length,1);
});
test('missing history and protected destinations fail before dispatch',async()=>{
 const empty=fixture('back');empty.index=0;await assert.rejects(navigatePage(empty.options),(e:any)=>e.code==='HISTORY_ENTRY_NOT_FOUND'&&e.details.outcome==='not_dispatched');assert.equal(empty.sent.some(x=>x.method==='Page.navigateToHistoryEntry'),false);
 const protectedTarget=fixture('back');protectedTarget.options.validateUrl=url=>{assert.equal(url,protectedTarget.entries[0]!.url);throw new BrowserError('ADMIN_PAGE_PROTECTED','protected',{phase:'precondition',outcome:'not_dispatched'});};await assert.rejects(navigatePage(protectedTarget.options),(e:any)=>e.code==='ADMIN_PAGE_PROTECTED');assert.equal(protectedTarget.sent.some(x=>x.method==='Page.navigateToHistoryEntry'),false);
});
test('history timeout remains unknown without a second navigation and wait=false does not attach observers',async()=>{
 const f=fixture('back');f.options.deadline=Date.now()+60;await assert.rejects(navigatePage(f.options),(e:any)=>e.code==='NAVIGATION_TIMEOUT'&&e.details.outcome==='unknown');assert.equal(f.sent.filter(x=>x.method==='Page.navigateToHistoryEntry').length,1);assert.equal(f.listeners,0);
 const noWait=fixture('reload');noWait.options.wait=false;assert.deepEqual(await navigatePage(noWait.options),{action:'reload',dispatched:true});assert.equal(noWait.listeners,0);
});
