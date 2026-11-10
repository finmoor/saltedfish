import test from 'node:test';
import assert from 'node:assert/strict';
import {compactAccessibility,compactEvents,hideRawAccessibility} from '../src/observations.js';
import {fixture,fakeProfile} from './helpers.js';
import type {BrowserEvent} from '../src/shared.js';
import {createBrowserMcp} from '../src/mcp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';

test('AX 摘要预算严格有界且分页不会丢节点；不携带原始值和名称来源',()=>{
 const raw={nodes:Array.from({length:50},(_,i)=>({nodeId:String(i),parentId:'root',backendDOMNodeId:i+1,role:{value:'button'},name:{value:'\n'.repeat(1000),sources:[{secret:'SOURCE'}]},value:{value:'SENSITIVE'},properties:[{name:'checked',value:{value:true}}]}))};
 const seen:string[]=[];let offset:number|null=0;
 do{const result=compactAccessibility(raw,offset,50,1000);assert.ok(JSON.stringify(result).length<=1000);assert.ok(result.nodes.length>0);seen.push(...result.nodes.map((node:unknown)=>{assert.ok(node && typeof node==='object' && 'nodeId' in node);assert.ok(typeof node.nodeId==='string');return node.nodeId;}));assert.ok(!JSON.stringify(result).includes('SENSITIVE'));assert.ok(!JSON.stringify(result).includes('SOURCE'));offset=result.nextOffset;}while(offset!==null);
 assert.deepEqual(seen,raw.nodes.map(n=>n.nodeId));assert.equal(raw.nodes[0]!.value.value,'SENSITIVE');
});

test('事件摘要分页的 sequence 只推进到实际返回项，保留弹窗 ID，默认省略请求头',()=>{
 const events:BrowserEvent[]=Array.from({length:25},(_,i)=>({sequence:i+1,profileId:'profile',tabId:7,method:'Network.requestWillBeSent',time:new Date().toISOString(),params:{requestId:String(i),request:{method:'GET',url:'https://example.test/?token=SECRET&query=ok',headers:{Authorization:'SECRET'},postData:'SECRET'.repeat(10000)}}}));
 const seen:number[]=[];let since=0;
 while(since<25){const remaining=events.filter(e=>e.sequence>since),r=compactEvents(remaining,0,50,1000,since,25,1);assert.ok(JSON.stringify(r).length<=1000);assert.ok(r.items.length>0);assert.ok(!JSON.stringify(r).includes('SECRET'));seen.push(...r.items.map(e=>e.sequence));assert.equal(r.latestSequence,r.items.at(-1)!.sequence);since=r.latestSequence;}
 assert.deepEqual(seen,events.map(e=>e.sequence));
 const dialog={...events[0]!,method:'Page.javascriptDialogOpening',params:{dialogId:'dialog-1',type:'confirm',message:'\n'.repeat(2000)}};
 const r=compactEvents([dialog],0,50,1000,0,1,1);assert.equal(r.items[0]!.params.dialogId,'dialog-1');assert.ok(JSON.stringify(r).length<=1000);
});

test('raw 事件保留结构、隐藏凭据，预算摘要和持久大结果不丢错误分类或完成步数',async()=>{
 const f=await fixture();try{
  const p=await fakeProfile(f.config,'output',command=>command.operation==='page.batch'?{completed:false,failedIndex:1,results:[{result:'x'.repeat(40000)}],error:{code:'ELEMENT_DISABLED',message:'disabled',phase:'precondition',outcome:'not_dispatched'}}:{});
  f.service.broker.addEvent(p.id,7,'Network.requestWillBeSent',{request:{url:'https://example.test/?token=private-fixture&page=2',method:'POST',headers:{Authorization:'private-fixture',Cookie:'sid=private-fixture','X-Api-Key':'private-fixture',Accept:'text/html'},postData:'password=private-fixture'}});f.service.broker.addEvent(p.id,7,'Network.responseReceivedExtraInfo',{headers:{'Set-Cookie':'sid=private-fixture'},headersText:'HTTP/1.1 200 OK\r\nSet-Cookie: sid=private-fixture\r\nContent-Type: text/html\r\n'});f.service.broker.addEvent(p.id,7,'Network.requestWillBeSentExtraInfo',{associatedCookies:[{cookie:{value:'private-fixture'}}],headers:{}});
  const summary=await f.service.invoke('chrome_events',{profileId:p.id,tabId:7},'one');assert.ok(!JSON.stringify(summary).includes('private-fixture'));
  const raw=await f.service.invoke('chrome_events',{profileId:p.id,tabId:7,mode:'raw'},'one');assert.ok(!JSON.stringify(raw).includes('private-fixture'),'结果可能落盘，raw 也不带凭据');const sent=(raw.data as any).items.find((e:any)=>e.method==='Network.requestWillBeSent').params.request;assert.equal(sent.method,'POST');assert.equal(sent.headers.Accept,'text/html','其他内容保持原样');assert.match(sent.url,/page=2/);const extra=(raw.data as any).items.find((e:any)=>e.method==='Network.responseReceivedExtraInfo').params.headersText;assert.match(extra,/Content-Type: text\/html/);assert.match(extra,/Set-Cookie: \[redacted\]/);
  const result=await f.service.invoke('chrome_batch',{profileId:p.id,tabId:7,steps:[{operation:'page.evaluate',args:{expression:'1'}},{operation:'page.action',args:{action:'click',selector:'#disabled'}}]},'one');
  assert.equal(result.ok,false);assert.equal(result.error?.outcome,'not_dispatched');assert.equal(result.batch?.completedSteps,1);assert.equal(result.batch?.failedIndex,1);assert.equal(result.batch?.error.code,'ELEMENT_DISABLED');assert.ok((result.data as any).saved);assert.ok((result.data as any).preview.length<=2048);assert.equal(f.service.state.get(result.operationId!)!.state,'failed');
 }finally{await f.cleanup();}
});

test('工具目录公共说明只在初始化出现，默认 46 个工具和 JSON 约束保持',async()=>{
 const server=createBrowserMcp(async()=>({ok:true,data:null})),client=new Client({name:'catalog-regression',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 try{await server.connect(b);await client.connect(a);const catalog=(await client.listTools()).tools;assert.equal(catalog.length,46);assert.ok(!catalog.some(tool=>/^chrome_(workflow|task)/.test(tool.name)));const instructions=client.getInstructions()!;assert.ok(instructions.includes('禁止整段重放'));assert.ok(!instructions.includes('task_submit'),'说明不能提默认目录里没有的工具');assert.ok(!catalog.some(tool=>/chrome_(workflow|task)|task_submit|workflow_/.test(tool.description||'')),'默认目录的说明不能提没列出的工具');assert.ok(catalog.every(tool=>!tool.description?.includes(instructions)));assert.ok(catalog.reduce((n,t)=>n+(t.description?.length||0),0)<4800);for(const tool of catalog)assert.equal(tool.inputSchema.additionalProperties,false);
  for(const [name,fields] of Object.entries({chrome_action:['autoWait'],chrome_inspect:['scopeSelector','valueLimit','sinceSnapshot'],chrome_accessibility:['offset','limit','mode','maxCharacters'],chrome_events:['mode','maxCharacters'],chrome_dialog:['dialogId','expectedType','expectedMessage']})){
    const properties=catalog.find(tool=>tool.name===name)!.inputSchema.properties!;
    for(const field of fields)assert.ok(Object.hasOwn(properties,field),`${name}.${field} 未对客户端声明`);
  }
  assert.ok(JSON.stringify(catalog.find(tool=>tool.name==='chrome_batch')!.inputSchema).includes('page.dialog'));
 }
 finally{await client.close();await server.close();}
});

test('raw 无障碍树隐藏敏感输入框的值，连内部文本节点一起，其他节点原样',()=>{
 const tree={nodes:[{nodeId:'1',role:{value:'textbox'},name:{value:'卡号'},value:{value:'4111111111111111'},childIds:['2']},{nodeId:'2',role:{value:'generic'},name:{value:''},childIds:['3']},{nodeId:'3',role:{value:'StaticText'},name:{type:'computedString',value:'4111111111111111',sources:[{type:'contents',value:{value:'4111111111111111'}}]}},{nodeId:'4',role:{value:'textbox'},name:{value:'城市'},value:{value:'上海'}},{nodeId:'5',role:{value:'button'},name:{value:'修改密码'}}]};
 const hidden=hideRawAccessibility(tree),text=JSON.stringify(hidden);
 assert.ok(!text.includes('4111111111111111'));assert.equal(hidden.nodes[0].name.value,'卡号','名称保留，才看得出是什么字段');assert.equal(hidden.nodes[3].value.value,'上海');assert.equal(hidden.nodes[4].name.value,'修改密码','只隐藏输入框，不动按钮');
});

test('打开高级工具后目录完整，任务和流程工具的说明写明只在用户明确要求时使用',async()=>{
 const server=createBrowserMcp(async()=>({ok:true,data:null}),undefined,{advancedTools:true}),client=new Client({name:'catalog-advanced',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 try{await server.connect(b);await client.connect(a);const catalog=(await client.listTools()).tools;assert.equal(catalog.length,64);assert.ok(client.getInstructions()!.includes('task_submit'));
  for(const name of ['chrome_workflow_save','chrome_task_submit'])assert.match(catalog.find(tool=>tool.name===name)!.description!,/^只在用户明确要/);
 }finally{await client.close();await server.close();}
});
