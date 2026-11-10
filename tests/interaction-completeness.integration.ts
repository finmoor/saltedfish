import test from 'node:test';
import assert from 'node:assert/strict';
import {interactionHarness} from './interaction-harness.js';

const html=`<!doctype html><meta charset="utf-8"><style>body{margin:30px}#drag{width:70px;height:60px;background:#6ae;touch-action:none}#drop{position:absolute;left:320px;top:150px;width:100px;height:100px;background:#cfa}</style>
<button id="double">Double</button><input id="check" type="checkbox"><input id="radio" type="radio"><button id="aria" role="checkbox" aria-checked="false">ARIA</button><div id="drag">Drag</div><div id="drop">Drop</div><output id="done"></output><script>
window.log=[];for(const type of ['click','dblclick','pointerdown','pointermove','pointerup'])document.addEventListener(type,e=>window.log.push({type,id:e.target.id,trusted:e.isTrusted,buttons:e.buttons}));
document.querySelector('#double').addEventListener('dblclick',()=>window.doubles=(window.doubles||0)+1);
document.querySelector('#aria').addEventListener('click',e=>e.currentTarget.setAttribute('aria-checked',e.currentTarget.getAttribute('aria-checked')==='true'?'false':'true'));
document.querySelector('#drag').addEventListener('pointerdown',e=>e.currentTarget.setPointerCapture(e.pointerId));
document.querySelector('#drag').addEventListener('pointerup',e=>{if(e.clientX>=320&&e.clientX<=420&&e.clientY>=150&&e.clientY<=250)document.querySelector('#done').textContent='dropped';});
</script>`;

test('complete pointer interactions and history navigation use real Chrome event semantics',async t=>{
 const h=await interactionHarness(t,html);
 await t.test('double click generates exactly two clicks and one trusted dblclick',async()=>{
  const {page,call}=await h.open();try{
   const result=await call('chrome_action',{action:'doubleClick',selector:'#double'});assert.equal(result.doubleClicked,true);
   const state=await page.evaluate(()=>({doubles:(window as any).doubles,log:(window as any).log.filter((e:any)=>e.id==='double'&&['click','dblclick'].includes(e.type))}));
   assert.equal(state.doubles,1);assert.deepEqual(state.log.map((e:any)=>e.type),['click','click','dblclick']);assert.ok(state.log.every((e:any)=>e.trusted));
  }finally{await page.close();}
 });
 await t.test('setChecked reaches native and ARIA states, is idempotent, and does not synthetically set DOM properties',async()=>{
  const {page,call,raw}=await h.open();try{
   for(const selector of ['#check','#aria']){
    assert.equal((await call('chrome_action',{action:'setChecked',selector,checked:true})).changed,true);
    assert.equal((await call('chrome_action',{action:'setChecked',selector,checked:true})).changed,false);
    assert.equal((await call('chrome_action',{action:'setChecked',selector,checked:false})).verified,true);
   }
   assert.equal(await page.$eval('#check',e=>(e as HTMLInputElement).checked),false);assert.equal(await page.$eval('#aria',e=>e.getAttribute('aria-checked')),'false');
   assert.deepEqual(await page.evaluate(()=>(window as any).log.filter((e:any)=>e.type==='click'&&['check','aria'].includes(e.id)).map((e:any)=>[e.id,e.trusted])),[['check',true],['check',true],['aria',true],['aria',true]]);
   await call('chrome_action',{action:'setChecked',selector:'#radio',checked:true});const radio=await raw('chrome_action',{action:'setChecked',selector:'#radio',checked:false});assert.equal(radio.error?.code,'RADIO_CANNOT_UNCHECK');assert.equal(radio.error?.outcome,'not_dispatched');
  }finally{await page.close();}
 });
 await t.test('prevented setChecked is unknown after one click and never toggles again',async()=>{
  const {page,raw,call}=await h.open();try{
   await page.$eval('#check',e=>e.addEventListener('click',event=>event.preventDefault()));
   // 首次附加调试器与定位也在操作预算内；留足时间，确保验证的是已点击后状态未应用。
   const result=await raw('chrome_action',{action:'setChecked',selector:'#check',checked:true,timeoutMs:2000});assert.equal(result.ok,false);assert.equal(result.error?.outcome,'unknown');
   assert.equal(await page.evaluate(()=>(window as any).log.filter((e:any)=>e.type==='click'&&e.id==='check').length),1);
   assert.equal(await page.$eval('#check',e=>(e as HTMLInputElement).checked),false);await call('chrome_recover_tab');
  }finally{await page.close();}
 });
 await t.test('setChecked waits for async controls and can no-op an already checked hidden semantic target',async()=>{
  const {page,call,raw}=await h.open();try{
   await page.evaluate(()=>{setTimeout(()=>{const input=document.createElement('input');input.id='late';input.type='checkbox';input.setAttribute('aria-label','Late checkbox');document.body.append(input);},120);});
   const changed=await call('chrome_action',{action:'setChecked',locator:{role:'checkbox',name:'Late checkbox'},checked:true,timeoutMs:2000});assert.equal(changed.changed,true);
   await page.$eval('#late',e=>(e as HTMLElement).style.display='none');
   const noop=await call('chrome_action',{action:'setChecked',locator:{role:'checkbox',name:'Late checkbox'},checked:true});assert.equal(noop.changed,false);
   for(const autoWait of [false,true]){const missing=await raw('chrome_action',{action:'setChecked',selector:'#not-present',checked:true,autoWait,timeoutMs:200});assert.equal(missing.error?.code,autoWait?'ACTIONABILITY_TIMEOUT':'ELEMENT_NOT_FOUND');assert.equal(missing.error?.outcome,'not_dispatched');}
   assert.equal(await page.evaluate(()=>(window as any).log.filter((e:any)=>e.type==='click'&&e.id==='late').length),1);
  }finally{await page.close();}
 });
 await t.test('drag sends pressed pointer motion and a release at a verified destination',async()=>{
  const {page,call}=await h.open();try{
   const result=await call('chrome_action',{action:'drag',selector:'#drag',to:{selector:'#drop'},steps:6,durationMs:120});assert.equal(result.dragged,true);
   assert.equal(await page.$eval('#done',e=>e.textContent),'dropped');
   const events=await page.evaluate(()=>(window as any).log.filter((e:any)=>e.id==='drag'&&e.type.startsWith('pointer')));assert.ok(events.some((e:any)=>e.type==='pointermove'&&e.buttons===1));assert.ok(events.every((e:any)=>e.trusted));assert.equal(events.filter((e:any)=>e.type==='pointerdown').length,1);assert.equal(events.filter((e:any)=>e.type==='pointerup').length,1);
  }finally{await page.close();}
 });
 await t.test('same-frame pointer operations also work inside a cross-origin iframe',async()=>{
  const {page,call}=await h.open();try{
   await page.evaluate(url=>{const frame=document.createElement('iframe');frame.name='child';frame.src=url;frame.width='650';frame.height='450';document.body.append(frame);},`http://localhost:${h.port}/child`);
   const frame=await page.waitForFrame(f=>f.name()==='child'&&f.url().includes('localhost'));await frame.waitForSelector('#double');
   let context:any;
   for(let i=0;i<50&&!context;i++){const contexts=await call('chrome_contexts');context=contexts.contexts.find((c:any)=>c.auxData?.isDefault&&String(c.origin).includes('localhost'));if(!context)await new Promise(resolve=>setTimeout(resolve,50));}
   assert.ok(context);const scope={contextId:context.id,sessionId:context.sessionId};
   await call('chrome_action',{action:'doubleClick',selector:'#double',...scope});assert.equal(await frame.evaluate(()=>(window as any).doubles),1);
   await call('chrome_action',{action:'setChecked',selector:'#check',checked:true,...scope});assert.equal(await frame.$eval('#check',e=>(e as HTMLInputElement).checked),true);
   await call('chrome_action',{action:'drag',selector:'#drag',to:{selector:'#drop'},durationMs:100,steps:5,...scope});assert.equal(await frame.$eval('#done',e=>e.textContent),'dropped');
  }finally{await page.close();}
 });
 await t.test('native HTML drag/drop and a dragged source following the pointer both complete',async()=>{
  for(const native of [true,false]){
   const {page,call}=await h.open();try{
    await page.evaluate(native=>{
     const source=document.querySelector('#drag') as HTMLElement,drop=document.querySelector('#drop')!;
     if(native){
      source.draggable=true;source.addEventListener('dragstart',event=>event.dataTransfer!.setData('text/plain','payload'));
      drop.addEventListener('dragover',event=>event.preventDefault());drop.addEventListener('drop',event=>{event.preventDefault();document.querySelector('#done')!.textContent=(event as DragEvent).dataTransfer!.getData('text/plain');});
     }else source.addEventListener('pointermove',event=>{if(event.buttons===1){source.style.position='fixed';source.style.left=(event.clientX-35)+'px';source.style.top=(event.clientY-30)+'px';source.style.zIndex='10';}});
    },native);
    await call('chrome_action',{action:'drag',selector:'#drag',to:{selector:'#drop'},steps:10,durationMs:200});
    assert.equal(await page.$eval('#done',e=>e.textContent),native?'payload':'dropped');
   }finally{await page.close();}
  }
 });
 await t.test('back/forward preserve history state and reload replaces the document once',async()=>{
  const {page,call}=await h.open();try{
   const original=page.url();await call('chrome_navigate',{url:original+'second',timeoutMs:3000});
   assert.equal((await call('chrome_navigate',{action:'back',timeoutMs:3000})).url,original);
   assert.equal((await call('chrome_navigate',{action:'forward',timeoutMs:3000})).url,original+'second');
   await page.evaluate(()=>{(window as any).marker='old';});await call('chrome_navigate',{action:'reload',timeoutMs:3000});assert.equal(await page.evaluate(()=>(window as any).marker),undefined);
   await page.evaluate(()=>history.pushState({id:1},'','#one'));await page.evaluate(()=>history.pushState({id:2},'','#two'));
   assert.ok((await call('chrome_navigate',{action:'back',timeoutMs:1500})).url.endsWith('#one'));
   assert.ok((await call('chrome_navigate',{action:'forward',timeoutMs:1500})).url.endsWith('#two'));assert.equal(await page.evaluate(()=>history.state.id),2);
  }finally{await page.close();}
 });
});
