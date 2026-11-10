import test from 'node:test';
import assert from 'node:assert/strict';
import {interactionHarness} from './interaction-harness.js';
import {TYPE_LIMIT} from '../extension/human-input.js';

// 像真人一样操作（扩展设置，默认开）在真实 Chrome 里页面这一侧看到什么：连续的鼠标轨迹、按下有 pressure、按住有时长、
// 先点进输入框再键盘全选、逐键打字、滚轮一格一格。只核对页面能观察到的事件，数值范围宽松，不依赖具体随机数。
const html=`<!doctype html><meta charset="utf-8"><style>html,body{height:100%}body{margin:0}#go{position:absolute;left:420px;top:160px;width:160px;height:48px}#field{position:absolute;left:120px;top:300px;width:260px;height:30px}
#src,#dst{position:absolute;width:60px;height:60px;background:#ddd}#src{left:80px;top:420px}#dst{left:520px;top:440px}#list{position:absolute;left:640px;top:260px;width:220px;height:200px;overflow:auto}#list div{height:2000px}</style>
<button id="go">Go</button><input id="field" aria-label="Field" value="old value"><div id="src"></div><div id="dst"></div><div id="list"><div></div></div><script>
window.log=[];
const rec=(e,extra)=>log.push(Object.assign({type:e.type,t:e.timeStamp,trusted:e.isTrusted,target:e.target.id||e.target.nodeName},extra));
for(const type of ['pointermove','pointerdown','pointerup'])addEventListener(type,e=>rec(e,{x:e.clientX,y:e.clientY,mx:e.movementX,my:e.movementY,pressure:e.pressure,buttons:e.buttons}),true);
for(const type of ['mousedown','click','focus'])addEventListener(type,e=>rec(e,{}),true);
for(const type of ['keydown','keyup'])addEventListener(type,e=>rec(e,{key:e.key,shift:e.shiftKey,ctrl:e.ctrlKey}),true);
addEventListener('input',e=>rec(e,{inputType:e.inputType,data:e.data}),true);
addEventListener('wheel',e=>rec(e,{dy:e.deltaY,dx:e.deltaX}),{capture:true,passive:true});
</script>`;
type Logged={type:string;t:number;trusted:boolean;target:string;[key:string]:any};

test('像真人一样操作：页面看到连续轨迹、按下有压力和时长、先点进字段再逐键打、滚轮分格',async t=>{
 const h=await interactionHarness(t,html);
 await h.humanInput(true);
 const {page,call}=await h.open();
 const log=async()=>await page.evaluate(()=>(window as any).log.splice(0)) as Logged[];
 const dpr=await page.evaluate(()=>devicePixelRatio),onGrid=(value:number)=>Math.abs(value*dpr-Math.round(value*dpr))<1e-3;
 const rect=(selector:string)=>page.$eval(selector,element=>{const r=element.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom};});

 await t.test('点击',async()=>{
  const clicked=await call('chrome_action',{action:'click',selector:'#go',observe:false});
  const events=await log(),moves=events.filter(e=>e.type==='pointermove'),down=events.find(e=>e.type==='pointerdown')!,up=events.find(e=>e.type==='pointerup')!;
  assert.ok(events.length&&events.every(e=>e.trusted),'都是可信事件');
  assert.ok(moves.length>=5,`按下前有一串移动，实际 ${moves.length}`);
  for(const move of moves.slice(1))assert.ok(Math.abs(move.mx)<=120&&Math.abs(move.my)<=120,`没有一步跳过去：${move.mx},${move.my}`);
  for(const move of moves)assert.ok(onGrid(move.x)&&onGrid(move.y),`坐标对齐设备像素：${move.x},${move.y}`);
  assert.equal(down.pressure,.5);assert.equal(up.pressure,0);
  assert.ok(down.t-moves.at(-1)!.t>=50,`停到按下 ${(down.t-moves.at(-1)!.t).toFixed(1)}ms`);
  assert.ok(up.t-down.t>=40,`按住 ${(up.t-down.t).toFixed(1)}ms`);
  const box=await rect('#go');assert.ok(down.x>box.left&&down.x<box.right&&down.y>box.top&&down.y<box.bottom);
  assert.deepEqual([clicked.x,clicked.y],[down.x,down.y]);
  assert.equal(events.filter(e=>e.type==='click').length,1);
 });

 await t.test('fill：先点进字段，Ctrl+A 全选，逐键打，大写和符号前按 Shift',async()=>{
  const text='Hello, World!';
  const result=await call('chrome_action',{action:'fill',selector:'#field',text,observe:false});
  assert.equal(result.verified,true);assert.equal(await page.$eval('#field',e=>(e as HTMLInputElement).value),text);
  const events=await log(),keys=events.filter(e=>e.type==='keydown');
  assert.ok(events.every(e=>e.trusted),'都是可信事件');
  const mousedown=events.findIndex(e=>e.type==='mousedown'&&e.target==='field'),focus=events.findIndex(e=>e.type==='focus'&&e.target==='field');
  assert.ok(mousedown>=0&&focus>mousedown,'焦点来自鼠标按下');
  assert.deepEqual(keys.slice(0,2).map(e=>[e.key,e.ctrl]),[['Control',true],['a',true]],'Ctrl+A 全选');
  const inputs=events.filter(e=>e.type==='input');
  assert.equal(inputs.length,text.length);assert.ok(inputs.every(e=>e.inputType==='insertText'&&e.data.length===1));
  const shifted=keys.filter(e=>e.key==='H'||e.key==='W'||e.key==='!');
  assert.ok(shifted.every(e=>e.shift));
  for(const key of ['H','W','!']){const index=keys.findIndex(e=>e.key===key);assert.equal(keys[index-1]!.key,'Shift',`${key} 之前按下了 Shift`);}
  const chars=keys.filter(e=>!['Shift','Control','a'].includes(e.key)||e.key==='a'&&!e.ctrl);
  const gaps=chars.slice(1).map((e,i)=>e.t-chars[i]!.t);
  assert.ok(gaps.every(gap=>gap>=40),`字符之间至少几十毫秒：${gaps.map(gap=>gap.toFixed(0)).join(',')}`);
  assert.ok(new Set(gaps.map(gap=>Math.round(gap/10))).size>=4,'间隔不是固定的');
 });

 await t.test(`fill：超过 ${TYPE_LIMIT} 个字符整段插入`,async()=>{
  const text='x'.repeat(TYPE_LIMIT+16);
  await call('chrome_action',{action:'fill',selector:'#field',text,observe:false});
  const inputs=(await log()).filter(e=>e.type==='input');
  assert.deepEqual(inputs.map(e=>[e.inputType,e.data?.length]),[['insertText',text.length]]);
 });

 await t.test('press Ctrl+Z：页面先看到 Control 按下',async()=>{
  await call('chrome_action',{action:'press',selector:'#field',key:'z',modifiers:2,observe:false});
  const keys=(await log()).filter(e=>e.type==='keydown'||e.type==='keyup').map(e=>`${e.type}:${e.key}`);
  assert.deepEqual(keys,['keydown:Control','keydown:z','keyup:z','keyup:Control']);
 });

 await t.test('拖拽：按住时每一步 pressure 0.5、buttons 1，步数够多',async()=>{
  const result=await call('chrome_action',{action:'drag',selector:'#src',to:{selector:'#dst'},observe:false});
  assert.equal(result.dragged,true);
  const events=await log(),down=events.findIndex(e=>e.type==='pointerdown'),up=events.findIndex(e=>e.type==='pointerup');
  const held=events.slice(down+1,up).filter(e=>e.type==='pointermove');
  assert.equal(events[down]!.pressure,.5);
  assert.ok(held.length>=8,`拖动 ${held.length} 步`);
  assert.ok(held.every(e=>e.pressure===.5&&e.buttons===1));
  const box=await rect('#dst'),end=events[up]!;assert.ok(end.x>box.left&&end.x<box.right&&end.y>box.top&&end.y<box.bottom);
 });

 await t.test('滚动：鼠标先移过去，600 拆成 6 格',async()=>{
  await call('chrome_action',{action:'scroll',selector:'#list',observe:false});
  const events=await log(),wheels=events.filter(e=>e.type==='wheel');
  assert.deepEqual(wheels.map(e=>e.dy),[100,100,100,100,100,100]);
  assert.ok(events.findIndex(e=>e.type==='pointermove')<events.findIndex(e=>e.type==='wheel'));
  assert.ok(wheels.slice(1).every((e,i)=>e.t-wheels[i]!.t>=20),'格间有停顿');
  // 滚轮在 Chrome 里是平滑滚动，最后一格的动画要再等一会儿。
  await page.waitForFunction(()=>document.querySelector('#list')!.scrollTop===600,{timeout:3000});
 });

 await t.test('关掉开关：一步移到目标立即按下，按下仍带 pressure',async()=>{
  await h.humanInput(false);
  try{
   await call('chrome_action',{action:'click',selector:'#go',observe:false});
   const events=await log(),moves=events.filter(e=>e.type==='pointermove'),down=events.find(e=>e.type==='pointerdown')!;
   assert.ok(moves.length<=1);assert.equal(down.pressure,.5);
  }finally{await h.humanInput(true);}
 });
});
