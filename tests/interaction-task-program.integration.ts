import test from 'node:test';
import assert from 'node:assert/strict';
import {interactionHarness} from './interaction-harness.js';

const html='<!doctype html><meta charset="utf-8"><title>Task program fixture</title><div id="ready">ready</div><input id="value"><input id="status"><script>window.reads=0;window.bad=0;window.confirms=0;window.requests=0;</script>';
const end={operation:'flow.end',args:{}};
async function finished(call:(name:string,args?:any)=>Promise<any>,id:string){
 // 像真人一样操作时每个点击、填值要多花零点几秒到几秒，最多等 30 秒。
 for(let i=0;i<1200;i++){const record=await call('chrome_task',{taskId:id});if(['succeeded','failed','needs_review','cancelled','interrupted'].includes(record.status))return record;await new Promise(resolve=>setTimeout(resolve,25));}
 throw new Error('task did not finish');
}
test('task programs combine observed results, branches, loops, screenshots and response waits in isolated Chrome',async t=>{
 const h=await interactionHarness(t,html);
 const taskCall=async(name:string,args:any={})=>{const result=await h.service.invoke(name,{profileId:h.profile.id,...args},'interaction-test');assert.ok(result.ok,`${name}: ${JSON.stringify(result.error)}`);return result.data as any;};
 await t.test('read → if → repeat → bound fill → screenshot → network response completes with exact page state',async()=>{
  const {page,call}=await h.open();try{
   const task=await call('chrome_task_submit',{name:'task-program-real',captureOnFailure:false,steps:[
    {operation:'page.evaluate',args:{expression:'({accepted:true})'},postcondition:{selector:'#ready',textContains:'ready'},saveAs:'config'},
    {operation:'flow.if',args:{variable:'config.accepted',operator:'equals',value:true}},
    {operation:'flow.repeat',args:{count:3}},
    {operation:'page.evaluate',args:{expression:'({text:"value-"+(++window.reads)})'},saveAs:'row'},
    {operation:'page.action',args:{action:'fill',selector:'#value',text:'placeholder'},bindings:{text:'row.text'},postcondition:{selector:'#value',state:'editable'}},end,
    {operation:'flow.else',args:{}},{operation:'page.evaluate',args:{expression:'window.bad++'}},end,
    {operation:'page.screenshot',args:{},saveAs:'shot'},
    {operation:'flow.if',args:{variable:'shot.artifactId',operator:'exists'}},{operation:'page.action',args:{action:'fill',selector:'#status',text:'screenshot-saved'}},end,
    {operation:'network.start',args:{},saveAs:'capture'},
    {operation:'page.evaluate',args:{expression:'window.requests++;fetch("/payload").then(r=>r.text()).then(()=>({sent:true}))'}},
    {operation:'network.wait',args:{urlContains:'/payload',since:0,status:200},bindings:{since:'capture.since'},saveAs:'response'},
    {operation:'flow.if',args:{variable:'response.status',operator:'equals',value:200}},
    {operation:'page.action',args:{action:'fill',selector:'#status',text:'all-complete'}},end,{operation:'network.stop',args:{}},
   ]});
   const result=await finished(taskCall,task.id);assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(result.steps[4].executions,3);assert.equal(result.steps[7].state,'skipped');assert.equal(result.steps[9].artifactType,'png');assert.ok(result.steps[9].artifactId);
   assert.deepEqual(await page.evaluate(()=>({value:(document.querySelector('#value') as HTMLInputElement).value,status:(document.querySelector('#status') as HTMLInputElement).value,reads:(window as any).reads,bad:(window as any).bad,requests:(window as any).requests})),{value:'value-3',status:'all-complete',reads:3,bad:0,requests:1});
   assert.ok(!JSON.stringify(await taskCall('chrome_task_diagnostics',{taskId:task.id})).includes('value-3'));
  }finally{await page.close();}
 });
 await t.test('paired dialog bindings are predeclared and both saved results can feed later steps',async()=>{
  const {page,call}=await h.open();try{
   const task=await call('chrome_task_submit',{name:'paired-results',captureOnFailure:false,steps:[
    {operation:'flow.set',args:{name:'message',value:'confirm-once'}},
    {operation:'page.evaluate',args:{expression:'window.confirms++;({value:confirm("confirm-once")?"accepted":"declined"})'},saveAs:'answer'},
    {operation:'page.dialog',args:{accept:true,expectedType:'confirm',expectedMessage:'placeholder'},bindings:{expectedMessage:'message'},saveAs:'dialog'},
    {operation:'flow.if',args:{variable:'dialog.accept',operator:'equals',value:true}},
    {operation:'page.action',args:{action:'fill',selector:'#value',text:'placeholder'},bindings:{text:'answer.value'}},end,
   ]});
   const result=await finished(taskCall,task.id);assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(result.steps[2].executions,1);
   assert.equal(await page.$eval('#value',e=>(e as HTMLInputElement).value),'accepted');assert.equal(await page.evaluate(()=>(window as any).confirms),1);
  }finally{await page.close();}
 });
 await t.test('failed network result stops the tail without repeating the completed request',async()=>{
  const {page,call}=await h.open();try{
   const task=await call('chrome_task_submit',{name:'network-failure',captureOnFailure:false,steps:[
    {operation:'network.start',args:{},saveAs:'capture'},
    {operation:'page.evaluate',args:{expression:'window.requests++;fetch("/rejected-status").then(r=>r.text()).then(()=>true)'}},
    {operation:'network.wait',args:{urlContains:'/rejected-status',since:0,status:201},bindings:{since:'capture.since'}},
    {operation:'page.action',args:{action:'fill',selector:'#value',text:'must-not-run'}},
   ]});
   const result=await finished(taskCall,task.id);assert.equal(result.status,'failed',JSON.stringify(result));assert.equal(result.reason,'RESPONSE_STATUS_MISMATCH');assert.equal(result.steps[1].state,'succeeded');assert.equal(result.steps[3].state,'pending');
   assert.equal(await page.evaluate(()=>(window as any).requests),1);assert.equal(await page.$eval('#value',e=>(e as HTMLInputElement).value),'');assert.equal(h.service.state.pendingOperations(h.profile.id).unknown,0);
  }finally{await page.close();}
 });
});
