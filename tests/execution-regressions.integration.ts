import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { launchTestChrome } from './chrome-launch.js';
import { fixture, freePort } from './helpers.js';
import { projectDir } from '../src/config.js';
import { bridgeToken } from '../src/auth.js';
import { VERSION } from '../src/version.js';

const frame = `<!doctype html><style>body{margin:15px}button{margin:12px;padding:10px}</style><input id="inner" value="ORIGINAL"><button id="innerbtn" onclick="window.count=(window.count||0)+1" onmouseenter="window.hovered=true">Frame target</button>`;
const html = `<!doctype html><style>body{margin:35px}iframe{margin-left:230px;border:11px solid navy;width:330px;height:170px}button,input{margin:8px;padding:8px}</style>
<button id="normal" onclick="window.count=(window.count||0)+1">Normal</button>
<fieldset disabled><legend><input id="legend" value="allowed"></legend><input id="disabled" value="ORIGINAL"><button id="disabled-button" onclick="window.bad=true">Disabled group</button></fieldset>
<div aria-disabled="true"><input id="aria-child" value="ORIGINAL"></div>
<details id="fold"><summary>Toggle</summary><button id="folded">Folded target</button></details>
<button id="confirm" onclick="window.dialogClicks=(window.dialogClicks||0)+1;window.answer=confirm('fixture-confirm')">Confirm</button>
<button id="alert" onclick="window.dialogClicks=(window.dialogClicks||0)+1;alert('fixture-alert');window.answer='alert-closed'">Alert</button>
<button id="prompt" onclick="window.dialogClicks=(window.dialogClicks||0)+1;window.answer=prompt('fixture-prompt')">Prompt</button>
<div style="height:180px"></div><iframe id="frame" src="/frame"></iframe>`;

test('F01–F04 Chrome regression suite', async t => {
  const f = await fixture(), port = await freePort();
  const web = createServer((req,res) => { res.setHeader('content-type','text/html; charset=utf-8'); res.end(req.url?.startsWith('/frame') ? frame : html); });
  let closeBrowser=async()=>{};
  // 启动 Chrome 失败也必须关闭本次测试服务，不能让失败用例挂住进程。
  t.after(async()=>{try{await closeBrowser();}finally{web.closeAllConnections();await new Promise<void>(r=>web.close(()=>r()));await f.cleanup();}});
  await new Promise<void>(r => web.listen(port,'0.0.0.0',r));
  const ext = path.join(f.config.dataDir,'extension'); await cp(path.join(projectDir,'dist/extension'),ext,{recursive:true});
  await writeFile(path.join(ext,'pairing.json'),JSON.stringify({port:f.config.port,token:bridgeToken(f.config)}));
  const browser = await launchTestChrome({headless:true,pipe:true,userDataDir:path.join(f.config.dataDir,'chrome'),enableExtensions:[ext],args:['--no-first-run','--site-per-process']});
  closeBrowser=()=>browser.close();
  for(let i=0;i<150&&!f.service.broker.listProfiles().length;i++)await new Promise(r=>setTimeout(r,100));
  const profileId=f.service.broker.listProfiles()[0]!.id;
  const results: {name:string;passed:boolean}[]=[];
  async function check(name:string,fn:(target:any,call:(name:string,args?:any)=>Promise<any>,page:any)=>Promise<void>) {
    await t.test(name,async()=>{
      const opened=await f.service.invoke('chrome_new_tab',{profileId,url:`http://127.0.0.1:${port}/`},'repair-test');const tabId=(opened.data as any).tabId,target={profileId,tabId};
      const call=async(name:string,args:any={})=>{const r=await f.service.invoke(name,{...(name === 'chrome_task' ? {profileId} : target),...args},'repair-test');assert.equal(r.ok,true,JSON.stringify(r.error||r.data));return r.data as any;};
      await call('chrome_wait',{expression:'document.readyState === "complete"'});
      const pages=await browser.pages(),page=pages.find(p=>p.url()===`http://127.0.0.1:${port}/`)!;let dialog:any;page.on('dialog',d=>{dialog=d;});
      try{await fn(target,call,page);results.push({name,passed:true});}
      catch(e){results.push({name,passed:false});throw e;}
      finally{if(dialog)await dialog.dismiss().catch(()=>{});await page.close().catch(()=>{});}
    });
  }
  await check('F01 same-process iframe click reaches actual target',async(_target,call,page)=>{
    const directory=await call('chrome_contexts');const ctx=directory.contexts.find((c:any)=>c.auxData?.isDefault&&c.auxData?.frameId!==directory.frameTree.frameTree.frame.id);assert.ok(ctx);
    await call('chrome_action',{contextId:ctx.id,sessionId:ctx.sessionId,action:'click',selector:'#innerbtn'});
    assert.equal(await page.frames()[1].evaluate(()=> (window as any).count),1);
  });
  await check('F01 nested/scrolled/transformed same-process and OOPIF targets, ten repetitions each',async(_target,call,page)=>{
    for (const cross of [false,true]) for (const nested of [false,true]) for (const transform of [false,true,'perspective']) {
      const url=`http://${cross?'localhost':'127.0.0.1'}:${port}/frame?case=${cross}-${nested}-${transform}`;
      await page.evaluate((url:string,nested:boolean,transform:boolean|string)=>{
        const f=document.querySelector('iframe')!;document.body.style.zoom=transform?'1.2':'1';f.style.transform=transform==='perspective'?'perspective(700px) rotateY(18deg) rotate(8deg) scale(.9)':transform?'rotate(8deg) scale(.9)':'none';
        if(nested) f.srcdoc=`<!doctype html><style>body{margin:25px;height:800px}iframe{margin-top:200px;border:7px solid red;width:250px;height:130px;transform:rotate(-4deg)}</style><iframe src="${url}"></iframe>`;
        else {f.removeAttribute('srcdoc');f.src=url;}
      },url,nested,transform);
      await page.waitForFunction((url:string)=>[...document.querySelectorAll('iframe')].some(f=>f.src===url||f.srcdoc.includes(url)),{},url);
      let ctx:any, targetFrame:any;
      for(let i=0;i<100;i++) {targetFrame=page.frames().find((f:any)=>f.url()===url);if(targetFrame){await targetFrame.waitForFunction(()=>document.readyState==='complete'&&!!document.querySelector('#innerbtn'),{polling:50,timeout:4000}).catch(async(error:any)=>{console.log('FRAME WAIT DIAGNOSTIC',url,await targetFrame.evaluate(()=>({ready:document.readyState,url:location.href,html:document.documentElement.outerHTML.slice(0,1200)})));throw error;});const info=await call('chrome_contexts');const id=(targetFrame as any)._id;ctx=info.contexts.find((c:any)=>c.auxData?.isDefault&&c.auxData.frameId===id);if(ctx)break;}await new Promise(r=>setTimeout(r,50));}
      assert.ok(ctx,`missing context ${url}`);console.log(`FRAME CASE ${url}`);
      for(let i=1;i<=10;i++) {
        await call('chrome_action',{contextId:ctx.id,sessionId:ctx.sessionId,action:'hover',selector:'#innerbtn'});
        await call('chrome_action',{contextId:ctx.id,sessionId:ctx.sessionId,action:'click',selector:'#innerbtn'});
        assert.equal(await targetFrame.evaluate(()=>(window as any).count),i,`${url}, transform=${transform}`);
        assert.equal(await targetFrame.evaluate(()=>(window as any).hovered),true);
      }
      await page.evaluate(()=>{const overlay=document.createElement('div');overlay.id='frame-blocker';overlay.style.cssText='position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.05)';document.body.append(overlay);});
      const blocked=await f.service.invoke('chrome_action',{..._target,contextId:ctx.id,sessionId:ctx.sessionId,action:'click',selector:'#innerbtn',autoWait:false},'repair-test');
      assert.equal(blocked.ok,false);assert.equal(await targetFrame.evaluate(()=>(window as any).count),10);
      await page.evaluate(()=>document.querySelector('#frame-blocker')!.remove());
    }
  });
  await check('F03 inherited disabled rejects fill/click; first legend remains editable',async(target,call,page)=>{
    const result=await f.service.invoke('chrome_action',{...target,action:'fill',selector:'#disabled',text:'BAD',autoWait:false},'repair-test');
    assert.equal(await page.$eval('#disabled',(e:HTMLInputElement)=>e.value),'ORIGINAL');assert.equal(result.ok,false);
    const metadata=await call('chrome_find',{locator:{role:'button',name:'Disabled group',exact:true}});assert.equal(metadata.elements[0].disabled,true);
    assert.equal((await f.service.invoke('chrome_action',{...target,action:'click',selector:'#disabled-button',autoWait:false},'repair-test')).ok,false);
    assert.equal((await f.service.invoke('chrome_action',{...target,action:'fill',selector:'#aria-child',text:'BAD',autoWait:false},'repair-test')).ok,false);
    await call('chrome_action',{action:'fill',selector:'#legend',text:'works'});assert.equal(await page.$eval('#legend',(e:HTMLInputElement)=>e.value),'works');
  });
  await check('F04 closed details hidden for find/wait; summary and opened descendants visible',async(target,call)=>{
    const found=await call('chrome_find',{locator:{role:'button',name:'Folded target',exact:true}});assert.equal(found.elements.length,0);
    const waited=await f.service.invoke('chrome_wait',{...target,selector:'#folded',timeoutMs:250},'repair-test');assert.equal(waited.ok,false); await call('chrome_recover_tab');
    await call('chrome_action',{action:'click',selector:'summary'});await call('chrome_wait',{selector:'#folded',timeoutMs:1000});
  });
  await check('F02 queued confirm cancellation completes once without human intervention',async(target,call,page)=>{
    // 默认拟人点击：鼠标移过去最长约 1.1 秒，再停一下、按住，一次点击可能超过 1.2 秒（0.3.24 候选3 浏览器组第一次因此 CANCELLED）。
    const task=await call('chrome_task_submit',{name:'expected-confirm',stepTimeoutMs:3000,captureOnFailure:false,steps:[{operation:'page.action',args:{action:'click',selector:'#confirm'}},{operation:'page.dialog',args:{accept:false}},{operation:'page.wait',args:{expression:'window.answer === false'}}]});
    let record:any;for(let i=0;i<150;i++){record=await call('chrome_task',{taskId:task.id});if(['succeeded','failed','needs_review','interrupted'].includes(record.status))break;await new Promise(r=>setTimeout(r,100));}
    assert.equal(record.status,'succeeded',JSON.stringify(record));assert.equal(await page.evaluate(()=> (window as any).dialogClicks),1);assert.equal(await page.evaluate(()=> (window as any).answer),false);
  });
  await check('F02 alert/confirm/prompt policies are one-shot and queue keeps the tail',async(_target,call,page)=>{
    for(const type of ['alert','confirm','prompt']) for(let i=1;i<=10;i++) {
      await page.evaluate(()=>{(window as any).dialogClicks=0;(window as any).answer=undefined;});
      const result=await call('chrome_batch',{steps:[{operation:'page.action',args:{action:'click',selector:`#${type}`}},{operation:'page.dialog',args:{accept:type!=='confirm',expectedType:type,expectedMessage:`fixture-${type}`,...(type==='prompt'?{promptText:'test-response'}:{})}},{operation:'page.wait',args:{expression:'window.dialogClicks === 1 && window.answer !== undefined'}}],timeoutMs:2000});
      assert.equal(result.completed,true);assert.equal(result.results.length,3);assert.equal(await page.evaluate(()=>(window as any).dialogClicks),1);
      assert.equal(await page.evaluate(()=>(window as any).answer),type==='alert'?'alert-closed':type==='confirm'?false:'test-response');
    }
  });
  await check('F02 mismatched dialog answers keep protection; the matching answer settles the triggering action',async(target,call,page)=>{
    const started=Date.now();const result=await f.service.invoke('chrome_action',{...target,selector:'#confirm',action:'click',timeoutMs:5000},'repair-test');
    assert.equal(result.error?.code,'DIALOG_OPEN');assert.ok(Date.now()-started<2000);
    assert.equal((await f.service.invoke('chrome_action',{...target,selector:'#normal',action:'click'},'repair-test')).error?.code,'RESULT_UNKNOWN');
    const events=await call('chrome_events',{method:'Page.javascriptDialogOpening'});const id=events.items.at(-1).params.dialogId;assert.ok(id);
    assert.equal((await f.service.invoke('chrome_dialog',{...target,accept:true,dialogId:crypto.randomUUID()},'repair-test')).error?.code,'DIALOG_MISMATCH');
    for(const expected of [{expectedType:'alert'},{expectedMessage:'WRONG_EXPECTED_MESSAGE'}]){
      const refused=await f.service.invoke('chrome_dialog',{...target,accept:false,dialogId:id,...expected},'repair-test');
      assert.equal(refused.error?.code,'DIALOG_MISMATCH');assert.equal(refused.error?.phase,'precondition');assert.equal(refused.error?.outcome,'not_dispatched');
      assert.ok(refused.operationId);assert.equal(f.service.state.get(refused.operationId)!.state,'failed');
      assert.equal(f.service.state.get(result.operationId!)!.state,'unknown','原触发动作的不确定性保护不能被错配响应清除');
      assert.equal(f.service.broker.stats().openDialogs,1,'校验拒绝后原弹窗仍待处理');
    }
    await call('chrome_dialog',{accept:false,dialogId:id,expectedType:'confirm',expectedMessage:'fixture-confirm'});
    for(let i=0;i<50;i++){if(await page.evaluate(()=>(window as any).answer===false))break;await new Promise(r=>setTimeout(r,20));}
    assert.equal(await page.evaluate(()=>(window as any).dialogClicks),1);assert.equal(f.service.state.get(result.operationId!)!.state,'succeeded');
    assert.equal((await f.service.invoke('chrome_action',{...target,selector:'#normal',action:'click'},'repair-test')).ok,true,'答对了就不用再解除保护');
    const mismatch=await f.service.invoke('chrome_batch',{...target,steps:[{operation:'page.action',args:{action:'click',selector:'#confirm'}},{operation:'page.dialog',args:{accept:true,expectedType:'confirm',expectedMessage:'different message'}}]},'repair-test');
    assert.equal(mismatch.error?.code,'BATCH_FAILED');assert.equal((mismatch.data as any).error.code,'DIALOG_MISMATCH');assert.equal(f.service.state.get(mismatch.operationId!)!.state,'unknown');await call('chrome_dialog',{accept:false});await new Promise(r=>setTimeout(r,50));await call('chrome_recover_tab');
    assert.equal(await page.evaluate(()=>(window as any).dialogClicks),2);
  });
  await check('F02 invalid accept policy dispatches nothing; cancellation stops before dialog trigger',async(target,call,page)=>{
    const invalid=await f.service.invoke('chrome_batch',{...target,steps:[{operation:'page.action',args:{action:'click',selector:'#confirm'}},{operation:'page.dialog',args:{accept:true}}]},'repair-test');assert.equal(invalid.ok,false);assert.equal(await page.evaluate(()=>(window as any).dialogClicks),undefined);
    const task=await call('chrome_task_submit',{name:'cancel-before-modal',captureOnFailure:false,steps:[{operation:'page.evaluate',args:{expression:'new Promise(r=>setTimeout(()=>r(true),300))'}},{operation:'page.action',args:{action:'click',selector:'#confirm'}},{operation:'page.dialog',args:{accept:false}}]});
    await f.service.invoke('chrome_task_control',{profileId,taskId:task.id,action:'cancel'},'repair-test');
    let record:any;for(let i=0;i<60;i++){record=await call('chrome_task',{taskId:task.id});if(record.status==='cancelled')break;await new Promise(r=>setTimeout(r,20));}
    assert.equal(record.status,'cancelled');assert.equal(await page.evaluate(()=>(window as any).dialogClicks),undefined);
  });
  await check('F02 hover/mousedown modal never resumes a delayed click after dismissal; batch progress retained',async(target,call,page)=>{
    for(const event of ['mouseenter','mousedown']){
      await page.evaluate((event:string)=>{document.querySelector('#late')?.remove();(window as any).lateClicks=0;(window as any).opens=0;const button=document.createElement('button');button.id='late';button.textContent='Late trigger';button.addEventListener(event,()=>{(window as any).opens++;confirm('pre-click-modal');});button.onclick=()=>{(window as any).lateClicks++;};document.body.prepend(button);},event);
      const result=await f.service.invoke('chrome_batch',{...target,timeoutMs:3000,steps:[{operation:'page.evaluate',args:{expression:'"known-completed-step"'}},{operation:'page.action',args:{action:'click',selector:'#late'}},{operation:'page.evaluate',args:{expression:'window.tailRan=true'}}]},'repair-test');
      assert.equal(result.error?.code,'BATCH_FAILED');assert.equal((result.data as any).failedIndex,1);assert.equal((result.data as any).results[0].result,'known-completed-step');
      await call('chrome_dialog',{accept:false,expectedMessage:'pre-click-modal'});
      await new Promise(r=>setTimeout(r,100));
      assert.equal(await page.evaluate(()=>(window as any).opens),1);assert.equal(await page.evaluate(()=>(window as any).lateClicks),0);assert.equal(await page.evaluate(()=>(window as any).tailRan),undefined);
      // 只在明确未派发时等待取消收尾并重试恢复；原click和batch绝不重放。
      let recovered=false;
      for(let attempt=0;attempt<60;attempt++){
        const recovery=await f.service.invoke('chrome_recover_tab',target,'repair-test');
        if(recovery.ok){recovered=true;break;}
        assert.equal(recovery.error?.outcome,'not_dispatched');assert.match(recovery.error?.message||'',/未结束的操作/);
        assert.equal(await page.evaluate(()=>(window as any).lateClicks),0);await new Promise(resolve=>setTimeout(resolve,50));
      }
      assert.ok(recovered,'取消的输入应在有界时间内结束，之后才能恢复');
    }
  });
  await mkdir(path.join(projectDir,'.local/verification'),{recursive:true});
  await new Promise(r=>setTimeout(r,100));
  const stats=f.service.broker.stats();assert.equal(stats.trackedControllers,0);assert.equal(stats.openDialogs,0);assert.equal(stats.pendingDialogResponses,0);
  await writeFile(path.join(projectDir,'.local/verification/execution-regressions.json'),JSON.stringify({version:VERSION,chrome:await browser.version(),results,frameMatrix:{variants:12,repetitions:10,clicks:120,hovers:120,blockedOverlays:12},dialogs:{types:3,repetitions:10},resources:stats,passed:results.every(x=>x.passed)},null,2));
});
