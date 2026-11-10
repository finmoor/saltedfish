import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,fakeProfile,testDirectory} from './helpers.js';
import {StateStore} from '../src/state-store.js';
import {TaskManager} from '../src/tasks.js';
import {adminPrincipal} from '../src/auth.js';
import {toolMap} from '../src/tools.js';

const plan={name:'one business task',captureOnFailure:false,steps:[{operation:'page.action',args:{action:'fill',selector:'#field',text:'private-value'}}]};
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function ended(f:any,profileId:string,id:string){for(let i=0;i<100;i++){const task=f.service.tasks.get(profileId,id);if(['succeeded','failed','needs_review'].includes(task.status))return task;await pause(20);}throw new Error('task did not end');}

test('submission identity is scoped, durable and conflicts never dispatch twice',async()=>{
 const f=await fixture();let writes=0;
 try{
  const a=await fakeProfile(f.config,'A',command=>{if(command.operation==='tabs.list')return [{tabId:1}];if(command.operation==='page.action')writes++;return {};});
  const b=await fakeProfile(f.config,'B',command=>{if(command.operation==='tabs.list')return [{tabId:1}];if(command.operation==='page.action')writes++;return {};});
  const submissionId=randomUUID(),args={profileId:a.id,tabId:1,...plan,submissionId};
  const [first,again]=await Promise.all([f.service.invoke('chrome_task_submit',args,'one'),f.service.invoke('chrome_task_submit',args,'two')]);assert.ok(first.ok&&again.ok);assert.equal((first.data as any).id,(again.data as any).id);assert.equal((again.data as any).deduplicated,true);
  await ended(f,a.id,(first.data as any).id);assert.equal(writes,1);
  assert.equal((await f.service.invoke('chrome_task_submit',{...args,tabId:2},'one')).error?.code,'TASK_SUBMISSION_CONFLICT');
  const other=f.service.tasks.submit(b.id,1,plan,adminPrincipal,undefined,submissionId);await ended(f,b.id,other.id);assert.equal(writes,2);
  const grant=f.service.state.createClient('other writer',[a.id]),principal=f.service.state.authenticate(grant.token)!;
  const own=f.service.tasks.submit(a.id,1,plan,principal,undefined,submissionId);await ended(f,a.id,own.id);assert.equal(writes,3);
  const stored=JSON.stringify(f.service.state.tasks());assert.ok(!stored.includes('private-value'));assert.ok(!stored.includes('fingerprint'));
 }finally{await f.cleanup();}
});

test('restart and expired task history preserve submission receipts without restarting work',async()=>{
 const temp=await testDirectory();let state=new StateStore(temp.directory),manager=new TaskManager(state,async()=>{throw new Error('must not invoke');},()=>undefined,async()=>[],'stable-secret');
 const submissionId=randomUUID();
 try{
  const first=manager.submit('profile',1,plan,adminPrincipal,undefined,submissionId);manager.stopScheduling();await manager.drain();state.close();
  state=new StateStore(temp.directory);manager=new TaskManager(state,async()=>{throw new Error('must not invoke');},()=>undefined,async()=>[],'stable-secret');manager.stopScheduling();
  const repeat=manager.submit('profile',1,plan,adminPrincipal,undefined,submissionId);assert.equal(repeat.id,first.id);assert.equal(repeat.status,'interrupted');
  for(let i=0;i<501;i++)state.saveTask({id:randomUUID(),profileId:'profile',status:'succeeded',updatedAt:new Date(Date.now()+1000+i).toISOString()});
  assert.equal(state.task(first.id),undefined);assert.throws(()=>manager.submit('profile',1,plan,adminPrincipal,undefined,submissionId),{code:'TASK_SUBMISSION_EXPIRED'});
 }finally{manager.stopScheduling();await manager.drain();state.close();await temp.cleanup();}
});

test('submission receipt and task intent are one transaction on journal failure',async()=>{
 const f=await fixture(),original=f.service.state.saveTask.bind(f.service.state),submissionId=randomUUID();
 try{
  f.service.state.saveTask=()=>{throw new Error('disk failure');};
  assert.throws(()=>f.service.tasks.submit('profile',1,plan,adminPrincipal,undefined,submissionId),{code:'TASK_JOURNAL_FAILED'});
  assert.equal(f.service.state.taskSubmission('profile',adminPrincipal.id,submissionId),undefined);assert.equal(f.service.state.tasks().length,0);assert.equal(f.service.tasks.stats().activeTaskProfiles,0);
 }finally{f.service.state.saveTask=original;await f.cleanup();}
});

test('failed postcondition marks task and operation unknown, keeps the tail pending and blocks replay',async()=>{
 const f=await fixture();let batches=0;
 try{
  const p=await fakeProfile(f.config,'checked',command=>{if(command.operation==='tabs.list')return [{tabId:1}];if(command.operation==='page.batch'){batches++;assert.ok((command.args.steps as any[])[0].postcondition);return {completed:false,failedIndex:0,results:[],error:{code:'POSTCONDITION_TIMEOUT',phase:'postcondition',outcome:'unknown'}};}return {};});
  const input={...plan,steps:[{...plan.steps[0],postcondition:{selector:'#field',valueEquals:'private-value'}},plan.steps[0]]};
  const job=f.service.tasks.submit(p.id,1,input,adminPrincipal);const task=await ended(f,p.id,job.id);
  assert.equal(task.status,'needs_review');assert.equal(task.steps[0].verification,'unconfirmed');assert.equal(task.steps[0].phase,'postcondition');assert.equal(task.steps[1].state,'pending');assert.equal(f.service.state.get(task.steps[0].operationId)!.state,'unknown');assert.equal(batches,1);
  assert.throws(()=>f.service.tasks.control(p.id,job.id,'resume',adminPrincipal),{code:'TASK_FINISHED'});
 }finally{await f.cleanup();}
});

test('condition schemas reject ignored fields and saved workflows reject temporary postcondition refs',async()=>{
 const f=await fixture();
 try{
  const batch=toolMap.get('chrome_batch')!.schema;
  for(const postcondition of [{expression:'sideEffect()'},{urlContains:'x',valueEquals:'ignored'},{selector:'#x',ref:'ambiguous'}])assert.equal(batch.safeParse({profileId:'p',tabId:1,steps:[{...plan.steps[0],postcondition}]}).success,false);
  assert.throws(()=>f.service.tasks.saveWorkflow('p',{...plan,steps:[{...plan.steps[0],postcondition:{ref:'temporary'}}]}),{code:'EPHEMERAL_LOCATOR'});
  const p=await fakeProfile(f.config,'old');f.service.broker.profiles.get(p.id)!.info.capabilities=['execution-v3','element-state-v2'];
  assert.equal((await f.service.invoke('chrome_action',{profileId:p.id,tabId:1,action:'fill',selector:'#x',text:'x'},'test')).error?.code,'EXTENSION_UPDATE_REQUIRED');
 }finally{await f.cleanup();}
});

test('步骤动作做完、后置条件没满足（dispatched）：批次里标签页照常可写，但任务仍按待核查停下，不当普通失败',async()=>{
 const f=await fixture();
 try{
  const profile=await fakeProfile(f.config,'dispatched',command=>{if(command.operation==='tabs.list')return [{tabId:1}];if(command.operation==='page.batch')return {completed:false,failedIndex:0,results:[],failedStep:{index:0,operation:'page.action',result:{},postcondition:{matched:false}},error:{code:'POSTCONDITION_TIMEOUT',message:'动作已经做完，后置条件没有满足',phase:'postcondition',outcome:'dispatched'}};return {};});
  const steps=[{operation:'page.action',args:{action:'click',selector:'#publish'},postcondition:{selector:'.done',stableMs:0}}];
  const submitted=await f.service.invoke('chrome_task_submit',{profileId:profile.id,tabId:1,name:'publish',captureOnFailure:false,steps},'owner');assert.ok(submitted.ok,JSON.stringify(submitted.error));
  const task=await ended(f,profile.id,(submitted.data as any).id);
  assert.equal(task.status,'needs_review');assert.equal(task.reason,'POSTCONDITION_TIMEOUT');
 }finally{await f.cleanup();}
});
