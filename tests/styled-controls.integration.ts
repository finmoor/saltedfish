import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {interactionHarness} from './interaction-harness.js';
import {checkedValue} from './dom-readers.js';

const html=await readFile(new URL('./fixtures/styled-controls.html',import.meta.url),'utf8');
test('S18-01 styled native controls and semantic checked conditions',async t=>{
 const h=await interactionHarness(t,html);
 await t.test('the exact independent stress-report fixture works without coordinate fallback',async()=>{
  const {page,call}=await h.open();await page.setContent(await readFile(new URL('./fixtures/opacity-checkbox.html',import.meta.url),'utf8'));
  const locator={role:'checkbox',name:'Styled acceptance',exact:true};assert.equal((await call('chrome_find',{locator})).totalElements,1);
  await call('chrome_batch',{steps:[{operation:'page.action',args:{action:'click',locator,autoWait:false},postcondition:{locator,state:'checked',timeoutMs:300}}]});
  assert.equal(await page.$eval('#styled',checkedValue),true);assert.equal(await page.$eval('#status',e=>e.textContent),'ON');await page.close();
 });
 await t.test('semantic discovery, native toggles and checked postconditions agree exactly once',async()=>{
  const {page,call}=await h.open();const locator={role:'checkbox',name:'Styled acceptance',exact:true};
  const found=await call('chrome_find',{locator});assert.equal(found.totalElements,1);
  const inspected=await call('chrome_inspect',{limit:100});assert.ok(inspected.elements.some((e:any)=>e.ref===found.elements[0].ref));
  for(const state of ['checked','unchecked'])await call('chrome_batch',{steps:[{operation:'page.action',args:{action:'click',locator,autoWait:false},postcondition:{locator,state,timeoutMs:300}}]});
  assert.equal(await page.$eval('#status',e=>e.textContent),'OFF');
  assert.deepEqual(await page.evaluate(()=>(window as any).events.filter((e:any)=>e.id==='styled')),[{type:'click',id:'styled',trusted:true},{type:'change',id:'styled',trusted:true},{type:'click',id:'styled',trusted:true},{type:'change',id:'styled',trusted:true}]);await page.close();
 });
 await t.test('adjacent label skin, associated radio and ARIA switch use native input',async()=>{
  const {page,call}=await h.open();
  for(const [id,role,name]of [['todo','checkbox','Toggle Todo'],['radio','radio','Styled radio'],['switch','switch','ARIA switch']]){
   await call('chrome_batch',{steps:[{operation:'page.action',args:{action:'click',locator:{role,name,exact:true},autoWait:false},postcondition:{selector:`#${id}`,state:'checked',timeoutMs:300}}]});
   assert.equal(await page.evaluate(id=>(window as any).events.filter((e:any)=>e.id===id&&e.type==='click'&&e.trusted).length,id),1);
  }await page.close();
 });
 await t.test('skin can disappear after a successful toggle without false unknown',async()=>{
  const {page,call}=await h.open();await page.$eval('#styled',e=>e.addEventListener('change',()=>{(e as HTMLElement).style.display='none';e.parentElement!.querySelector('.skin')!.remove();},{once:true}));
  await call('chrome_batch',{steps:[{operation:'page.action',args:{action:'click',selector:'#styled',autoWait:false},postcondition:{locator:{role:'checkbox',name:'Styled acceptance',exact:true},state:'checked',timeoutMs:300}}]});
  assert.equal(await page.$eval('#styled',checkedValue),true);assert.equal(await page.$eval('#status',e=>e.textContent),'ON');await page.close();
 });
 await t.test('checked and unchecked are semantic state checks including hidden controls',async()=>{
  const {page,call,raw}=await h.open();
  await call('chrome_wait',{locator:{role:'checkbox',name:'Hidden state',exact:true},state:'checked',timeoutMs:300});
  await call('chrome_wait',{selector:'#hidden-switch',state:'unchecked',timeoutMs:300});
  await page.$eval('#hidden-switch',e=>e.setAttribute('aria-checked','mixed'));
  for(const state of ['checked','unchecked']){const r=await raw('chrome_wait',{selector:'#hidden-switch',state,timeoutMs:100});assert.equal(r.ok,false);assert.equal(r.error?.outcome,'not_dispatched');}
  await page.$eval('#hidden-state',element=>{if(!(element instanceof HTMLInputElement))throw new Error('Expected checkbox fixture');element.checked=false;});await call('chrome_wait',{selector:'#hidden-state',state:'unchecked',timeoutMs:300});
  const r=await raw('chrome_wait',{selector:'#status',state:'unchecked',timeoutMs:100});assert.equal(r.ok,false);await page.close();
 });
 await t.test('hidden, disabled, inert, obscured and skinless inputs remain protected',async()=>{
  const {page,raw}=await h.open();
  for(const [id,code]of [['display','ELEMENT_NOT_VISIBLE'],['visibility','ELEMENT_NOT_VISIBLE'],['ancestor','ELEMENT_NOT_VISIBLE'],['plain','ELEMENT_NOT_VISIBLE'],['orphan','ELEMENT_NOT_VISIBLE'],['wrong-label','ELEMENT_NOT_VISIBLE'],['disabled','ELEMENT_DISABLED'],['inert','ELEMENT_DISABLED'],['obscured','ELEMENT_OBSCURED'],['pointer','ELEMENT_OBSCURED']]){
   const r=await raw('chrome_action',{action:'click',selector:`#${id}`,autoWait:false});assert.equal(r.error?.code,code,id);assert.equal(r.error?.outcome,'not_dispatched',id);
   assert.equal(await page.$eval(`#${id}`,checkedValue),false,id);
  }assert.deepEqual(await page.evaluate(()=>(window as any).events),[]);await page.close();
 });
 await t.test('vanishing skin during held input cancels without replay',async()=>{
  const {page,raw,call}=await h.open();await page.$eval('#styled',e=>e.addEventListener('mousedown',()=>setTimeout(()=>e.parentElement!.querySelector('.skin')!.remove(),20),{once:true}));
  const r=await raw('chrome_action',{action:'click',selector:'#styled',holdMs:120,autoWait:false});assert.equal(r.error?.code,'ELEMENT_NOT_VISIBLE');assert.equal(r.error?.outcome,'unknown');
  assert.equal(await page.$eval('#styled',checkedValue),false);await call('chrome_recover_tab');await page.close();
 });
 await t.test('unsatisfied checked condition stops the tail and never replays the toggle',async()=>{
  const {page,raw,call}=await h.open();const r=await raw('chrome_batch',{steps:[{operation:'page.action',args:{action:'click',selector:'#styled',autoWait:false},postcondition:{selector:'#styled',state:'unchecked',timeoutMs:150}},{operation:'page.evaluate',args:{expression:"document.querySelector('#tail').textContent='1'"}}]});
  assert.equal(r.batch?.error.code,'POSTCONDITION_TIMEOUT');assert.equal(r.batch?.error.outcome,'dispatched');assert.equal(r.batch?.error.phase,'postcondition');
  assert.equal(await page.$eval('#styled',checkedValue),true);assert.equal(await page.$eval('#tail',e=>e.textContent),'0');assert.equal(await page.evaluate(()=>(window as any).events.filter((e:any)=>e.id==='styled'&&e.type==='click').length),1);assert.equal(await call('chrome_evaluate',{expression:'1+1'}),2,'不暂停写入');await page.close();
 });
});
