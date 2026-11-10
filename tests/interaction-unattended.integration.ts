import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {interactionHarness} from './interaction-harness.js';

// 夜间无人值守跑视频平台创作者后台时踩到的页面问题（0.3.0-beta.18），用真 Chrome 复现。
// 下拉框用 1000 秒延迟、backwards 填充的淡入动画：页面一直停在 opacity:0 的第一帧，等同于后台标签页、窗口被挡住或锁屏时 Chrome 不出帧。
// 旧版把这样的选项当成看不见，按文字找只剩外层容器，点容器中心选中了中间那一项。
const html=`<!doctype html><meta charset="utf-8"><title>创作者后台</title>
<style>
@keyframes fade{from{opacity:0}to{opacity:1}}
body{margin:0;font:14px sans-serif}
#trigger{display:inline-block;width:200px;height:30px;line-height:30px;border:1px solid #888;margin:10px}
#portal{position:absolute;top:50px;left:10px;width:200px;background:#fff;border:1px solid #888;animation:fade .2s 1000s backwards}
.opt{height:30px;line-height:30px;padding:0 8px}
#ghost{opacity:0}
.skin{position:relative;display:inline-block;padding:6px 12px;margin:4px}
.skin input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;z-index:1}
#agree-box{position:relative;display:inline-block;margin:4px}
#cover{position:absolute;inset:0;background:rgba(255,255,255,.9)}
#area{position:absolute;top:400px;left:10px}
</style>
<div id="trigger" role="combobox" aria-expanded="false" aria-label="分类" tabindex="0">请选择分类</div>
<div id="portal" hidden><div role="listbox" id="listbox"><div role="option" class="opt">生活</div><div role="option" class="opt">知识</div><div role="option" class="opt">游戏</div></div></div>
<div id="area">
<button id="ghost">幽灵按钮</button>
<div id="radios"><label class="skin"><input type="radio" name="g" value="a"><span>选项A</span></label><label class="skin"><input type="radio" name="g" value="b"><span>选项B</span></label></div>
<div id="agree-box"><label><input type="checkbox" id="agree"><span>同意协议</span></label><div id="cover">提示</div></div>
<section><button onclick="window.saved='1'">保存</button></section><section><button onclick="window.saved='2'">保存</button></section>
<div id="editor" contenteditable="true" aria-label="正文"></div>
<label class="upload">选择视频<input type="file" id="file" style="display:none"></label>
<button id="noop">无动静</button>
<div id="toolbar" style="display:flex;width:300px"><button style="flex:1">左</button><button style="flex:1" onclick="window.middle=1">中</button><button style="flex:1">右</button></div>
</div>
<script>
const trigger=document.querySelector('#trigger'),portal=document.querySelector('#portal');
trigger.onclick=()=>{portal.hidden=false;trigger.setAttribute('aria-expanded','true');};
for(const option of document.querySelectorAll('.opt'))option.onclick=()=>{trigger.textContent=option.textContent;window.chosen=option.textContent;portal.hidden=true;trigger.setAttribute('aria-expanded','false');};
</script>`;

test('无人值守需求：冻结的淡入下拉、容器点击、选下拉项、遮挡说明、等待、截图坐标、上传读回',async t=>{
 const h=await interactionHarness(t,html);
 await t.test('停在第一帧的下拉：find、inspect、点击对它的可见性一致；按文字找到的是选项本身；点容器被拦下',async()=>{
  const {page,call,raw}=await h.open();
  try{
   await call('chrome_action',{action:'click',selector:'#trigger'});
   assert.equal(await page.$eval('#portal',e=>getComputedStyle(e).opacity),'0','前提：动画停在 opacity:0');
   const found=await call('chrome_find',{locator:{text:'知识'}});
   assert.equal(found.totalElements,1);assert.equal(found.elements[0].role,'option','最贴近文字的那一层，不是外层容器');assert.equal(found.elements[0].visible,undefined,'看得见');
   assert.equal(found.elements[0].box[3],30);
   const list=await call('chrome_find',{locator:{role:'listbox'}});assert.equal(list.elements[0].controls,3,'容器带子控件数');
   const inspected=await call('chrome_inspect',{scopeSelector:'#listbox'});assert.equal(inspected.elements.filter((e:any)=>e.role==='option'&&e.visible===undefined).length,3);
   const container=await raw('chrome_action',{action:'click',selector:'#listbox'});
   assert.equal(container.error?.code,'CONTAINER_TARGET',JSON.stringify(container.error));assert.equal(container.error?.outcome,'not_dispatched');assert.match(container.error!.message,/3 项.*知识/);
   assert.equal(await page.evaluate(()=>(window as any).chosen),undefined,'没有误选中间那项');
   await call('chrome_action',{action:'click',ref:found.elements[0].ref});assert.equal(await page.evaluate(()=>(window as any).chosen),'知识');
   // 不是一组选项的容器照常点，结果写明落到了哪个子元素上。
   const toolbar=await call('chrome_action',{action:'click',selector:'#toolbar'});
   assert.equal(toolbar.landedOn?.name,'中',JSON.stringify(toolbar));assert.match(toolbar.note,/容器/);assert.equal(await page.evaluate(()=>(window as any).middle),1);
  }finally{await page.close();}
 });
 await t.test('choose：点开触发器、按文字选项、读回触发器上显示的值；选项不存在时说清楚已经点开了下拉',async()=>{
  const {page,call,raw}=await h.open();
  try{
   const chosen=await call('chrome_action',{action:'choose',locator:{role:'combobox',name:'分类'},option:'游戏'});
   assert.equal(chosen.chosen,'游戏');assert.equal(chosen.verified,true);assert.equal(await page.evaluate(()=>(window as any).chosen),'游戏');
   const missing=await raw('chrome_action',{action:'choose',selector:'#trigger',option:'美食'});
   assert.equal(missing.error?.code,'OPTION_NOT_FOUND',JSON.stringify(missing.error));assert.equal(missing.error?.outcome,'dispatched','下拉已经点开了，不暂停但也不该重复');
   assert.match(missing.error!.message,/生活/,'列出看得到的选项');
   assert.equal((await call('chrome_action',{action:'click',selector:'#noop'})).pageChange!==undefined,true,'标签页照常可写');
  }finally{await page.close();}
 });
 await t.test('看不见时说原因和最近一个看得见的祖先；label 里的透明 input 盖着文字时放行，别的东西挡着时提示 setChecked',async()=>{
  const {page,call,raw}=await h.open();
  try{
   const ghost=await raw('chrome_action',{action:'click',selector:'#ghost',autoWait:false});
   assert.equal(ghost.error?.code,'ELEMENT_NOT_VISIBLE');assert.match(ghost.error!.message,/透明度为 0/);assert.equal((ghost.error as any).detail?.reason,'transparent');assert.ok((ghost.error as any).detail?.nearestVisible?.ref,'带最近一个看得见的祖先');
   await call('chrome_action',{action:'click',locator:{text:'选项B'}});
   assert.equal(await page.evaluate(()=>document.querySelector<HTMLInputElement>('input[value=b]')!.checked),true,'点文字等于点同一个 label 里的单选框');
   const covered=await raw('chrome_action',{action:'click',locator:{text:'同意协议'},autoWait:false});
   assert.equal(covered.error?.code,'ELEMENT_OBSCURED');assert.match(covered.error!.message,/div#cover.*setChecked/);
   const agree=(await call('chrome_inspect',{scopeSelector:'#agree'})).elements[0];assert.match(covered.error!.message,new RegExp(agree.ref),'提示里给的是那个 input 的 ref');
  }finally{await page.close();}
 });
 await t.test('多个匹配：报错列出候选和 ref，nth 取第几个，scopeRef 指定范围；等待用 match:any/all',async()=>{
  const {page,call,raw}=await h.open();
  try{
   const ambiguous=await raw('chrome_action',{action:'click',locator:{role:'button',name:'保存'}});
   assert.equal(ambiguous.error?.code,'AMBIGUOUS_SELECTOR');assert.match(ambiguous.error!.message,/nth/);assert.equal((ambiguous.error as any).detail.candidates.length,2);
   await call('chrome_action',{action:'click',locator:{role:'button',name:'保存',nth:1}});assert.equal(await page.evaluate(()=>(window as any).saved),'2');
   const scope=await raw('chrome_inspect',{scopeSelector:'section'});assert.equal(scope.error?.code,'AMBIGUOUS_SCOPE');
   const first=(scope.error as any).detail.candidates[0].ref;
   const scoped=await call('chrome_find',{scopeRef:first,locator:{role:'button'}});assert.equal(scoped.totalElements,1);
   await call('chrome_action',{action:'click',ref:scoped.elements[0].ref});assert.equal(await page.evaluate(()=>(window as any).saved),'1');
   const plain=await raw('chrome_wait',{selector:'.opt',state:'hidden',timeoutMs:1000});assert.equal(plain.error?.code,'AMBIGUOUS_SELECTOR');
   assert.equal((await raw('chrome_wait',{selector:'.opt',state:'hidden',match:'all',timeoutMs:1000})).ok,true,'下拉关着，所有选项都看不见');
   await call('chrome_action',{action:'click',selector:'#trigger'});
   assert.equal((await raw('chrome_wait',{selector:'.opt',state:'visible',match:'all',timeoutMs:2000})).ok,true,'停在第一帧也算看得见');
   assert.equal((await raw('chrome_wait',{locator:{text:'知识'},state:'visible',match:'any',timeoutMs:2000})).ok,true);
  }finally{await page.close();}
 });
 await t.test('批次：page.wait 有自己的时限；后置条件没满足时动作结果交回、标签页照常可写',async()=>{
  const {page,call,raw}=await h.open();
  try{
   const started=Date.now();
   const waited=await raw('chrome_batch',{timeoutMs:30000,steps:[{operation:'page.wait',args:{selector:'#never',timeoutMs:400}}]});
   assert.ok(Date.now()-started<5000,'不等整批的 30 秒');assert.equal((waited.data as any).completed,false);assert.equal((waited.data as any).error.code,'WAIT_TIMEOUT');
   const checked=await raw('chrome_batch',{steps:[{operation:'page.action',args:{action:'click',selector:'#noop'},postcondition:{selector:'#never',timeoutMs:300}}]});
   const data=checked.data as any;
   assert.equal(data.completed,false);assert.equal(data.error.code,'POSTCONDITION_TIMEOUT');assert.equal(data.error.outcome,'dispatched');assert.match(data.error.message,/不要重复这一步/);
   assert.equal(data.failedStep.index,0);assert.ok(data.failedStep.result,'失败那一步的动作结果');
   assert.equal((await raw('chrome_action',{action:'click',selector:'#noop'})).ok,true,'没有暂停写入');
   assert.deepEqual(((await h.service.invoke('chrome_operations',{profileId:h.profile.id,state:'unknown'},'interaction-test')).data as any).items,[]);
  }finally{await page.close();}
 });
 await t.test('没写 role 的富文本编辑器按 textbox 找得到；只读脚本被拦时告诉怎么改写',async()=>{
  const {page,call,raw}=await h.open();
  try{
   const editor=await call('chrome_find',{locator:{role:'textbox',name:'正文'}});assert.equal(editor.totalElements,1);
   await call('chrome_action',{action:'fill',ref:editor.elements[0].ref,text:'今天的标题'});assert.equal(await page.$eval('#editor',e=>e.textContent),'今天的标题');
   const blocked=await raw('chrome_evaluate',{expression:"document.getElementById('editor').textContent",readOnly:true});
   assert.equal(blocked.error?.code,'SIDE_EFFECT_BLOCKED');assert.match(blocked.error!.message,/querySelector/);
   assert.equal(await call('chrome_evaluate',{expression:"document.querySelector('#editor').textContent",readOnly:true}),'今天的标题','照建议改写后能过');
  }finally{await page.close();}
 });
 await t.test('隐藏的文件框上传后能读回文件名和大小',async()=>{
  const {page,call}=await h.open();
  const directory=path.join(h.config.dataDir,'..',path.basename(h.config.dataDir)+'-channels'),video=path.join(directory,'第3集.mp4');
  try{
   await mkdir(directory,{recursive:true});await writeFile(video,'0123456789');
   await call('chrome_upload',{selector:'#file',paths:[video]});
   const read=await call('chrome_inspect',{scopeSelector:'#file'});
   const input=read.elements.find((e:any)=>e.fileNames);assert.ok(input,'范围本身是隐藏的文件框也列出');assert.deepEqual(input.fileNames,['第3集.mp4']);assert.deepEqual(input.fileSizes,[10]);
  }finally{await page.close();await rm(directory,{recursive:true,force:true});}
 });
});

// 截图要在设备像素比不是 1 的 Chrome 上看：--force-device-scale-factor 等同于 Windows 的显示缩放。
test('截图按 CSS 像素出图，带坐标说明：图片坐标就是点击坐标',async t=>{
 const h=await interactionHarness(t,html,{chromeArgs:['--force-device-scale-factor=2']});
 const {page,raw}=await h.open();
 try{
  await page.setViewport(null);// 测试 Chrome 默认按 800×600、像素比 1 模拟视口，去掉模拟才是真的像素比
  const view=await page.evaluate(()=>({dpr:devicePixelRatio,width:document.documentElement.clientWidth}));assert.equal(view.dpr,2,'前提：设备像素比 2');
  const shot=await raw('chrome_screenshot',{});assert.equal(shot.ok,true,JSON.stringify(shot.error));
  assert.equal(Buffer.from((shot as any).image.data,'base64').readUInt32BE(16),view.width,'宽是 CSS 像素，不是两倍的设备像素');
  const coordinates=(shot.data as any).coordinates;assert.equal(coordinates.cssPixels,true);assert.equal(coordinates.viewport,true);assert.match(coordinates.note,/chrome_action 的 x\/y/);
  await page.evaluate(()=>scrollTo(0,40));
  const element=await raw('chrome_screenshot',{selector:'#trigger'});assert.equal(element.ok,true,JSON.stringify(element.error));
  const box=await page.$eval('#trigger',e=>{const r=e.getBoundingClientRect();return {x:r.left+scrollX,width:r.width};});
  assert.equal((element.data as any).coordinates.area.x,Math.round(box.x));assert.equal(Buffer.from((element as any).image.data,'base64').readUInt32BE(16),Math.round(box.width));
  assert.equal((element.data as any).coordinates.viewport,undefined);assert.match((element.data as any).coordinates.note,/toViewport/);
 }finally{await page.close();}
});
