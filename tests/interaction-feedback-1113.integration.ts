import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,rm,writeFile} from 'node:fs/promises';
import {interactionHarness} from './interaction-harness.js';

// 11-13 在视频平台创作者后台排片时的反馈，用真 Chrome 复现。
// 封面区仿 Semi Design 的 Upload：一个控件里有主文件框和替换框两个隐藏的文件框，点上传区时页面只打开主框；误传进替换框页面会出错。
// 主框收到文件后换成一个新的空文件框（Semi 换 key 重建，同一个文件才能再选一次；真实页面上每传一次主框的 ref 都变）。
// 另有一个点了不打开选择框的上传区；话题候选、文字相近的一组候选、被固定顶栏压住的按钮、视口外的按钮；编辑器里的标签带 data-mention。
const html=`<!doctype html><meta charset="utf-8"><title>发布页</title>
<style>body{margin:0;position:relative}header{position:fixed;top:0;left:0;right:0;height:50px;background:#222;color:#fff;z-index:5}
.abs{position:absolute;left:10px}.add{display:inline-block;width:200px;height:50px;background:#eee}.list span{display:block;height:20px;width:200px}
.spacer{height:2400px}</style>
<header class="topbar">创作者中心</header>
<div class="abs" style="top:60px">
 <div class="semi-upload" id="up1">
  <input type="file" class="semi-upload-hidden-input" accept="image/png,image/jpeg" style="display:none" onchange="window.__main=(window.__main||0)+this.files.length;const fresh=this.cloneNode();fresh.value='';this.replaceWith(fresh)">
  <input type="file" class="semi-upload-hidden-input-replace" accept="image/png,image/jpeg" style="display:none" onchange="window.__broken=true">
  <div class="semi-upload-add add" onclick="document.querySelector('#up1 .semi-upload-hidden-input').click()"><div><span>上传封面</span></div></div>
 </div>
 <div class="semi-upload" id="up2" style="margin-top:6px">
  <input type="file" class="semi-upload-hidden-input" style="display:none">
  <input type="file" class="semi-upload-hidden-input-replace" style="display:none">
  <div class="semi-upload-add add" onclick="window.__dead=true"><div><span>拖到这里</span></div></div>
 </div>
</div>
<div class="abs" style="top:200px;width:400px" contenteditable id="editor">为宇宙打前站 <span data-mention="activity">vibe知识大赏</span> <span data-mention="#">#Claude</span></div>
<div class="abs list" style="top:300px" id="list">
 <span onclick="window.__picked='月球背面'">月球背面</span><span onclick="window.__picked='月球背面图片'">月球背面图片</span><span onclick="window.__picked='月球背面探测'">月球背面探测</span>
</div>
<button class="abs" style="top:520px;height:20px" id="under" onclick="window.__under=true">被顶栏压住</button>
<button class="abs" style="top:1500px" id="far" onclick="window.__far=true">远处的按钮</button>
<div class="spacer"></div>`;

test('11-13 反馈：上传区有主框和替换框时点它用页面打开的那个、看得见的目标点击前不滚动、按 ref 点击带 hit、属性条件超时报实际值、多匹配提示去掉 exact:false',{timeout:180000},async t=>{
 const h=await interactionHarness(t,html);
 const directory=path.join(h.config.dataDir,'..',path.basename(h.config.dataDir)+'-cover'),cover=path.join(directory,'竖封面.png');
 await mkdir(directory,{recursive:true});await writeFile(cover,'png-bytes');
 t.after(()=>rm(directory,{recursive:true,force:true}));

 await t.test('上传：「上传封面」往上碰到的那层有主框和替换框，点它、用页面打开的主框；不弹系统选择框，替换框没动',async()=>{
  const {page,call}=await h.open();
  try{
   const uploaded=await call('chrome_upload',{locator:{text:'上传封面'},paths:[cover],timeoutMs:15000});
   assert.deepEqual(uploaded.files,[{name:'竖封面.png',size:9}]);
   assert.equal(uploaded.input.via,'fileChooser');assert.match(uploaded.input.selector,/semi-upload-hidden-input$/);assert.equal(uploaded.input.area,'上传封面');assert.equal(uploaded.input.accept,'image/png,image/jpeg');
   assert.deepEqual(await page.evaluate(()=>({main:(window as any).__main,broken:(window as any).__broken??false})),{main:1,broken:false},'传进主框，替换框没碰');
   // 拦截只在那次点击前后开着：之后页面自己再打开选择框，扩展不会接走。
   const again=await call('chrome_upload',{locator:{text:'上传封面'},paths:[cover],timeoutMs:15000});
   assert.equal(again.input.via,'fileChooser','主框换过 value 也照样找得到');
   assert.equal(await page.evaluate(()=>(window as any).__main),2);
  }finally{await page.close();}
 });

 await t.test('上传：点了不打开选择框的上传区，报 FILE_CHOOSER_NOT_OPENED（已派发）并列出候选；目标本身装着几个文件框照旧报歧义、不点',async()=>{
  const {page,raw}=await h.open();
  try{
   const dead=await raw('chrome_upload',{locator:{text:'拖到这里'},paths:[cover],timeoutMs:15000});
   assert.equal(dead.error?.code,'FILE_CHOOSER_NOT_OPENED',JSON.stringify(dead.error));assert.equal(dead.error?.outcome,'dispatched');
   assert.equal((dead.error as any).detail.total,2);assert.match(dead.error!.message,/页面没有打开文件选择框/);assert.match(dead.error!.message,/不要重复点击/);
   assert.equal(await page.evaluate(()=>(window as any).__dead),true,'点击确实发出了');
   const container=await raw('chrome_upload',{selector:'#up1',paths:[cover]});
   assert.equal(container.error?.code,'AMBIGUOUS_FILE_INPUT');assert.equal(container.error?.outcome,'not_dispatched');assert.match(container.error!.message,/目标里面有 2 个文件框/);
   assert.equal(await page.evaluate(()=>(window as any).__main??0),0,'没点也没传');
  }finally{await page.close();}
 });

 await t.test('点击：完整在视口里的目标不滚动，box 照旧有效，结果带落点 hit；视口外的才滚，结果带 scrolled',async()=>{
  const {page,call}=await h.open();
  try{
   const found=await call('chrome_find',{locator:{text:'月球背面探测'}});
   const [,y,,height]=found.elements[0].box;
   const clicked=await call('chrome_action',{action:'click',ref:found.elements[0].ref,observe:false});
   assert.equal(await page.evaluate(()=>scrollY),0,'没有滚动');assert.equal(clicked.scrolled,undefined);
   assert.ok(Math.abs(clicked.y-(y+height/2))<=height/2,`点在 find 给的 box 里：${clicked.y} vs ${JSON.stringify(found.elements[0].box)}`);
   assert.equal(clicked.hit?.text,'月球背面探测',JSON.stringify(clicked.hit));assert.equal(await page.evaluate(()=>(window as any).__picked),'月球背面探测');
   const named=await call('chrome_action',{action:'click',locator:{role:'button',name:'远处的按钮'},observe:false});
   assert.ok(named.scrolled?.y>800,JSON.stringify(named.scrolled));assert.equal(named.hit?.name,'远处的按钮');
   assert.ok(await page.evaluate(()=>scrollY)>800);assert.equal(await page.evaluate(()=>(window as any).__far),true);
  }finally{await page.close();}
 });

 await t.test('点击：完整在视口里但被固定顶栏压住，退回滚到正中再点',async()=>{
  const {page,call}=await h.open();
  try{
   await page.evaluate(()=>scrollTo(0,500));
   const clicked=await call('chrome_action',{action:'click',selector:'#under',observe:false});
   assert.ok(clicked.scrolled?.y<0,`往上滚回来了：${JSON.stringify(clicked.scrolled)}`);assert.equal(await page.evaluate(()=>(window as any).__under),true);
  }finally{await page.close();}
 });

 await t.test('属性条件：等不到时报出实际值；动作的后置条件同样带上',async()=>{
  const {raw}=await h.open();
  const waited=await raw('chrome_wait',{locator:{text:'vibe知识大赏',inside:'[contenteditable]'},attribute:{name:'data-mention',value:'#'},timeoutMs:400});
  assert.equal(waited.error?.code,'WAIT_TIMEOUT');assert.match(waited.error!.message,/data-mention 现在是 "activity"/);
  const missing=await raw('chrome_wait',{selector:'#editor',attribute:{name:'data-mention',value:'#'},timeoutMs:300});
  assert.match(missing.error!.message,/data-mention 现在没有这个属性/);
  const acted=await raw('chrome_action',{action:'click',locator:{text:'月球背面',exact:true},observe:false,postcondition:{locator:{text:'vibe知识大赏',inside:'[contenteditable]'},attribute:{name:'data-mention',value:'#'},timeoutMs:300}});
  assert.equal(acted.error?.code,'POSTCONDITION_TIMEOUT');assert.match(acted.error!.message,/data-mention 现在是 "activity"/);
 });

 await t.test('多匹配：传了 exact:false 撞上一组相近的字，其中只有一个一字不差时提示去掉它；不替调用方挑',async()=>{
  const {page,raw,call}=await h.open();
  try{
   const loose=await raw('chrome_action',{action:'click',locator:{text:'月球背面',exact:false,inside:'#list'},observe:false});
   assert.equal(loose.error?.code,'AMBIGUOUS_SELECTOR');assert.match(loose.error!.message,/去掉 exact:false/);
   assert.equal(await page.evaluate(()=>(window as any).__picked),undefined,'没有点');
   const none=await raw('chrome_action',{action:'click',locator:{text:'月球',exact:false,inside:'#list'},observe:false});
   assert.equal(none.error?.code,'AMBIGUOUS_SELECTOR');assert.doesNotMatch(none.error!.message,/exact:false/,'没有一字不差的就不提');
   await call('chrome_action',{action:'click',locator:{text:'月球背面',inside:'#list'},observe:false});
   assert.equal(await page.evaluate(()=>(window as any).__picked),'月球背面');
  }finally{await page.close();}
 });
});
