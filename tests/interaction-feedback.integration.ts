import test from 'node:test';
import assert from 'node:assert/strict';
import {interactionHarness} from './interaction-harness.js';

// 在一个 ERP 系统上使用时的反馈，用真 Chrome 复现能复现的几条。
// 表头勾选框：鼠标移到表头上冒出筛选图标，勾选框被挤左 10px（flex 右对齐）。
const html=`<!doctype html><meta charset="utf-8"><title>反馈</title>
<style>
body{margin:0;font:14px sans-serif}
.head{display:flex;justify-content:flex-end;align-items:center;width:120px;height:30px;margin:40px;border:1px solid #ccc}
.head .funnel{display:none;width:10px;height:10px;background:#888}
.head:hover .funnel{display:inline-block}
#hidden-file{display:none}
</style>
<div class="head"><input type="checkbox" id="all" aria-label="全选"><span class="funnel"></span></div>
<p id="count">导入资源文件(65)</p>
<input type="file" id="hidden-file">
<button id="touch" onclick="window.touched=1">碰一下</button>`;

test('ERP 反馈：悬停挪位置的勾选框、beforeunload、等待超时的现场、全角半角、只读改写建议',{timeout:180000},async t=>{
 const h=await interactionHarness(t,html);

 await t.test('表头悬停冒出筛选图标、勾选框左移 10px：跟过去再点，一次勾上，标签页照常可写',async()=>{
  const {page,call}=await h.open();
  try{
   const box=await call('chrome_find',{locator:{role:'checkbox',name:'全选'}});
   const result=await call('chrome_action',{action:'setChecked',ref:box.elements[0].ref,checked:true});
   assert.equal(result.checked,true);assert.equal(result.changed,true);assert.equal(await page.$eval('#all',e=>(e as HTMLInputElement).checked),true);
   await call('chrome_action',{action:'click',selector:'#touch'});assert.equal(await page.evaluate(()=>(window as any).touched),1);
  }finally{await page.close();}
 });

 await t.test('beforeunload：navigate、close_tab 带 beforeUnload 直接离开；不带时停下，用 chrome_dialog 答完不用再 recover',async()=>{
  const {page,call,raw,target}=await h.open();
  const guard=async()=>{await page.evaluate(()=>{window.onbeforeunload=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};});await call('chrome_action',{action:'click',selector:'#touch'});};
  const base=`http://127.0.0.1:${h.port}`;
  try{
   // 不带：停下报 DIALOG_OPEN；答“留下”，页面不动，原操作算没做，标签页照常可写。
   await guard();
   const stopped=await raw('chrome_navigate',{url:`${base}/a`});
   assert.equal(stopped.error?.code,'DIALOG_OPEN',JSON.stringify(stopped));
   const stay=await call('chrome_dialog',{accept:false});
   assert.equal(stay.type,'beforeunload');assert.equal(stay.writable,true,'答完不用再 recover');
   assert.equal(h.service.state.get(stopped.operationId!)!.state,'failed');assert.equal(new URL(page.url()).pathname,'/');
   // 答“离开”：原操作算做成了。
   const again=await raw('chrome_navigate',{url:`${base}/b`});assert.equal(again.error?.code,'DIALOG_OPEN',JSON.stringify(again));
   const leave=await call('chrome_dialog',{accept:true});assert.equal(leave.writable,true);
   assert.equal(h.service.state.get(again.operationId!)!.state,'succeeded');
   for(let i=0;i<50&&new URL(page.url()).pathname!=='/b';i++)await new Promise(r=>setTimeout(r,100));
   assert.equal(new URL(page.url()).pathname,'/b');
   // 带 beforeUnload:"accept"：一步到位。
   await guard();
   const direct=await call('chrome_navigate',{url:`${base}/c`,beforeUnload:'accept'});
   assert.equal(direct.beforeUnload,'accepted');assert.equal(new URL(page.url()).pathname,'/c');
   // 页面没挂 beforeunload 时带上也照常导航。
   const plain=await call('chrome_navigate',{url:`${base}/d`,beforeUnload:'accept'});assert.equal(plain.beforeUnload,undefined);
   await guard();
   const closed=await call('chrome_close_tab',{beforeUnload:'accept'});
   assert.equal(closed.closed,true);assert.equal(closed.beforeUnload,'accepted');
   for(let i=0;i<50&&!page.isClosed();i++)await new Promise(r=>setTimeout(r,100));
   assert.equal(page.isClosed(),true);
   // 已经关掉的再关一次：要的结果已经达成。
   const twice=await h.service.invoke('chrome_close_tab',target,'interaction-test');
   assert.equal(twice.ok,true,JSON.stringify(twice.error));assert.equal((twice.data as any).alreadyClosed,true);
  }finally{if(!page.isClosed())await page.close();}
 });

 await t.test('等待：全角半角当一样；超时带上页面、最接近的文字和元素个数',async()=>{
  const {page,call,raw}=await h.open();
  try{
   assert.equal((await call('chrome_wait',{textContains:'导入资源文件（65）',timeoutMs:3000})).matched,true);
   assert.equal((await call('chrome_find',{locator:{text:'导入资源文件（65）'}})).totalElements,1);
   const missed=await raw('chrome_wait',{textContains:'导入资源文件（66）',timeoutMs:500});
   assert.equal(missed.error?.code,'WAIT_TIMEOUT');assert.equal(missed.error?.outcome,'not_dispatched');
   assert.match(missed.error!.message,/「反馈」[\s\S]*最接近的文字："导入资源文件\(65\)"/);
   const detail=(missed.error as any).detail;assert.equal(detail.title,'反馈');assert.equal(detail.loading,false);assert.deepEqual(detail.closestText,['导入资源文件(65)']);
   const none=await raw('chrome_wait',{selector:'#nothing',timeoutMs:300});
   assert.equal(none.error?.code,'WAIT_TIMEOUT');assert.match(none.error!.message,/没有匹配的元素/);
   const hidden=await raw('chrome_wait',{selector:'#hidden-file',timeoutMs:300});
   assert.match(hidden.error!.message,/匹配的元素 1 个，看得见的 0 个/);
  }finally{await page.close();}
 });

 await t.test('只读脚本：getClientRects 被拦，建议换 getBoundingClientRect，照改能过',async()=>{
  const {page,call,raw}=await h.open();
  try{
   const blocked=await raw('chrome_evaluate',{expression:"document.querySelector('#hidden-file').getClientRects().length",readOnly:true});
   assert.equal(blocked.error?.code,'SIDE_EFFECT_BLOCKED');assert.match(blocked.error!.message,/getBoundingClientRect/);
   assert.equal(await call('chrome_evaluate',{expression:"document.querySelector('#hidden-file').getBoundingClientRect().width",readOnly:true}),0);
   // 反馈里那段写法本身（Array.from、箭头函数、对象字面量、offsetWidth）都能过。
   const listed=await call('chrome_evaluate',{expression:"Array.from(document.querySelectorAll('input')).map((e,i)=>({i,id:e.id,visible:!!(e.offsetWidth||e.offsetHeight)}))",readOnly:true});
   assert.deepEqual(listed,[{i:0,id:'all',visible:true},{i:1,id:'hidden-file',visible:false}]);
  }finally{await page.close();}
 });
});
