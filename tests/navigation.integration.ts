import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {interactionHarness} from './interaction-harness.js';
import {freePort} from './helpers.js';

test('navigation completion belongs to the requested document',async t=>{
 const h=await interactionHarness(t,'<!doctype html><title>Original</title><button id="old">old document</button>');
 const port=await freePort(),hits=new Map<string,number>(),timers=new Set<ReturnType<typeof setTimeout>>();
 const web=createServer((req,res)=>{
  const url=req.url!;hits.set(url,(hits.get(url)||0)+1);
  if(url==='/redirect'){res.writeHead(302,{location:'/final'});res.end();return;}
  if(url==='/linked'||url==='/held-link'){res.setHeader('content-type','text/html');res.end(`<!doctype html><title>Links</title><a id="go" href="${url==='/linked'?'/final':'/held'}">next</a>`);return;}
  if(url==='/held'){const timer=setTimeout(()=>{timers.delete(timer);res.setHeader('content-type','text/html');res.end('<!doctype html><title>Held</title><p id="new">new document</p>');},350);timers.add(timer);return;}
  if(url.startsWith('/asset')){if(url.includes('never'))return;const timer=setTimeout(()=>{timers.delete(timer);res.end('asset');},250);timers.add(timer);return;}
  res.setHeader('content-type','text/html');res.end(`<!doctype html><title>Destination</title><p id="new">new document</p>${url==='/slow'?'<img src="/asset-slow">':url==='/hanging'?'<img src="/asset-never">':''}`);
 });
 await new Promise<void>(r=>web.listen(port,'127.0.0.1',r));
 t.after(async()=>{for(const timer of timers)clearTimeout(timer);web.closeAllConnections();await new Promise<void>(r=>web.close(()=>r()));});
 const base=`http://127.0.0.1:${port}`;
 await t.test('about:blank supports both document replacement and blank-to-blank',async()=>{
  const {page,call}=await h.open();
  try{
   await call('chrome_inspect');
   for(let i=0;i<2;i++){
    await page.evaluate(()=>{document.title='Must disappear';document.body.innerHTML='<button>old</button>';});
    const result=await call('chrome_navigate',{url:'about:blank',timeoutMs:1000});
    assert.equal(result.url,'about:blank');assert.equal(result.status,'complete');
    assert.deepEqual(await page.evaluate(()=>({title:document.title,body:document.body.textContent,ready:document.readyState})),{title:'',body:'',ready:'complete'});
   }
  }finally{await page.close();}
 });
 await t.test('normal and HTTP redirect navigation return the final loaded document',async()=>{
  const {page,call}=await h.open();
  try{for(const url of ['/normal','/redirect']){const result=await call('chrome_navigate',{url:base+url,timeoutMs:3000});assert.equal(result.status,'complete');assert.equal(result.url,base+(url==='/redirect'?'/final':url));assert.equal(await page.title(),'Destination');}}
  finally{await page.close();}
 });
 await t.test('same-document navigation preserves the document and settles without a new loader',async()=>{
  const {page,call}=await h.open();
  try{await call('chrome_inspect');await page.evaluate(()=>{(window as any).documentMarker='kept';});const result=await call('chrome_navigate',{url:page.url()+'#section',timeoutMs:1000});assert.ok(result.url.endsWith('#section'));assert.equal(await page.evaluate(()=>(window as any).documentMarker),'kept');}
  finally{await page.close();}
 });
 await t.test('load wait includes delayed resources; wait=false returns after dispatch',async()=>{
  const {page,call}=await h.open();
  try{const start=Date.now();await call('chrome_navigate',{url:base+'/slow',timeoutMs:3000});assert.ok(Date.now()-start>=200);assert.equal(await page.evaluate(()=>document.readyState),'complete');const reply=await call('chrome_navigate',{url:base+'/hanging',wait:false,timeoutMs:1000});assert.ok(reply.frameId);assert.ok(reply.loaderId);}
  finally{await page.close();}
 });
 await t.test('a click that navigates keeps postconditions and waits working across the document change',async()=>{
  const {page,call}=await h.open();
  try{
   for(let i=0;i<5;i++){
    await call('chrome_navigate',{url:base+'/linked',timeoutMs:3000});
    const batch=await call('chrome_batch',{steps:[{operation:'page.action',args:{action:'click',selector:'#go'},postcondition:{urlContains:'/final',textContains:'new document',timeoutMs:3000}}]});
    assert.equal(batch.completed,true);assert.equal(batch.results[0].postcondition.matched,true);
    await call('chrome_navigate',{url:base+'/held-link',timeoutMs:3000});
    await call('chrome_action',{action:'click',selector:'#go'});
    assert.equal((await call('chrome_wait',{urlContains:'/held',textContains:'new document',timeoutMs:3000})).matched,true);
    await call('chrome_navigate',{url:base+'/held-link',timeoutMs:3000});
    await call('chrome_action',{action:'click',selector:'#go'});
    assert.equal((await call('chrome_wait',{expression:"location.pathname==='/held'&&document.title==='Held'",timeoutMs:3000})).matched,true);
   }
  }finally{await page.close();}
 });
 await t.test('a task keeps running after a click that navigates and carries a postcondition',async()=>{
  const {page,target,call}=await h.open();
  try{
   await call('chrome_navigate',{url:base+'/linked',timeoutMs:3000});
   const task=await call('chrome_task_submit',{name:'navigate then read',captureOnFailure:false,steps:[{operation:'page.action',args:{action:'click',selector:'#go'},postcondition:{urlContains:'/final'}},{operation:'page.wait',args:{selector:'#new'}}]});
   let seen:any;for(let i=0;i<60;i++){seen=await h.service.invoke('chrome_task',{profileId:target.profileId,taskId:task.taskId??task.id},'interaction-test');if(['succeeded','failed','needs_review','interrupted'].includes((seen.data as any)?.status))break;await new Promise(r=>setTimeout(r,100));}
   assert.equal((seen.data as any)?.status,'succeeded',JSON.stringify(seen.data));
  }finally{await page.close();}
 });
 await t.test('a stale context the caller named still fails instead of waiting for it',async()=>{
  const {page,raw,call}=await h.open();
  try{
   await call('chrome_navigate',{url:base+'/normal',timeoutMs:3000});
   const contexts=await call('chrome_contexts');const context=contexts.contexts.find((item:any)=>item.auxData?.isDefault)??contexts.contexts[0];
   await call('chrome_navigate',{url:base+'/final',timeoutMs:3000});
   const result=await raw('chrome_wait',{selector:'#new',contextId:context.id,timeoutMs:1000});
   assert.equal(result.ok,false);assert.equal(result.error?.code,'STALE_CONTEXT');
  }finally{await page.close();}
 });
 await t.test('timeout preserves unknown and does not repeat navigation; observe before recovery',async()=>{
  const {page,raw,call}=await h.open();
  try{
   const previous=hits.get('/hanging')||0,result=await raw('chrome_navigate',{url:base+'/hanging',timeoutMs:400});
   assert.equal(result.ok,false);assert.equal(result.error?.code,'NAVIGATION_TIMEOUT');assert.equal(result.error?.outcome,'unknown');assert.equal(hits.get('/hanging'),previous+1);
   assert.equal((await call('chrome_inspect')).url,base+'/hanging');
   const cdp=await page.createCDPSession();await cdp.send('Page.stopLoading');await cdp.detach();
   assert.equal(await page.$eval('#new',e=>e.textContent),'new document');await call('chrome_recover_tab');
  }finally{await page.close();}
 });
});
