import test from 'node:test';
import assert from 'node:assert/strict';
import {interactionHarness} from './interaction-harness.js';

// 11-05 在视频平台创作者后台发片时的反馈，用真 Chrome 复现。
// 页面带 core-js 一类的补丁：JSON.stringify 换成自己的 JS（记调用次数，是真的副作用），Function.prototype.toString 也换掉、让补丁看着像原生。
// 话题候选是普通块里的 span（这种浮层不在浮层规则认得出的结构里），编辑器里有同名的话题；两个“选择封面”只有旁边的文字不同。
const html=`<!doctype html><meta charset="utf-8"><title>发布页</title>
<script>
(()=>{const native=JSON.stringify,toString=Function.prototype.toString,fake=new WeakMap();window.__calls=0;
 const patched=function(){window.__calls++;return native.apply(JSON,arguments);};fake.set(patched,'function stringify() { [native code] }');JSON.stringify=patched;
 const spoof=function(){return fake.has(this)?fake.get(this):toString.call(this);};fake.set(spoof,'function toString() { [native code] }');Function.prototype.toString=spoof;})();
</script>
<input id="title" value="原标题">
<input id="secret" type="password" aria-label="密码">
<div contenteditable id="editor" style="width:300px;min-height:40px;border:1px solid #ccc"><span>#识字启蒙</span> 正文</div>
<div id="topics"><span>#识字启蒙</span></div>
<div class="cover"><div>竖封面 3:4</div><div class="pick">选择封面</div></div>
<div class="cover"><div>横封面 4:3</div><div class="pick">选择封面</div></div>
<div id="heat">还没有</div>
<button id="publish" onclick="document.title='作品管理';setTimeout(()=>history.pushState({},'','/manage?from=publish'),900)">发布</button>
<button id="noop">没反应</button>`;

test('11-05 反馈：页面换掉内置函数时 readOnly 点名、find 标出编辑器和旁边文字、动作带后置条件、textMatches、type 读回',{timeout:180000},async t=>{
 const h=await interactionHarness(t,html);

 await t.test('只读脚本：页面把 JSON.stringify 换成 JS 时被拦，消息点名它、页面没被调用；去掉它直接返回对象就能过',async()=>{
  const {page,call,raw}=await h.open();
  try{
   assert.equal(await page.evaluate(()=>Function.prototype.toString.call(JSON.stringify)),'function stringify() { [native code] }','补丁假装是原生的');
   const blocked=await raw('chrome_evaluate',{expression:"(()=>{const q=s=>Array.from(document.querySelectorAll(s));return JSON.stringify({title:q('#title')[0].value,tags:q('#editor span').map(e=>e.textContent)})})()",readOnly:true});
   assert.equal(blocked.error?.code,'SIDE_EFFECT_BLOCKED');
   assert.match(blocked.error!.message,/这个页面把 JSON\.stringify 换成了自己的 JS/);
   assert.match(blocked.error!.message,/去掉 JSON\.stringify、直接返回对象/);
   assert.deepEqual((blocked.error as any).detail.replacedBuiltins,['JSON.stringify'],'Array.from、map、querySelectorAll 是原生的，不点名');
   assert.equal(blocked.error?.outcome,'not_dispatched');
   assert.equal(await page.evaluate(()=>(window as any).__calls),0,'补丁一次都没被调用：被拦在副作用之前，诊断也不调用它');
   assert.deepEqual(await call('chrome_evaluate',{expression:"(()=>{const q=s=>Array.from(document.querySelectorAll(s));return {title:q('#title')[0].value,tags:q('#editor span').map(e=>e.textContent)}})()",readOnly:true}),{title:'原标题',tags:['#识字启蒙']});
   // 原生就拦的写法（closest）照旧按写法提示，不说页面换了什么。
   const native=await raw('chrome_evaluate',{expression:"document.querySelector('.pick').closest('.cover').textContent",readOnly:true});
   assert.equal(native.error?.code,'SIDE_EFFECT_BLOCKED');assert.match(native.error!.message,/closest 换成先取 const all=\[\.\.\.document\.querySelectorAll/);assert.doesNotMatch(native.error!.message,/换成了自己的 JS/);
   assert.equal(await page.evaluate(()=>(window as any).__calls),0);
  }finally{await page.close();}
 });

 await t.test('find：编辑器里的同名文字带 within textbox；多个“选择封面”各带旁边的文字；只有一个时不带',async()=>{
  const {page,call}=await h.open();
  try{
   const topics=(await call('chrome_find',{locator:{text:'#识字启蒙',exact:true}})).elements;
   assert.equal(topics.length,2,JSON.stringify(topics));
   assert.equal(topics[0].within?.role,'textbox');assert.ok(topics[0].within.ref);
   assert.equal(topics[1].within,undefined,'候选不在编辑器里');
   const covers=(await call('chrome_find',{locator:{text:'选择封面',exact:true}})).elements;
   assert.deepEqual(covers.map((e:any)=>e.context),['竖封面 3:4 选择封面','横封面 4:3 选择封面']);
   const one=(await call('chrome_find',{locator:{text:'没反应',exact:true}})).elements;
   assert.equal(one.length,1);assert.equal(one[0].context,undefined);
  }finally{await page.close();}
 });

 await t.test('chrome_action 带后置条件：等到跳转，结果带 url、title；没满足报 POSTCONDITION_TIMEOUT、已派发，标签页照常可写；批次步骤同样带 url',async()=>{
  const {page,call,raw}=await h.open();
  try{
   const done=await call('chrome_action',{action:'click',selector:'#publish',postcondition:{urlContains:'/manage',timeoutMs:5000}});
   assert.equal(done.clicked,true);assert.equal(done.postcondition.matched,true);
   assert.match(done.postcondition.url,/\/manage\?from=publish$/);assert.equal(done.postcondition.title,'作品管理');
   const missed=await raw('chrome_action',{action:'click',selector:'#noop',postcondition:{urlContains:'/never',timeoutMs:600}});
   assert.equal(missed.error?.code,'POSTCONDITION_TIMEOUT');assert.equal(missed.error?.outcome,'dispatched');
   assert.match(missed.error!.message,/动作已经做完，但后置条件 600 毫秒内没有满足.*不要重复这个动作/);
   assert.equal((missed.error as any).detail.action.clicked,true,'失败里带着动作本身的结果');
   await call('chrome_action',{action:'fill',selector:'#title',text:'新标题',observe:false});
   assert.equal(await page.$eval('#title',e=>(e as HTMLInputElement).value),'新标题','没满足的后置条件不暂停写入');
   await page.evaluate(()=>{history.pushState({},'','/post');document.title='发布页';});
   const batch=await call('chrome_batch',{steps:[{operation:'page.action',args:{action:'click',selector:'#publish'},postcondition:{urlContains:'/manage',timeoutMs:5000}}],observe:false});
   assert.equal(batch.completed,true);assert.match(batch.results[0].postcondition.url,/\/manage/);assert.equal(batch.results[0].postcondition.title,'作品管理');
  }finally{await page.close();}
 });

 await t.test('textMatches：等事先不知道的文字（热度数字），按元素限定，全角数字也认；不匹配照常超时',async()=>{
  const {page,call,raw}=await h.open();
  try{
   setTimeout(()=>{void page.evaluate(()=>{document.querySelector('#heat')!.textContent='热度 12.3万';});},300);
   assert.equal((await call('chrome_wait',{textMatches:'热度\\s*[\\d.]+万',timeoutMs:3000})).matched,true);
   assert.equal((await call('chrome_wait',{selector:'#heat',textMatches:'^热度',timeoutMs:1000})).matched,true);
   await page.evaluate(()=>{document.querySelector('#heat')!.textContent='热度１２万';});
   assert.equal((await call('chrome_wait',{selector:'#heat',textMatches:'热度\\d+万',timeoutMs:1000})).matched,true,'全角数字按 NFKC 归一后匹配');
   assert.equal((await raw('chrome_wait',{textMatches:'不存在\\d',timeoutMs:300})).error?.code,'WAIT_TIMEOUT');
  }finally{await page.close();}
 });

 await t.test('type 读回：富文本给出编辑器现在的文字，普通输入框给值，密码框不回',async()=>{
  const {page,call}=await h.open();
  try{
   const rich=await call('chrome_action',{action:'type',selector:'#editor',text:'新增',observe:false});
   assert.equal(rich.verification,'not_checked');assert.match(rich.value,/^#识字启蒙 正文新增$/);
   const plain=await call('chrome_action',{action:'type',selector:'#title',text:'abc',observe:false});
   assert.equal(plain.value,'原标题abc');
   const secret=await call('chrome_action',{action:'type',selector:'#secret',text:'pw123',observe:false});
   assert.equal(secret.valueRedacted,true);assert.equal(secret.value,undefined);
  }finally{await page.close();}
 });
});
