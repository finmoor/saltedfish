import test from 'node:test';
import assert from 'node:assert/strict';
import {interactionHarness} from './interaction-harness.js';

// 一次安全测试里发现、用真 Chrome 复现的两条。
// F1：页面抛出超过 10 万字的错误，服务曾把整条桥接关掉，这个浏览器上同时在途的命令全成了结果不明。
// F2：navigate 到 javascript: 地址会在页面里执行代码，标签页因此暂停写入；现在派发前就拒绝。
const html=`<!doctype html><meta charset="utf-8"><title>安全测试</title><p id="p">原样</p>`;

test('安全测试反馈：超长错误消息不断开连接、不连累别的标签页；javascript: 地址在派发前拒绝',{timeout:180000},async t=>{
 const h=await interactionHarness(t,html);

 await t.test('页面抛出 10 万字以上的错误：照常返回截短的错误，同时在途的另一个标签页拿到结果，连接还在',async()=>{
  const a=await h.open(),b=await h.open();
  try{
   const profileId=a.target.profileId,online=()=>h.service.broker.listProfiles().map(profile=>profile.id);
   // b 的调用要 1 秒才结束，a 在这期间抛出长错误。
   const slow=b.raw('chrome_evaluate',{expression:"new Promise(resolve=>setTimeout(()=>resolve('b 完成'),1000))"});
   await new Promise(resolve=>setTimeout(resolve,100));
   for(const expression of ["throw new Error('y'.repeat(100500))",'x'.repeat(200000)]){
    const failed=await a.raw('chrome_evaluate',{expression});
    assert.equal(failed.error?.code,'JAVASCRIPT_ERROR',JSON.stringify(failed.error).slice(0,300));
    assert.ok(failed.error!.message.length<=8000,`消息 ${failed.error!.message.length} 字`);
    assert.match(failed.error!.message,/消息已截断，原长 \d+ 字/);
    assert.deepEqual(online(),[profileId],'浏览器一直在线');
   }
   const done=await slow;
   assert.equal(done.ok,true,JSON.stringify(done.error));assert.equal(done.data,'b 完成');
   assert.equal(await a.call('chrome_evaluate',{expression:'1+1'}),2,'同一个标签页马上能继续用');
   assert.equal(h.service.broker.stats().quarantinedTabs,0);
  }finally{await a.page.close();await b.page.close();}
 });

 await t.test('navigate 到 javascript: 地址：未派发，页面没被改，标签页照常可写、可关',async()=>{
  const {page,raw,call}=await h.open();
  const refused=await raw('chrome_navigate',{url:"javascript:document.getElementById('p').textContent='被改了'"});
  assert.equal(refused.error?.code,'INVALID_ARGUMENT');assert.equal(refused.error?.outcome,'not_dispatched');assert.match(refused.error!.message,/chrome_evaluate/);
  assert.equal(await page.$eval('#p',e=>e.textContent),'原样');
  assert.equal(await call('chrome_evaluate',{expression:"document.title='还能写'"}),'还能写');
  const closed=await raw('chrome_close_tab',{});
  assert.equal(closed.ok,true,JSON.stringify(closed.error));
 });
});
