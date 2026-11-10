import test from 'node:test';
import assert from 'node:assert/strict';
import {interactionHarness} from './interaction-harness.js';

// 在视频平台创作者后台发片时的反馈，用真 Chrome 复现能复现的几条。
// 话题候选是挂在 body 下的绝对定位浮层，编辑器里已经有同名的话题；封面弹窗关掉后页面上还留着另一个 role=dialog。
const html=`<!doctype html><meta charset="utf-8"><title>发布</title>
<style>body{margin:0;font:14px sans-serif}input{position:absolute;left:20px;width:200px;font:14px monospace}</style>
<input id="when" value="2026-11-04 00:05" style="top:20px">
<input id="long" value="abcdefghijklmnopqrstuvwxyz0123456789" style="top:60px">
<div contenteditable id="editor" style="position:absolute;left:20px;top:100px;width:240px;height:60px;border:1px solid #ccc"><span>#识字启蒙</span> 正文</div>
<div id="topics" style="position:absolute;z-index:10;left:300px;top:100px;width:200px;background:#eee"><span>#识字启蒙</span><br><span>#识字启蒙游戏</span></div>
<div role="dialog" id="cover" aria-label="设置封面" style="position:fixed;left:300px;top:300px;width:200px;height:80px;background:#fff;border:1px solid #999"><button>完成</button></div>
<div role="dialog" id="other" style="position:absolute;left:20px;top:420px">别的面板</div>
<div style="height:3000px"></div>`;
const size=(png:string)=>{const bytes=Buffer.from(png,'base64');return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};};

test('发布反馈：全选后打字替换、只读脚本的顶层声明、按 ref 等弹窗消失、find 标出弹层、截图的视口坐标和缩放',{timeout:180000},async t=>{
 const h=await interactionHarness(t,html);

 await t.test('像真人一样操作时：press Ctrl+A 后 type 替换选中的内容；点进来的字段照旧接在末尾',async()=>{
  const {page,call}=await h.open();
  try{
   await call('chrome_action',{action:'press',selector:'#when',key:'a',modifiers:2,observe:false});
   assert.deepEqual(await page.$eval('#when',e=>[(e as HTMLInputElement).selectionStart,(e as HTMLInputElement).selectionEnd]),[0,16]);
   await call('chrome_action',{action:'type',selector:'#when',text:'2026-11-05 18:00',observe:false});
   assert.equal(await page.$eval('#when',e=>(e as HTMLInputElement).value),'2026-11-05 18:00');
   // 字段没焦点：先用鼠标点进去，光标落在点击处，按 End 后接在末尾。
   await call('chrome_action',{action:'type',selector:'#long',text:'!',observe:false});
   assert.equal(await page.$eval('#long',e=>(e as HTMLInputElement).value),'abcdefghijklmnopqrstuvwxyz0123456789!');
  }finally{await page.close();}
 });

 await t.test('只读脚本：顶层 const/let 自动包进大括号再试；var 照旧拦下并说明；不带 readOnly 时顶层声明照常建全局变量',async()=>{
  const {page,call,raw}=await h.open();
  try{
   assert.equal(await call('chrome_evaluate',{expression:"const v=document.querySelector('#when')?.value;\nlet n=v.length; JSON.stringify({v,n})",readOnly:true}),'{"v":"2026-11-04 00:05","n":16}');
   assert.equal(await page.evaluate(()=>typeof (window as any).v),'undefined','只读执行没有留下全局变量');
   setTimeout(()=>{void page.evaluate(()=>{document.title='发布完成';});},300);
   assert.equal((await call('chrome_wait',{expression:"const t=document.title; t==='发布完成'",readOnly:true,timeoutMs:3000})).matched,true,'带顶层 const 的只读等待照样轮询到成立');
   const blocked=await raw('chrome_evaluate',{expression:"var w=document.title; w",readOnly:true});
   assert.equal(blocked.error?.code,'SIDE_EFFECT_BLOCKED');assert.match(blocked.error!.message,/顶层的 var/);
   assert.equal(await call('chrome_evaluate',{expression:'const shared=5; shared'}),5);
   assert.equal(await call('chrome_evaluate',{expression:'shared+1',readOnly:true}),6,'普通执行的顶层 const 留在页面里');
  }finally{await page.close();}
 });

 await t.test('等待：按 ref 等弹窗消失，被移除就算；按角色等超时时列出还看得见的那个；不认识的 ref 照旧报失效',async()=>{
  const {page,call,raw}=await h.open();
  try{
   const dialogs=(await call('chrome_find',{locator:{role:'dialog'}})).elements,cover=dialogs.find((e:any)=>e.name==='设置封面');
   setTimeout(()=>{void page.evaluate(()=>document.querySelector('#cover')!.remove());},300);
   assert.equal((await call('chrome_wait',{ref:cover.ref,state:'hidden',timeoutMs:3000})).matched,true);
   const missed=await raw('chrome_wait',{locator:{role:'dialog'},state:'hidden',timeoutMs:400});
   assert.equal(missed.error?.code,'WAIT_TIMEOUT');assert.match(missed.error!.message,/还看得见：\[dialog\] ref \S+，要等其中一个消失就按它的 ref 等/);
   const other=dialogs.find((e:any)=>e.name!=='设置封面');
   assert.deepEqual((missed.error as any).detail.stillVisible,[{ref:other.ref,role:'dialog'}]);
   assert.equal((await raw('chrome_wait',{ref:'nope:1',state:'hidden',timeoutMs:300})).error?.code,'STALE_ELEMENT_REF');
  }finally{await page.close();}
 });

 await t.test('find：浮层里的话题候选标 layer:overlay，编辑器里的同名文字不标；弹窗里的按钮带所在弹窗',async()=>{
  const {page,call}=await h.open();
  try{
   const topics=(await call('chrome_find',{locator:{text:'#识字启蒙',exact:true}})).elements;
   assert.equal(topics.length,2);
   assert.deepEqual(topics.map((e:any)=>e.layer??null),[null,'overlay'],JSON.stringify(topics));
   const done=(await call('chrome_find',{locator:{role:'button',name:'完成'}})).elements[0];
   assert.equal(done.within.role,'dialog');assert.equal(done.within.name,'设置封面');assert.ok(done.within.ref);
   assert.equal(done.layer,undefined,'有角色的弹层只写 within');
  }finally{await page.close();}
 });

 await t.test('截图：clipViewport 按视口坐标截，滚动后 area 是页面坐标；scale 缩小图片并写进 coordinates',async()=>{
  const {page,raw}=await h.open();
  try{
   await page.evaluate(()=>scrollTo(0,500));
   const clipped=await raw('chrome_screenshot',{clip:{x:300,y:300,width:100,height:50},clipViewport:true});
   assert.equal(clipped.ok,true,JSON.stringify(clipped.error));
   assert.deepEqual((clipped.data as any).coordinates.area,{x:300,y:800,width:100,height:50});
   assert.deepEqual(size((clipped as any).image.data),{width:100,height:50});
   const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
   const small=await raw('chrome_screenshot',{scale:0.5});
   assert.equal(small.ok,true,JSON.stringify(small.error));
   assert.equal((small.data as any).coordinates.scale,0.5);assert.match((small.data as any).coordinates.note,/÷ 0\.5/);
   const image=size((small as any).image.data);
   assert.ok(Math.abs(image.width-viewport.width/2)<=1&&Math.abs(image.height-viewport.height/2)<=1,`${JSON.stringify(image)} 对 ${JSON.stringify(viewport)}`);
  }finally{await page.close();}
 });
});
