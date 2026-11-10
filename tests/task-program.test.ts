import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, fakeProfile, FAKE_CAPABILITIES } from './helpers.js';
import { adminPrincipal } from '../src/auth.js';
import { TaskVariables, compileProgram } from '../src/task-program.js';
import type { TaskRecord } from '../src/tasks.js';
import { CAPABILITY } from '../src/shared.js';

async function ended(read:()=>TaskRecord){for(let i=0;i<300;i++){const value=read();if(['succeeded','failed','needs_review','interrupted','cancelled'].includes(value.status))return value;await new Promise(r=>setTimeout(r,10));}throw new Error('任务未结束');}
const fill=(text:string,extra={})=>({operation:'page.action',args:{action:'fill',selector:'#value',text},...extra});
const end={operation:'flow.end',args:{}};

test('条件、嵌套有界循环、结果绑定执行正确分支；历史不含运行值',async()=>{
 const f=await fixture();const writes:string[]=[];let reads=0;
 try{
  const p=await fakeProfile(f.config,'program',c=>c.operation==='tabs.list'?[{tabId:1}]:c.operation==='page.evaluate'?{title:`secret-${++reads}`,accept:true}:c.operation==='page.action'?(writes.push(String(c.args.text)),{filled:true}):{});
  const job=f.service.tasks.submit(p.id,1,{name:'控制流',captureOnFailure:false,steps:[
   {operation:'flow.repeat',args:{count:2}},
   {operation:'page.evaluate',args:{expression:'readRecord()'},saveAs:'row'},
   {operation:'flow.if',args:{variable:'row.accept',operator:'equals',value:true}},
   fill('placeholder',{bindings:{text:'row.title'}}),
   {operation:'flow.else',args:{}},fill('wrong'),end,end,
  ]},adminPrincipal);
  const result=await ended(()=>f.service.tasks.get(p.id,job.id));
  assert.equal(result.status,'succeeded',JSON.stringify(result));assert.deepEqual(writes,['secret-1','secret-2']);
  assert.equal(result.steps[3]!.executions,2);assert.equal(result.steps[5]!.state,'skipped');
  assert.ok(!JSON.stringify(f.service.tasks.diagnostics(p.id,job.id)).includes('secret-'));
  assert.ok(!JSON.stringify(f.service.state.tasks()).includes('readRecord'));
 }finally{await f.cleanup();}
});

test('循环while条件读取更新后的结果，次数和总执行预算同时生效',async()=>{
 const f=await fixture();let count=0;
 try{
  const p=await fakeProfile(f.config,'loop',c=>c.operation==='tabs.list'?[{tabId:1}]:c.operation==='page.evaluate'?{count:++count}:{});
  const steps=[{operation:'flow.set',args:{name:'row',value:{count:0}}},{operation:'flow.repeat',args:{count:100,while:{variable:'row.count',operator:'lt',value:3}}},{operation:'page.evaluate',args:{expression:'increment()'},saveAs:'row'},end];
  const first=f.service.tasks.submit(p.id,1,{name:'while',captureOnFailure:false,steps},adminPrincipal);
  assert.equal((await ended(()=>f.service.tasks.get(p.id,first.id))).status,'succeeded');assert.equal(count,3);
  const limited=f.service.tasks.submit(p.id,1,{name:'bounded',captureOnFailure:false,maxExecutedSteps:4,steps:[{operation:'flow.repeat',args:{count:100}},{operation:'page.evaluate',args:{expression:'increment()'}},end]},adminPrincipal);
  const result=await ended(()=>f.service.tasks.get(p.id,limited.id));assert.equal(result.status,'failed');assert.equal(result.reason,'TASK_EXECUTION_LIMIT');assert.equal(count,4);
  assert.equal(f.service.state.pendingOperations(p.id).unknown,0);
 }finally{await f.cleanup();}
});

test('无效控制结构和脚本/目标绑定在提交时拒绝',()=>{
 for(const steps of [[end],[{operation:'flow.else',args:{}}],[{operation:'flow.if',args:{}}],[{operation:'flow.repeat',args:{count:1}},{operation:'flow.else',args:{}},end]])assert.throws(()=>compileProgram(steps),{code:'TASK_CONTROL_INVALID'});
 for(const [operation,target] of [['page.evaluate','expression'],['page.cdp','params'],['page.action','tabId'],['page.action','locator.__proto__.polluted']] as const)assert.throws(()=>compileProgram([{operation,args:{},bindings:{[target]:'source'}}]));
 assert.equal(({} as any).polluted,undefined);
});

test('未定义变量和绑定后无效参数都不派发网页动作、不制造unknown',async()=>{
 const f=await fixture();let writes=0;
 try{
  const p=await fakeProfile(f.config,'bind',c=>c.operation==='tabs.list'?[{tabId:1}]:(c.operation==='page.action'&&writes++,{}));
  for(const [steps,reason] of [[ [fill('x',{bindings:{text:'missing.title'}})],'TASK_VARIABLE_MISSING'],[[{operation:'flow.set',args:{name:'bad',value:123}},fill('x',{bindings:{text:'bad'}})],'INVALID_ARGUMENT']] as const){
   const job=f.service.tasks.submit(p.id,1,{name:'invalid',captureOnFailure:false,steps},adminPrincipal);
   const result=await ended(()=>f.service.tasks.get(p.id,job.id));assert.equal(result.status,'failed');assert.equal(result.reason,reason);
  }
  assert.equal(writes,0);assert.equal(f.service.state.pendingOperations(p.id).unknown,0);
 }finally{await f.cleanup();}
});

test('队列直接编排截图、网络捕获、CDP与下载，并可传递结果',async()=>{
 const f=await fixture();const methods:string[]=[];
 try{
  const p=await fakeProfile(f.config,'tools',c=>{
   methods.push(c.operation);if(c.operation==='tabs.list')return[{tabId:1}];
   if(c.operation==='page.screenshot')return{data:Buffer.from('image').toString('base64'),mimeType:'image/png'};
   if(c.operation==='downloads.start')return{downloadId:7};
   if(c.operation==='downloads.list')return[{id:7,state:'complete',exists:true,filename:'result.txt'}];
   return{};
  });
  const job=f.service.tasks.submit(p.id,1,{name:'extended',captureOnFailure:false,steps:[
   {operation:'page.screenshot',args:{},saveAs:'shot'},
   {operation:'network.start',args:{},saveAs:'capture'},
   {operation:'page.cdp',args:{method:'DOM.getDocument',params:{}}},
   {operation:'network.stop',args:{}},
   {operation:'downloads.start',args:{url:'https://example.test/file'},saveAs:'download'},
   {operation:'downloads.wait',args:{downloadId:0},bindings:{downloadId:'download.downloadId'}},
  ]},adminPrincipal);
  const result=await ended(()=>f.service.tasks.get(p.id,job.id));assert.equal(result.status,'succeeded',JSON.stringify(result));
  for(const operation of ['page.screenshot','network.start','page.cdp','network.stop','downloads.start','downloads.list'])assert.ok(methods.includes(operation),operation);
 }finally{await f.cleanup();}
});

test('结果变量只读取自有路径，容量明确有界',()=>{
 const vars=new TaskVariables();vars.set('record',{list:[{value:'ok'}]});assert.equal(vars.read('record.list.0.value'),'ok');
 assert.throws(()=>vars.read('record.toString'),{code:'TASK_VARIABLE_MISSING'});assert.throws(()=>vars.read('record.__proto__'),{code:'TASK_VARIABLE_PATH'});
 assert.throws(()=>vars.set('large','x'.repeat(256*1024)),{code:'TASK_VARIABLE_CAPACITY'});
 assert.throws(()=>vars.set('small','data',1),{code:'TASK_VARIABLE_CAPACITY'});
 assert.throws(()=>vars.bind({operation:'page.action',args:{values:['a']},bindings:{'values.999999999':'record.list.0.value'}}),{code:'TASK_BINDING_TARGET'});
 const cyclic:any={};cyclic.self=cyclic;assert.throws(()=>vars.set('cycle',cyclic),{code:'TASK_VARIABLE_INVALID'});
});

test('嵌套if/else和repeat每次重新进入内部循环，跳过分支不执行',async()=>{
 const f=await fixture(),writes:string[]=[];
 try{
  const p=await fakeProfile(f.config,'nested',c=>c.operation==='tabs.list'?[{tabId:1}]:(c.operation==='page.action'&&writes.push(String(c.args.text)),{}));
  const job=f.service.tasks.submit(p.id,1,{name:'nested',captureOnFailure:false,steps:[
   {operation:'flow.set',args:{name:'accept',value:false}},{operation:'flow.repeat',args:{count:2}},
   {operation:'flow.if',args:{variable:'accept',operator:'truthy'}},fill('wrong'),{operation:'flow.else',args:{}},
   {operation:'flow.repeat',args:{count:3}},fill('right'),end,end,end,
  ]},adminPrincipal);
  const result=await ended(()=>f.service.tasks.get(p.id,job.id));assert.equal(result.status,'succeeded');assert.deepEqual(writes,Array(6).fill('right'));assert.equal(result.steps[6]!.executions,6);assert.equal(result.steps[3]!.state,'skipped');
 }finally{await f.cleanup();}
});

test('循环暂停继续保留变量与迭代位置，不重复已经完成的写入',async()=>{
 const f=await fixture(),writes:string[]=[];let reads=0,release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
 try{
  const p=await fakeProfile(f.config,'pause-loop',async c=>{if(c.operation==='tabs.list')return[{tabId:1}];if(c.operation==='page.evaluate')return{value:`value-${++reads}`};if(c.operation==='page.action'){writes.push(String(c.args.text));if(writes.length===1)await held;}return{};});
  const job=f.service.tasks.submit(p.id,1,{name:'pause-loop',captureOnFailure:false,steps:[{operation:'flow.repeat',args:{count:3}},{operation:'page.evaluate',args:{expression:'read()'},saveAs:'row'},fill('placeholder',{bindings:{text:'row.value'}}),end]},adminPrincipal);
  for(let i=0;i<200&&!writes.length;i++)await new Promise(r=>setTimeout(r,5));assert.equal(writes.length,1);
  f.service.tasks.control(p.id,job.id,'pause',adminPrincipal);release();
  for(let i=0;i<200&&f.service.tasks.get(p.id,job.id).status!=='paused';i++)await new Promise(r=>setTimeout(r,5));assert.equal(f.service.tasks.get(p.id,job.id).status,'paused');assert.equal(reads,1);
  f.service.tasks.control(p.id,job.id,'resume',adminPrincipal);const result=await ended(()=>f.service.tasks.get(p.id,job.id));assert.equal(result.status,'succeeded');assert.deepEqual(writes,['value-1','value-2','value-3']);assert.equal(reads,3);
 }finally{release();await f.cleanup();}
});

test('申请租约期间暂停不消耗未执行步骤的额度',async()=>{
 const f=await fixture();let claims=0,writes=0,release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
 try{
  const p=await fakeProfile(f.config,'pause-preparation',async c=>{if(c.operation==='tabs.list'){if(++claims===1)await held;return[{tabId:1}];}if(c.operation==='page.action')writes++;return{};});
  const job=f.service.tasks.submit(p.id,1,{name:'one-step-budget',captureOnFailure:false,maxExecutedSteps:1,steps:[fill('once')]},adminPrincipal);
  for(let i=0;i<200&&!claims;i++)await new Promise(r=>setTimeout(r,5));assert.equal(claims,1);f.service.tasks.control(p.id,job.id,'pause',adminPrincipal);release();
  for(let i=0;i<200&&f.service.tasks.get(p.id,job.id).status!=='paused';i++)await new Promise(r=>setTimeout(r,5));assert.equal(writes,0);
  f.service.tasks.control(p.id,job.id,'resume',adminPrincipal);assert.equal((await ended(()=>f.service.tasks.get(p.id,job.id))).status,'succeeded');assert.equal(writes,1);
 }finally{release();await f.cleanup();}
});

test('纯控制流循环让出事件循环，取消请求无需等到所有循环结束',async()=>{
 const f=await fixture(),save=f.service.state.saveTask.bind(f.service.state);let scheduled=false;
 try{
  const p=await fakeProfile(f.config,'control',()=>({}));
  f.service.state.saveTask=task=>{save(task);const record=task as TaskRecord;if(!scheduled&&record.name==='control-only'&&record.status==='running'&&record.nextStep===1){scheduled=true;setTimeout(()=>f.service.tasks.control(p.id,record.id,'cancel',adminPrincipal),0);}};
  const job=f.service.tasks.submit(p.id,1,{name:'control-only',captureOnFailure:false,steps:[{operation:'flow.repeat',args:{count:100}},{operation:'flow.set',args:{name:'x',value:1}},end]},adminPrincipal);
  const result=await ended(()=>f.service.tasks.get(p.id,job.id));assert.equal(result.status,'cancelled');assert.ok((result.steps[1]!.executions??0)<100);
 }finally{f.service.state.saveTask=save;await f.cleanup();}
});

test('带后置检查的saveAs读取批次子结果，绑定不会重复读取或写入',async()=>{
 const f=await fixture(),writes:string[]=[];let batches=0;
 try{
  const p=await fakeProfile(f.config,'saved-result',c=>{if(c.operation==='tabs.list')return[{tabId:1}];if(c.operation==='page.batch'){batches++;return{completed:true,results:[{index:0,operation:'page.evaluate',result:{value:'exact-result'}}]};}if(c.operation==='page.action')writes.push(String(c.args.text));return{};});
  const job=f.service.tasks.submit(p.id,1,{name:'subresult',captureOnFailure:false,steps:[{operation:'page.evaluate',args:{expression:'read()'},postcondition:{selector:'#ready'},saveAs:'response'},fill('placeholder',{bindings:{text:'response.value'}})]},adminPrincipal);
  assert.equal((await ended(()=>f.service.tasks.get(p.id,job.id))).status,'succeeded');assert.deepEqual(writes,['exact-result']);assert.equal(batches,1);
 }finally{await f.cleanup();}
});

test('配对dialog的缺失变量、绑定类型错误和步骤额度不足均在派发前拒绝',async()=>{
 const f=await fixture();let writes=0;
 const trigger={operation:'page.evaluate',args:{expression:'confirm("safe")'}},dialog={operation:'page.dialog',args:{accept:true,expectedType:'confirm',expectedMessage:'placeholder'}};
 try{
  const p=await fakeProfile(f.config,'dialog-invalid',c=>{if(c.operation==='tabs.list')return[{tabId:1}];if(['page.evaluate','page.batch'].includes(c.operation))writes++;return{};},undefined,{capabilities:[...FAKE_CAPABILITIES,CAPABILITY.dialogControl]});
  for(const [steps,maxExecutedSteps,reason]of [
   [[trigger,{...dialog,bindings:{expectedMessage:'missing'}}],1000,'TASK_VARIABLE_MISSING'],
   [[{operation:'flow.set',args:{name:'bad',value:123}},trigger,{...dialog,bindings:{expectedMessage:'bad'}}],1000,'INVALID_ARGUMENT'],
   [[trigger,dialog],1,'TASK_EXECUTION_LIMIT'],
  ] as const){
   const job=f.service.tasks.submit(p.id,1,{name:'dialog-invalid',steps,captureOnFailure:false,maxExecutedSteps},adminPrincipal);
   const result=await ended(()=>f.service.tasks.get(p.id,job.id));assert.equal(result.status,'failed');assert.equal(result.reason,reason);assert.ok(result.steps.every(step=>!['unknown','running'].includes(step.state)));
  }
  assert.equal(writes,0);assert.equal(f.service.state.pendingOperations(p.id).unknown,0);
 }finally{await f.cleanup();}
});

test('配对dialog结果容量超限保留两步成功证据，尾部不执行且没有unknown',async()=>{
 const f=await fixture();let batches=0,writes=0;f.config.outputLimit=2*1024*1024;
 try{
  const p=await fakeProfile(f.config,'dialog-capacity',c=>{if(c.operation==='tabs.list')return[{tabId:1}];if(c.operation==='page.batch'){batches++;return{completed:true,results:[{index:0,result:{body:'x'.repeat(270000)}},{index:1,result:{accepted:true}}]};}if(c.operation==='page.action')writes++;return{};},undefined,{capabilities:[...FAKE_CAPABILITIES,CAPABILITY.dialogControl]});
  const job=f.service.tasks.submit(p.id,1,{name:'capacity',captureOnFailure:false,steps:[{operation:'page.evaluate',args:{expression:'confirm("safe")'},saveAs:'response'},{operation:'page.dialog',args:{accept:true,expectedType:'confirm',expectedMessage:'safe'},saveAs:'dialog'},fill('must-not-run')]},adminPrincipal);
  const result=await ended(()=>f.service.tasks.get(p.id,job.id));assert.equal(result.status,'failed');assert.equal(result.reason,'TASK_VARIABLE_CAPACITY');assert.deepEqual(result.steps.map(s=>s.state),['succeeded','succeeded','pending']);assert.equal(result.nextStep,2);assert.equal(result.steps[1]!.executions,1);assert.equal(batches,1);assert.equal(writes,0);assert.equal(f.service.state.pendingOperations(p.id).unknown,0);assert.equal(f.service.state.get(result.steps[0]!.operationId!)!.state,'succeeded');
 }finally{await f.cleanup();}
});

test('保存流程拒绝嵌套临时引用和CDP脚本插值，普通数据参数仍安全可用',async()=>{
 const f=await fixture();
 try{
  const save=(steps:unknown[])=>f.service.tasks.saveWorkflow('p',{name:'saved',steps,parameters:[{name:'query'}]});
  for(const args of [{method:'Runtime.evaluate',params:{expression:'{{query}}'}},{method:'Runtime.callFunctionOn',params:{functionDeclaration:'function(){return "{{query}}"}'}},{method:'Page.addScriptToEvaluateOnNewDocument',params:{source:'{{query}}'}}])assert.throws(()=>save([{operation:'page.cdp',args}]),{code:'UNSAFE_INTERPOLATION'});
  assert.throws(()=>save([{operation:'page.action',args:{action:'drag',selector:'#source',to:{ref:'old-document:1'}}}]),{code:'EPHEMERAL_LOCATOR'});
  assert.throws(()=>save([{operation:'page.cdp',args:{method:'Runtime.evaluate',params:{expression:'1',contextId:42}}}]),{code:'EPHEMERAL_LOCATOR'});
  const flow=save([{operation:'flow.set',args:{name:'row',value:{ref:'domain-data',value:'{{query}}'}}},fill('placeholder',{bindings:{text:'row.value'}})]);
  const preview=f.service.tasks.preview('p',flow.id,{query:'";window.evil=true;'});assert.equal((preview.plan.steps[0]!.args as any).value.value,'";window.evil=true;');
 }finally{await f.cleanup();}
});

test('成功截图和大JSON结果在任务及诊断里留下可信artifact引用，不保存正文或绝对路径',async()=>{
 const f=await fixture();f.config.outputLimit=200;
 try{
  const p=await fakeProfile(f.config,'artifacts',c=>{
   if(c.operation==='tabs.list')return[{tabId:1}];
   if(c.operation==='page.screenshot')return{data:Buffer.from('png-bytes').toString('base64'),mimeType:'image/png'};
   if(c.operation==='page.evaluate')return{secretBody:'private-page-'.repeat(100)};
   return{};
  });
  const job=f.service.tasks.submit(p.id,1,{name:'artifacts',captureOnFailure:false,steps:[{operation:'page.screenshot',args:{}},{operation:'page.evaluate',args:{expression:'largeResult()'}}]},adminPrincipal);
  const result=await ended(()=>f.service.tasks.get(p.id,job.id));assert.equal(result.status,'succeeded');assert.deepEqual(result.steps.map(step=>step.artifactType),['png','json']);
  for(const step of result.steps){assert.match(step.artifactId!,/^[a-f0-9-]{36}$/);assert.equal(f.service.state.artifact(step.artifactId!)?.extension,step.artifactType);}
  const diagnostics=f.service.tasks.diagnostics(p.id,job.id);assert.equal(diagnostics.task.steps[0]!.artifactId,result.steps[0]!.artifactId);
  const encoded=JSON.stringify(f.service.state.tasks());assert.ok(!encoded.includes('private-page-'));assert.ok(!encoded.includes(f.config.dataDir));assert.ok(!encoded.includes('largeResult'));
 }finally{await f.cleanup();}
});

test('截图保存失败不附artifact；网页伪造data.artifactId不能冒充服务生成引用',async()=>{
 const f=await fixture();
 try{
  const p=await fakeProfile(f.config,'artifact-provenance',c=>{
   if(c.operation==='tabs.list')return[{tabId:1}];
   if(c.operation==='page.screenshot')return{data:Buffer.from('png-bytes').toString('base64'),mimeType:'image/png'};
   if(c.operation==='page.evaluate')return{artifactId:f.service.state.listArtifacts()[0]?.id,saved:true,filename:'fake.png'};
   return{};
  });
  const job=f.service.tasks.submit(p.id,1,{name:'provenance',captureOnFailure:false,steps:[{operation:'page.screenshot',args:{}},{operation:'page.evaluate',args:{expression:'fakeArtifact()'}}]},adminPrincipal);
  const good=await ended(()=>f.service.tasks.get(p.id,job.id));assert.ok(good.steps[0]!.artifactId);assert.equal(good.steps[1]!.artifactId,undefined);
  f.config.resultByteLimit=1;
  const failed=f.service.tasks.submit(p.id,1,{name:'no-storage',captureOnFailure:false,steps:[{operation:'page.screenshot',args:{}}]},adminPrincipal);
  const result=await ended(()=>f.service.tasks.get(p.id,failed.id));assert.equal(result.status,'succeeded');assert.equal(result.steps[0]!.artifactId,undefined);assert.equal(result.steps[0]!.artifactType,undefined);
 }finally{await f.cleanup();}
});

test('流程不保存密码和令牌的字面值：目标写明敏感字段时拒绝，用参数或绑定可以保存',async t=>{
 const f=await fixture();t.after(()=>f.cleanup());const p=await fakeProfile(f.config,'workflow');
 const save=(step:any,parameters:any[]=[])=>f.service.invoke('chrome_workflow_save',{profileId:p.id,definition:{name:'登录',parameters,steps:[step]}},'one');
 const fill=(args:any)=>({operation:'page.action',args:{action:'fill',...args}});
 for(const step of [fill({selector:'#password',text:'hunter2'}),fill({locator:{label:'登录密码'},text:'hunter2'}),fill({selector:'input[name=api_key]',text:'sk-1'})]){const saved=await save(step);assert.equal(saved.ok,false);assert.equal(saved.error?.code,'WORKFLOW_SECRET_LITERAL',JSON.stringify(saved.error));}
 assert.equal((await save(fill({selector:'#password',text:'{{password}}'}),[{name:'password'}])).ok,true);
 assert.equal((await save(fill({selector:'#city',text:'上海'}))).ok,true,'普通字段不受影响');
});
