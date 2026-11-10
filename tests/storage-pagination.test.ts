import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import { StateStore } from '../src/state-store.js';

test('流程摘要分页不返回正文，编辑归档删除及旧写入路径保持摘要同步', async () => {
  const f = await fixture();
  try {
    const flows = Array.from({length:12},(_,i)=>f.service.tasks.saveWorkflow('p',{name:'流程'+i,steps:[{operation:'page.action',args:{action:'fill',selector:'#x',text:'x'.repeat(65536)}}]}));
    const page = f.service.tasks.workflows('p',0,10,false,true);
    assert.equal(page.total,12); assert.equal(page.nextOffset,10); assert.equal(page.items.length,10); assert.ok(JSON.stringify(page).length<10000);
    assert.equal(page.items[0].stepCount,1); assert.equal(page.items[0].definition.steps,undefined);
    const original = flows[0]!;
    const edited = f.service.tasks.saveWorkflow('p',{...original.definition,name:'已编辑'},original.id,original.revision);
    f.service.tasks.archiveWorkflow('p',edited.id,edited.revision,true);
    assert.equal(f.service.tasks.workflows('p',0,10,false,true).total,11);
    assert.equal(f.service.tasks.workflows('p',0,10,true,true).items[0].definition.name,'已编辑');
    assert.equal(f.service.tasks.workflows('other',0,10,true,true).total,0);
    f.service.state.removeWorkflow(edited.id,'p',edited.revision);
    assert.equal(f.service.tasks.workflows('p',0,10,true,true).total,0);
    const legacy=flows[1]!,value={...legacy,definition:{...legacy.definition,name:'旧版写入'}};
    (f.service.state as any).db.prepare('UPDATE workflows SET data=? WHERE id=?').run(JSON.stringify(value),legacy.id);
    assert.ok(f.service.tasks.workflows('p',0,20,false,true).items.some((item:any)=>item.definition.name==='旧版写入'));
  } finally { await f.cleanup(); }
});

test('待核查查询保留旧unknown，汇总仅统计未确认记录，收据旧身份拒绝重复', async () => {
  const f=await fixture();
  try {
    const old=f.service.state.begin('A',1,'review','chrome_action');f.service.state.finish(old,'unknown');
    const acknowledged=f.service.state.begin('A',2,'review','chrome_action');f.service.state.finish(acknowledged,'unknown');f.service.state.acknowledge(acknowledged);
    for(let i=0;i<35;i++){const id=f.service.state.begin('A',3,'review','chrome_action');f.service.state.finish(id,'succeeded');}
    assert.equal(f.service.state.list('A','unknown',0,30,false).items[0]!.id,old);
    assert.deepEqual(f.service.state.protection(),{unknown:1,running:0,profiles:[{profileId:'A',unknown:1,running:0}]});
    const agent=randomUUID(),submission=randomUUID(),legacy=`remote:${randomUUID()}:${agent}`;
    f.service.state.saveNewTask({id:randomUUID(),profileId:'A',status:'succeeded',updatedAt:new Date().toISOString()},{principalId:legacy,id:submission,fingerprint:'old'});
    assert.throws(()=>f.service.tasks.submit('A',1,{name:'legacy',steps:[{operation:'page.evaluate',args:{expression:'one'}}]},
      {id:`remote:${randomUUID()}:${agent}`,submissionScope:'remote-submission:new',remoteAgentId:agent,label:'test',profiles:['A'],admin:false,readOnly:false},undefined,submission),{code:'TASK_SUBMISSION_LEGACY'});
  } finally { await f.cleanup(); }
});

test('稳定远程收据与最低数据读取版本原子提交，日志失败不提升版本', async () => {
  const f=await fixture();
  try {
    const db=(f.service.state as any).db;
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,1);
    const record={id:randomUUID(),profileId:'A',status:'queued',updatedAt:new Date().toISOString()};
    const receipt={principalId:'remote-submission:test',id:randomUUID(),fingerprint:'fixture'};
    const original=f.service.state.saveTask.bind(f.service.state);
    f.service.state.saveTask=()=>{throw new Error('fixture journal failure');};
    assert.throws(()=>f.service.state.saveNewTask(record,receipt));
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,1);
    assert.equal(f.service.state.taskSubmission('A',receipt.principalId,receipt.id),undefined);
    f.service.state.saveTask=original;f.service.state.saveNewTask(record,receipt);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,2);
  } finally { await f.cleanup(); }
});
