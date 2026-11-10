import test from 'node:test';
import assert from 'node:assert/strict';
import {inflateSync} from 'node:zlib';
import {interactionHarness} from './interaction-harness.js';

// Agent 光标在真实 Chrome 里：画得出来、截图里没有、过一会儿收起；页面这一侧看到的 DOM 和输入事件与关掉光标时一样。
// 截图用测试自己的 CDP 连接截，和用户在屏幕上看到的是同一帧（Overlay 由扩展的调试会话画）。
const html=`<!doctype html><meta charset="utf-8"><style>html,body{height:100%}body{margin:0;background:#fff}#go{position:absolute;left:200px;top:150px;width:120px;height:40px}#field{position:absolute;left:200px;top:300px;width:200px;height:30px}</style>
<button id="go">Go</button><input id="field" aria-label="Field"><script>
window.seen=[];window.mutations=0;
new MutationObserver(records=>{window.mutations+=records.length;}).observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
for(const type of ['pointerover','pointermove','pointerdown','pointerup','mouseover','mousemove','mousedown','mouseup','click','focus','focusin','blur','wheel'])
  addEventListener(type,e=>seen.push([type,e.isTrusted,e.clientX,e.clientY,e.screenX-e.clientX,e.screenY-e.clientY,e.button,e.buttons,e.detail,e.pressure,e.target.id||e.target.nodeName]),true);
</script>`;
// 只解码测试截图需要的 8 位 RGB/RGBA PNG。
function pixels(png:Buffer){
 let p=8,width=0,height=0,type=0;const data:Buffer[]=[];
 while(p<png.length){const length=png.readUInt32BE(p),kind=png.toString('ascii',p+4,p+8),body=png.subarray(p+8,p+8+length);if(kind==='IHDR'){width=body.readUInt32BE(0);height=body.readUInt32BE(4);type=body[9]!;}if(kind==='IDAT')data.push(body);p+=12+length;}
 const raw=inflateSync(Buffer.concat(data)),bpp=type===6?4:3,stride=width*bpp,out=Buffer.alloc(height*stride);
 for(let y=0;y<height;y++){const filter=raw[y*(stride+1)],row=raw.subarray(y*(stride+1)+1,(y+1)*(stride+1));for(let x=0;x<stride;x++){const a=x>=bpp?out[y*stride+x-bpp]!:0,b=y?out[(y-1)*stride+x]!:0,c=y&&x>=bpp?out[(y-1)*stride+x-bpp]!:0;let v=row[x]!;if(filter===1)v+=a;else if(filter===2)v+=b;else if(filter===3)v+=(a+b)>>1;else if(filter===4){const q=a+b-c,pa=Math.abs(q-a),pb=Math.abs(q-b),pc=Math.abs(q-c);v+=pa<=pb&&pa<=pc?a:pb<=pc?b:c;}out[y*stride+x]=v&255;}}
 // 橙色（光标、外框描边）的像素数，区域按 CSS 像素给，截图像素比为 1。文字的彩色抗锯齿边红绿差不到 100，不算。
 return (x0=0,y0=0,x1=width,y1=height)=>{let count=0;for(let y=Math.max(0,y0);y<Math.min(height,y1);y++)for(let x=Math.max(0,x0);x<Math.min(width,x1);x++){const i=y*stride+x*bpp,r=out[i]!,g=out[i+1]!,b=out[i+2]!;if(r>=185&&r-g>=100&&b<=90)count++;}return count;};
}
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

test('Agent 光标：真实 Chrome 里画在页面上层，页面看不到',async t=>{
 const h=await interactionHarness(t,html);
 // 这里逐条比开关光标时页面收到的事件，要求两次输入一样：关掉“像真人一样操作”（它的落点和轨迹每次随机），那一项另有 interaction-human.integration.ts。
 await h.humanInput(false);
 await h.showCursor(true);
 const shown=await h.open(),shot=async()=>pixels(Buffer.from(await shown.page.screenshot({encoding:'binary'})));
 const nodes=await shown.page.evaluate(()=>document.getElementsByTagName('*').length);
 await shown.call('chrome_action',{action:'click',selector:'#go',observe:false});
 const seenWithCursor=await shown.page.evaluate(()=>(window as any).seen.slice());
 const afterClick=await shot();
 assert.ok(afterClick(255,165,300,215)>20,`点击后按钮中心右下方应有箭头，实际 ${afterClick(255,165,300,215)} 个橙色像素`);
 assert.equal(afterClick(0,0,190,600)+afterClick(330,0,800,600),0,'别处没有');

 const product=await shown.raw('chrome_screenshot',{});assert.equal(product.ok,true,JSON.stringify(product.error));
 assert.equal(pixels(Buffer.from((product as any).image.data,'base64'))(),0,'产品截图里没有光标');
 await sleep(100);
 assert.ok((await shot())(255,165,300,215)>20,'截完画回去');

 await shown.call('chrome_action',{action:'fill',selector:'#field',text:'x',observe:false});
 await sleep(60);
 const framed=await shot();
 assert.ok(framed(190,290,410,340)>100,`填值时框住输入框，实际 ${framed(190,290,410,340)} 个橙色像素`);
 await shown.call('chrome_action',{action:'scroll',selector:'#field',deltaY:10,observe:false});
 await sleep(3200);
 assert.equal((await shot())(),0,'没有动作 2.5 秒后收起');
 assert.equal(await shown.page.evaluate(()=>(window as any).mutations),0,'页面没有任何 DOM 变化');
 assert.equal(await shown.page.evaluate(()=>document.getElementsByTagName('*').length),nodes);
 assert.equal(await shown.page.evaluate(()=>[...document.querySelectorAll('*')].some(element=>element.shadowRoot)),false);

 await h.showCursor(false);
 const hidden=await h.open();
 await hidden.call('chrome_action',{action:'click',selector:'#go',observe:false});
 const seenWithout=await hidden.page.evaluate(()=>(window as any).seen.slice());
 // 窗口级的 focus/blur（目标是 window，最后一列为 null）来自焦点模拟：测试开始时 Chrome 窗口不在系统前台，第一次动作才让页面得到焦点，
 // 之后窗口切到前台，第二个页面打开时已有焦点。和光标无关，比之前去掉（0.3.19 候选2的浏览器组因此失败过一次）。
 const onElements=(events:any[])=>events.filter(event=>event[10]!==null);
 assert.deepEqual(onElements(seenWithCursor),onElements(seenWithout),'页面收到的输入事件和关掉光标时一样');
 assert.equal(pixels(Buffer.from(await hidden.page.screenshot({encoding:'binary'})))(),0,'关掉后不画');

 // 跨进程 iframe 有自己的 Overlay：箭头要落在 iframe 里按钮的位置上。
 await h.showCursor(true);
 const framedPage=await h.open();
 await framedPage.page.evaluate(port=>new Promise(resolve=>{const frame=document.createElement('iframe');frame.style.cssText='position:absolute;left:400px;top:250px;width:390px;height:300px;border:0';frame.src=`http://localhost:${port}/`;frame.onload=resolve;document.body.append(frame);}),h.port);
 // 跨进程 iframe 的会话和上下文是异步登记的，等它出现。
 let contexts:any,child:any;
 for(let i=0;i<50&&!child?.sessionId;i++){contexts=await framedPage.call('chrome_contexts');child=contexts.contexts.find((context:any)=>String(context.origin).includes('localhost')&&context.auxData?.isDefault);if(!child?.sessionId)await sleep(100);}
 assert.ok(child?.sessionId,JSON.stringify(contexts));
 await framedPage.call('chrome_action',{contextId:child.id,sessionId:child.sessionId,action:'click',selector:'#go',observe:false});
 const inFrame=pixels(Buffer.from(await framedPage.page.screenshot({encoding:'binary'})));
 // 点之前 iframe 里会把按钮滚进视野，按点完后的实际位置算。
 const frame=framedPage.page.frames().find(item=>item.url().includes('localhost'))!;
 const button=await frame.$eval('#go',element=>{const r=element.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
 const offset=await framedPage.page.$eval('iframe',element=>{const r=element.getBoundingClientRect();return {x:r.x,y:r.y};});
 const tip={x:Math.round(offset.x+button.x),y:Math.round(offset.y+button.y)};
 assert.ok(inFrame(tip.x-5,tip.y-5,tip.x+45,tip.y+50)>20,`iframe 按钮中心 ${JSON.stringify(tip)} 右下方应有箭头，实际 ${inFrame(tip.x-5,tip.y-5,tip.x+45,tip.y+50)} 个橙色像素，全图 ${inFrame()}`);
 assert.equal(inFrame()-inFrame(tip.x-5,tip.y-5,tip.x+45,tip.y+50),0,'别处没有');
});
