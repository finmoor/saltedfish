import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {adminPrincipal} from '../src/auth.js';
import {interactionHarness} from './interaction-harness.js';

// 11-26 在一个服务端驱动的 ERP 上用了两周半后的反馈，用真 Chrome 复现。
// 开关：按下就切换，滑块随之滑到另一头；输入框聚焦后变宽；有个按钮一按下就盖上全屏遮罩。
// 弹框：点“退出”冒出页面自己的确认层，点“确定”后页面先发请求、几百毫秒后才跳走，这时才问“确定离开吗”；弹出窗口里的“关闭”调 window.close()。
const html=`<!doctype html><meta charset="utf-8"><title>反馈 1126</title>
<style>body{margin:0;font:14px sans-serif}button{display:block;margin:6px 10px}
.switch{position:relative;width:60px;height:24px;margin:6px 10px;background:#ccc;border-radius:12px}
.switch-handle{position:absolute;left:2px;top:2px;width:20px;height:20px;background:#fff;border-radius:10px}
.switch.open .switch-handle{left:38px}
#grow{width:100px;margin:6px 10px}#grow:focus{width:320px;padding:6px}
#mask{position:fixed;inset:0;background:rgba(0,0,0,.2)}
.toggle{display:inline-block;margin:6px 10px;padding:2px 8px;background:#eee}.busy{position:fixed;inset:0}
#modal{position:fixed;inset:0;background:rgba(0,0,0,.3)}#modal .box{position:absolute;left:30%;top:30%;background:#fff;padding:10px}.kd-btn{cursor:pointer;margin-top:6px;color:#06c}
#loading{position:fixed;inset:0;background:rgba(255,255,255,.4)}
#grid{width:300px;height:120px;overflow:auto;margin:6px 10px;border:1px solid #888}
.kgrid{margin:6px 10px}.kgrid table{border-collapse:collapse;table-layout:fixed;width:300px}.kgrid td{width:100px;height:20px;border:1px solid #ccc}#grid .inner{width:3000px;height:600px;background:linear-gradient(90deg,#eee,#ccc)}</style>
<button id="touch" onclick="window.touched=(window.touched||0)+1">碰一下</button>
<button id="exit" onclick="document.querySelector('#confirm').hidden=false">退出</button>
<div id="confirm" hidden><button id="ok" onclick="setTimeout(()=>{location.href='/left'},400)">确定</button></div>
<button id="nav" onclick="location.href='/next'">下一页</button>
<button id="popup" onclick="window.open('/popup','_blank')">打开新窗口</button>
<button id="closewin" onclick="window.close()">关闭窗口</button>
<div class="switch" id="sw" role="switch" aria-label="是否采用" onmousedown="this.classList.toggle('open');window.toggles=(window.toggles||0)+1"><div class="switch-handle"></div></div>
<input id="grow" placeholder="编码">
<button id="overlaid" onmousedown="document.querySelector('#mask').hidden=false">按下就盖住</button>
<div id="mask" hidden></div>
<div class="toggle" id="tg" onclick="this.classList.toggle('switch-open')">是否采用</div>
<button id="save" onclick="save()">保存</button>
<button id="behind" onclick="window.behindClicks=(window.behindClicks||0)+1">被挡的按钮</button>
<div id="modal" hidden><div class="box">正在 PC 端编辑<div class="kd-btn">我知道了</div></div></div>
<div id="loading" hidden></div>
<div id="grid"><div class="inner"></div></div>
<input id="code" autocomplete="new-password" value="MXYS-001" aria-label="编码">
<input id="pwd" type="password" value="secret" aria-label="登录密码">
<div class="kgrid">
 <table class="head"><tr><td>编码</td><td>名称</td><td>是否采用</td></tr></table>
 <table class="body">
  <tr data-rowindex="0"><td data-code="number">MX-001</td><td data-code="name">螺丝</td><td data-code="enable" onclick="this.classList.toggle('on')">否</td></tr>
  <tr data-rowindex="1"><td data-code="number">MX-002</td><td data-code="name">螺母</td><td data-code="enable" onclick="this.classList.toggle('on')">否</td></tr>
 </table>
</div>
<script>
// 模态框的按钮没写 role，也没有 onclick 属性，监听是脚本挂的；只有手形鼠标看得出能点。
document.querySelector('.kd-btn').addEventListener('click',()=>{document.querySelector('#modal').hidden=true;});
// 服务端驱动的保存：先盖一层没有文字的遮罩，1.2 秒后请求回来，撤掉遮罩、出“保存成功”，1.5 秒后提示消失。
function save(){const busy=document.createElement('div');busy.className='busy';document.body.append(busy);
 setTimeout(()=>{busy.remove();const toast=document.createElement('div');toast.className='toast';toast.textContent='保存成功';document.body.append(toast);setTimeout(()=>toast.remove(),1500);},1200);}
</script>`;

// 页面挂上“确定离开吗”：Chrome 只在页面有过用户操作后才问，所以先点一下。
async function guard(page:any,call:(name:string,args?:any)=>Promise<any>){
 await page.evaluate(()=>{window.onbeforeunload=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};});
 await call('chrome_action',{action:'click',selector:'#touch',observe:false});
}
async function until(check:()=>Promise<boolean>|boolean,ms=10000,what='条件'){
 for(const end=Date.now()+ms;Date.now()<end;){if(await check())return;await new Promise(r=>setTimeout(r,50));}
 assert.fail(`${ms}ms 内没等到：${what}`);
}

test('11-26 反馈',{timeout:400000},async t=>{
 const h=await interactionHarness(t,html);
 const dialogOpened=(tabId:number)=>h.service.broker.events(h.profile.id,tabId,0).events.some(event=>event.method==='Page.javascriptDialogOpening');

 await t.test('按住期间：开关按下就切换、滑块滑走，照常松开报 clicked；输入框聚焦后变宽，fill 照常；按下时盖上遮罩才取消，报 dispatched、标签页照常可写',async()=>{
  const {page,call,raw}=await h.open();
  try{
   const clicked=await call('chrome_action',{action:'click',selector:'.switch-handle'});
   assert.equal(clicked.clicked,true,JSON.stringify(clicked));
   assert.equal(await page.evaluate(()=>(window as any).toggles),1,'只切换了一次');assert.equal(await page.$eval('#sw',e=>e.classList.contains('open')),true);
   assert.ok(clicked.pageChange?.updated?.some((item:any)=>item.class==='+open'),`开关的 class 变化写进结果：${JSON.stringify(clicked.pageChange)}`);
   await call('chrome_action',{action:'fill',selector:'#grow',text:'MXYS-001'});
   assert.equal(await page.$eval('#grow',e=>(e as HTMLInputElement).value),'MXYS-001');
   const covered=await raw('chrome_action',{action:'click',selector:'#overlaid'});
   assert.equal(covered.error?.code,'ELEMENT_MOVED',JSON.stringify(covered));assert.equal(covered.error?.outcome,'dispatched');
   assert.match(covered.error!.message,/已按下.*#mask/);
   // dispatched 不暂停写入：遮罩撤掉后，紧接着的写操作照常执行，不用 recover_tab。
   await page.evaluate(()=>{(document.querySelector('#mask') as HTMLElement).hidden=true;});
   await call('chrome_action',{action:'click',selector:'#touch',observe:false});
  }finally{await page.close();}
 });

 await t.test('页面变化：只改 class 的开关报出 class 变化；保存先出遮罩、1.2 秒后才出“保存成功”，点击结果接得住',async()=>{
  const {page,call}=await h.open();
  try{
   const toggled=await call('chrome_action',{action:'click',selector:'#tg'});
   assert.equal(toggled.pageChange?.changed,true,JSON.stringify(toggled.pageChange));
   assert.ok(toggled.pageChange.updated?.some((item:any)=>item.class==='+switch-open'),JSON.stringify(toggled.pageChange));
   const saved=await call('chrome_action',{action:'click',selector:'#save'});
   assert.ok(saved.pageChange?.added?.includes('保存成功'),JSON.stringify(saved.pageChange));
   await new Promise(r=>setTimeout(r,1800));// 提示已经消失，留给下一个子用例一个干净的页面
  }finally{await page.close();}
 });

 await t.test('页面自己开的新标签页：动作结果带 openedTabs，进本会话的组，Chrome 的 opener 指错了也不用 claim 就能写，wait_tab 也认得出',async()=>{
  const sessionId=randomUUID(),owner=`admin:mcp:${sessionId}`;
  h.service.presence.heartbeat(adminPrincipal,{sessionId,owner,clientInfo:{name:'test-client',version:'1.0'}});
  const call=async(name:string,args:any={})=>{const result=await h.service.invoke(name,{profileId:h.profile.id,...args},owner);assert.ok(result.ok,`${name}: ${JSON.stringify(result.error||result.data)}`);return result.data as any;};
  const chrome=<T>(script:string,...values:unknown[])=>h.worker.evaluate(new Function('...values',`return (async()=>{${script}})()`) as never,...(values as never[])) as Promise<T>;
  try{
   const user=await h.open();// 用户自己的标签页，在前台
   const opener=await call('chrome_new_tab',{url:`http://127.0.0.1:${h.port}/opener`});// 默认后台打开，进本会话的组
   await call('chrome_wait',{tabId:opener.tabId,expression:'document.readyState==="complete"'});
   const before=((await h.service.invoke('chrome_tabs',{profileId:h.profile.id},owner)).data as any).items.map((item:any)=>item.tabId);
   const clicked=await call('chrome_action',{tabId:opener.tabId,action:'click',selector:'#popup'});
   assert.equal(clicked.openedTabs?.length,1,JSON.stringify(clicked));const opened=clicked.openedTabs[0].tabId;
   assert.match(clicked.openedTabs[0].url,/\/popup$/);
   // Chrome 从后台标签页打开时把 opener 填成用户当时的标签页，之后还可能清掉：这里直接改成用户的标签页。
   await chrome('await chrome.tabs.update(values[0],{openerTabId:values[1]})',opened,user.target.tabId);
   for(let i=0;i<50&&(await chrome<any>('return chrome.tabs.get(values[0])',opened)).groupId!==(await chrome<any>('return chrome.tabs.get(values[0])',opener.tabId)).groupId;i++)await new Promise(r=>setTimeout(r,100));
   assert.equal((await chrome<any>('return chrome.tabs.get(values[0])',opened)).groupId,(await chrome<any>('return chrome.tabs.get(values[0])',opener.tabId)).groupId,'移进了本会话的组');
   await call('chrome_evaluate',{tabId:opened,expression:'1+1'});
   const waited=await call('chrome_wait_tab',{openerTabId:opener.tabId,excludeTabIds:before,timeoutMs:5000});
   assert.equal(waited.tabId,opened);
   for(const tabId of [opened,opener.tabId])await call('chrome_close_tab',{tabId});
   await user.page.close();
  }finally{h.service.presence.remove(adminPrincipal,{sessionId,owner});}
 });

 await t.test('被弹层挡住：带按钮的模态框 2.5 秒不变就报错并带上“我知道了”的 ref；没有按钮的加载遮罩照旧等它消失',async()=>{
  const {page,call,raw}=await h.open();
  try{
   await page.evaluate(()=>{(document.querySelector('#modal') as HTMLElement).hidden=false;});
   const started=Date.now();
   const blocked=await raw('chrome_action',{action:'click',selector:'#behind',timeoutMs:10000});
   assert.equal(blocked.error?.code,'ELEMENT_OBSCURED',JSON.stringify(blocked.error));assert.equal(blocked.error?.outcome,'not_dispatched');
   assert.ok(Date.now()-started<6000,`没有等满 10 秒：${Date.now()-started}ms`);
   const button=(blocked.error as any).detail.cover.controls.find((item:any)=>item.name==='我知道了');
   assert.ok(button,JSON.stringify((blocked.error as any).detail));assert.match(blocked.error!.message,/我知道了」 ref/);
   await call('chrome_action',{action:'click',ref:button.ref,observe:false});
   await call('chrome_action',{action:'click',selector:'#behind',observe:false});
   assert.equal(await page.evaluate(()=>(window as any).behindClicks),1);
   // 加载遮罩：没有可点的东西，3.5 秒后自己消失；照旧等到它消失再点。
   await page.evaluate(()=>{const mask=document.querySelector('#loading') as HTMLElement;mask.hidden=false;setTimeout(()=>{mask.hidden=true;},3500);});
   await call('chrome_action',{action:'click',selector:'#behind',timeoutMs:10000,observe:false});
   assert.equal(await page.evaluate(()=>(window as any).behindClicks),2);
  }finally{await page.close();}
 });

 await t.test('后台标签页里横向滚 800px：不再每格等 1 秒，一格不丢',async()=>{
  const {page,call}=await h.open();
  const front=await h.browser.newPage();
  try{
   await front.bringToFront();// 用户在别的标签页上，Agent 的标签页在后台、不出帧
   const started=Date.now();
   await call('chrome_action',{action:'scroll',selector:'#grid',deltaX:800});
   assert.ok(Date.now()-started<3000,`后台滚动 ${Date.now()-started}ms`);
   // 滚轮的平滑滚动还要一百多毫秒才走完。
   await page.waitForFunction(()=>(document.querySelector('#grid') as HTMLElement).scrollLeft===800,{timeout:2000}).catch(()=>{});
   assert.equal(await page.$eval('#grid',e=>e.scrollLeft),800,'8 格都滚到了');
  }finally{await front.close();await page.close();}
 });

 await t.test('表格单元格和按坐标查：按行文字加列头找格子（表头和表体分成两张表）、只给列头读整列、行没渲染时说明；按坐标返回落点和往上几层',async()=>{
  const {page,call}=await h.open();
  try{
   const cell=await call('chrome_find',{cell:{row:'螺母',column:'名称'}});
   assert.equal(cell.totalElements,1,JSON.stringify(cell));assert.equal(await page.evaluate((ref:string)=>document.querySelectorAll('[data-code=name]')[1]!.textContent,cell.elements[0].ref),'螺母');
   assert.match(JSON.stringify(cell.elements[0]),/螺母/);
   const column=await call('chrome_find',{cell:{column:'编码'}});
   assert.deepEqual(column.elements.map((item:any)=>item.name||item.text),['MX-001','MX-002'],JSON.stringify(column));
   const missing=await call('chrome_find',{cell:{row:'MX-009',column:'名称'}});
   assert.equal(missing.totalElements,0);assert.match(missing.note,/虚拟滚动/);
   const toggle=await call('chrome_find',{cell:{row:'MX-001',column:'是否采用'}});
   await call('chrome_action',{action:'click',ref:toggle.elements[0].ref,observe:false});
   assert.equal(await page.evaluate(()=>document.querySelector('[data-rowindex="0"] [data-code=enable]')!.classList.contains('on')),true,'按格子的 ref 点中了那一格');
   const [x,y,width,height]=cell.elements[0].box;
   const at=await call('chrome_find',{at:{x:x+width/2,y:y+height/2}});
   assert.equal(at.elements[0].ref,cell.elements[0].ref,'落点上的就是那一格');
   assert.ok(at.elements.length>=3&&at.elements.some((item:any)=>item.tag==='tr'),JSON.stringify(at.elements.map((item:any)=>item.tag)));
  }finally{await page.close();}
 });

 await t.test('脱敏：autocomplete=new-password 的普通输入框照常给值，密码框写明 redactedBy；只读被拦时给能过的写法、说清纯读取也会被拦',async()=>{
  const {page,call,raw}=await h.open();
  try{
   const code=await call('chrome_find',{locator:{role:'textbox',name:'编码'}});
   assert.equal(code.elements[0].value,'MXYS-001',JSON.stringify(code.elements[0]));assert.equal(code.elements[0].valueRedacted,undefined);
   const secret=await call('chrome_find',{locator:{name:'登录密码'}});
   assert.equal(secret.elements[0].valueRedacted,true);assert.equal(secret.elements[0].redactedBy,'password');assert.equal(secret.elements[0].value,undefined);
   const stored=await raw('chrome_evaluate',{expression:"localStorage.getItem('k')",readOnly:true});
   assert.equal(stored.error?.code,'SIDE_EFFECT_BLOCKED');assert.match(stored.error!.message,/localStorage\['k'\]/);assert.match(stored.error!.message,/去掉 readOnly 照样能执行/);
   assert.equal(await call('chrome_evaluate',{expression:"localStorage['k']",readOnly:true}),null,'照建议改写后能过');
   const unknown=await raw('chrome_evaluate',{expression:"document.createElement('div').tagName",readOnly:true});
   assert.equal(unknown.error?.code,'SIDE_EFFECT_BLOCKED');assert.match(unknown.error!.message,/可能是这些调用：createElement/);
  }finally{await page.close();}
 });

 await t.test('点了“确定”、页面过一会儿才问“确定离开吗”：close_tab 带 accept 先答离开再关，不再卡 30 秒；不带 accept 立刻报未派发的 DIALOG_OPEN',async()=>{
  const {page,call,raw,target}=await h.open();
  await guard(page,call);
  await call('chrome_action',{action:'click',selector:'#exit',observe:false});
  await call('chrome_action',{action:'click',selector:'#ok',observe:false});
  await until(()=>dialogOpened(target.tabId),5000,'页面弹出离开确认框');
  const started=Date.now();
  const refused=await raw('chrome_close_tab',{});
  assert.equal(refused.error?.code,'DIALOG_OPEN',JSON.stringify(refused));assert.equal(refused.error?.outcome,'not_dispatched');
  assert.match(refused.error!.message,/beforeUnload:"accept"/);assert.equal(page.isClosed(),false);
  const closed=await call('chrome_close_tab',{beforeUnload:'accept'});
  assert.ok(Date.now()-started<8000,`不再等到看门狗：${Date.now()-started}ms`);
  assert.equal(closed.closed,true);assert.equal(closed.beforeUnload,'accepted');
  await until(()=>page.isClosed(),5000,'标签页关掉');
 });

 await t.test('动作被弹框打断、过了期限才去答：调试连接还在，chrome_dialog 照样答得上',async()=>{
  const {page,call,raw}=await h.open();
  await guard(page,call);
  const stopped=await raw('chrome_action',{action:'click',selector:'#nav',timeoutMs:1500});
  assert.equal(stopped.error?.code,'DIALOG_OPEN',JSON.stringify(stopped));
  await new Promise(r=>setTimeout(r,3000));// 过了命令期限加看门狗的 0.5 秒
  const left=await call('chrome_dialog',{accept:true});
  assert.equal(left.type,'beforeunload');assert.equal(left.writable,true);
  await until(()=>new URL(page.url()).pathname==='/next',5000,'导航到 /next');
  await page.close();
 });

 await t.test('chrome_action 带 beforeUnload:"accept"：动作里弹的、动作返回后才弹的都直接答离开；授权用一次就作废',async()=>{
  const {page,call,raw}=await h.open();
  await guard(page,call);
  const direct=await call('chrome_action',{action:'click',selector:'#nav',beforeUnload:'accept'});
  assert.equal(direct.beforeUnload,'accepted',JSON.stringify(direct));
  await until(()=>new URL(page.url()).pathname==='/next',5000,'导航到 /next');
  await guard(page,call);
  await call('chrome_action',{action:'click',selector:'#exit',observe:false});
  await call('chrome_action',{action:'click',selector:'#ok',observe:false,beforeUnload:'accept'});
  await until(()=>new URL(page.url()).pathname==='/left',5000,'晚弹的框也答了离开，导航到 /left');
  // 5 秒的余量还没过，但授权已经用掉了：再挂上、再触发，照旧停下问。
  await guard(page,call);
  const asked=await raw('chrome_action',{action:'click',selector:'#nav'});
  assert.equal(asked.error?.code,'DIALOG_OPEN',JSON.stringify(asked));
  await call('chrome_dialog',{accept:false});assert.equal(new URL(page.url()).pathname,'/left');
  await page.close();
 });

 await t.test('弹出窗口里点“关闭”（window.close）：带 accept 的动作和答完的 chrome_dialog 都写明标签页关了',async()=>{
  const {page,call}=await h.open();
  try{
   const tabIds=async()=>((await h.service.invoke('chrome_tabs',{profileId:h.profile.id},'interaction-test')).data as any).items.map((item:any)=>item.tabId) as number[];
   // 点之前已有的标签页和页面都排除掉，只认这次点出来的。
   const existing=new Set(h.browser.targets());
   const popupTarget=h.browser.waitForTarget(target=>!existing.has(target)&&target.url().endsWith('/popup'));
   const before=await tabIds();
   await call('chrome_action',{action:'click',selector:'#popup',observe:false});
   const popup=(await (await popupTarget).page())!;
   // 等弹出窗口加载完再挂“确定离开吗”：还在 about:blank 时挂上的，跳到 /popup 就没了。
   await popup.waitForFunction(()=>location.pathname==='/popup'&&document.readyState==='complete');
   const popupTab=(await tabIds()).find(tabId=>!before.includes(tabId))!;
   const inPopup=(name:string,args:any={})=>h.service.invoke(name,{profileId:h.profile.id,tabId:popupTab,...args},'interaction-test');
   const callPopup=async(name:string,args:any={})=>{const result=await inPopup(name,args);assert.ok(result.ok,`${name}: ${JSON.stringify(result.error||result.data)}`);return result.data as any;};
   await guard(popup,callPopup);
   const stopped=await inPopup('chrome_action',{action:'click',selector:'#closewin'});
   assert.equal(stopped.error?.code,'DIALOG_OPEN',JSON.stringify(stopped));
   const answered=await callPopup('chrome_dialog',{accept:true});
   assert.equal(answered.tabClosed,true,JSON.stringify(answered));
   // 再开一个，带 accept 一步关掉。
   await until(()=>popup.isClosed(),5000,'第一个弹出窗口关掉');
   const existing2=new Set(h.browser.targets());
   const second=h.browser.waitForTarget(target=>!existing2.has(target)&&target.url().endsWith('/popup'));
   const before2=await tabIds();
   await call('chrome_action',{action:'click',selector:'#popup',observe:false});
   const popup2=(await (await second).page())!;
   await popup2.waitForFunction(()=>location.pathname==='/popup'&&document.readyState==='complete');
   const popupTab2=(await tabIds()).find(tabId=>!before2.includes(tabId))!;
   const call2=async(name:string,args:any={})=>{const result=await h.service.invoke(name,{profileId:h.profile.id,tabId:popupTab2,...args},'interaction-test');assert.ok(result.ok,`${name}: ${JSON.stringify(result.error||result.data)}`);return result.data as any;};
   await guard(popup2,call2);
   const closed=await call2('chrome_action',{action:'click',selector:'#closewin',beforeUnload:'accept'});
   assert.equal(closed.beforeUnload,'accepted',JSON.stringify(closed));assert.equal(closed.tabClosed,true,JSON.stringify(closed));
  }finally{await page.close();}
 });

 await t.test('没有可答的弹框：DIALOG_NOT_OPEN 说清是还没弹、已经关了还是标签页没了',async()=>{
  const {page,call,raw,target}=await h.open();
  try{
   const none=await raw('chrome_dialog',{accept:true});
   assert.equal(none.error?.code,'DIALOG_NOT_OPEN');assert.equal(none.error?.outcome,'not_dispatched');assert.match(none.error!.message,/还没弹过框/);
   await guard(page,call);
   await call('chrome_navigate',{url:`http://127.0.0.1:${h.port}/again`,beforeUnload:'accept'});
   const opening=h.service.broker.events(h.profile.id,target.tabId,0).events.findLast(event=>event.method==='Page.javascriptDialogOpening');
   assert.ok(opening,'navigate 的离开确认框记在事件里');
   const late=await raw('chrome_dialog',{accept:true,dialogId:opening!.params.dialogId});
   assert.equal(late.error?.code,'DIALOG_NOT_OPEN');assert.match(late.error!.message,/已经关了（离开）/,late.error!.message);
  }finally{await page.close();}
 });
});
