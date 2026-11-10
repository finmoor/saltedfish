import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {z} from 'zod';
import {toolDefinitions,toolMap} from '../src/tools.js';
import {CODEX_TOOL_SCHEMA_MAX_BYTES} from '../src/client-config.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createBrowserMcp} from '../src/mcp.js';
import {projectDir} from '../src/config.js';
import {readdirSync,readFileSync} from 'node:fs';
import path from 'node:path';

test('interaction steps expose flat discriminated branches with strict arguments and postconditions',()=>{
 const schemas=toolDefinitions.map(t=>({name:t.name,description:t.description,inputSchema:z.toJSONSchema(t.schema,{target:'draft-7',io:'input'})}));
 assert.ok(JSON.stringify(schemas).length<128000,'64工具与平面流程目录保持显式字符预算；每工具UTF-8字节上限仍独立核验');
 for(const tool of schemas)assert.ok(Buffer.byteLength(JSON.stringify(tool.inputSchema))<CODEX_TOOL_SCHEMA_MAX_BYTES,`${tool.name}: must fit configured Codex UTF-8 input schema budget`);
 const batch=schemas.find(x=>x.name==='chrome_batch')!.inputSchema as any;
 for(const [name,count] of [['chrome_batch',6],['chrome_task_submit',21]] as const){
  const items=(schemas.find(x=>x.name===name)!.inputSchema as any).properties.steps.items;
  assert.ok(!items.allOf,'host renderers can turn intersection members into unknown');assert.equal(items.oneOf?.length,count);
  const basic=['page.action','page.evaluate','page.wait','page.navigate','page.upload','page.dialog'];
  assert.deepEqual(items.oneOf.map((x:any)=>x.properties.operation.const),[...basic,...(count===21?['tabs.wait','page.screenshot','page.inspect','page.cdp','network.start','network.stop','network.body','network.wait','downloads.start','downloads.wait','flow.if','flow.else','flow.repeat','flow.end','flow.set']:[])]);
  for(const branch of items.oneOf){assert.equal(branch.type,'object');assert.equal(branch.additionalProperties,false);assert.equal(branch.properties.args.type,'object');assert.equal(branch.properties.args.additionalProperties,false);if(basic.includes(branch.properties.operation.const))assert.equal(branch.properties.postcondition.type,'object');else assert.equal(branch.properties.postcondition,undefined);}
  const action=items.oneOf[0].properties.args.properties;for(const field of ['fillMode','inputMode','compositionUpdates','compositionCommit','selection','holdMs'])assert.ok(action[field],field);
 }
 const ajv=new Ajv({strict:false,validateFormats:false}),validate=ajv.compile(batch);
 const valid={profileId:'p',tabId:1,steps:[{operation:'page.action',args:{action:'fill',selector:'#x',text:'once'},postcondition:{selector:'#x',valueEquals:'once',stableMs:100}}]};
 assert.equal(validate(valid),true,JSON.stringify(validate.errors));assert.equal(toolMap.get('chrome_batch')!.schema.safeParse(valid).success,true);
 for(const step of [{...valid.steps[0],unexpected:true},{...valid.steps[0],args:{...valid.steps[0]!.args,unexpected:true}},{...valid.steps[0],postcondition:{...valid.steps[0]!.postcondition,expression:'unsafe()'}}]){
  const input={...valid,steps:[step]};assert.equal(validate(input),false);assert.equal(toolMap.get('chrome_batch')!.schema.safeParse(input).success,false);
 }
 const legacy={...valid,steps:[{operation:'page.action',args:{action:'click',selector:'#button'}}]};assert.equal(validate(legacy),true);assert.equal(toolMap.get('chrome_batch')!.schema.safeParse(legacy).success,true);
 const task={profileId:'p',tabId:1,name:'test',steps:[{operation:'tabs.wait',args:{},postcondition:{selector:'#x'}}]};assert.equal(toolMap.get('chrome_task_submit')!.schema.safeParse(task).success,false);
});

test('actual MCP tools/list preserves branches and rejects malformed steps before invoking service',async()=>{
 let calls=0;const server=createBrowserMcp(async()=>{calls++;return {ok:true,data:{accepted:true}};}),client=new Client({name:'step-schema',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 try{
  await server.connect(b);await client.connect(a);const catalog=(await client.listTools()).tools;
  for(const tool of catalog)assert.ok(Buffer.byteLength(JSON.stringify(tool.inputSchema))<CODEX_TOOL_SCHEMA_MAX_BYTES,tool.name);
  assert.equal((catalog.find(x=>x.name==='chrome_batch')!.inputSchema.properties!.steps as any).items.oneOf.length,6);
  const input={profileId:'p',tabId:1,steps:[{operation:'page.action',args:{action:'fill',selector:'#x',text:'once'}}]};
  assert.equal((await client.callTool({name:'chrome_batch',arguments:input})).isError,false);assert.equal(calls,1);
  for(const step of [{...input.steps[0],unexpected:true},{operation:'page.navigate',args:{action:'click',selector:'#x'}},{operation:'unknown',args:{}},{...input.steps[0],postcondition:{expression:'unsafe()'}}]){
   const result=await client.callTool({name:'chrome_batch',arguments:{...input,steps:[step]}});assert.equal(result.isError,true);assert.equal(calls,1);
  }
 }finally{await client.close();await server.close();}
});

test('chrome_action：modifiers 只用于 click/hover/scroll/press；scroll 要么元素定位要么坐标，不再静默忽略',()=>{
 const action=toolMap.get('chrome_action')!.schema,batch=toolMap.get('chrome_batch')!.schema,base={profileId:'p',tabId:1};
 const ok=(args:Record<string,unknown>)=>action.safeParse({...base,...args}).success;
 for(const name of ['click','hover','scroll'])assert.equal(ok({action:name,selector:'#a',modifiers:2}),true,`${name} 的修饰键会转发给鼠标事件`);
 assert.equal(ok({action:'press',selector:'#a',key:'a',modifiers:2}),true);
 for(const input of [{action:'fill',selector:'#a',text:'x'},{action:'type',selector:'#a',text:'x'},{action:'select',selector:'#a',values:['a']}]){
  assert.equal(ok({...input,modifiers:2}),false,`${input.action} 不支持修饰键，必须明确拒绝而不是静默忽略`);
  assert.equal(ok({...input,modifiers:0}),true,`${input.action} 的 modifiers:0 等于没用`);
  assert.equal(batch.safeParse({...base,steps:[{operation:'page.action',args:{...input,modifiers:2}}]}).success,false,`批次步骤同样拒绝 ${input.action}+modifiers`);
 }
 assert.equal(ok({action:'scroll',selector:'#list',deltaY:300}),true);assert.equal(ok({action:'scroll',ref:'doc:1',deltaX:30}),true);assert.equal(ok({action:'scroll',locator:{role:'list'},deltaY:30}),true);
 assert.equal(ok({action:'scroll',x:10,y:20,deltaY:300}),true);assert.equal(ok({action:'scroll',deltaY:300}),true);
 assert.equal(ok({action:'scroll',selector:'#list',x:10,y:20}),false,'元素定位与坐标只能选一种');
 assert.equal(ok({action:'scroll',selector:'#list',y:20}),false);
 assert.equal(batch.safeParse({...base,steps:[{operation:'page.action',args:{action:'scroll',selector:'#a',x:1,y:1}}]}).success,false);
});

test('chrome_action 的说明写明修饰键与滚轮语义，且目录仍在预算内',()=>{
 const description=toolMap.get('chrome_action')!.description;
 for(const word of ['modifiers','scroll','deltaY'])assert.ok(description.includes(word),`说明缺少 ${word}`);
 assert.ok(/focusVerified/.test(description));
 // 无元素定位又不给 x,y 时滚轮发在视口原点（extension/executor.ts 的 scroll 分支），调用方必须能从说明里知道，免得滚到侧栏上。
 assert.ok(description.includes('x,y（缺省 0,0）'),'scroll 的 x,y 缺省值');
});

test('租约类工具的说明写明接管规则：只有本机管理员能接管远程 Agent 的占用，本机客户端之间、同一 Agent 的不同会话之间都不行',()=>{
 for(const name of ['chrome_release_tab','chrome_recover_tab','chrome_recover_operation']){
  const text=toolMap.get(name)!.description;
  for(const word of ['TAB_CLAIMED','只有本机管理员能接管远程 Agent 持有的占用','本机客户端之间','同一 Agent 的不同会话之间'])assert.ok(text.includes(word),`${name} 的说明缺少「${word}」`);
 }
 assert.ok(toolMap.get('chrome_release_tab')!.description.includes('takenOver:true'),'接管成功的释放结果带 takenOver:true');
});

test('chrome_workflow_run 的说明写明重试例外：同一 submissionId 返回原任务（deduplicated），没有收据的新请求仍在流程变更或归档后被拒',()=>{
 const text=toolMap.get('chrome_workflow_run')!.description;
 for(const word of ['submissionId','deduplicated','编辑或归档','没有收据的新请求'])assert.ok(text.includes(word),`缺少「${word}」`);
 assert.ok(!text.includes('流程变更拒绝运行'),'旧说明把重试也说成会被拒绝');
});

test('工具说明点名的错误码和结果字段在实现里真实存在，说明不会引用已改名或已删除的东西',()=>{
 const read=(dir:string)=>readdirSync(path.join(projectDir,dir)).filter(file=>file.endsWith('.ts')&&!(dir==='src'&&file==='tools.ts')).map(file=>readFileSync(path.join(projectDir,dir,file),'utf8'));
 const sources=[...read('src'),...read('extension')].join('\n');
 const catalog=JSON.stringify(toolDefinitions.map(t=>({description:t.description,schema:z.toJSONSchema(t.schema,{target:'draft-7',io:'input'})})));
 const codes=[...new Set(catalog.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)??[])];
 assert.ok(codes.includes('TAB_CLAIMED'),'租约类工具的说明应点名 TAB_CLAIMED');
 for(const token of [...codes,'takenOver','deduplicated','focusVerified','requestedCharacters'])assert.ok(sources.includes(token),`说明提到的 ${token} 在实现里找不到`);
});
