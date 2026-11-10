import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {interactionHarness} from './interaction-harness.js';
import {freePort} from './helpers.js';

// 新文档加载前注入脚本（initScript），用真 Chrome 复现抓取内容平台主页时漏掉首屏请求的场景：
// 页面一加载就自己用 fetch 和 XHR 各请求一次作品列表（像一些内容平台主页的首屏），开完页面再 evaluate 装钩子就晚了。
// 另一条路：导航前 network_start，再用 wait_response、network_body 读这两个响应。
// 127.0.0.1 和 localhost 是两个站点，配 --site-per-process，跳转时换进程，iframe 是跨进程 iframe。
test('initScript：钩子接到页面自己发的第一批 fetch 和 XHR；只管这一次导航；跨域跳转照样跑；跨进程 iframe 不跑；管理页上不跑；网络工具也能拿到首屏响应',{timeout:240000},async t=>{
 const h=await interactionHarness(t,'<!doctype html><title>blank</title>');
 const port=await freePort();
 const page=(label:string)=>`<!doctype html><meta charset="utf-8"><title>${label}</title>
<script>
window.__pageGot=[];
fetch('/api/posts?cursor=0').then(r=>r.json()).then(j=>__pageGot.push(j));
const x=new XMLHttpRequest();x.open('GET','/api/posts?cursor=1');x.onload=()=>__pageGot.push(JSON.parse(x.responseText));x.send();
const other=location.hostname==='localhost'?'127.0.0.1':'localhost',cross=document.createElement('iframe');cross.id='cross';cross.src='http://'+other+':'+location.port+'/frame';
document.documentElement.appendChild(cross);
</script><iframe id="same" src="/frame"></iframe>`;
 const web=createServer((request,response)=>{
  const url=new URL(request.url||'/','http://x');
  if(url.pathname==='/api/posts'){response.setHeader('content-type','application/json');response.end(JSON.stringify({cursor:Number(url.searchParams.get('cursor')),aweme_list:[{aweme_id:'a'+url.searchParams.get('cursor')}]}));return;}
  if(url.pathname==='/redirect'){response.writeHead(302,{location:`http://localhost:${port}/page`});response.end();return;}
  if(url.pathname==='/to-admin'){response.writeHead(302,{location:`http://127.0.0.1:${h.config.port}/`});response.end();return;}
  response.setHeader('content-type','text/html; charset=utf-8');
  response.end(url.pathname==='/frame'?'<!doctype html><script>window.__frameRan=true</script>':page(url.pathname));
 });
 await new Promise<void>(r=>web.listen(port,'127.0.0.1',r));
 t.after(async()=>{web.closeAllConnections();await new Promise<void>(r=>web.close(()=>r()));});
 const base=`http://127.0.0.1:${port}`,profileId=h.profile.id;
 const invoke=(name:string,args:any,principal?:any)=>h.service.invoke(name,{profileId,...args},principal?`o-${principal.id}`:'init-script-test',principal);
 const call=async(name:string,args:any,principal?:any)=>{const result=await invoke(name,args,principal);assert.ok(result.ok,`${name}: ${JSON.stringify(result.error||result.data)}`);return result.data as any;};
 const read=(tabId:number,expression:string)=>call('chrome_evaluate',{tabId,expression,readOnly:true});
 const settled=(tabId:number,name:string)=>call('chrome_wait',{tabId,expression:`(window.${name}||[]).length>=2`,readOnly:true,timeoutMs:10000});
 // 调用方常用的钩子：改写 fetch 和 XMLHttpRequest，接住作品列表接口的返回。
 const HOOK=`if (window !== top) return;
const got = window.__hooked = [];
const nativeFetch = window.fetch;
window.fetch = async function (...args) {
  const response = await nativeFetch.apply(this, args);
  if (response.url.includes('/api/posts')) response.clone().text().then(body => got.push({ via: 'fetch', url: response.url, body }));
  return response;
};
const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function (method, url, ...rest) { this.__u = String(url); return open.call(this, method, url, ...rest); };
XMLHttpRequest.prototype.send = function (...args) {
  this.addEventListener('load', () => { if (this.__u.includes('/api/posts')) got.push({ via: 'xhr', url: this.responseURL, body: this.responseText }); });
  return send.apply(this, args);
};
const notGlobal = 1;`;
 const hooked=async(tabId:number)=>(await read(tabId,'window.__hooked')).map((x:any)=>({via:x.via,cursor:JSON.parse(x.body).cursor,path:new URL(x.url).pathname})).sort((a:any,b:any)=>a.cursor-b.cursor);

 await t.test('对照：照现在的做法，开完页面再 evaluate 装钩子，首屏两条一条都接不到',async()=>{
  const opened=await call('chrome_new_tab',{url:`${base}/page`});
  await settled(opened.tabId,'__pageGot');
  await call('chrome_evaluate',{tabId:opened.tabId,expression:`(function(){${HOOK}\n})()`});
  assert.deepEqual(await read(opened.tabId,'window.__hooked'),[],'请求早就发完了');
  await call('chrome_close_tab',{tabId:opened.tabId});
 });

 await t.test('new_tab 带 initScript：开页面前装好钩子，首屏的 fetch 和 XHR 都接到；顶层声明不进全局；调用返回后撤销，重新加载就没有钩子',async()=>{
  const opened=await call('chrome_new_tab',{url:`${base}/page`,initScript:HOOK,timeoutMs:30000});
  assert.equal(opened.url,`${base}/page`);assert.equal(opened.status,'complete');assert.deepEqual(opened.initScript,{removed:true});
  const tabId=opened.tabId;
  await settled(tabId,'__hooked');await settled(tabId,'__pageGot');
  assert.deepEqual(await hooked(tabId),[{via:'fetch',cursor:0,path:'/api/posts'},{via:'xhr',cursor:1,path:'/api/posts'}],'页面自己的第一批请求都被钩子接到');
  assert.equal((await read(tabId,'window.__pageGot.length')),2,'页面自己也照常拿到了数据');
  assert.equal(await read(tabId,'typeof notGlobal'),'undefined','脚本按函数体执行，顶层 const 不进页面全局');
  // 只管这一次导航：调用返回时已撤销，之后的新文档（不带 initScript 的重新加载）不跑。
  await call('chrome_navigate',{tabId,action:'reload'});await settled(tabId,'__pageGot');
  assert.equal(await read(tabId,'typeof window.__hooked'),'undefined','重新加载后没有钩子');
  // 再要就再给：reload 也可以带。
  const again=await call('chrome_navigate',{tabId,action:'reload',initScript:HOOK});assert.deepEqual(again.initScript,{removed:true});
  await settled(tabId,'__hooked');assert.equal((await hooked(tabId)).length,2);
  await call('chrome_close_tab',{tabId});
 });

 await t.test('跨域跳转：127.0.0.1 302 到 localhost（换进程），钩子跑在落点文档里；结果是落点的网址',async()=>{
  const opened=await call('chrome_new_tab',{url:'about:blank'});
  const navigated=await call('chrome_navigate',{tabId:opened.tabId,url:`${base}/redirect`,initScript:HOOK});
  assert.equal(navigated.url,`http://localhost:${port}/page`);assert.deepEqual(navigated.initScript,{removed:true});
  await settled(opened.tabId,'__hooked');
  assert.deepEqual((await hooked(opened.tabId)).map((x:any)=>x.via),['fetch','xhr']);
  await call('chrome_close_tab',{tabId:opened.tabId});
 });

 await t.test('iframe：同进程的 iframe 也跑（不写 window!==top 时），跨进程的 iframe 不跑；脚本报错不影响导航、出现在 chrome_events 里',async()=>{
  const opened=await call('chrome_new_tab',{url:'about:blank'});const tabId=opened.tabId;
  const MARK='window.__seen = location.href;';
  await call('chrome_navigate',{tabId,url:`${base}/page`,initScript:MARK});
  await call('chrome_wait',{tabId,expression:"!!document.querySelector('#same').contentWindow.__frameRan",readOnly:true,timeoutMs:10000});
  assert.equal(await read(tabId,'window.__seen'),`${base}/page`);
  assert.equal(await read(tabId,"document.querySelector('#same').contentWindow.__seen"),`${base}/frame`,'同源 iframe 在同一个进程里，也跑了');
  const pages=await h.browser.pages(),target=pages.find(p=>p.url()===`${base}/page`)!;assert.ok(target);
  const cross=await (async()=>{for(let i=0;i<100;i++){const frame=target.frames().find(f=>f.url().startsWith(`http://localhost:${port}/frame`));if(frame&&await frame.evaluate(()=>(window as any).__frameRan===true).catch(()=>false))return frame;await new Promise(r=>setTimeout(r,100));}})();
  assert.ok(cross,'跨进程 iframe 加载出来了');
  assert.equal(await cross!.evaluate(()=>(window as any).__seen),undefined,'跨进程 iframe 是另一个调试会话，不跑');
  // 脚本自己抛错：导航照常完成，报错进事件。
  const since=(await call('chrome_events',{tabId,limit:1})).headSequence;
  const thrown=await call('chrome_navigate',{tabId,url:`${base}/page?boom`,initScript:'if (window !== top) return; throw new Error("hook boom");'});
  assert.equal(thrown.status,'complete');
  await call('chrome_wait',{tabId,expression:'window.__pageGot.length>=2',readOnly:true,timeoutMs:10000});
  const events=await call('chrome_events',{tabId,since,method:'Runtime.exceptionThrown',mode:'raw',limit:20});
  assert.ok(JSON.stringify(events).includes('hook boom'),JSON.stringify(events).slice(0,2000));
  await call('chrome_close_tab',{tabId});
 });

 await t.test('非管理员：跳到本机管理页时整段不执行（管理员同样的跳转会执行，说明拦下它的是这道判断）；参数里的函数体闭合不了外层',async()=>{
  const agent=h.service.state.authenticate(h.service.state.createClient('受限客户端').token)!;
  const adminUrl=`http://127.0.0.1:${h.config.port}/`;
  const MARK='window.__seen = self.origin;';
  const find=async()=>{for(let i=0;i<50;i++){const found=(await h.browser.pages()).find(p=>p.url().startsWith(adminUrl));if(found)return found;await new Promise(r=>setTimeout(r,100));}throw new Error('没找到管理页标签页');};
  const restricted=await call('chrome_new_tab',{url:'about:blank'},agent);
  const result=await invoke('chrome_navigate',{tabId:restricted.tabId,url:`${base}/to-admin`,initScript:MARK},agent);
  assert.ok(result.ok,JSON.stringify(result.error));assert.equal((result.data as any).url,'','落到管理页，结果照旧隐藏网址');
  const shown=await find();assert.equal(await shown.evaluate(()=>(window as any).__seen),undefined,'管理页上没有执行');
  await shown.close();
  const admin=await call('chrome_new_tab',{url:'about:blank'});
  await call('chrome_navigate',{tabId:admin.tabId,url:`${base}/to-admin`,initScript:MARK});
  const adminPage=await find();assert.equal(await adminPage.evaluate(()=>(window as any).__seen),`http://127.0.0.1:${h.config.port}`,'管理员没有这道判断，同样的跳转会执行');
  await adminPage.close();
  const escaped=await invoke('chrome_navigate',{tabId:restricted.tabId,url:`${base}/page`,initScript:'})();window.__escaped=1;(function(){'},agent);
  assert.equal(escaped.error?.code,'INVALID_ARGUMENT');assert.match(escaped.error!.message,/不是合法的 JavaScript 函数体/);
 });

 await t.test('chrome_cdp 登记的新文档脚本（非管理员）：套进函数，顶层函数声明换不掉页面的 fetch；跳到管理页时整段不执行',async()=>{
  const agent=h.service.state.authenticate(h.service.state.createClient('受限客户端 cdp').token)!;
  const adminUrl=`http://127.0.0.1:${h.config.port}/`;
  const tab=await call('chrome_new_tab',{url:'about:blank'},agent);
  await call('chrome_cdp',{tabId:tab.tabId,method:'Page.addScriptToEvaluateOnNewDocument',params:{source:'function fetch() { return "hooked"; }\nwindow.__cdpSeen = self.origin;'}},agent);
  await call('chrome_navigate',{tabId:tab.tabId,url:`${base}/page`},agent);
  assert.equal(await read(tab.tabId,'window.__cdpSeen'),base,'普通页面照常跑');
  assert.equal(await read(tab.tabId,'String(window.fetch).includes("[native code]")'),true,'函数声明留在函数里，没换掉页面的 fetch（以前拼前缀时会被提升成全局）');
  await call('chrome_navigate',{tabId:tab.tabId,url:`${base}/to-admin`},agent);
  let shown;for(let i=0;i<50&&!shown;i++){shown=(await h.browser.pages()).find(p=>p.url().startsWith(adminUrl));if(!shown)await new Promise(r=>setTimeout(r,100));}
  assert.ok(shown,'跳到了管理页');
  assert.deepEqual(await shown!.evaluate(()=>({seen:typeof (window as any).__cdpSeen,nativeFetch:String(window.fetch).includes('[native code]')})),{seen:'undefined',nativeFetch:true},'管理页上整段没执行');
  await shown!.close(); // 关掉标签页，登记随调试连接一起消失
  const refused=await invoke('chrome_cdp',{tabId:(await call('chrome_new_tab',{url:'about:blank'},agent)).tabId,method:'Page.addScriptToEvaluateOnNewDocument',params:{source:'})();window.fetch=null;(function(){'}},agent);
  assert.equal(refused.error?.code,'INVALID_ARGUMENT');assert.equal(refused.error?.outcome,'not_dispatched');
 });

 await t.test('另一条路：空白页上先 network_start，再导航，wait_response 等到首屏的 fetch 和 XHR，network_body 读到正文',async()=>{
  const opened=await call('chrome_new_tab',{url:'about:blank'});const tabId=opened.tabId;
  const {since}=await call('chrome_network_start',{tabId});
  await call('chrome_navigate',{tabId,url:`${base}/page`});
  const bodies:any[]=[];
  for(const cursor of [0,1]){
   const response=await call('chrome_wait_response',{tabId,since,urlContains:`/api/posts?cursor=${cursor}`,timeoutMs:10000});
   const body=await call('chrome_network_body',{tabId,requestId:response.requestId});
   bodies.push({type:response.resourceType??response.type,body:JSON.parse(body.body)});
  }
  assert.deepEqual(bodies.map(x=>x.body.cursor),[0,1]);assert.deepEqual(bodies.map(x=>x.body.aweme_list[0].aweme_id),['a0','a1']);
  const listed=await call('chrome_events',{tabId,since,urlContains:'/api/posts',method:'Network.responseReceived',mode:'raw',limit:50});
  assert.equal(JSON.stringify(listed).match(/"Network\.responseReceived"/g)?.length,2,'events 按网址筛也能一次列出两条首屏请求');
  await call('chrome_network_stop',{tabId});
  await call('chrome_close_tab',{tabId});
 });
});
