import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,rm,writeFile} from 'node:fs/promises';
import {interactionHarness} from './interaction-harness.js';

// 11-08 在视频平台创作者后台排片时的反馈，用真 Chrome 复现。
// 话题候选晚一会儿才出来，每个候选各是一个容器，页面别处还有同样的字；封面弹窗晚一会儿出来，里面“上传封面”和“生成参考图”各有一个隐藏的文件框；
// 页面有固定顶栏，内容比视口长；还有一块空白区域给按坐标点击。
const html=`<!doctype html><meta charset="utf-8"><title>发布页</title>
<style>body{margin:0}header{position:fixed;top:0;left:0;right:0;height:50px;background:#222;color:#fff;z-index:5}main{padding-top:60px}.spacer{height:2400px}#blank{width:300px;height:120px;background:#f4f4f4}</style>
<header class="topbar">创作者中心</header>
<main>
<p class="intro"><span>英语听力</span>｜美国生活里的日常对话</p>
<div contenteditable id="editor" style="width:300px;min-height:40px;border:1px solid #ccc"></div>
<button id="type-topic" onclick="setTimeout(()=>{document.querySelector('#suggest').innerHTML=['英语听力','英语听力训练'].map(t=>'<div class=&quot;mention-suggest-item-container-x1&quot; onclick=&quot;window.__picked=this.dataset.tag&quot; data-tag=&quot;'+t+'&quot;><span>#</span><span class=&quot;tag-hash-x2&quot;>'+t+'</span><span>199.3亿</span></div>').join('')},600)">打 #英语听力</button>
<div id="suggest"></div>
<button id="open-cover" onclick="setTimeout(()=>{document.querySelector('#cover').hidden=false},600)">选择封面</button>
<div id="cover" role="dialog" aria-label="设置封面" hidden>
 <div class="upload-ZOJTUA"><input type="file" class="semi-upload-hidden-input" accept="image/png,image/jpeg" style="display:none"><div>点击上传文件或拖拽文件到这里</div></div>
 <div class="ai-ref"><input type="file" class="upload-btn-input" style="display:none"><span>生成参考图</span></div>
</div>
<div id="blank"></div>
<button id="save" onclick="window.__saved=true">保存</button>
<div class="spacer"></div>
</main>`;

test('11-08 反馈：locator.inside 一步点候选、上传按旁边的文字定位、attached、只读等价写法、整页截图的固定元素、坐标点击带落点',{timeout:180000},async t=>{
 const h=await interactionHarness(t,html);

 await t.test('话题候选：没有范围时页面别处的同名字会撞上；inside 限定在候选容器里（可以匹配多个），候选晚出来也等；find 的 selector 当 inside 用',async()=>{
  const {page,call,raw}=await h.open();
  try{
   await call('chrome_action',{action:'click',selector:'#type-topic',observe:false});
   // 候选 600ms 后才出来：find 不等，动作等。
   assert.equal((await call('chrome_find',{selector:'[class*="mention-suggest-item-container"]',locator:{text:'英语听力',exact:true}})).totalElements,0,'候选还没出来');
   const clicked=await call('chrome_action',{action:'click',locator:{text:'英语听力',exact:true,inside:'[class*="mention-suggest-item-container"]'},observe:false});
   assert.equal(clicked.clicked,true);
   assert.equal(await page.evaluate(()=>(window as any).__picked),'英语听力','点中的是候选，不是简介里的字');
   const found=await call('chrome_find',{selector:'[class*="mention-suggest-item-container"]',locator:{text:'英语听力',exact:true}});
   assert.equal(found.totalElements,1,JSON.stringify(found));assert.equal(found.elements[0].tag,'span');
   const ambiguous=await raw('chrome_action',{action:'click',locator:{text:'英语听力',exact:true},observe:false});
   assert.equal(ambiguous.error?.code,'AMBIGUOUS_SELECTOR','不加范围时简介里的同名字也算');
   const none=await call('chrome_find',{locator:{text:'英语听力',inside:'.not-here'}});
   assert.equal(none.totalElements,0);assert.equal(none.insideMatched,0,'范围本身没匹配到时说出来');
   assert.equal((await raw('chrome_action',{action:'click',locator:{text:'x',inside:'[['},observe:false})).error?.code,'INVALID_SELECTOR');
  }finally{await page.close();}
 });

 await t.test('上传：按“点击上传文件或拖拽文件到这里”定位，用最近的文件框，弹窗晚出来也等；目标里有两个文件框就报出来不猜；attached 等隐藏的文件框',async()=>{
  const {page,call,raw}=await h.open();
  const directory=path.join(h.config.dataDir,'..',path.basename(h.config.dataDir)+'-cover'),cover=path.join(directory,'竖封面.png');
  try{
   await mkdir(directory,{recursive:true});await writeFile(cover,'png-bytes');
   await call('chrome_action',{action:'click',selector:'#open-cover',observe:false});
   const uploaded=await call('chrome_upload',{locator:{text:'点击上传文件或拖拽文件到这里'},paths:[cover],timeoutMs:10000});
   assert.deepEqual(uploaded.files,[{name:'竖封面.png',size:9}]);
   assert.equal(uploaded.input.accept,'image/png,image/jpeg');assert.match(uploaded.input.selector,/semi-upload-hidden-input/);assert.equal(uploaded.input.area,'点击上传文件或拖拽文件到这里');
   assert.deepEqual(await page.evaluate(()=>[...document.querySelectorAll<HTMLInputElement>('input[type=file]')].map(input=>input.files?.length||0)),[1,0],'传进“上传封面”的框，不是“生成参考图”的');
   const both=await raw('chrome_upload',{selector:'#cover',paths:[cover]});
   assert.equal(both.error?.code,'AMBIGUOUS_FILE_INPUT');assert.equal(both.error?.outcome,'not_dispatched');assert.equal((both.error as any).detail.total,2);
   const direct=await call('chrome_upload',{selector:'input.upload-btn-input',paths:[cover]});
   assert.equal(direct.input,undefined,'直接给文件框时不多带说明');
   assert.equal((await call('chrome_wait',{selector:'input.semi-upload-hidden-input',state:'attached',timeoutMs:1000})).matched,true,'隐藏的文件框 attached 立刻成立');
   assert.equal((await raw('chrome_wait',{selector:'input.semi-upload-hidden-input',timeoutMs:300})).error?.code,'WAIT_TIMEOUT','默认 visible 照旧等不到');
   const far=await raw('chrome_upload',{selector:'#blank',paths:[cover]});
   assert.equal(far.error?.code,'AMBIGUOUS_FILE_INPUT','往上碰到的那层有两个文件框，不猜');assert.match(far.error!.message,/目标附近有 2 个文件框/);
   const none=await raw('chrome_upload',{selector:'header.topbar',paths:[cover]});
   assert.equal(none.error?.code,'NOT_FILE_INPUT','往上到 body 都没有');assert.match(none.error!.message,/往上 4 层都没有文件框/);
  }finally{await page.close();await rm(directory,{recursive:true,force:true});}
 });

 await t.test('只读：closest、matches 被拦时，提示里的等价写法照抄就能过',async()=>{
  const {call,raw}=await h.open();
  const blocked=await raw('chrome_evaluate',{expression:"document.querySelector('#cover input').closest('[role=dialog]').id",readOnly:true});
  assert.equal(blocked.error?.code,'SIDE_EFFECT_BLOCKED');assert.match(blocked.error!.message,/while\(e&&!all\.includes\(e\)\) e=e\.parentElement/);
  assert.equal(await call('chrome_evaluate',{expression:"(()=>{const el=document.querySelector('#cover input'),all=[...document.querySelectorAll('[role=dialog]')];let e=el; while(e&&!all.includes(e)) e=e.parentElement;return e&&e.id;})()",readOnly:true}),'cover');
  const matched=await raw('chrome_evaluate',{expression:"document.querySelector('#save').matches('button')",readOnly:true});
  assert.match(matched.error!.message,/\(el\.parentNode\|\|document\)\.querySelectorAll/);
  assert.equal(await call('chrome_evaluate',{expression:"(()=>{const el=document.querySelector('#save');return [...(el.parentNode||document).querySelectorAll('button')].includes(el);})()",readOnly:true}),true);
 });

 await t.test('截图：视口截图不带 area、scroll；滚过以后的整页截图标出固定顶栏画在图里的高度，并建议先滚到顶',async()=>{
  const {page,call}=await h.open();
  try{
   const view=await call('chrome_screenshot',{});
   assert.equal(view.coordinates.viewport,true);assert.equal(view.coordinates.area,undefined);assert.equal(view.coordinates.scroll,undefined);
   await page.evaluate(()=>scrollTo(0,900));
   const full=await call('chrome_screenshot',{fullPage:true,scale:0.5,returnImage:false});
   assert.deepEqual(full.coordinates.toViewport,{x:0,y:-900});
   assert.equal(full.coordinates.fixed?.length,1,JSON.stringify(full.coordinates));
   assert.match(full.coordinates.fixed[0].selector,/header\.topbar/);assert.equal(full.coordinates.fixed[0].box[1],450,'顶栏画在滚动位置 900 × 0.5');
   assert.match(full.coordinates.note,/header\.topbar 画在图片 y≈450/);assert.match(full.coordinates.note,/滚到顶再截/);
   assert.equal(await page.evaluate(()=>scrollY),900,'截图不滚动页面');
   await page.evaluate(()=>scrollTo(0,0));
   const top=await call('chrome_screenshot',{fullPage:true,returnImage:false});
   assert.equal(top.coordinates.fixed[0].box[1],0);assert.doesNotMatch(top.coordinates.note,/滚到顶/);
   const inside=await call('chrome_screenshot',{selector:'#save',returnImage:false});
   assert.equal(inside.coordinates.fixed,undefined,'截的区域在视口里时，固定元素就在看到的位置，不用说');
  }finally{await page.close();}
 });

 await t.test('按坐标点击：结果带落点上的元素，点到空白一眼看得出；按 ref 点不带',async()=>{
  const {page,call}=await h.open();
  try{
   const blank=await page.$eval('#blank',e=>{const r=e.getBoundingClientRect();return {x:Math.round(r.x+20),y:Math.round(r.y+20)};});
   const missed=await call('chrome_action',{action:'click',...blank,observe:false});
   assert.equal(missed.hit.selector,'div#blank');assert.equal(missed.hit.text,undefined);assert.equal(missed.hit.name,undefined);
   const save=await page.$eval('#save',e=>{const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};});
   const hit=await call('chrome_action',{action:'click',...save,observe:false});
   assert.equal(hit.hit.role,'button');assert.equal(hit.hit.name,'保存');assert.equal(await page.evaluate(()=>(window as any).__saved),true);
   assert.equal((await call('chrome_action',{action:'click',selector:'#save',observe:false})).hit,undefined);
  }finally{await page.close();}
 });
});
