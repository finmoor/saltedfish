import test from 'node:test';
import assert from 'node:assert/strict';
import {loadExtension} from './extension-harness.js';
import {errorInfo,type JsonObject} from '../src/shared.js';
import {toolMap} from '../src/tools.js';
import {isVisualAction} from '../src/interaction-policy.js';

const h=await loadExtension();
const run=(tabId:number,args:JsonObject,ms=1000)=>h.executor.execute('page.action',{tabId,...args},h.deadline(ms)) as Promise<JsonObject>;
async function failure(pending:Promise<unknown>){try{await pending;}catch(error){return errorInfo(error);}assert.fail('expected refusal');}
const checkable=(page:ReturnType<typeof h.openTab>['page'],id:string,checked=false,type='checkbox')=>Object.assign(page.input(id),{checked,indeterminate:false,type,getAttribute:(_name:string)=>null});

test('doubleClick emits two trusted-protocol click pairs with clickCount 1/2 and shared modifiers',async()=>{
 const {tabId,page}=h.openTab();await run(tabId,{action:'doubleClick',x:20,y:40,modifiers:8});
 assert.deepEqual(page.mouseEvents.map(e=>[e.type,e.clickCount,e.buttons,e.modifiers]),[['mouseMoved',undefined,undefined,8],['mousePressed',1,1,8],['mouseReleased',1,0,8],['mousePressed',2,1,8],['mouseReleased',2,0,8]]);
});
test('doubleClick stops before second press if the first click replaces the target',async t=>{
 const {tabId,page}=h.openTab(),field=page.element('target');
 h.hooks.intercept=command=>{if(command.tabId===tabId&&command.method==='Input.dispatchMouseEvent'&&command.params.type==='mouseReleased')field.isConnected=false;};t.after(()=>{h.hooks.intercept=undefined;});
 const error=await failure(run(tabId,{action:'doubleClick',selector:'#target'}));assert.equal(error.outcome,'unknown');
 assert.equal(page.mouseEvents.filter(e=>e.type==='mousePressed').length,1);
});
test('drag follows bounded pointer steps, keeps button pressed, and releases at the target',async()=>{
 const {tabId,page}=h.openTab();const result=await run(tabId,{action:'drag',x:10,y:20,to:{x:110,y:220},steps:4,durationMs:0,modifiers:2});
 assert.equal(result.dragged,true);
 assert.deepEqual(page.mouseEvents.map(e=>[e.type,e.x,e.y,e.buttons]),[['mouseMoved',10,20,undefined],['mousePressed',10,20,1],['mouseMoved',35,70,1],['mouseMoved',60,120,1],['mouseMoved',85,170,1],['mouseMoved',110,220,1],['mouseReleased',110,220,0]]);
 assert.ok(page.mouseEvents.every(e=>e.modifiers===2));
});
test('drag cancellation after press releases the mouse without replaying or reaching the destination',async t=>{
 const {tabId,page}=h.openTab();
 h.hooks.intercept=command=>{if(command.tabId===tabId&&command.method==='Input.dispatchMouseEvent'&&command.params.type==='mousePressed')h.executor.cancelOperations();};t.after(()=>{h.hooks.intercept=undefined;});
 const error=await failure(run(tabId,{action:'drag',x:10,y:20,to:{x:110,y:220},steps:4,durationMs:0}));
 assert.equal(error.outcome,'unknown');assert.equal(page.mouseEvents.filter(e=>e.type==='mousePressed').length,1);
 assert.equal(page.mouseEvents.at(-1)?.type,'mouseReleased');assert.equal(page.mouseEvents.at(-1)?.buttons,0);assert.equal(page.mouseEvents.at(-1)?.x,-1);
});
test('drag resolves both elements before input and does not scroll while holding the mouse',async t=>{
 const {tabId,page}=h.openTab(),source=page.element('from',{left:10,right:60}),target=page.element('to',{left:300,right:350});
 let sourceScroll=0,targetScroll=0;
 h.hooks.intercept=command=>{if(command.tabId===tabId&&command.method==='Input.dispatchMouseEvent'&&command.params.type==='mousePressed'){sourceScroll=source.scrolled;targetScroll=target.scrolled;}};t.after(()=>{h.hooks.intercept=undefined;});
 await run(tabId,{action:'drag',selector:'#from',to:{selector:'#to'},durationMs:0,steps:3});
 assert.deepEqual([source.scrolled,target.scrolled],[sourceScroll,targetScroll]);
 assert.deepEqual([page.mouseEvents.at(-1)?.x,page.mouseEvents.at(-1)?.y],[325,25]);
});
test('drag with missing destination is not dispatched and cannot fall back to coordinates',async()=>{
 const {tabId,page}=h.openTab();page.element('source');const error=await failure(run(tabId,{action:'drag',selector:'#source',to:{selector:'#missing'},autoWait:false}));
 assert.equal(error.code,'ELEMENT_NOT_FOUND');assert.equal(error.outcome,'not_dispatched');assert.equal(page.mouseEvents.length,0);
});
test('setChecked is idempotent, including a disabled control whose state already matches',async()=>{
 const {tabId,page}=h.openTab(),field=checkable(page,'check',true);field.disabled=true;
 assert.deepEqual(await run(tabId,{action:'setChecked',selector:'#check',checked:true}),{checked:true,changed:false,verified:true});assert.equal(page.mouseEvents.length,0);
});
test('setChecked refuses readonly targets and rechecks state after hovering to avoid toggling a newly satisfied target',async t=>{
 const readonly=h.openTab(),blocked=checkable(readonly.page,'check');blocked.readOnly=true;
 const error=await failure(run(readonly.tabId,{action:'setChecked',selector:'#check',checked:true}));assert.equal(error.code,'NOT_EDITABLE');assert.equal(error.outcome,'not_dispatched');assert.equal(readonly.page.mouseEvents.length,0);
 const changed=h.openTab(),field=checkable(changed.page,'check');
 h.hooks.intercept=command=>{if(command.tabId===changed.tabId&&command.method==='Input.dispatchMouseEvent'&&command.params.type==='mouseMoved')field.checked=true;};t.after(()=>{h.hooks.intercept=undefined;});
 assert.deepEqual(await run(changed.tabId,{action:'setChecked',selector:'#check',checked:true}),{checked:true,changed:false,verified:true});assert.equal(changed.page.mouseEvents.filter(e=>e.type==='mousePressed').length,0);
});
test('setChecked verifies real state after one click and supports asynchronous component updates',async t=>{
 const {tabId,page}=h.openTab(),field=checkable(page,'check');
 h.hooks.intercept=command=>{if(command.tabId===tabId&&command.method==='Input.dispatchMouseEvent'&&command.params.type==='mouseReleased')setTimeout(()=>{field.checked=true;},20);};t.after(()=>{h.hooks.intercept=undefined;});
 assert.deepEqual(await run(tabId,{action:'setChecked',selector:'#check',checked:true}),{checked:true,changed:true,verified:true});
 assert.equal(page.mouseEvents.filter(e=>e.type==='mousePressed').length,1);
});
test('setChecked waits for a later checkbox before first input; autoWait:false and timeout never dispatch',async t=>{
 const delayed=h.openTab();let field:ReturnType<typeof checkable>|undefined;
 const timer=setTimeout(()=>{field=checkable(delayed.page,'late');},30);t.after(()=>clearTimeout(timer));
 h.hooks.intercept=command=>{if(command.tabId===delayed.tabId&&command.method==='Input.dispatchMouseEvent'&&command.params.type==='mouseReleased'&&field)field.checked=true;};t.after(()=>{h.hooks.intercept=undefined;});
 assert.equal((await run(delayed.tabId,{action:'setChecked',selector:'#late',checked:true})).verified,true);assert.equal(delayed.page.mouseEvents.filter(e=>e.type==='mousePressed').length,1);
 for(const autoWait of [false,true]){
  const missing=h.openTab(),error=await failure(run(missing.tabId,{action:'setChecked',selector:'#missing',checked:true,autoWait},100));assert.equal(error.code,autoWait?'ACTIONABILITY_TIMEOUT':'ELEMENT_NOT_FOUND');assert.equal(error.outcome,'not_dispatched');assert.equal(missing.page.mouseEvents.length,0);
 }
});
test('setChecked initial wait observes cancellation before any pointer event',async t=>{
 const {tabId,page}=h.openTab(),timer=setTimeout(()=>h.executor.cancelOperations(),20);t.after(()=>clearTimeout(timer));
 const error=await failure(run(tabId,{action:'setChecked',selector:'#missing',checked:true},500));assert.equal(error.code,'CANCELLED');assert.equal(error.outcome,'not_dispatched');assert.equal(page.mouseEvents.length,0);
});
test('setChecked cannot cancel a checked radio; a rejected checkbox update is unknown and never retried',async()=>{
 const radio=h.openTab();checkable(radio.page,'radio',true,'radio');
 const refused=await failure(run(radio.tabId,{action:'setChecked',selector:'#radio',checked:false}));assert.equal(refused.code,'RADIO_CANNOT_UNCHECK');assert.equal(refused.outcome,'not_dispatched');assert.equal(radio.page.mouseEvents.length,0);
 const checkbox=h.openTab();checkable(checkbox.page,'check');const missed=await failure(run(checkbox.tabId,{action:'setChecked',selector:'#check',checked:true},200));assert.equal(missed.code,'CHECK_STATE_NOT_APPLIED');assert.equal(missed.outcome,'unknown');assert.equal(checkbox.page.mouseEvents.filter(e=>e.type==='mousePressed').length,1);
});
test('schemas reject ambiguous drag targets, cross-frame destination fields and wrong action options',()=>{
 const action=toolMap.get('chrome_action')!.schema,base={profileId:'p',tabId:1};
 for(const input of [{action:'drag',x:0,y:0,to:{x:1}},{action:'drag',x:0,y:0,to:{selector:'#x',x:1,y:2}},{action:'drag',x:0,y:0,to:{selector:'#x',contextId:5}},{action:'drag',x:0,y:0,to:{x:1,y:2},steps:101},{action:'click',x:0,y:0,to:{x:1,y:2}},{action:'setChecked',selector:'#x'},{action:'click',x:0,y:0,checked:true}])assert.equal(action.safeParse({...base,...input}).success,false,JSON.stringify(input));
 for(const name of ['doubleClick','drag','setChecked'])assert.equal(isVisualAction(name),true);
 const navigate=toolMap.get('chrome_navigate')!.schema;
 assert.equal(navigate.safeParse({...base,url:'https://example.test/'}).success,true);
 for(const kind of ['back','forward','reload']){assert.equal(navigate.safeParse({...base,action:kind}).success,true);assert.equal(navigate.safeParse({...base,action:kind,url:'https://example.test/'}).success,false);}
 assert.equal(navigate.safeParse(base).success,false);
});
