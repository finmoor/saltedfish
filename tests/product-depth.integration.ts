import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {cp,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {launchTestChrome} from './chrome-launch.js';
import {fixture,freePort} from './helpers.js';
import {projectDir} from '../src/config.js';
import {bridgeToken} from '../src/auth.js';
import {VERSION} from '../src/version.js';

const html=`<!doctype html><meta charset="utf-8"><title>F05–F09 controlled fixture</title>
<style>body{margin:30px}button,input,select{padding:10px;margin:6px}#cover{position:fixed;inset:0;background:#ddd9;z-index:999}#moving{position:relative}</style>
<button id="late" onclick="window.clicks=(window.clicks||0)+1">Later enabled</button>
<button id="covered" onclick="window.coveredClicks=(window.coveredClicks||0)+1">Covered</button>
<button id="moving" onclick="window.movingClicks=(window.movingClicks||0)+1">Moving</button>
<button id="image"><img alt="图标下载" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10'/%3E"></button>
<button id="hidden-text">目标<span aria-hidden="true">装饰</span></button>
<label>Dropdown (select)<select id="choice"><option value="one">One</option><option value="two" selected>Two</option></select></label>
<label>范围<input id="range" type="range" value="40"></label>
<label>普通字段<input id="text" value="initial"></label>
<label>勾选<input id="check" type="checkbox" checked></label>
<label>密码<input id="password" type="password" value="sensitive-password"></label>
<label>API Token<input id="token" name="api_token" value="sensitive-token"></label>
<label>只读<input id="readonly" readonly value="locked"></label>
<div id="scope"><button>Scoped action</button></div><div id="outside"><button>Outside action</button></div><output id="result"></output>`;

test('F05–F09 product depth',async t=>{
 const f=await fixture(),port=await freePort(),web=createServer((_req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(html);});
 await new Promise<void>(r=>web.listen(port,'127.0.0.1',r));
 const ext=path.join(f.config.dataDir,'extension');await cp(path.join(projectDir,'dist/extension'),ext,{recursive:true});await writeFile(path.join(ext,'pairing.json'),JSON.stringify({port:f.config.port,token:bridgeToken(f.config)}));
 const browser=await launchTestChrome({headless:true,pipe:true,userDataDir:path.join(f.config.dataDir,'chrome'),enableExtensions:[ext],args:['--no-first-run','--site-per-process']});
 t.after(async()=>{await browser.close();web.closeAllConnections();await new Promise<void>(r=>web.close(()=>r()));await f.cleanup();});
 for(let i=0;i<100&&!f.service.broker.listProfiles().length;i++)await new Promise(r=>setTimeout(r,100));
 const profileId=f.service.broker.listProfiles()[0]!.id,results:{name:string;passed:boolean;error?:string}[]=[],metrics:Record<string,unknown>={};
 async function check(name:string,fn:(target:any,call:(name:string,args?:any)=>Promise<any>,page:any)=>Promise<void>){await t.test(name,async()=>{
  const opened=await f.service.invoke('chrome_new_tab',{profileId,url:`http://127.0.0.1:${port}/`},'depth-test');assert.ok(opened.ok);const target={profileId,tabId:(opened.data as any).tabId};
  const call=async(name:string,args:any={})=>{const result=await f.service.invoke(name,{...(name==='chrome_task'?{profileId}:target),...args},'depth-test');assert.ok(result.ok,JSON.stringify(result.error));return result.data as any;};
  await call('chrome_wait',{expression:'document.readyState === "complete"'});const page=(await browser.pages()).find(p=>p.url()===`http://127.0.0.1:${port}/`)!;
  try{await fn(target,call,page);results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:String(error)});throw error;}finally{await f.service.invoke('chrome_recover_tab',target,'depth-test');await page.close();}
 });}
 await check('F05 delayed enabled and overlay are awaited before exactly one click',async(_target,call,page)=>{
  await page.evaluate(()=>{const b=document.querySelector('#late') as HTMLButtonElement;b.disabled=true;setTimeout(()=>{b.disabled=false;},350);});
  await call('chrome_action',{selector:'#late',action:'click',timeoutMs:2000});assert.equal(await page.evaluate(()=>(window as any).clicks),1);
  await page.evaluate(()=>{const e=document.createElement('div');e.id='cover';document.body.append(e);setTimeout(()=>e.remove(),350);});
  await call('chrome_action',{selector:'#covered',action:'click',timeoutMs:2000});assert.equal(await page.evaluate(()=>(window as any).coveredClicks),1);
 });
 await check('F05 appearing, readonly, option loading and moving targets wait without replay',async(_target,call,page)=>{
  await page.evaluate(()=>{setTimeout(()=>{const b=document.createElement('button');b.id='appearing';b.textContent='Appeared';b.onclick=()=>{(window as any).appeared=((window as any).appeared||0)+1;};document.body.append(b);},180);});
  await call('chrome_action',{selector:'#appearing',action:'click',timeoutMs:2000});assert.equal(await page.evaluate(()=>(window as any).appeared),1);
  await page.evaluate(()=>setTimeout(()=>{(document.querySelector('#readonly') as HTMLInputElement).readOnly=false;},180));
  await call('chrome_action',{selector:'#readonly',action:'fill',text:'ready-now',timeoutMs:2000});assert.equal(await page.$eval('#readonly',(e:HTMLInputElement)=>e.value),'ready-now');
  await page.evaluate(()=>setTimeout(()=>{const o=document.createElement('option');o.value='later';o.textContent='Later';document.querySelector('#choice')!.append(o);},180));
  await call('chrome_action',{selector:'#choice',action:'select',values:['later'],timeoutMs:2000});assert.equal(await page.$eval('#choice',(e:HTMLSelectElement)=>e.value),'later');
  await page.evaluate(()=>{const b=document.querySelector('#moving') as HTMLElement;let x=0;const timer=setInterval(()=>{b.style.left=`${x+=5}px`;},20);setTimeout(()=>clearInterval(timer),260);});
  await call('chrome_action',{selector:'#moving',action:'click',timeoutMs:2000});assert.equal(await page.evaluate(()=>(window as any).movingClicks),1);
 });
 await check('F05 expired preconditions dispatch no input; a target that moves on hover is followed, one that keeps moving is never pressed',async(target,call,page)=>{
  await page.$eval('#late',(e:HTMLButtonElement)=>{e.disabled=true;});
  const expired=await f.service.invoke('chrome_action',{...target,action:'click',selector:'#late',timeoutMs:200},'depth-test');assert.equal(expired.error?.code,'ACTIONABILITY_TIMEOUT');assert.equal(expired.error?.outcome,'not_dispatched');assert.equal(f.service.state.get(expired.operationId!)!.state,'failed');assert.equal(await page.evaluate(()=>(window as any).clicks),undefined);
  const instant=await f.service.invoke('chrome_action',{...target,action:'click',selector:'#late',autoWait:false},'depth-test');assert.equal(instant.error?.code,'ELEMENT_DISABLED');
  // 鼠标移上去目标就挪位置（表头冒出筛选图标一类）：新位置停稳了就跟过去，只按一次。
  await page.evaluate(()=>{const b=document.querySelector('#covered') as HTMLElement;(window as any).shift=8;b.addEventListener('mouseenter',()=>{(window as any).hoverCount=((window as any).hoverCount||0)+1;b.style.transform=`translateX(${(window as any).shift}px)`;});});
  await call('chrome_action',{action:'click',selector:'#covered',timeoutMs:2000});assert.equal(await page.evaluate(()=>(window as any).coveredClicks),1);assert.ok(await page.evaluate(()=>(window as any).hoverCount)>=1);
  // 挪过去以后被旁边的按钮挡住了：不按，只移动过鼠标，算未派发。
  // 先把鼠标移开，下一次点它才会再触发 mouseenter。
  await page.evaluate(()=>{const b=document.querySelector('#covered') as HTMLElement;b.style.transform='';(window as any).shift=80;});await call('chrome_action',{action:'hover',selector:'#text'});
  const hidden=await f.service.invoke('chrome_action',{...target,action:'click',selector:'#covered',timeoutMs:2000},'depth-test');assert.ok(['ELEMENT_OBSCURED','ELEMENT_MOVED'].includes(hidden.error!.code),JSON.stringify(hidden.error));assert.equal(hidden.error?.outcome,'not_dispatched',JSON.stringify(hidden.error));assert.equal(f.service.state.get(hidden.operationId!)!.state,'failed');assert.equal(await page.evaluate(()=>(window as any).coveredClicks),1);
  // 一直在动的目标：始终不按下。只移动过鼠标，算未派发，标签页照常可写。
  await call('chrome_action',{action:'hover',selector:'#text'});
  // 后台标签页的定时器会被节流，不靠 setInterval：鼠标一动它就挪一下，跟过去也照样挪。
  await page.evaluate(()=>{const b=document.querySelector('#covered') as HTMLElement;b.style.transform='';(window as any).shift=0;b.addEventListener('mouseenter',()=>{let x=0;(window as any).drift=()=>{b.style.marginLeft=`${x=(x+17)%140}px`;};document.addEventListener('mousemove',(window as any).drift);},{once:true});});
  const moving=await f.service.invoke('chrome_action',{...target,action:'click',selector:'#covered',timeoutMs:3000},'depth-test');assert.equal(moving.error?.code,'ELEMENT_MOVED',JSON.stringify(moving));assert.equal(moving.error?.outcome,'not_dispatched');assert.equal(f.service.state.get(moving.operationId!)!.state,'failed');assert.equal(await page.evaluate(()=>(window as any).coveredClicks),1);
  await page.evaluate(()=>{document.removeEventListener('mousemove',(window as any).drift);(document.querySelector('#covered') as HTMLElement).style.marginLeft='';});
  assert.equal((await f.service.invoke('chrome_action',{...target,action:'fill',selector:'#text',text:'still writable'},'depth-test')).ok,true);
 });
 await check('F05 navigation and lost focus stop before typing in a different target',async(target,call,page)=>{
  await page.evaluate(()=>{const input=document.querySelector('#text') as HTMLInputElement;input.onfocus=()=>{(document.querySelector('#password') as HTMLInputElement).focus();};});
  // 0.3.24 起标签页留在后台操作：无头 Chrome 里后台标签页的拟人点击要 0.8–1 秒（实测 811–954ms），1 秒的期限会先到，报 CANCELLED 而不是 FOCUS_CHANGED。
  const focus=await f.service.invoke('chrome_action',{...target,action:'type',selector:'#text',text:'MUST_NOT_TYPE',timeoutMs:3000},'depth-test');assert.equal(focus.error?.code,'FOCUS_CHANGED');assert.equal(await page.$eval('#password',(e:HTMLInputElement)=>e.value),'sensitive-password');await call('chrome_recover_tab');
  await page.evaluate(()=>{(document.querySelector('#late') as HTMLButtonElement).disabled=true;setTimeout(()=>location.reload(),120);});
  const changed=await f.service.invoke('chrome_action',{...target,action:'click',selector:'#late',timeoutMs:1500},'depth-test');assert.equal(changed.ok,false);assert.ok(['DOCUMENT_CHANGED','STALE_CONTEXT','OPERATION_FAILED','JAVASCRIPT_ERROR'].includes(changed.error!.code));await new Promise(r=>setTimeout(r,300));assert.equal(await page.evaluate(()=>(window as any).clicks),undefined);
 });
 await check('F05 predeclared dialog is not armed while waiting for a disabled target',async(target,call,page)=>{
  let nativeDialog:any;page.on('dialog',(dialog:any)=>{nativeDialog=dialog;});
  await page.evaluate(()=>{(document.querySelector('#late') as HTMLButtonElement).disabled=true;setTimeout(()=>{(window as any).unexpectedAccepted=confirm('same-predeclared-message');(document.querySelector('#late') as HTMLButtonElement).disabled=false;},150);});
  const result=await f.service.invoke('chrome_batch',{...target,timeoutMs:2000,steps:[{operation:'page.action',args:{action:'click',selector:'#late'}},{operation:'page.dialog',args:{accept:true,expectedType:'confirm',expectedMessage:'same-predeclared-message'}}]},'depth-test');
  try{assert.equal(result.ok,false);assert.equal((result.data as any).error.code,'DIALOG_OPEN');
   // 扩展和 puppeteer 各有一条 CDP 会话，弹窗事件谁先到不一定（准备 0.3.24 时有一次 puppeteer 晚到、断言落空），稍等它。
   for(let i=0;i<20&&!nativeDialog;i++)await new Promise(r=>setTimeout(r,50));
   assert.ok(nativeDialog);await call('chrome_dialog',{accept:false,expectedType:'confirm',expectedMessage:'same-predeclared-message'});await new Promise(r=>setTimeout(r,150));assert.equal(await page.evaluate(()=>(window as any).unexpectedAccepted),false);assert.equal(await page.evaluate(()=>(window as any).clicks),undefined);}
  finally{await nativeDialog?.dismiss().catch(()=>{});}
 });
 await check('F06 accessible names, labels and implicit roles match Chrome AX',async(_target,call,page)=>{
  for(const [selector,locator] of [['#image',{role:'button',name:'图标下载'}],['#hidden-text',{role:'button',name:'目标'}],['#choice',{label:'Dropdown (select)'}],['#range',{role:'slider',name:'范围'}]] as const){
   const found=await call('chrome_find',{locator:{...locator,exact:true}});assert.equal(found.elements.length,1,selector);
   const session=await page.createCDPSession(),doc=await session.send('DOM.getDocument'),node=await session.send('DOM.querySelector',{nodeId:doc.root.nodeId,selector}),ax=await session.send('Accessibility.getPartialAXTree',{nodeId:node.nodeId,fetchRelatives:false});
   const native=ax.nodes.find((n:any)=>!n.ignored);assert.equal(found.elements[0].name,native.name.value);assert.equal(found.elements[0].role,native.role.value);await session.detach();
  }
 });
 await check('F06 labels, hidden references, search/spin controls and Shadow DOM retain semantics',async(_target,call,page)=>{
  await page.evaluate(()=>{const root=document.createElement('div');root.innerHTML=`<span id="label1" hidden>隐藏引用</span><span id="label2">名称</span><button id="labelled" aria-labelledby="label1 label2">Wrong</button><button id="aria" aria-label="ARIA 名称">Other</button><input id="submit" type="submit" value="提交表单"><label>数量<input id="number" type="number"></label><label>搜索<input id="search" type="search"></label><label>单选<input id="radio" type="radio"></label><textarea id="titled" title="标题输入"></textarea>`;document.body.append(root);const host=document.createElement('div');host.innerHTML='<span>插槽名称</span>';host.attachShadow({mode:'open'}).innerHTML='<button><slot></slot></button>';document.body.append(host);});
  for(const selector of ['#labelled','#aria','#submit','#number','#search','#radio','#titled']){
   const session=await page.createCDPSession(),doc=await session.send('DOM.getDocument'),node=await session.send('DOM.querySelector',{nodeId:doc.root.nodeId,selector}),ax=await session.send('Accessibility.getPartialAXTree',{nodeId:node.nodeId,fetchRelatives:false});const native=ax.nodes.find((n:any)=>!n.ignored);await session.detach();
   const found=await call('chrome_find',{locator:{role:native.role.value,name:native.name.value,exact:true}});assert.equal(found.elements.length,1,`${selector} ${native.role.value} ${native.name.value}`);
  }
  assert.equal((await call('chrome_find',{locator:{role:'button',name:'插槽名称',exact:true}})).elements.length,1);
 });
 await check('F07 compact inspect exposes current form state without sensitive values',async(_target,call,page)=>{
  await page.evaluate(()=>{const label=document.createElement('label');label.innerHTML='访问令牌<input value="sensitive-label">';document.body.append(label);const host=document.createElement('div');host.setAttribute('data-mcp-sensitive','');host.attachShadow({mode:'open'}).innerHTML='<label>Shadow private<input value="sensitive-shadow"></label>';document.body.append(host);});
  await page.$eval('#text',(e:HTMLInputElement)=>{e.value='changed-now';});await page.$eval('#check',(e:HTMLInputElement)=>{e.indeterminate=true;});
  const result=await call('chrome_inspect'),byName=(name:string)=>result.elements.find((e:any)=>e.name===name);
  assert.equal(byName('普通字段').value,'changed-now');assert.equal(byName('勾选').checked,true);assert.equal(byName('勾选').indeterminate,true);assert.equal(byName('只读').readOnly,true);
  assert.deepEqual(byName('Dropdown (select)').selectedOptions.map((o:any)=>o.value),['two']);
  assert.equal(byName('密码').valueRedacted,true);assert.equal(byName('API Token').valueRedacted,true);assert.equal(byName('访问令牌').valueRedacted,true);assert.equal(byName('Shadow private').valueRedacted,true);assert.ok(!JSON.stringify(result).includes('sensitive-'));
 });
 await check('F07 scoped delta reports added/removed/state changes and expires to full safely',async(_target,call,page)=>{
  const first=await call('chrome_inspect',{scopeSelector:'#scope',textLimit:1000});assert.equal(first.elements.length,1);assert.ok(!first.text.includes('Outside'));
  const unchanged=await call('chrome_inspect',{scopeSelector:'#scope',textLimit:1000,sinceSnapshot:first.snapshotId});assert.equal(unchanged.mode,'delta');assert.equal(unchanged.unchanged,true);assert.equal(unchanged.elements.length,0);assert.equal(unchanged.text,undefined);
  await page.evaluate(()=>{document.querySelector('#scope button')!.remove();const e=document.createElement('input');e.id='scoped-input';e.setAttribute('aria-label','Scoped input');e.value='value-1';document.querySelector('#scope')!.append(e);});
  const change=await call('chrome_inspect',{scopeSelector:'#scope',textLimit:1000,sinceSnapshot:unchanged.snapshotId});assert.equal(change.elements[0].value,'value-1');assert.deepEqual(change.removedRefs,[first.elements[0].ref]);
  await page.$eval('#scoped-input',(e:HTMLInputElement)=>{e.value='value-2';});const updated=await call('chrome_inspect',{scopeSelector:'#scope',textLimit:1000,sinceSnapshot:change.snapshotId});assert.equal(updated.elements[0].value,'value-2');assert.equal(updated.unchanged,false);
  for(let i=0;i<10;i++)await call('chrome_inspect',{scopeSelector:'#scope',textLimit:1000});const expired=await call('chrome_inspect',{scopeSelector:'#scope',textLimit:1000,sinceSnapshot:first.snapshotId});assert.equal(expired.mode,'full');assert.equal(expired.baselineStatus,'expired_or_different_document');
  assert.equal(await page.evaluate(()=>Object.hasOwn(window,'__fengMcp')),false);
 });
 await check('F08 default AX observation has a compact bounded response',async(target,_call,page)=>{
  await page.evaluate(()=>{for(let i=0;i<700;i++){const b=document.createElement('button');b.textContent=`Diagnostic item ${i} with repeated text`;document.body.append(b);}});
  const result=await f.service.invoke('chrome_accessibility',target,'depth-test');assert.ok(result.ok);assert.ok(JSON.stringify(result).length<=8000,`response characters ${JSON.stringify(result).length}`);
  assert.ok((result.data as any).totalNodes>100);assert.ok((result.data as any).nextOffset!==null);
  const raw=await f.service.invoke('chrome_accessibility',{...target,mode:'raw'},'depth-test');assert.ok(raw.ok);assert.ok((raw.data as any).saved);assert.ok((raw.data as any).preview.length<=2048);const content=await f.service.invoke('chrome_read_result',{artifactId:(raw.data as any).artifactId,offset:0,limit:200},'depth-test');assert.ok(content.ok);assert.ok((content.data as any).text.includes('"nodes"'));metrics.ax={summaryCharacters:JSON.stringify(result).length,rawPreviewCharacters:JSON.stringify(raw).length,rawTotalCharacters:(raw.data as any).totalCharacters};
 });
 await check('F09 arbitrary evaluation exception is consistently unknown; pure DOM wait is a known failure',async(target,_call,page)=>{
  const result=await f.service.invoke('chrome_evaluate',{...target,expression:'window.sideEffect=1;throw new Error("after mutation")'},'depth-test');assert.equal(result.ok,false);assert.equal(await page.evaluate(()=>(window as any).sideEffect),1);assert.equal(f.service.state.get(result.operationId!)!.state,'unknown');
  await f.service.invoke('chrome_recover_tab',target,'depth-test');const wait=await f.service.invoke('chrome_wait',{...target,selector:'#absent',timeoutMs:150},'depth-test');assert.equal(wait.error?.code,'WAIT_TIMEOUT');assert.equal(wait.error?.outcome,'not_dispatched');assert.equal(wait.operationId,undefined,'结构化等待只读，不记操作');
  const spoof=await f.service.invoke('chrome_evaluate',{...target,expression:'window.sideEffect=2;throw Object.assign(new Error("fake validation"),{name:"FengPrecondition",code:"ELEMENT_NOT_FOUND"})'},'depth-test');assert.equal(spoof.error?.code,'JAVASCRIPT_ERROR');assert.equal(spoof.error?.outcome,'unknown');assert.equal(f.service.state.get(spoof.operationId!)!.state,'unknown');assert.equal(await page.evaluate(()=>(window as any).sideEffect),2);
 });
 await check('F09 task and operation agree on known/unknown failures and preserve partial batch progress',async(target,call,page)=>{
  const waitTask=await call('chrome_task_submit',{name:'known-wait',captureOnFailure:false,stepTimeoutMs:150,steps:[{operation:'page.wait',args:{selector:'#absent'}},{operation:'page.evaluate',args:{expression:'window.mustNotRun=true'}}]});
  const ended=async(id:string)=>{let task:any;for(let i=0;i<100;i++){task=await call('chrome_task',{taskId:id});if(['failed','needs_review','succeeded'].includes(task.status))break;await new Promise(r=>setTimeout(r,30));}return task;};
  const known=await ended(waitTask.id);assert.equal(known.status,'failed');assert.equal(known.steps[0].state,'failed');assert.equal(known.steps[0].outcome,'not_dispatched');assert.equal(known.steps[1].state,'pending');assert.equal(known.steps[0].operationId,undefined);assert.equal(await page.evaluate(()=>(window as any).mustNotRun),undefined);
  const scriptTask=await call('chrome_task_submit',{name:'unknown-js',captureOnFailure:false,steps:[{operation:'page.evaluate',args:{expression:'window.effectCount=(window.effectCount||0)+1;throw new Error("after effect")'}}]});
  const unknown=await ended(scriptTask.id);assert.equal(unknown.status,'needs_review');assert.equal(unknown.steps[0].state,'unknown');assert.equal(f.service.state.get(unknown.steps[0].operationId)!.state,'unknown');assert.equal(await page.evaluate(()=>(window as any).effectCount),1);await call('chrome_recover_tab');
  const batch=await f.service.invoke('chrome_batch',{...target,steps:[{operation:'page.evaluate',args:{expression:'window.completedCount=(window.completedCount||0)+1'}},{operation:'page.action',args:{action:'fill',selector:'#readonly',text:'BAD',autoWait:false}},{operation:'page.evaluate',args:{expression:'window.mustNotRun=true'}}]},'depth-test');
  assert.equal(batch.ok,false);assert.equal(batch.batch?.completedSteps,1);assert.equal(batch.batch?.failedIndex,1);assert.equal(batch.batch?.error.outcome,'not_dispatched');assert.equal(f.service.state.get(batch.operationId!)!.state,'failed');assert.equal(await page.evaluate(()=>(window as any).completedCount),1);assert.equal(await page.evaluate(()=>(window as any).mustNotRun),undefined);
 });
 await new Promise(r=>setTimeout(r,100));const resources=f.service.stats();for(const key of ['pendingCommands','locks','leases','trackedControllers','openDialogs','pendingDialogResponses','inFlight','activeTaskProfiles'] as const)assert.equal(resources[key],0,key);
 await mkdir(path.join(projectDir,'.local/verification'),{recursive:true});await writeFile(path.join(projectDir,`.local/verification/product-depth${process.env.DEPTH_BASELINE?'-before':''}.json`),JSON.stringify({version:VERSION,chrome:await browser.version(),time:new Date().toISOString(),results,metrics,resources,passed:results.every(r=>r.passed)},null,2));
});
