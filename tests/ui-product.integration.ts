import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {launchTestChrome} from './chrome-launch.js';
import {fixture,testDirectory,fakeProfile} from './helpers.js';
import {projectDir} from '../src/config.js';
import {VERSION} from '../src/version.js';
import {parseCodex} from '../src/codex-config.js';
import {pathToFileURL} from 'node:url';

async function harness(t:TestContext,names:string[]=[]){
 const home=await testDirectory(),entry={command:'fixture.exe',args:['mcp'],env:{}};let verifications=0;
 const packaged=process.env.PRODUCT_SERVICE_ROOT?await import(pathToFileURL(path.join(process.env.PRODUCT_SERVICE_ROOT,'dist/http-server.js')).href):undefined;
 const f=await fixture({setup:{home:home.directory,entries:{codex:entry,opencode:entry,claude:entry,'claude-desktop':entry,codebuddy:entry,workbuddy:entry},verify:async()=>{verifications++;return {tools:51,profiles:names.length};}}},packaged?.startServer);
 const profiles=[];for(const name of names)profiles.push(await fakeProfile(f.config,name,c=>c.operation==='tabs.list'?[{tabId:7,windowId:1,title:name+'的页面',url:'https://example.test/'+ 'long-path'.repeat(30)}]:{}));
 const browser=await launchTestChrome({headless:true});
 t.after(async()=>{await browser.close();await f.cleanup();await home.cleanup();});const page=await browser.newPage(),errors:string[]=[],requests:string[]=[];
 page.on('pageerror',e=>errors.push(String(e)));t.after(()=>assert.deepEqual(errors,[]));page.on('request',r=>{if(r.method()==='POST')requests.push(r.postData()||'');});
 await page.evaluateOnNewDocument("Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>{window.copied=value;}}})");
 const base=`http://127.0.0.1:${f.config.port}`;
 const login=async()=>{await page.goto(base+'/#'+f.config.token);await page.waitForFunction(()=>document.querySelector<HTMLElement>('#login')!.hidden);await page.waitForSelector('#overview:not([hidden])');};
 const nav=async(route:string)=>{if(['tasks','access','activity','setup'].includes(route))await page.$eval('#advanced-nav',e=>(e as HTMLDetailsElement).open=true);await page.click(`nav a[href="#${route}"]`);await page.waitForFunction(route=>!document.querySelector<HTMLElement>('#'+route)!.hidden,{},route);if(route==='setup')await page.waitForSelector('#setup-clients .setup-card');};
  return {f,home,profiles,browser,page,base,login,nav,requests,verifications:()=>verifications};
}
test('八客户端接入页完成三种新增配置，Desktop/WorkBuddy 显示专属批准步骤；新增 Agent 可切换配置',async t=>{
 const h=await harness(t,['本轮测试']);await h.login();await h.nav('setup');
 assert.equal(await h.page.$$eval('.setup-card',nodes=>nodes.length),8);
 for(const client of ['claude-desktop','codebuddy','workbuddy']){
  const card=`.setup-card[data-client="${client}"]`;
  assert.equal(await h.page.$$eval(card+' .setup-trust',nodes=>nodes.length),client==='codebuddy'?1:0);
  await h.page.click(card+' .setup-preview');await h.page.waitForSelector(card+' .setup-result button');await h.page.click(card+' .setup-result button');
  await h.page.waitForFunction(selector=>document.querySelector(selector)!.textContent!.includes('接入已保存'),{},card+' .setup-result');
  const text=await h.page.$eval(card+' .setup-result',node=>node.textContent!);
  if(client==='claude-desktop')assert.match(text,/完全退出并重启/);
  if(client==='workbuddy')assert.match(text,/刷新并批准/);
 }
 assert.equal(h.verifications(),3);
 await h.nav('agents');await h.page.click('#add-agent');await h.page.type('#new-agent-name','新客户端测试');await h.page.select('#new-agent-profile',h.profiles[0]!.id);await h.page.click('#create-agent');await h.page.waitForSelector('#agent-created:not([hidden])');
 for(const client of ['claude-desktop','codebuddy','workbuddy']){
  await h.page.select('#new-agent-client',client);const text=await h.page.$eval('#new-agent-configuration',node=>(node as HTMLTextAreaElement).value),entry=JSON.parse(text).mcpServers.saltedfish;
  if(client==='claude-desktop'){assert.deepEqual(entry.args,['mcp-bridge']);assert.equal(entry.url,undefined);assert.match(await h.page.$eval('#agent-import-hint',node=>node.textContent!),/同一台电脑/);}
  else assert.equal(entry.type,'http');
 }
});
test('本机启动入口只由用户点击打开协议，未安装或目标不支持时保留手动登录',async t=>{
 const h=await harness(t,['工作']);let available=true;
 await h.page.setRequestInterception(true);h.page.on('request',request=>{if(new URL(request.url()).pathname==='/health')void request.respond({status:200,contentType:'application/json',body:JSON.stringify({service:'feng-chrome-mcp',version:VERSION,desktopLaunch:available})});else void request.continue();});
 await h.page.evaluateOnNewDocument(()=>{(window as any).desktopClicks=[];document.addEventListener('click',event=>{const link=(event.target as Element)?.closest<HTMLAnchorElement>('a');if(link?.href.startsWith('saltedfish-')){event.preventDefault();(window as any).desktopClicks.push(link.href);}},true);});
 await h.page.setViewport({width:1440,height:900});await h.page.goto(h.base+'/#remote');await h.page.waitForFunction(()=>!document.querySelector<HTMLElement>('#desktop-login')!.hidden);
 const href=`saltedfish-${h.f.config.port}://settings/remote`;
 assert.equal(await h.page.$eval('#open-desktop-settings',e=>e.getAttribute('href')),href);assert.equal(await h.page.$eval('#login-command-alternative',e=>(e as HTMLDetailsElement).open),false);
 assert.equal(h.requests.length,0);assert.deepEqual(await h.page.evaluate(()=>(window as any).desktopClicks),[],'加载或轮询不自动打开应用');
 const before=(await h.browser.pages()).length;await h.page.click('#open-desktop-settings');assert.deepEqual(await h.page.evaluate(()=>(window as any).desktopClicks),[href]);assert.equal((await h.browser.pages()).length,before);assert.equal(h.requests.length,0,'点击只启动本机应用协议，不向HTTP请求管理员登录码');assert.equal(await h.page.evaluate(()=>sessionStorage.getItem('chrome-mcp-session')),null);
 await h.page.click('#login-command-alternative > summary');assert.equal(await h.page.$eval('#login-command-alternative',e=>(e as HTMLDetailsElement).open),true);await h.page.click('#check-login-service');await h.page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>('#check-login-service')!.disabled);assert.equal(await h.page.$eval('#login-command-alternative',e=>(e as HTMLDetailsElement).open),true,'状态检查保留用户展开的备用方式');
 const output=path.join(projectDir,'.local/verification',`desktop-login-${VERSION}-${Date.now()}`);await mkdir(output,{recursive:true});await h.page.click('#login-command-alternative > summary');await h.page.screenshot({path:path.join(output,'desktop.png'),fullPage:true});for(const width of [390,320]){await h.page.setViewport({width,height:844});assert.equal(await h.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await h.page.screenshot({path:path.join(output,'mobile-'+width+'.png'),fullPage:true});}
 await h.page.evaluate(()=>{location.hash='setup';});await h.page.waitForFunction(()=>document.querySelector('#open-desktop-settings')!.getAttribute('href')!.endsWith('/setup'));
 await h.page.evaluate(()=>{location.hash='tasks';});await h.page.waitForFunction(()=>document.querySelector<HTMLElement>('#desktop-login')!.hidden);assert.equal(await h.page.$eval('#open-desktop-settings',e=>e.hasAttribute('href')),false);assert.equal(await h.page.$eval('#login-command-alternative',e=>(e as HTMLDetailsElement).open),true,'没有桌面入口时命令是主路径，直接展开');assert.equal(await h.page.$eval('#login-command-alternative > summary',e=>(e as HTMLElement).hidden),true);assert.equal(await h.page.evaluate(()=>location.hash),'#tasks');
 available=false;await h.page.evaluate(()=>{location.hash='remote';});await h.page.click('#check-login-service');await h.page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>('#check-login-service')!.disabled);assert.equal(await h.page.$eval('#desktop-login',e=>(e as HTMLElement).hidden),true);assert.equal(await h.page.$eval('#login-command-alternative',e=>(e as HTMLDetailsElement).open),true);assert.equal(h.requests.length,0);console.log(JSON.stringify({desktopLoginScreenshots:output}));
});

test('桌面启动返回的一次性登录码直达目标，参数非法或旧式链接回概览，失败保留目标',async t=>{
 const h=await harness(t,['工作']);
 for(const target of ['remote','setup']){
  const code=h.f.sessions.issueCode().code;await h.page.goto(`${h.base}/?target=${target}#${code}`);await h.page.waitForFunction(()=>document.querySelector<HTMLElement>('#login')!.hidden);
  assert.equal(await h.page.evaluate(()=>location.hash),'#'+target);assert.equal(await h.page.evaluate(()=>location.search),'');assert.equal(await h.page.$eval('#'+target,e=>(e as HTMLElement).hidden),false);assert.ok(!(await h.page.url()).includes(code));await h.page.click('#lock-dashboard');
 }
 const profileId=h.profiles[0]!.id,code=h.f.sessions.issueCode().code;await h.page.goto(`${h.base}/?target=agents&profile=${profileId}&add=1#${code}`);await h.page.waitForSelector('#agent-add-dialog[open]');assert.equal(await h.page.$eval('#agent-profile',e=>(e as HTMLSelectElement).value),profileId);assert.equal(await h.page.$eval('#new-agent-profile',e=>(e as HTMLSelectElement).value),profileId);await h.page.click('#close-agent-add');await h.page.click('#lock-dashboard');
 for(const query of ['?target=remote&target=setup','?target=remote&next=https://example.test','']){const token=h.f.sessions.issueCode().code;await h.page.goto('about:blank');await h.page.goto(`${h.base}/${query}#${token}`);await h.page.waitForFunction(()=>document.querySelector<HTMLElement>('#login')!.hidden);assert.equal(await h.page.evaluate(()=>location.hash),'#overview');await h.page.click('#lock-dashboard');}
 const used=h.f.sessions.issueCode().code;assert.equal(h.f.sessions.redeem(used),true);await h.page.goto(`${h.base}/?target=remote#${used}`);await h.page.waitForFunction(()=>!document.querySelector<HTMLElement>('#login-message')!.hidden);assert.equal(await h.page.evaluate(()=>location.hash),'#remote');assert.match(await h.page.$eval('#login-target',e=>e.textContent!),/当前服务/);assert.equal(await h.page.$eval('#workspace',e=>(e as HTMLElement).hidden),true);assert.equal(await h.page.evaluate(()=>sessionStorage.getItem('chrome-mcp-session')),null);
});

test('未认证深链接只显示登录入口，不把在线浏览器误报为离线',async t=>{
 const h=await harness(t,['工作']),traffic:{method:string;path:string;hasAuth:boolean}[]=[];
 h.page.on('request',request=>traffic.push({method:request.method(),path:new URL(request.url()).pathname,hasAuth:!!request.headers().authorization}));
 await h.page.setViewport({width:1440,height:900});await h.page.goto(h.base+'/#remote');
 assert.equal(await h.page.$eval('#workspace',e=>(e as HTMLElement).hidden),true);assert.equal(await h.page.$eval('#login',e=>(e as HTMLElement).hidden),false);
 assert.equal(await h.page.$eval('#login-title',e=>e.textContent!.trim()),'登录管理页');
 await h.page.waitForFunction(()=>{const state=document.querySelector<HTMLElement>('#login-service')!.dataset.state;return !!state&&!['checking','loading'].includes(state)&&!document.querySelector<HTMLButtonElement>('#check-login-service')!.disabled;});
 const healthyState=await h.page.$eval('#login-service',e=>(e as HTMLElement).dataset.state);assert.ok(healthyState&&healthyState!=='error');
 assert.equal(await h.page.$eval('#login-code',e=>(e as HTMLElement).offsetParent!==null),true,'登录入口直接可见');assert.equal(await h.page.$eval('#manual-login',e=>(e as HTMLDetailsElement).open),false,'管理员密钥收起');
 assert.match(await h.page.$eval('#login-target',e=>e.textContent!),/当前服务/);
 await h.page.evaluate(()=>{location.hash='tasks';});await h.page.waitForFunction(()=>document.querySelector('#login-target')!.textContent!.includes('任务'));
 await h.page.evaluate(()=>{location.hash='remote';});await h.page.waitForFunction(()=>document.querySelector('#login-target')!.textContent!.includes('当前服务'));
 assert.equal(await h.page.$eval('#workspace',e=>(e as HTMLElement).hidden),true);
 assert.equal(await h.page.$eval('#manual-login',e=>(e as HTMLDetailsElement).open),false);
 const output=path.join(projectDir,'.local/verification',`login-${VERSION}-${Date.now()}`);await mkdir(output,{recursive:true});
 async function captureLogin(width:number,height:number,name:string){
  await h.page.setViewport({width,height});await h.page.evaluate(()=>scrollTo(0,0));
  const layout=await h.page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth+1,smallText:[...document.querySelectorAll<HTMLElement>('#login p,#login label,#login summary,#login button,#login code')].filter(e=>e.offsetParent!==null).map(e=>({text:e.textContent?.slice(0,60),size:parseFloat(getComputedStyle(e).fontSize)})).filter(item=>item.size<12)}));
  assert.equal(layout.overflow,false,`${width}px登录入口不应横向溢出`);assert.deepEqual(layout.smallText,[],`${width}px登录说明与控件至少12px`);
  await h.page.screenshot({path:path.join(output,`${name}.png`),fullPage:true});
 }
 await h.page.$eval('#login-command-alternative',e=>(e as HTMLDetailsElement).open=true);
 for(const[method,command,width,height,name]of[['native','.\\SaltedFish.exe dashboard',1440,900,'native-desktop'],['npm','saltedfish dashboard',390,844,'npm-mobile'],['native','.\\SaltedFish.exe dashboard',320,740,'native-small']]as const){
  await h.page.click('#login-'+method);assert.equal(await h.page.$eval('#login-'+method,e=>e.getAttribute('aria-pressed')),'true');assert.equal(await h.page.$eval('#login-'+(method==='native'?'npm':'native'),e=>e.getAttribute('aria-pressed')),'false');
  assert.equal(await h.page.$eval('#login-command',e=>e.textContent!.trim()),command);assert.equal(await h.page.$eval('#copy-login-command',e=>(e as HTMLElement).dataset.copy),command);
  const instruction=await h.page.$eval('#login-instruction',e=>e.textContent!);assert.match(instruction,method==='native'?/文件夹|目录/:/终端|命令行/);
  const next=await h.page.$eval('#login-next-step',e=>e.textContent!);assert.match(next,method==='native'?/打开已登录的管理页/:/登录链接和 4 位登录码/);assert.equal(await h.page.$eval('#login-code-form',e=>getComputedStyle(e).display==='none'),method==='native','Windows 安装包不打印登录码，不显示输入框');
  const pagesBefore=(await h.browser.pages()).length;await h.page.click('#copy-login-command');await h.page.waitForFunction(command=>(window as any).copied===command,{},command);
  assert.equal((await h.browser.pages()).length,pagesBefore,'复制命令不自动执行或打开页面');assert.equal(await h.page.evaluate(()=>location.hash),'#remote');assert.equal(await h.page.evaluate(()=>sessionStorage.getItem('chrome-mcp-session')),null);
  assert.equal(await h.page.$eval('#workspace',e=>(e as HTMLElement).hidden),true);assert.equal(h.requests.length,0,'命令选择与复制不发送未授权POST');await captureLogin(width,height,name);
 }
 if(!await h.page.$eval('#manual-login',e=>(e as HTMLDetailsElement).open))await h.page.click('#manual-login > summary');await h.page.type('#token','draft-only-key');
 let healthFails=true;await h.page.setRequestInterception(true);h.page.on('request',request=>{if(healthFails&&new URL(request.url()).pathname==='/health')void request.respond({status:503,contentType:'application/json',body:'{"error":"test unavailable"}'});else void request.continue();});
 const healthStart=traffic.length;await h.page.click('#check-login-service');await h.page.waitForFunction(()=>document.querySelector<HTMLElement>('#login-service')!.dataset.state==='error'&&!document.querySelector<HTMLButtonElement>('#check-login-service')!.disabled);
 assert.equal(await h.page.$eval('#token',e=>(e as HTMLInputElement).value),'draft-only-key');assert.equal(await h.page.$eval('#manual-login',e=>(e as HTMLDetailsElement).open),true);assert.equal(h.f.service.broker.listProfiles()[0]!.online,true,'服务探测失败不能改变已连接浏览器');
 await captureLogin(390,844,'service-error-mobile');healthFails=false;await h.page.click('#check-login-service');await h.page.waitForFunction(state=>document.querySelector<HTMLElement>('#login-service')!.dataset.state===state&&!document.querySelector<HTMLButtonElement>('#check-login-service')!.disabled,{},healthyState);
 assert.equal(await h.page.$eval('#token',e=>(e as HTMLInputElement).value),'draft-only-key');assert.equal(await h.page.$eval('#manual-login',e=>(e as HTMLDetailsElement).open),true);
 assert.ok(traffic.slice(healthStart).length>=2);assert.ok(traffic.slice(healthStart).every(request=>request.method==='GET'&&request.path==='/health'&&!request.hasAuth),'状态检查只读公开health，不带草稿或认证');
 assert.equal(h.requests.length,0,'明确提交管理员密钥前不得发送POST');
 await h.page.click('#connect');await h.page.waitForFunction(()=>!document.querySelector<HTMLElement>('#login-message')!.hidden);
 assert.equal(await h.page.$eval('#workspace',e=>(e as HTMLElement).hidden),true);assert.equal(await h.page.evaluate(()=>sessionStorage.getItem('chrome-mcp-session')),null);assert.ok(!(await h.page.content()).includes(h.f.config.token));
 assert.ok(traffic.filter(request=>request.method==='POST').every(request=>request.path==='/session'),'手动登录只向会话端点提交');
 await h.page.focus('#token');await h.page.keyboard.down('Control');await h.page.keyboard.press('A');await h.page.keyboard.up('Control');await h.page.type('#token',h.f.config.token);await h.page.click('#connect');await h.page.waitForFunction(()=>document.querySelector<HTMLElement>('#login')!.hidden);
 assert.equal(await h.page.$eval('#remote',e=>(e as HTMLElement).hidden),false);assert.equal(await h.page.evaluate(()=>location.hash),'#remote');
 await h.page.click('#lock-dashboard');assert.equal(await h.page.$eval('#workspace',e=>(e as HTMLElement).hidden),true);assert.equal(h.f.service.broker.listProfiles()[0]!.online,true);
 await h.page.evaluate(()=>{location.hash='tasks';});await h.page.waitForFunction(()=>document.querySelector('#login-target')!.textContent!.includes('任务'));
 if(!await h.page.$eval('#manual-login',e=>(e as HTMLDetailsElement).open))await h.page.click('#manual-login > summary');
 await h.page.focus('#token');await h.page.keyboard.down('Control');await h.page.keyboard.press('A');await h.page.keyboard.up('Control');await h.page.type('#token',h.f.config.token);await h.page.click('#connect');await h.page.waitForFunction(()=>document.querySelector<HTMLElement>('#login')!.hidden);
 assert.equal(await h.page.$eval('#tasks',e=>(e as HTMLElement).hidden),false);assert.equal(await h.page.evaluate(()=>location.hash),'#tasks');
 assert.equal(await h.page.$eval('#task-profile',e=>(e as HTMLSelectElement).value),'');assert.equal(await h.page.$eval('#task-next',e=>(e as HTMLButtonElement).disabled),true);
 await h.page.click('#lock-dashboard');assert.equal(await h.page.$eval('#workspace',e=>(e as HTMLElement).hidden),true);assert.equal(h.f.service.broker.listProfiles()[0]!.online,true);
 console.log(JSON.stringify({loginScreenshots:output}));
});
test('零浏览器首页给出真实加载目录和下一步，窄屏保持可用',async t=>{
 const h=await harness(t);await h.login();assert.ok(await h.page.$eval('#overview-title',e=>e.textContent!.includes('先连接')));assert.equal(h.verifications(),0);
 await h.nav('accounts');assert.equal(await h.page.$eval('#add-browser',e=>(e as HTMLDetailsElement).open),true);assert.equal(await h.page.$eval('a[href="/download/extension.zip"]',e=>(e as HTMLAnchorElement).href),h.base+'/download/extension.zip');
 await h.page.setViewport({width:390,height:844});assert.ok(await h.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await mkdir(path.join(projectDir,'.local/verification'),{recursive:true});await h.page.screenshot({path:path.join(projectDir,`.local/verification/product-${VERSION}-empty-mobile.png`),fullPage:true});
});
test('首次接入到可复制试用指令：真实配置写入、协议检查、无隐藏自动任务',async t=>{
 const h=await harness(t,['个人','工作']);await h.page.setViewport({width:1440,height:1000});await h.login();
 assert.equal(await h.page.$eval('#tasks',e=>(e as HTMLElement).hidden),true);await h.nav('setup');
 const card='.setup-card[data-client="codex"]';assert.ok(await h.page.$eval(card,e=>e.textContent!.includes('尚未接入')));assert.equal(await h.page.$eval(card+' details',e=>(e as HTMLDetailsElement).open),false);
 await h.page.click(card+' .setup-preview');await h.page.waitForSelector(card+' .setup-result button');await h.page.click(card+' .setup-result button');await h.page.waitForFunction(card=>document.querySelector(card+' .setup-result')!.textContent!.includes('接入已保存'),{},card);
 assert.equal(parseCodex(await readFile(path.join(h.home.directory,'.codex/config.toml'),'utf8')).mcp_servers['saltedfish'].default_tools_approval_mode,'approve');assert.equal(h.verifications(),1);
 await h.nav('overview');await h.page.waitForFunction(()=>document.querySelector('#journey-agent-state')!.textContent!.includes('创建 Agent'));await h.page.select('#example-profile',h.profiles[1]!.id);await h.page.click('#copy-example');const prompt:string=await h.page.evaluate(()=>(window as any).copied);assert.ok(prompt.includes(`profileId 为 ${h.profiles[1]!.id} `)&&prompt.includes('"工作"')&&prompt.includes('不是指令'));assert.equal(h.f.service.state.tasks().length,0);
 assert.ok(!h.requests.some(s=>s.includes('chrome_tabs')||s.includes('chrome_tasks')),'home should not poll browser/task data');
 await h.page.screenshot({path:path.join(projectDir,`.local/verification/product-${VERSION}-overview.png`),fullPage:true});
 await h.page.setViewport({width:390,height:844});await h.page.screenshot({path:path.join(projectDir,`.local/verification/product-${VERSION}-overview-mobile.png`),fullPage:true});assert.ok(await h.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await h.nav('setup');await h.page.click('#detect-clients');await h.page.waitForSelector(card+' .setup-check');await h.page.click(card+' .setup-check');await h.page.waitForFunction(card=>document.querySelector(card+' .setup-result')!.textContent!.includes('连接检查通过'),{},card);assert.equal(h.verifications(),2);
});
test('浏览器断开保留账号，不将试用目标悄悄切换给另一账号',async t=>{
 const h=await harness(t,['个人','工作']);await h.login();await h.page.select('#example-profile',h.profiles[0]!.id);h.profiles[0]!.socket.close();
 for(let i=0;i<50&&h.f.service.broker.listProfiles().find(p=>p.id===h.profiles[0]!.id)?.online;i++)await new Promise(r=>setTimeout(r,20));
 await h.page.click('#refresh-all');await h.page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>('#refresh-all')!.disabled);
 assert.equal(await h.page.$eval('#example-profile',e=>(e as HTMLSelectElement).value),h.profiles[0]!.id);assert.equal(await h.page.$eval('#copy-example',e=>(e as HTMLButtonElement).disabled),true);assert.ok(await h.page.$eval('#example-prompt',e=>e.textContent!.includes('不会自动切换')));
 h.profiles[1]!.socket.close();for(let i=0;i<50&&h.f.service.broker.listProfiles().some(p=>p.online);i++)await new Promise(r=>setTimeout(r,20));await h.page.click('#refresh-all');await h.page.waitForFunction(()=>document.querySelector('#overview-title')!.textContent!.includes('打开浏览器'));
});
test('服务读取失败保留上次状态并显式标记过期，恢复后继续同一页面',async t=>{
 const h=await harness(t,['工作']);await h.login();let fail=true;await h.page.setRequestInterception(true);h.page.on('request',r=>{if(fail&&new URL(r.url()).pathname==='/dashboard')void r.abort('failed');else void r.continue();});
 await h.page.click('#refresh-all');await h.page.waitForFunction(()=>!document.querySelector<HTMLElement>('#connection-alert')!.hidden);assert.equal(await h.page.$eval('#login',e=>(e as HTMLElement).hidden),true);assert.ok(await h.page.$eval('#overview-browsers',e=>e.textContent!.includes('上次状态')));
 fail=false;await h.page.click('#retry-connection');await h.page.waitForFunction(()=>document.querySelector<HTMLElement>('#connection-alert')!.hidden);assert.ok(await h.page.$eval('#overview-browsers',e=>e.textContent!.includes('已连接')));
});
test('概览轮询不读取任务、标签和重复检测配置；导航和深链接可恢复',async t=>{
 const h=await harness(t,['工作']);let detects=0;h.page.on('request',r=>{if(new URL(r.url()).pathname==='/setup/clients')detects++;});await h.login();await new Promise(r=>setTimeout(r,5400));assert.equal(detects,0);assert.ok(!h.requests.some(s=>s.includes('chrome_tasks')||s.includes('chrome_tabs')));
 await h.nav('tasks');await h.page.select('#task-profile',h.profiles[0]!.id);await h.page.waitForSelector('#task-tab option[value="7"]');await h.page.select('#task-tab','7');await h.nav('overview');await h.page.reload();await h.page.waitForFunction(()=>document.querySelector<HTMLElement>('#login')!.hidden);assert.equal(await h.page.$eval('#overview',e=>(e as HTMLElement).hidden),false);
 await h.page.keyboard.press('Tab');assert.ok(await h.page.evaluate(()=>!!document.activeElement));
});

test('退出后重新连接不被旧请求阻塞，晚到的401不能退出新会话',async t=>{
 const h=await harness(t,['工作']);await h.login();let held:any,ready!:()=>void;const seen=new Promise<void>(r=>ready=r);await h.page.setRequestInterception(true);
 h.page.on('request',r=>{if(!held&&new URL(r.url()).pathname==='/dashboard'){held=r;ready();}else void r.continue();});
 await h.page.click('#refresh-all');await seen;await h.page.click('#lock-dashboard');if(!await h.page.$eval('#manual-login',e=>(e as HTMLDetailsElement).open))await h.page.click('#manual-login summary');await h.page.type('#token',h.f.config.token);await h.page.click('#connect');
 await h.page.waitForFunction(()=>document.querySelector<HTMLElement>('#login')!.hidden,{timeout:3000});
 await held.respond({status:401,contentType:'application/json',body:'{"error":"UNAUTHORIZED"}'});await h.page.waitForNetworkIdle({idleTime:100,timeout:3000});assert.equal(await h.page.$eval('#workspace',e=>(e as HTMLElement).hidden),false);assert.equal(await h.page.evaluate(()=>!!sessionStorage.getItem('chrome-mcp-session')),true);
 // ui:1：旧会话里挂起过的静态按钮不能因为会话代际变化而永远停在禁用态。
 assert.equal(await h.page.$eval('#refresh-all',e=>(e as HTMLButtonElement).disabled),false);
});

test('长浏览器名称在窄屏概览和管理页完整换行，不撑出屏幕',async t=>{
 const label='Work-'+ 'A'.repeat(90),h=await harness(t,[label]);await h.page.setViewport({width:390,height:844});await h.login();
 assert.ok(await h.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overview width');await h.nav('accounts');assert.ok(await h.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'browser management width');assert.ok(await h.page.$eval('#profiles',e=>e.textContent!.includes('Work-')));
 await h.page.evaluate(()=>[...document.querySelectorAll<HTMLButtonElement>('#profiles button')].find(e=>e.textContent==='查看标签页')!.click());await h.page.waitForSelector('#profiles table');assert.ok(await h.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'tab list width');await h.nav('remote');assert.ok(await h.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'remote labels width');
});
