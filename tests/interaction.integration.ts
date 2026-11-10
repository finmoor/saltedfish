import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {interactionHarness} from './interaction-harness.js';
import {inputValue,textareaValue,innerText,editableMarkup} from './dom-readers.js';

const html=`<!doctype html><meta charset="utf-8"><input id="text" aria-label="Editor"><button id="click" onclick="window.clicks=(window.clicks||0)+1">Count</button><div id="editor" contenteditable="true">alpha beta</div><input id="other"><textarea id="notes"></textarea><input id="special" type="date"><output id="done"></output>`;
test('beta.17 isolation and interaction contracts',async t=>{
 const h=await interactionHarness(t,html);
 await t.test('internal state cannot be read or poisoned from the page; explicit evaluation stays in main world',async()=>{
  const {page,call}=await h.open();
  await page.evaluate(()=>{Object.defineProperty(window,'__fengMcp',{get(){throw new Error('page trap');}});(window as any).mainMarker=42;});
  const before=await page.evaluate(()=>Object.getOwnPropertyNames(window));
  const inspected=await call('chrome_inspect');assert.ok(inspected.elements.length);
  const ref=inspected.elements.find((x:any)=>x.name==='Editor').ref;
  await call('chrome_action',{action:'fill',ref,text:'isolated'});
  assert.equal(await page.$eval('#text',inputValue),'isolated');
  assert.equal(await call('chrome_evaluate',{expression:'window.mainMarker'}),42);
  const after=await page.evaluate(()=>Object.getOwnPropertyNames(window));assert.deepEqual(after,before);
  await page.close();
 });
 await t.test('one bootstrap per document, concurrent observations share initialization; refs expire after navigation',async()=>{
  const {page,call,raw}=await h.open();const before=await h.metrics();
  const [first,second]=await Promise.all([call('chrome_inspect'),call('chrome_inspect')]);assert.equal(first.documentId,second.documentId);
  const warmed=await h.metrics();assert.equal(warmed.methods['Page.createIsolatedWorld']-(before.methods['Page.createIsolatedWorld']||0),1);
  for(let i=0;i<10;i++)await call('chrome_inspect',{sinceSnapshot:first.snapshotId});
  const end=await h.metrics();assert.equal(end.methods['Page.createIsolatedWorld'],warmed.methods['Page.createIsolatedWorld']);
  await page.reload();const next=await call('chrome_inspect');assert.notEqual(next.documentId,first.documentId);
  const stale=await raw('chrome_action',{action:'fill',ref:first.elements[0].ref,text:'wrong'});assert.equal(stale.error?.code,'STALE_ELEMENT_REF');
  assert.equal(await page.$eval('#text',inputValue),'');
  assert.equal(await page.evaluate(()=>Object.hasOwn(window,'__fengMcp')),false);
  const contexts=await call('chrome_contexts');assert.ok(!contexts.contexts.some((x:any)=>x.name==='SaltedFish internal runtime'));
  await page.close();
 });
 await t.test('native fill emits trusted editing events, supports clear and undo; setValue is explicit',async()=>{
  const {page,call}=await h.open();
  await page.evaluate(()=>{(document.querySelector('#text') as HTMLInputElement).value='before';(window as any).events=[];for(const type of ['beforeinput','input','change'])document.addEventListener(type,e=>(window as any).events.push({type:e.type,trusted:e.isTrusted}));});
  const filled=await call('chrome_action',{action:'fill',selector:'#text',text:'中文🙂'});assert.equal(filled.mode,'input');assert.equal(filled.verified,true);
  assert.deepEqual(await page.evaluate(()=>(window as any).events.map((e:any)=>[e.type,e.trusted])),[['beforeinput',true],['input',true]]);
  await call('chrome_action',{action:'press',selector:'#text',key:'z',modifiers:2});assert.equal(await page.$eval('#text',inputValue),'before');
  await call('chrome_action',{action:'fill',selector:'#text',text:''});assert.equal(await page.$eval('#text',inputValue),'');
  const set=await call('chrome_action',{action:'fill',selector:'#text',text:'direct',fillMode:'setValue'});assert.equal(set.inputEventTrusted,false);
  assert.deepEqual(await page.evaluate(()=>(window as any).events.slice(-2).map((e:any)=>[e.type,e.trusted])),[['input',false],['change',false]]);
  assert.equal((await call('chrome_action',{action:'fill',selector:'#special',text:'2026-10-24'})).mode,'setValue');
  await page.close();
 });
 await t.test('selection, Unicode, textarea and rich text preserve editing semantics',async()=>{
  const {page,call,raw}=await h.open();
  await call('chrome_action',{action:'fill',selector:'#text',text:'A🙂B'});
  await call('chrome_action',{action:'type',selector:'#text',text:'中文',selection:{start:1,end:3}});
  assert.equal(await page.$eval('#text',inputValue),'A中文B');
  await call('chrome_action',{action:'fill',selector:'#notes',text:'第一行\nsecond🙂'});assert.equal(await page.$eval('#notes',textareaValue),'第一行\nsecond🙂');
  await call('chrome_action',{action:'type',selector:'#editor',text:'中文🙂',selection:{start:6,end:10}});assert.equal(await page.$eval('#editor',e=>e.textContent),'alpha 中文🙂');
  await call('chrome_action',{action:'fill',selector:'#editor',text:'replacement'});assert.equal(await page.$eval('#editor',e=>e.textContent),'replacement');
  await call('chrome_action',{action:'press',selector:'#editor',key:'z',modifiers:2});assert.equal(await page.$eval('#editor',e=>e.textContent),'alpha 中文🙂');
  const multiline=await call('chrome_action',{action:'fill',selector:'#editor',text:'第一行\nsecond🙂'});assert.equal(multiline.verified,true);assert.equal(await page.$eval('#editor',innerText),'第一行\nsecond🙂');
  for(const text of ['','line\n','\n','\nA','A\n\nB','\n\n','two  spaces','win\r\nlines','non\u00a0breaking']){
   const result=await raw('chrome_action',{action:'fill',selector:'#editor',text});
   assert.ok(result.ok,JSON.stringify({text,error:result.error,dom:await page.$eval('#editor',editableMarkup)}));
   await call('chrome_wait',{selector:'#editor',valueEquals:text,timeoutMs:500});
  }
  await page.close();
 });
 await t.test('controlled component sees browser input; prevented input is unknown and never retried',async()=>{
  const {page,call,raw}=await h.open();
  await page.evaluate(()=>{(window as any).updates=0;document.querySelector('#text')!.addEventListener('input',e=>{(window as any).updates++;(window as any).model=(e.target as HTMLInputElement).value;});});
  await call('chrome_action',{action:'fill',selector:'#text',text:'model🙂'});assert.equal(await page.evaluate(()=>(window as any).model),'model🙂');
  await page.evaluate(()=>document.querySelector('#text')!.addEventListener('beforeinput',e=>e.preventDefault()));
  const result=await raw('chrome_action',{action:'fill',selector:'#text',text:'blocked'});assert.equal(result.error?.code,'EDIT_NOT_APPLIED');assert.equal(result.error?.outcome,'unknown');
  assert.equal(await page.$eval('#text',inputValue),'model🙂');assert.equal(await page.evaluate(()=>(window as any).updates),1);
  await call('chrome_recover_tab');await page.close();
 });
 await t.test('keySequence and composition expose their actual event paths',async()=>{
  const {page,call}=await h.open();
  await page.evaluate(()=>{(window as any).events=[];for(const type of ['keydown','keyup','compositionstart','compositionupdate','compositionend','input'])document.addEventListener(type,e=>(window as any).events.push({type:e.type,trusted:e.isTrusted,key:(e as KeyboardEvent).key,code:(e as KeyboardEvent).code,shiftKey:(e as KeyboardEvent).shiftKey}));});
  await call('chrome_action',{action:'type',selector:'#text',text:'aB9!',inputMode:'keySequence'});assert.equal(await page.$eval('#text',inputValue),'aB9!');
  // B 和 ! 前面各按一次 Shift，页面看得到 Shift 自己的 keydown/keyup。
  assert.equal(await page.evaluate(()=>(window as any).events.filter((e:any)=>e.type==='keydown').length),6);assert.equal(await page.evaluate(()=>(window as any).events.filter((e:any)=>e.type==='keyup').length),6);
  assert.equal(await page.evaluate(()=>(window as any).events.filter((e:any)=>e.type==='keydown'&&e.key==='Shift').length),2);
  assert.deepEqual(await page.evaluate(()=>{const e=(window as any).events.find((e:any)=>e.type==='keydown'&&e.key==='!');return [e.code,e.shiftKey];}),['Digit1',true]);
  await call('chrome_action',{action:'fill',selector:'#text',text:''});
  await call('chrome_action',{action:'type',selector:'#text',text:'中文🙂',inputMode:'composition',compositionUpdates:['z','中','中文🙂']});assert.equal(await page.$eval('#text',inputValue),'中文🙂');
  const events=await page.evaluate(()=>(window as any).events);for(const type of ['compositionstart','compositionupdate'])assert.ok(events.some((e:any)=>e.type===type&&e.trusted),`${type}: ${JSON.stringify(events)}`);
  assert.equal(events.filter((e:any)=>e.type==='compositionend').length,1);console.log('Browser compositionend trust:',events.find((e:any)=>e.type==='compositionend').trusted);
  await call('chrome_action',{action:'type',selector:'#text',text:'cancelled',inputMode:'composition',compositionCommit:false});assert.equal(await page.$eval('#text',inputValue),'中文🙂');
  await page.close();
 });
 await t.test('paste respects cancellation/page handling and does not claim a trusted clipboard event',async()=>{
  const {page,call}=await h.open();
  await page.evaluate(()=>{document.querySelector('#text')!.addEventListener('paste',e=>{e.preventDefault();(window as any).pasteTrusted=e.isTrusted;(e.target as HTMLInputElement).value='handled:'+(e as ClipboardEvent).clipboardData!.getData('text/plain');},{once:true});});
  const paste=await call('chrome_action',{action:'type',selector:'#text',text:'hello🙂',inputMode:'paste'});assert.equal(paste.handledByPage,true);assert.equal(paste.pasteEventTrusted,false);assert.equal(await page.$eval('#text',inputValue),'handled:hello🙂');
  await call('chrome_action',{action:'type',selector:'#other',text:'paste fallback',inputMode:'paste'});assert.equal(await page.$eval('#other',inputValue),'paste fallback');
  await page.close();
 });
 await t.test('focus change during keydown stops characters and still releases the key',async()=>{
  const {page,call,raw}=await h.open();
  await page.evaluate(()=>{(window as any).keyUps=0;document.addEventListener('keyup',()=>{(window as any).keyUps++;});document.querySelector('#text')!.addEventListener('keydown',()=>{(document.querySelector('#other') as HTMLElement).focus();});});
  const result=await raw('chrome_action',{action:'type',selector:'#text',text:'abc',inputMode:'keySequence'});assert.equal(result.error?.code,'FOCUS_CHANGED');assert.equal(result.error?.outcome,'unknown');
  assert.equal(await page.$eval('#text',inputValue),'');assert.equal(await page.$eval('#other',inputValue),'');assert.equal(await page.evaluate(()=>(window as any).keyUps),1);
  await call('chrome_recover_tab');await page.close();
 });
 await t.test('held pointer target changes cancel the click and release buttons without replay',async()=>{
  const {page,call,raw}=await h.open();
  await page.evaluate(()=>{(window as any).ups=[];document.addEventListener('mouseup',e=>(window as any).ups.push(e.buttons));document.querySelector('#click')!.addEventListener('mousedown',()=>setTimeout(()=>{(document.querySelector('#click') as HTMLElement).style.transform='translateX(80px)';},20),{once:true});});
  const result=await raw('chrome_action',{action:'click',selector:'#click',holdMs:100});assert.equal(result.error?.code,'ELEMENT_MOVED');assert.equal(result.error?.outcome,'unknown');
  assert.equal(await page.evaluate(()=>(window as any).clicks||0),0);assert.deepEqual(await page.evaluate(()=>(window as any).ups),[0]);
  await call('chrome_recover_tab');await call('chrome_action',{action:'click',selector:'#click'});assert.equal(await page.evaluate(()=>(window as any).clicks),1);await page.close();
 });
 await t.test('postconditions wait for page results, stop on failure and never repeat the action',async()=>{
  const {page,call,raw}=await h.open();
  await page.evaluate(()=>document.querySelector('#click')!.addEventListener('click',()=>setTimeout(()=>{document.querySelector('#done')!.textContent='ready';},120)));
  await call('chrome_batch',{steps:[{operation:'page.action',args:{action:'click',selector:'#click'},postcondition:{selector:'#done',textContains:'ready',timeoutMs:1500}},{operation:'page.action',args:{action:'fill',selector:'#text',text:'tail'},postcondition:{selector:'#text',valueEquals:'tail'}}]});
  assert.equal(await page.evaluate(()=>(window as any).clicks),1);
  const fail=await raw('chrome_batch',{steps:[{operation:'page.action',args:{action:'click',selector:'#click'},postcondition:{selector:'#done',textContains:'never',timeoutMs:150}},{operation:'page.action',args:{action:'fill',selector:'#text',text:'MUST NOT RUN'}}]});
  assert.equal(fail.batch?.error.code,'POSTCONDITION_TIMEOUT');assert.equal(fail.batch?.error.phase,'postcondition');assert.equal(fail.batch?.error.outcome,'dispatched');assert.equal(await page.evaluate(()=>(window as any).clicks),2);assert.equal(await page.$eval('#text',inputValue),'tail');
  // 动作做完了只是后置条件没满足（0.3.0-beta.18 起）：不暂停写入，不用 recover_tab。
  assert.equal(await call('chrome_evaluate',{expression:'1+1'}),2);await page.close();
 });
 await t.test('task submission identity and postcondition status agree with exactly one page action',async()=>{
  const {page,call,target}=await h.open(),submissionId=randomUUID();
  const plan={name:'one task',submissionId,captureOnFailure:false,steps:[{operation:'page.action',args:{action:'click',selector:'#click'},postcondition:{selector:'#click',state:'enabled'}}]};
  const [first,second]=await Promise.all([call('chrome_task_submit',plan),call('chrome_task_submit',plan)]);assert.equal(first.id,second.id);assert.ok(first.deduplicated||second.deduplicated);
  let ended:any;for(let i=0;i<100;i++){ended=h.service.tasks.get(target.profileId,first.id);if(ended.status==='succeeded')break;await new Promise(r=>setTimeout(r,25));}
  assert.equal(ended.status,'succeeded');assert.equal(ended.steps[0].verification,'matched');assert.equal(await page.evaluate(()=>(window as any).clicks),1);assert.equal((await call('chrome_task_submit',plan)).id,first.id);await page.close();
 });
 await t.test('postcondition supports upload/selection state and waits through transient success',async()=>{
  const {page,call}=await h.open();await page.evaluate(()=>{document.body.insertAdjacentHTML('beforeend','<input id="file" type="file"><select id="choice"><option value="a">A</option><option value="b">B</option></select><input id="check" type="checkbox" checked>');});
  const file=path.join(h.config.dataDir,'upload.txt');await writeFile(file,'test upload');
  await call('chrome_batch',{steps:[{operation:'page.upload',args:{selector:'#file',paths:[file]},postcondition:{selector:'#file',fileCount:1}},{operation:'page.action',args:{action:'select',selector:'#choice',values:['b']},postcondition:{selector:'#choice',valueEquals:'b'}}]});
  await call('chrome_wait',{selector:'#check',state:'checked'});await call('chrome_wait',{selector:'#text',state:'editable'});
  await page.evaluate(()=>{const e=document.querySelector('#done')!;e.textContent='ready';setTimeout(()=>e.textContent='processing',50);setTimeout(()=>e.textContent='ready',180);});
  const start=performance.now();const waited=await call('chrome_wait',{selector:'#done',textContains:'ready',stableMs:150,timeoutMs:2000});assert.ok(performance.now()-start>=300);assert.ok(waited.stableForMs>=150);await page.close();
 });
 await t.test('postcondition inherits the action frame without reading a matching top-level element',async()=>{
  const {page,call}=await h.open();await page.evaluate(()=>{const iframe=document.createElement('iframe');iframe.srcdoc='<input id="text"><output id="done">frame ready</output>';document.body.append(iframe);});
  await page.waitForFunction(()=>!!document.querySelector('iframe')?.contentDocument?.querySelector('#text'));
  const found=await call('chrome_contexts'),top=found.frameTree.frameTree.frame.id,frame=found.contexts.find((x:any)=>x.auxData?.isDefault&&x.auxData.frameId!==top);assert.ok(frame);
  await call('chrome_batch',{steps:[{operation:'page.action',args:{action:'fill',selector:'#text',text:'frame value',contextId:frame.id},postcondition:{selector:'#text',valueEquals:'frame value'}}]});
  assert.equal(await page.$eval('#text',inputValue),'');assert.equal(await page.evaluate(()=>(document.querySelector('iframe')!.contentDocument!.querySelector('#text') as HTMLInputElement).value),'frame value');await page.close();
 });
 await t.test('deadline while a button is held releases it and does not emit a late click',async()=>{
  const {page,call,raw}=await h.open();await page.evaluate(()=>{(window as any).upButtons=[];document.addEventListener('mouseup',e=>(window as any).upButtons.push(e.buttons));});
  // 像真人一样操作时按下前要先移过去、停一会儿（最多一秒多），期限留够，保证到期发生在按住的时候。
  const result=await raw('chrome_action',{action:'click',selector:'#click',autoWait:false,holdMs:4000,timeoutMs:2500});assert.equal(result.ok,false);assert.equal(result.error?.outcome,'unknown');await page.waitForFunction(()=>(window as any).upButtons.length===1,{timeout:4000});
  assert.equal(await page.evaluate(()=>(window as any).clicks||0),0);assert.deepEqual(await page.evaluate(()=>(window as any).upButtons),[0]);await call('chrome_recover_tab');await page.close();
 });
 await t.test('repeated navigation releases old isolated worlds and keeps the renderer heap bounded',async()=>{
  const {page,call}=await h.open(),session=await page.createCDPSession();await call('chrome_inspect');await session.send('HeapProfiler.collectGarbage');const before=(await page.metrics()).JSHeapUsedSize!;
  const ids=new Set<string>();for(let i=0;i<30;i++){await page.reload();const result=await call('chrome_inspect');assert.ok(!ids.has(result.documentId));ids.add(result.documentId);assert.equal(await page.evaluate(()=>Object.hasOwn(window,'__fengMcp')),false);}
  await session.send('HeapProfiler.collectGarbage');const after=(await page.metrics()).JSHeapUsedSize!;assert.ok(after<before+2*1024*1024,`post-GC heap ${before} -> ${after}`);console.log('Navigation post-GC heap:',JSON.stringify({before,after,navigations:30}));await session.detach();await page.close();
 });
});

const feedbackHtml=`<!doctype html><meta charset="utf-8"><title>Start</title>
<button id="toast" onclick="setTimeout(()=>{const box=document.createElement('div');box.textContent='保存成功';document.body.append(box);setTimeout(()=>box.remove(),1500);},120)">Save</button>
<button id="panel" onclick="document.querySelector('#menu').hidden=false">Open</button><div id="menu" hidden><p>菜单已打开</p><button id="inner" onclick="window.printed=true">打印</button></div>
<button id="nothing">Nothing</button>
<button id="spa" onclick="history.pushState({},'','#/next');document.title='Next'">SPA</button>
<button id="confirm" onclick="document.body.append(confirm('确认删除？')?'已删除':'已取消')">Delete</button>
<button id="leave" onclick="location.search='?next=1'">Leave</button>
<button id="bulk" onclick="for(let i=0;i<300;i++){const row=document.createElement('p');row.textContent='第'+i+'行内容比较长一些用来撑满预算';document.body.append(row);const b=document.createElement('button');b.textContent='操作'+i;document.body.append(b);}">Bulk</button>
<input id="field" aria-label="Field" disabled><input id="live" aria-label="Live"><input id="secret" type="password" aria-label="支付密码"><input id="urgent" type="checkbox" aria-label="加急"><select id="mode" aria-label="方式"><option>甲</option><option>乙</option></select>
<div id="combo" role="combobox" aria-label="负责人" aria-expanded="false" tabindex="0" onclick="this.textContent='王五';this.setAttribute('aria-expanded','true')">请选择</div>
<button id="slow" onclick="setTimeout(()=>document.body.append('保存完成'),450)">Slow</button>`;
test('agent feedback: page change, dialog closure, read-only verification, compact inspect',async t=>{
 const h=await interactionHarness(t,feedbackHtml);
 await t.test('动作结果带页面变化：延迟提示、展开的控件、URL、没有变化、超长截断',async()=>{
  const {page,call}=await h.open();
  try{
   const saved=await call('chrome_action',{action:'click',selector:'#toast'});assert.equal(saved.pageChange.changed,true);assert.deepEqual(saved.pageChange.added,['保存成功']);
   const opened=await call('chrome_action',{action:'click',selector:'#panel'});assert.deepEqual(opened.pageChange.added,['菜单已打开'],'控件名不重复算进文字');
   const item=opened.pageChange.elements.find((x:any)=>x.name==='打印');assert.equal(item.role,'button');await call('chrome_action',{action:'click',ref:item.ref});assert.equal(await page.evaluate(()=>(window as any).printed),true);
   const same=await call('chrome_action',{action:'click',selector:'#nothing'});assert.equal(same.pageChange.changed,false);assert.ok(same.pageChange.waitedMs>=300,'要说清看了多久');
   const spa=await call('chrome_action',{action:'click',selector:'#spa'});assert.match(spa.pageChange.url,/#\/next$/);assert.equal(spa.pageChange.title,'Next');
   const bulk=await call('chrome_action',{action:'click',selector:'#bulk'});assert.ok(Buffer.byteLength(JSON.stringify(bulk.pageChange))<=620,JSON.stringify(bulk.pageChange));assert.ok(bulk.pageChange.moreText>0&&bulk.pageChange.moreElements>0);
   assert.equal((await call('chrome_action',{action:'click',selector:'#nothing',observe:false})).pageChange,undefined);
   assert.equal((await call('chrome_action',{action:'scroll',deltaY:10})).pageChange,undefined,'滚动不读');
   const batch=await call('chrome_batch',{steps:[{operation:'page.action',args:{action:'fill',selector:'#live',text:'x'}},{operation:'page.action',args:{action:'click',selector:'#toast'}}]});assert.equal(batch.completed,true);assert.ok(batch.pageChange.added.includes('保存成功'),JSON.stringify(batch.pageChange));assert.equal(batch.results[1].result.pageChange,undefined,'步骤不各自读');
   const form=await call('chrome_batch',{steps:[{operation:'page.action',args:{action:'fill',selector:'#live',text:'新值'}},{operation:'page.action',args:{action:'fill',selector:'#secret',text:'pw-1234'}},{operation:'page.action',args:{action:'setChecked',selector:'#urgent',checked:true}},{operation:'page.action',args:{action:'select',selector:'#mode',values:['乙']}}]});
   const changed=Object.fromEntries(form.pageChange.updated.map((x:any)=>[x.name,x]));assert.equal(changed.Live.value,'新值');assert.equal(changed.加急.checked,true);assert.equal(changed.方式.value,'乙');assert.equal(changed.支付密码.valueRedacted,true);assert.equal(JSON.stringify(form).includes('pw-1234'),false,'密码不进结果');
   const combo=await call('chrome_action',{action:'click',selector:'#combo'});const item2=combo.pageChange.updated[0];assert.equal(item2.text,'王五');assert.equal(item2.expanded,'true');
   const slow=await call('chrome_action',{action:'click',selector:'#slow'});assert.deepEqual(slow.pageChange.added,['保存完成'],'点击后没动静时多看一会儿');
   const left=await call('chrome_action',{action:'click',selector:'#leave'});assert.equal(left.pageChange.changed,true);assert.match(left.pageChange.url,/\?next=1/);
  }finally{await page.close();}
 });
 await t.test('点击弹出确认框：错误带内容，答完看到结果，不用恢复就能继续写',async()=>{
  const {page,call,raw}=await h.open();
  try{
   const blocked=await raw('chrome_action',{action:'click',selector:'#confirm'});assert.equal(blocked.error?.code,'DIALOG_OPEN');assert.match(blocked.error!.message,/确认删除？/);
   const answered=await call('chrome_dialog',{accept:true});assert.equal(answered.writable,true);assert.ok(answered.pageChange.added.includes('已删除'),JSON.stringify(answered));
   assert.equal((await call('chrome_action',{action:'click',selector:'#nothing'})).pageChange.changed,false);
  }finally{await page.close();}
 });
 await t.test('暂停写入时放行只读核对，写操作继续被拦',async()=>{
  const {page,call,raw}=await h.open();
  try{
   assert.equal((await raw('chrome_evaluate',{expression:'document.body.dataset.boom="1";throw new Error("boom")'})).error?.code,'JAVASCRIPT_ERROR');
   assert.equal((await raw('chrome_evaluate',{expression:'document.title'})).error?.code,'RESULT_UNKNOWN');
   assert.equal((await raw('chrome_action',{action:'click',selector:'#nothing'})).error?.code,'RESULT_UNKNOWN');
   assert.equal(await call('chrome_evaluate',{expression:'document.title',readOnly:true}),'Start');
   assert.deepEqual(await call('chrome_evaluate',{expression:"[...document.querySelectorAll('button')].map(b=>b.id).slice(0,2)",readOnly:true}),['toast','panel']);
   for(const expression of ["document.title='x'","document.querySelector('#nothing').click()","fetch('/x')"]){assert.equal((await raw('chrome_evaluate',{expression,readOnly:true})).error?.code,'SIDE_EFFECT_BLOCKED',expression);}
   assert.equal(await page.title(),'Start');
   assert.equal((await call('chrome_wait',{textContains:'Save',timeoutMs:1000})).matched,true);
   assert.equal((await raw('chrome_wait',{expression:'true',timeoutMs:500})).error?.code,'RESULT_UNKNOWN');
   assert.equal((await call('chrome_wait',{expression:'document.title==="Start"',readOnly:true,timeoutMs:1000})).matched,true);
   assert.equal((await raw('chrome_action',{action:'click',selector:'#nothing'})).error?.code,'RESULT_UNKNOWN','放行读取不解除保护');
   await call('chrome_recover_tab');
  }finally{await page.close();}
 });
 await t.test('普通客户端带管理页防护前缀时，只读核对和页面变化照常工作',async()=>{
  const {page,target}=await h.open();
  try{
   const principal=h.service.state.principal(h.service.state.createClient('restricted').id)!,call=(name:string,args:any)=>h.service.invoke(name,{...target,...args},'restricted-owner',principal);
   assert.equal((await call('chrome_evaluate',{expression:'document.title',readOnly:true})).data,'Start');
   assert.equal((await call('chrome_evaluate',{expression:"document.title='x'",readOnly:true})).error?.code,'SIDE_EFFECT_BLOCKED');
   assert.deepEqual(((await call('chrome_action',{action:'click',selector:'#toast'})).data as any).pageChange.added,['保存成功']);
  }finally{await page.close();}
 });
 await t.test('chrome_inspect 不输出默认值，ref 变短；非默认值照常输出，旧文档的 ref 仍然失效',async()=>{
  const {page,call,raw}=await h.open();
  try{
   const {elements}=await call('chrome_inspect'),save=elements.find((x:any)=>x.name==='Save'),field=elements.find((x:any)=>x.name==='Field');
   assert.match(save.ref,/^[0-9a-z]{1,7}:\d+$/);for(const key of ['visible','disabled','readOnly','type'])assert.equal(Object.hasOwn(save,key),false,key);
   assert.equal(field.disabled,true);assert.equal(field.visible,undefined);
   await page.reload();assert.equal((await raw('chrome_action',{action:'click',ref:save.ref})).error?.code,'STALE_ELEMENT_REF');
  }finally{await page.close();}
 });
});
