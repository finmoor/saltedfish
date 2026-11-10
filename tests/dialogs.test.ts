import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Dialogs } from '../extension/dialogs.js';
import { BrowserError, errorInfo, unknownResult } from '../src/shared.js';
import { fixture, fakeProfile } from './helpers.js';

test('独立弹窗前置校验失败明确未派发，匹配后仅发送一次响应',async()=>{
  const responses:unknown[]=[];
  const dialogs=new Dialogs(async(tabId,args,sessionId)=>{responses.push({tabId,args,sessionId});});
  const rejected=(code:string)=>(error:unknown)=>{
    const info=errorInfo(error);
    assert.equal(info.code,code);
    assert.equal(info.phase,'precondition');assert.equal(info.outcome,'not_dispatched');
    assert.equal(unknownResult(info),false);assert.equal(responses.length,0);
    return true;
  };
  await assert.rejects(dialogs.respond(7,{accept:false}),rejected('DIALOG_NOT_OPEN'));
  const dialog=dialogs.opening(7,{type:'confirm',message:'fixture-confirm',frameId:'frame-1'},'child-session');
  for(const mismatch of [{dialogId:randomUUID()},{expectedType:'alert'},{expectedMessage:'WRONG_EXPECTED_MESSAGE'},{expectedFrameId:'other-frame'}]){
    await assert.rejects(dialogs.respond(7,{accept:false,dialogId:dialog.dialogId,...mismatch}),rejected('DIALOG_MISMATCH'));
    assert.equal(dialogs.has(7),true);
  }
  await dialogs.respond(7,{accept:false,dialogId:dialog.dialogId,expectedType:'confirm',expectedMessage:'fixture-confirm'});
  assert.deepEqual(responses,[{tabId:7,args:{accept:false},sessionId:'child-session'}]);
});

test('弹窗响应已调用底层后失败仍为未知，不能按错误码认定未派发',async()=>{
  for(const code of ['CONNECTION_CHANGED','DIALOG_MISMATCH']){
    let dispatched=0;
    const dialogs=new Dialogs(async()=>{dispatched++;throw new BrowserError(code,'response lost');});
    const dialog=dialogs.opening(7,{type:'confirm',message:'fixture-confirm'});
    await assert.rejects(dialogs.respond(7,{accept:false,dialogId:dialog.dialogId}),error=>{
      assert.equal(dispatched,1);assert.equal(unknownResult(errorInfo(error)),true);return true;
    });
  }
});

test('触发后弹窗在自动响应前消失，原触发操作仍按未知处理',async()=>{
  let triggered=0,responses=0;
  const dialogs=new Dialogs(async()=>{responses++;});
  const running=dialogs.run(7,'dialog-race',Date.now()+3000,()=>true,()=>dialogs.expected(7,{accept:false,expectedType:'confirm',expectedMessage:'fixture-confirm'},async()=>{
    dialogs.arm(7);triggered++;
    dialogs.opening(7,{type:'confirm',message:'fixture-confirm'});
    dialogs.closed(7);
    return 'triggered';
  }),async()=>{});
  await assert.rejects(running,error=>{assert.equal(errorInfo(error).code,'DIALOG_RESPONSE_FAILED');assert.equal(unknownResult(errorInfo(error)),true);return true;});
  assert.equal(triggered,1);assert.equal(responses,0);
});

test('弹窗期间被拒绝的读取和响应不遗留控制者，原输入仍保留到物理完成',async()=>{
  const f=await fixture();let original='';const dialogId=randomUUID();
  try{
    const profile=await fakeProfile(f.config,'dialog-cleanup',command=>{
      if(!['page.action','page.inspect','page.dialog'].includes(command.operation))return {};
      if(command.operation==='page.action'){
        original=command.id;
        profile.socket.send(JSON.stringify({type:'event',tabId:7,method:'Page.javascriptDialogOpening',params:{dialogId,commandId:original,type:'confirm',message:'test'}}));
      }
      profile.socket.send(JSON.stringify({type:'result',id:command.id,error:{code:command.operation==='page.dialog'?'DIALOG_MISMATCH':'DIALOG_OPEN',message:'blocked by original modal'}}));
      return {}; // 第二个终态消息被 broker 忽略，模拟早返回后原输入尚未物理完成。
    });
    f.service.broker.profiles.get(profile.id)!.info.capabilities!.push('dialog-control');
    const target={profileId:profile.id,tabId:7};
    assert.equal((await f.service.invoke('chrome_action',{...target,action:'click',x:10,y:10},'owner')).error?.code,'DIALOG_OPEN');
    assert.equal(f.service.broker.stats().trackedControllers,1);
    for(let i=0;i<20;i++){
      assert.equal((await f.service.invoke('chrome_inspect',target,'owner')).error?.code,'DIALOG_OPEN');
      assert.equal((await f.service.invoke('chrome_dialog',{...target,dialogId,accept:false,expectedType:'alert'},'owner')).error?.code,'DIALOG_MISMATCH');
      assert.equal(f.service.broker.stats().trackedControllers,1,'仅保留真正触发弹窗的原输入');
    }
    profile.socket.send(JSON.stringify({type:'event',tabId:7,method:'Page.javascriptDialogClosed',params:{}}));
    profile.socket.send(JSON.stringify({type:'event',tabId:7,method:'bridge.commandFinished',params:{commandId:original}}));
    for(let i=0;i<20&&f.service.broker.stats().trackedControllers;i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(f.service.broker.stats().trackedControllers,0);assert.equal(f.service.broker.stats().openDialogs,0);
  }finally{await f.cleanup();}
});

test('预声明弹窗只消费一次，匹配类型/消息，过期控制不发送响应', async () => {
  const responses: unknown[]=[];const dialogs=new Dialogs(async(_tab,args)=>{responses.push(args);dialogs.closed(7);});
  let release!:()=>void;
  const physical=new Promise<void>(resolve=>{release=resolve;});
  const running=dialogs.run(7,'one',Date.now()+3000,()=>true,()=>dialogs.expected(7,{accept:false,expectedType:'confirm',expectedMessage:'expected'},async()=>{dialogs.arm(7);await physical;return 'clicked';}),async()=>{});
  await Promise.resolve();await Promise.resolve();
  dialogs.opening(7,{type:'confirm',message:'expected'});await new Promise(r=>setTimeout(r,0));release();
  assert.deepEqual((await running).dialog.accept,false);assert.equal(responses.length,1);
  let unblock!:()=>void;const blocked=new Promise<void>(r=>{unblock=r;});
  const mismatch=dialogs.run(7,'two',Date.now()+3000,()=>true,()=>dialogs.expected(7,{accept:true,expectedType:'confirm',expectedMessage:'expected'},()=>{dialogs.arm(7);return blocked;}),async()=>{});
  const rejected=assert.rejects(mismatch,error=>{assert.equal(errorInfo(error).code,'DIALOG_MISMATCH');assert.equal(unknownResult(errorInfo(error)),true);return true;});await Promise.resolve();await Promise.resolve();
  dialogs.opening(7,{type:'confirm',message:'different'});await rejected;assert.equal(responses.length,1);dialogs.closed(7);unblock();await new Promise(r=>setTimeout(r,0));
  const expired=dialogs.run(7,'three',Date.now()-1,()=>false,()=>dialogs.expected(7,{accept:true,expectedType:'alert',expectedMessage:''},async()=>{await new Promise(r=>setTimeout(r,10));}),async()=>{});
  const expiredRejected=assert.rejects(expired);await Promise.resolve();await Promise.resolve();dialogs.opening(7,{type:'alert'});await expiredRejected;assert.equal(responses.length,1);
});

test('弹窗控制限定原账号/客户端/连接/ID，并保持未知操作保护；无弹窗超时仍受保护',async()=>{
  const f=await fixture();let calls=0,release!:()=>void,commandId='';const dialogId=randomUUID();
  try {
    const profile=await fakeProfile(f.config,'dialog',command=>{
      if(command.operation==='page.action') {calls++;commandId=command.id;profile.socket.send(JSON.stringify({type:'event',tabId:7,method:'Page.javascriptDialogOpening',params:{dialogId,commandId:command.id,type:'confirm',message:'test'}}));return new Promise<void>(r=>{release=r;});}
      if(command.operation==='page.dialog') {assert.equal(command.args.dialogId,dialogId);profile.socket.send(JSON.stringify({type:'event',tabId:7,method:'Page.javascriptDialogClosed',params:{}}));release();return {handled:true};}
      return {idle:true};
    });
    f.service.broker.profiles.get(profile.id)!.info.capabilities!.push('dialog-control');
    const first=f.service.state.createClient('first'),second=f.service.state.createClient('second'),readonly=f.service.state.createClient('reader',[profile.id],true),other=f.service.state.createClient('other',[randomUUID()],false);
    const a=f.service.state.principal(first.id)!,b=f.service.state.principal(second.id)!;const target={profileId:profile.id,tabId:7};
    const timed=await f.service.invoke('chrome_action',{...target,action:'click',x:10,y:10,timeoutMs:100},'first-owner',a);
    assert.equal(timed.error?.code,'COMMAND_TIMEOUT');assert.equal(f.service.state.get(timed.operationId!)!.state,'unknown');
    const reply=(principal:any,args:any={})=>f.service.invoke('chrome_dialog',{...target,accept:false,...args},'new-owner',principal);
    assert.equal((await reply(b)).error?.code,'DIALOG_NOT_AUTHORIZED');
    assert.equal((await reply(a,{dialogId:randomUUID()})).error?.code,'DIALOG_MISMATCH');
    assert.equal((await reply(f.service.state.principal(readonly.id))).error?.code,'CLIENT_READ_ONLY');
    assert.equal((await reply(f.service.state.principal(other.id))).error?.code,'PROFILE_NOT_AUTHORIZED');
    assert.equal((await reply(a)).ok,true);assert.equal(calls,1);assert.equal(f.service.state.get(timed.operationId!)!.state,'unknown');
    assert.equal((await f.service.invoke('chrome_action',{...target,action:'click',x:10,y:10},'first-owner',a)).error?.code,'RESULT_UNKNOWN');
    assert.equal((await reply(a)).error?.code,'DIALOG_NOT_OPEN');
    // 原请求已超时并返回后，晚到的第二个弹窗仍归原客户端，不会退化为无所有者。
    profile.socket.send(JSON.stringify({type:'event',tabId:7,method:'Page.javascriptDialogOpening',params:{dialogId:randomUUID(),commandId,type:'alert',message:'late'}}));await new Promise(r=>setTimeout(r,20));
    assert.equal((await reply(b)).error?.code,'DIALOG_NOT_AUTHORIZED');
    const lone=await fakeProfile(f.config,'silent',async command=>command.operation==='page.action'?new Promise(()=>{}):{});
    const timeout=await f.service.invoke('chrome_action',{profileId:lone.id,tabId:8,action:'click',x:1,y:1,timeoutMs:100},'first-owner',a);
    assert.equal(timeout.error?.code,'COMMAND_TIMEOUT');assert.equal(f.service.state.get(timeout.operationId!)!.state,'unknown');
  } finally {await f.cleanup();}
});

test('预声明弹窗的前置拒绝（缺少声明、已有弹窗）是明确的未派发，触发动作没有运行；由已派发的输入触发的 DIALOG_OPEN 仍是未知',async()=>{
  const dialogs=new Dialogs(async()=>{});let triggered=0;
  const trigger=async()=>{triggered++;};
  const refused=async(promise:Promise<unknown>,code:string)=>{
    await assert.rejects(promise,error=>{const info=errorInfo(error);assert.equal(info.code,code);assert.equal(info.phase,'precondition');assert.equal(info.outcome,'not_dispatched');assert.equal(unknownResult(info),false);return true;});
  };
  await refused(dialogs.run(7,'policy',Date.now()+3000,()=>true,()=>dialogs.expected(7,{accept:true},trigger),async()=>{}),'DIALOG_POLICY_REQUIRED');
  await refused(dialogs.run(7,'policy-type',Date.now()+3000,()=>true,()=>dialogs.expected(7,{accept:true,expectedType:'confirm'},trigger),async()=>{}),'DIALOG_POLICY_REQUIRED');
  // 页面自发弹窗已经打开：新的触发动作不执行
  dialogs.opening(7,{type:'alert',message:'spontaneous'});
  await refused(dialogs.run(7,'already-open',Date.now()+3000,()=>true,()=>dialogs.expected(7,{accept:false,expectedType:'alert',expectedMessage:'x'},trigger),async()=>{}),'DIALOG_OPEN');
  assert.equal(triggered,0,'两类前置拒绝都发生在触发动作之前');
  dialogs.closed(7);
  // 对照：触发动作已经在跑，期间弹窗打开（没有预声明或不匹配）——输入可能已派发，仍是未知，不带 not_dispatched
  let finish!:()=>void;const physical=new Promise<void>(resolve=>{finish=resolve;});
  const running=dialogs.run(8,'in-job',Date.now()+3000,()=>true,()=>physical,async()=>{});
  const opened=assert.rejects(running,error=>{const info=errorInfo(error);assert.equal(info.code,'DIALOG_OPEN');assert.equal(info.outcome,undefined);assert.equal(unknownResult(info),true);return true;});
  dialogs.opening(8,{type:'confirm',message:'caused by dispatched input'});await opened;
  assert.throws(()=>dialogs.assert(8),error=>{const info=errorInfo(error);assert.equal(info.code,'DIALOG_OPEN');assert.equal(unknownResult(info),true);return true;});
  finish();await new Promise(resolve=>setTimeout(resolve,0));dialogs.closed(8);
});

test('同一调用方答完自己操作弹出的框，原操作不再算结果不明；脚本弹出的框和别人的框不解除保护',async()=>{
 const f=await fixture();const dialogId=randomUUID();let opened=false;
 try{
  const profile=await fakeProfile(f.config,'dialog-settle',command=>{
   const open=()=>{opened=true;profile.socket.send(JSON.stringify({type:'event',tabId:7,method:'Page.javascriptDialogOpening',params:{dialogId,commandId:command.id,type:'confirm',message:'确认删除？'}}));};
   const blocked={code:'DIALOG_OPEN',message:'blocked'};
   if(command.operation==='page.dialog'){opened=false;profile.socket.send(JSON.stringify({type:'event',tabId:7,method:'Page.javascriptDialogClosed',params:{}}));profile.socket.send(JSON.stringify({type:'event',tabId:7,method:'bridge.commandFinished',params:{commandId:command.args.__trigger}}));return {handled:true,dialogId,type:'confirm',accept:command.args.accept};}
   if(command.operation==='page.batch'&&(command.args.steps as any[])[0].args.action==='click'){open();return {completed:false,failedIndex:0,results:[],error:blocked,note:'x'};}
   if(command.operation==='page.action'&&command.args.action==='click'){open();profile.socket.send(JSON.stringify({type:'result',id:command.id,error:blocked}));return new Promise(()=>{});}
   if(command.operation==='page.evaluate'){open();profile.socket.send(JSON.stringify({type:'result',id:command.id,error:blocked}));return new Promise(()=>{});}
   if(command.operation==='page.action')return {filled:true};
   return {};
  });
  f.service.broker.profiles.get(profile.id)!.info.capabilities!.push('dialog-control');
  const first=f.service.state.principal(f.service.state.createClient('first').id)!,second=f.service.state.principal(f.service.state.createClient('second').id)!;
  const target={profileId:profile.id,tabId:7},call=(name:string,args:any,principal=first)=>f.service.invoke(name,{...target,...args},'owner-'+principal.id,principal);
  const fill={action:'fill',selector:'#a',text:'x'};
  const clicked=await call('chrome_action',{action:'click',selector:'#a'});
  assert.equal(clicked.error?.code,'DIALOG_OPEN');assert.equal(f.service.state.get(clicked.operationId!)!.state,'unknown');
  assert.equal((await call('chrome_dialog',{accept:true},second)).error?.code,'DIALOG_NOT_AUTHORIZED');assert.equal(f.service.state.get(clicked.operationId!)!.state,'unknown','别的客户端答不了，也解不了保护');
  assert.equal((await call('chrome_action',fill)).error?.code,'RESULT_UNKNOWN','答之前继续受保护');
  const answered=await call('chrome_dialog',{accept:true});assert.equal(answered.ok,true);assert.equal((answered.data as any).writable,true);
  const settled=f.service.state.get(clicked.operationId!)!;assert.equal(settled.state,'succeeded');assert.equal(settled.errorCode,'DIALOG_OPEN');
  assert.equal(f.service.broker.stats().quarantinedTabs,1,'隔离只在下次写入时撤销');
  assert.equal((await call('chrome_action',fill)).ok,true,'答完不用 chrome_recover_tab');assert.equal(f.service.broker.stats().quarantinedTabs,0);
  const batch=await call('chrome_batch',{steps:[{operation:'page.action',args:{action:'click',selector:'#a'}}]});assert.equal(f.service.state.get(batch.operationId!)!.state,'unknown');
  assert.equal(((await call('chrome_dialog',{accept:false})).data as any).writable,true);assert.equal(f.service.state.get(batch.operationId!)!.state,'failed','批次的后续步骤没有运行');
  assert.equal((await call('chrome_action',fill)).ok,true);
  const scripted=await call('chrome_evaluate',{expression:'confirm("x");location.reload()'});assert.equal(scripted.error?.code,'DIALOG_OPEN');
  assert.equal(((await call('chrome_dialog',{accept:true})).data as any).writable,false,'脚本答完还在接着跑，结果仍然不明');
  assert.equal(f.service.state.get(scripted.operationId!)!.state,'unknown');assert.equal((await call('chrome_action',fill)).error?.code,'RESULT_UNKNOWN');
  assert.equal((await call('chrome_recover_tab',{})).ok,true);assert.equal((await call('chrome_action',fill)).ok,true);
  assert.equal(opened,false);
 }finally{await f.cleanup();}
});

test('弹窗打断的错误文案直接带内容和下一步，不用再查事件',async()=>{
 const dialogs=new Dialogs(async()=>{});let finish!:()=>void;const physical=new Promise<void>(resolve=>{finish=resolve;});
 const running=dialogs.run(9,'with-text',Date.now()+3000,()=>true,()=>physical,async()=>{});
 const failed=assert.rejects(running,error=>{const {code,message}=errorInfo(error);assert.equal(code,'DIALOG_OPEN');assert.match(message,/确认删除？/);assert.match(message,/chrome_dialog/);assert.doesNotMatch(message,/chrome_events/);return true;});
 dialogs.opening(9,{type:'confirm',message:'确认删除？'});await failed;assert.equal(dialogs.interrupted(9),true);finish();await new Promise(resolve=>setTimeout(resolve,0));dialogs.closed(9);assert.equal(dialogs.interrupted(9),false);
});
