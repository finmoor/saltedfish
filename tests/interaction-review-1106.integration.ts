import test from 'node:test';
import assert from 'node:assert/strict';
import {interactionHarness} from './interaction-harness.js';

// 2026-11-06 全局评审 U22、U23 的真 Chrome 用例。
// U22：页面上另有一个开着的下拉（role=option），里面也有「游戏」；这个触发器点开的弹层里选项是不带角色的 div。
// 旧版按“带角色 2 分、新出现 1 分”打分，会点到别的下拉里的那项；现在只认点开后才出现的。
// U23：对原生 <select> 用 choose，点开之前就拒绝，指向 action:"select"。
const html=`<!doctype html><meta charset="utf-8"><title>评审</title>
<style>
.trigger{display:inline-block;width:200px;height:30px;line-height:30px;border:1px solid #888;margin:10px}
#portal{position:absolute;top:60px;left:260px;width:200px;background:#fff;border:1px solid #888}
#other-list{position:absolute;top:60px;left:10px;width:200px;background:#fff;border:1px solid #888}
.opt{height:30px;line-height:30px;padding:0 8px}
</style>
<div id="other" class="trigger" role="combobox" aria-expanded="true" aria-label="别的下拉" tabindex="0">别的</div>
<div id="trigger" class="trigger" role="combobox" aria-expanded="false" aria-label="分类" tabindex="0">请选择分类</div>
<div id="other-list" role="listbox"><div role="option" class="opt other-opt">生活</div><div role="option" class="opt other-opt">游戏</div></div>
<div id="portal" hidden><div><div class="opt mine">知识</div><div class="opt mine">游戏</div></div></div>
<select id="native"><option>生活</option><option>游戏</option></select>
<button id="noop">没反应</button>
<script>
window.clicks=[];window.changes=0;
const trigger=document.querySelector('#trigger'),portal=document.querySelector('#portal');
trigger.onclick=()=>{portal.hidden=false;trigger.setAttribute('aria-expanded','true');};
for(const option of document.querySelectorAll('.mine'))option.onclick=()=>{trigger.textContent=option.textContent;window.clicks.push('mine:'+option.textContent);portal.hidden=true;trigger.setAttribute('aria-expanded','false');};
for(const option of document.querySelectorAll('.other-opt'))option.onclick=()=>window.clicks.push('other:'+option.textContent);
const native=document.querySelector('#native');native.onchange=()=>window.changes++;native.onmousedown=()=>window.clicks.push('native');
</script>`;

test('全局评审 U22、U23：choose 不选别的下拉里的同名项；原生 select 点开前就拒绝',{timeout:180000},async t=>{
 const h=await interactionHarness(t,html);

 await t.test('U22：别的下拉开着、也有「游戏」，这个下拉的选项不带角色，只选这个触发器点开后出现的那个',async()=>{
  const {page,call}=await h.open();
  try{
   const chosen=await call('chrome_action',{action:'choose',selector:'#trigger',option:'游戏'});
   assert.equal(chosen.chosen,'游戏');assert.equal(chosen.verified,true);
   assert.deepEqual(await page.evaluate(()=>(window as any).clicks),['mine:游戏'],'没点到别的下拉');
  }finally{await page.close();}
 });

 await t.test('U23：原生 select 用 choose 直接拒绝，没点开、没改值，标签页照常可写',async()=>{
  const {page,call,raw}=await h.open();
  try{
   const refused=await raw('chrome_action',{action:'choose',selector:'#native',option:'游戏'});
   assert.equal(refused.error?.code,'NOT_CUSTOM_DROPDOWN',JSON.stringify(refused.error));
   assert.equal(refused.error?.outcome,'not_dispatched');
   assert.match(refused.error!.message,/action:"select"/);
   assert.deepEqual(await page.evaluate(()=>[(window as any).clicks,(window as any).changes,(document.querySelector('#native') as HTMLSelectElement).value]),[[],0,'生活']);
   assert.equal((await call('chrome_action',{action:'click',selector:'#noop'})).pageChange!==undefined,true,'没有暂停写入');
   await call('chrome_action',{action:'select',selector:'#native',values:['游戏']});
   assert.equal(await page.evaluate(()=>(document.querySelector('#native') as HTMLSelectElement).value),'游戏');
  }finally{await page.close();}
 });
});
