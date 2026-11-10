import test from 'node:test';
import assert from 'node:assert/strict';
import {inflateSync} from 'node:zlib';
import {interactionHarness} from './interaction-harness.js';

// 用户在同一窗口的另一个标签页里用着，Agent 在后台标签页里点击、填值、截图：不把 Agent 的标签页切到前台，用户的页面什么也收不到。
// Agent 在后台标签页里点开的 target=_blank 新标签页留在后台，用户停在原来的标签页上。
const html=`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#fff}#go{position:absolute;left:100px;top:100px;width:120px;height:40px}
#field{position:absolute;left:100px;top:200px;width:200px;height:30px}#shade{position:absolute;left:400px;top:100px;width:100px;height:100px;background:#f00}
#ln{position:absolute;left:100px;top:300px;width:160px;height:30px;display:block}</style>
<button id="go">Go</button><input id="field" aria-label="Field"><div id="shade"></div><a id="ln" href="/popup" target="_blank">open</a><script>
window.clicks=0;window.seen=[];document.getElementById('go').onclick=()=>clicks++;
for(const type of ['visibilitychange','focus','blur','mousedown','keydown','input','wheel','resize'])addEventListener(type,e=>seen.push((e.target===window?'window:':'')+type),true);
</script>`;
// 读截图里一个点的颜色（8 位 RGB/RGBA，截图像素比为 1）。
function colorAt(png:Buffer,x:number,y:number){
 let p=8,width=0,type=0;const data:Buffer[]=[];
 while(p<png.length){const length=png.readUInt32BE(p),kind=png.toString('ascii',p+4,p+8),body=png.subarray(p+8,p+8+length);if(kind==='IHDR'){width=body.readUInt32BE(0);type=body[9]!;}if(kind==='IDAT')data.push(body);p+=12+length;}
 const raw=inflateSync(Buffer.concat(data)),bpp=type===6?4:3,stride=width*bpp,row=Buffer.alloc(stride);let previous=Buffer.alloc(stride);
 for(let line=0;line<=y;line++){const filter=raw[line*(stride+1)],src=raw.subarray(line*(stride+1)+1,(line+1)*(stride+1));for(let i=0;i<stride;i++){const a=i>=bpp?row[i-bpp]!:0,b=previous[i]!,c=i>=bpp?previous[i-bpp]!:0;let v=src[i]!;if(filter===1)v+=a;else if(filter===2)v+=b;else if(filter===3)v+=(a+b)>>1;else if(filter===4){const q=a+b-c,pa=Math.abs(q-a),pb=Math.abs(q-b),pc=Math.abs(q-c);v+=pa<=pb&&pa<=pc?a:pb<=pc?b:c;}row[i]=v&255;}previous=Buffer.from(row);}
 return [...row.subarray(x*bpp,x*bpp+3)];
}
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const windowOf=async(h:any,tabId:number)=>((await h.service.invoke('chrome_tabs',{profileId:h.profile.id},'interaction-test')).data.items as any[]).find(tab=>tab.tabId===tabId);

test('后台标签页：Agent 操作时不切到前台，弹出的新标签页也不盖住用户的标签页',async t=>{
 const h=await interactionHarness(t,html);
 const agent=await h.open();
 const own=await windowOf(h,agent.target.tabId);
 // 用户的标签页开在 Agent 那个窗口里，并且在前台。
 const userUrl=`http://127.0.0.1:${h.port}/user`;
 const userTabId=await h.worker.evaluate(async(windowId:number,url:string)=>(await chrome.tabs.create({windowId,url,active:true})).id!,own.windowId,userUrl);
 const user=await (await h.browser.waitForTarget(target=>target.url()===userUrl)).page();
 assert.ok(user);await user.waitForFunction(()=>document.readyState==='complete');
 await sleep(300);
 assert.equal(await agent.page.evaluate(()=>document.visibilityState),'hidden','Agent 的标签页开始在后台');
 await user.evaluate(()=>{(window as any).seen=[];});
 await h.worker.evaluate(()=>{const root=globalThis as any;root.__activations=[];chrome.tabs.onActivated.addListener(info=>root.__activations.push(info.tabId));});

 await agent.call('chrome_action',{action:'click',selector:'#go'});
 await agent.call('chrome_action',{action:'fill',selector:'#field',text:'hello 中文'});
 await agent.call('chrome_batch',{steps:[{operation:'page.action',args:{action:'click',selector:'#go'}},{operation:'page.action',args:{action:'scroll',selector:'#field',deltaY:40}}]});
 assert.deepEqual(await h.worker.evaluate(()=>(globalThis as any).__activations),[],'点击、填值、批次都没有切换过当前标签页');
 // 窗口级的 focus/blur 跟着系统窗口焦点变（测试窗口被别的窗口挡住、抢走焦点），不是 Agent 的动作，不算。
 assert.deepEqual(await user.evaluate(()=>[document.visibilityState,(window as any).seen.filter((type:string)=>!/^window:(focus|blur)$/.test(type))]),['visible',[]],`用户的页面什么也没收到：${JSON.stringify(await user.evaluate(()=>(window as any).seen))}`);
 // 截图在后台逼一帧；无头 Chrome 里偶尔逼不出来，会短暂切到前台截完再切回，这里只要求截到 Agent 页面的画面、截完用户还在原来的标签页。
 const shot=await agent.raw('chrome_screenshot',{});assert.equal(shot.ok,true,JSON.stringify(shot.error));
 assert.deepEqual(colorAt(Buffer.from((shot as any).image.data,'base64'),450,150),[255,0,0],'后台截图是 Agent 页面的画面');
 const switched=await h.worker.evaluate(()=>(globalThis as any).__activations.length);
 const trace=(await h.metrics()).trace as {method:string;ms:number}[];
 t.diagnostic(`截图：${trace.filter(x=>x.method==='Page.captureScreenshot').map(x=>Math.round(x.ms)+'ms').join(',')}，逼帧 ${trace.filter(x=>x.method==='Overlay.highlightRect').length} 次${switched?`，走了前台兜底（切换 ${switched} 次）`:''}`);
 assert.equal(await agent.page.evaluate(()=>(window as any).clicks),2);
 assert.equal(await agent.page.evaluate(()=>(document.getElementById('field') as HTMLInputElement).value),'hello 中文');
 assert.equal(await agent.page.evaluate(()=>document.visibilityState),'hidden','动作做完，焦点模拟关掉，Agent 的标签页回到后台的样子');
 const active=await h.worker.evaluate(async(windowId:number)=>(await chrome.tabs.query({windowId,active:true}))[0]?.id,own.windowId);
 assert.equal(active,userTabId);

 // Agent 在后台标签页里点开 target=_blank：新标签页 Chrome 默认放到前台，这里切回用户的标签页，新标签页留在后台。
 await agent.call('chrome_action',{action:'click',selector:'#ln'});
 let opened:any;
 for(let i=0;i<50&&!opened;i++){opened=(await h.worker.evaluate(async()=>(await chrome.tabs.query({})).find(tab=>(tab.url||tab.pendingUrl||'').endsWith('/popup'))));if(!opened)await sleep(100);}
 assert.ok(opened,'新标签页开出来了');
 for(let i=0;i<30&&await h.worker.evaluate(async(windowId:number)=>(await chrome.tabs.query({windowId,active:true}))[0]?.id,own.windowId)!==userTabId;i++)await sleep(100);
 assert.equal(await h.worker.evaluate(async(windowId:number)=>(await chrome.tabs.query({windowId,active:true}))[0]?.id,own.windowId),userTabId,'用户停在原来的标签页上');
 assert.equal(await h.worker.evaluate(async(id:number)=>(await chrome.tabs.get(id)).active,opened.id),false,'新标签页在后台');
 assert.equal(await user.evaluate(()=>document.visibilityState),'visible');
});

test('后台标签页：服务没开焦点模拟时扩展自己补上，做完关掉',async t=>{
 const h=await interactionHarness(t,html);
 const agent=await h.open();
 const own=await windowOf(h,agent.target.tabId);
 const userUrl=`http://127.0.0.1:${h.port}/user`;
 await h.worker.evaluate(async(windowId:number,url:string)=>(await chrome.tabs.create({windowId,url,active:true})).id!,own.windowId,userUrl);
 await (await h.browser.waitForTarget(target=>target.url()===userUrl)).page();
 await sleep(300);
 assert.equal(await agent.page.evaluate(()=>document.visibilityState),'hidden');
 // 绕过服务直接发给扩展：服务那一侧的焦点模拟没开。后台不出帧时每次移动鼠标要等 5 秒，这里应在几秒内做完。
 const started=Date.now();
 await h.service.broker.command(h.profile.id,'page.action',{tabId:agent.target.tabId,action:'click',selector:'#go'},20000);
 assert.ok(Date.now()-started<4000,`点击用了 ${Date.now()-started}ms`);
 assert.equal(await agent.page.evaluate(()=>(window as any).clicks),1);
 assert.equal(await agent.page.evaluate(()=>document.visibilityState),'hidden','扩展补开的焦点模拟做完就关');
});
