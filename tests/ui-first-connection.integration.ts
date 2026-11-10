import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {networkInterfaces} from 'node:os';
import path from 'node:path';import {pathToFileURL} from 'node:url';
import {type Browser,type Page} from 'puppeteer-core';
import {launchTestChrome} from './chrome-launch.js';
import {fixture,unifiedFixture} from './helpers.js';
import {startServer} from '../src/http-server.js';
import {projectDir} from '../src/config.js';
import {privateAddress} from '../src/service-address.js';
const product=process.env.PRODUCT_SERVICE_ROOT||projectDir,shots=path.join(projectDir,'.local/verification/first-connection');
const host=Object.values(networkInterfaces()).flat().find(item=>item?.family==='IPv4'&&!item.internal&&privateAddress(item.address))?.address;

function unzipStored(archive:Buffer){
 const files=new Map<string,Buffer>();let offset=0;
 while(archive.readUInt32LE(offset)===0x04034b50){const size=archive.readUInt32LE(offset+18),nameLength=archive.readUInt16LE(offset+26),extra=archive.readUInt16LE(offset+28),start=offset+30+nameLength+extra;files.set(archive.toString('utf8',offset+30,offset+30+nameLength),archive.subarray(start,start+size));offset=start+size;}
 return files;
}
async function launch(directory:string,dataDir:string){
 const browser=await launchTestChrome({headless:true,pipe:true,enableExtensions:[directory],userDataDir:path.join(dataDir,'chrome'),args:['--no-first-run']});
 const worker=await browser.waitForTarget(target=>target.type()==='service_worker');
 return{browser,optionsUrl:`chrome-extension://${new URL(worker.url()).hostname}/options.html`};
}
const visible=(page:Page,selector:string)=>page.$eval(selector,e=>getComputedStyle(e).display!=='none'&&!!(e as HTMLElement).offsetParent);
async function popup(browser:Browser,url:string,errors:string[]){
 const page=await browser.newPage();page.on('pageerror',error=>errors.push(String(error)));await page.setViewport({width:360,height:600});await page.goto(url);await page.waitForSelector('#setup:not([hidden])');return page;
}
async function generateCode(dashboard:Page,name:string){
 await dashboard.waitForSelector('#pair-browser-label');await dashboard.$eval('#pair-browser-label',e=>(e as HTMLInputElement).value='');await dashboard.type('#pair-browser-label',name);await dashboard.click('#create-browser-pairing');await dashboard.waitForSelector('#browser-pairing-created:not([hidden])');
 return dashboard.$eval('#browser-connection-code',e=>(e as HTMLTextAreaElement).value);
}

test('下载的扩展自带服务地址：装好后从扩展打开管理页、生成配对码、粘贴后连上，名称用管理页填的',{timeout:60000},async t=>{
 const f=await unifiedFixture();let browser:Browser|undefined;t.after(async()=>{try{await browser?.close();}finally{await f.cleanup();}});
 const origin=`http://127.0.0.1:${f.config.port}`,errors:string[]=[],response=await fetch(origin+'/download/extension.zip');assert.equal(response.status,200);
 const archive=Buffer.from(await response.arrayBuffer()),files=unzipStored(archive);
 assert.deepEqual(JSON.parse(files.get('pairing.json')!.toString()),{serviceUrl:origin},'ZIP 不鉴权，只能带服务地址，不能带令牌');
 assert.equal(archive.includes(f.config.token),false,'ZIP 里不能出现管理令牌');
 assert.deepEqual(files.get('options.html'),await readFile(path.join(product,'dist/extension/options.html')));
 const extension=path.join(f.config.dataDir,'downloaded-extension');await mkdir(extension);for(const[name,bytes]of files)await writeFile(path.join(extension,name),bytes);
 const started=await launch(extension,f.config.dataDir);browser=started.browser;
 const options=await popup(browser,started.optionsUrl,errors);await mkdir(shots,{recursive:true});
 assert.equal(await options.$eval('#setup-address',e=>(e as HTMLInputElement).value),origin);assert.equal(await visible(options,'#workspace'),false,'没配对时不显示管理页入口、暂停和 Agent');
 assert.equal(await options.evaluate(()=>document.activeElement?.id),'setup-code','地址已知时光标直接在配对码上');
 assert.equal(await options.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=600),true,'弹窗 360×600 内放得下，不用滚动');
 await options.screenshot({path:path.join(shots,'popup-known-address.png')});

 await options.click('#setup-open');
 const opened=await browser.waitForTarget(target=>target.url().startsWith(origin));assert.equal(opened.url(),origin+'/#accounts');
 const dashboard=(await opened.page())!;await dashboard.waitForFunction(()=>document.querySelector('#login-target')?.textContent?.includes('浏览器'));
 await dashboard.goto('about:blank');await dashboard.goto(`${origin}/#${f.config.token}`);await dashboard.waitForFunction(()=>document.querySelector<HTMLElement>('#login')!.hidden);await dashboard.evaluate(()=>{location.hash='accounts';});
 await dashboard.waitForSelector('#accounts:not([hidden])');await dashboard.setViewport({width:1440,height:1000});
 assert.equal(await visible(dashboard,'.pair-records-title'),false,'没有记录时不显示空标题');
 await dashboard.screenshot({path:path.join(shots,'accounts-desktop.png')});
 const before=await dashboard.$eval('#pair-browser-label',e=>e.getBoundingClientRect().bottom);await dashboard.focus('#pair-browser-label');
 const nextLabel=await dashboard.$eval('#pair-browser-manage',e=>e.closest('label')!.getBoundingClientRect().top);assert.ok(nextLabel-before>=8,'焦点框不能压住下一项');
 const code=await generateCode(dashboard,'工作 Chrome');assert.match(await dashboard.$eval('#pairing-feedback',e=>e.textContent||''),/配对码已生成/);
 await dashboard.screenshot({path:path.join(shots,'accounts-code.png'),fullPage:true});
 await dashboard.setViewport({width:400,height:844});assert.equal(await dashboard.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'手机宽度不横向滚动');await dashboard.screenshot({path:path.join(shots,'accounts-mobile.png'),fullPage:true});

 await options.bringToFront();await options.type('#setup-code',code);await options.click('#setup-form button[type=submit]');
 await options.waitForFunction(()=>document.querySelector('#status')?.getAttribute('data-state')==='connected');
 assert.equal(await visible(options,'#setup'),false);assert.equal(await visible(options,'#workspace'),true);assert.equal(await options.$eval('#profile-name',e=>e.textContent),'工作 Chrome','管理页填的名称替换自动名称');
 await options.click('#settings-toggle');assert.equal(await options.$eval('input[name=serviceUrl]',e=>(e as HTMLInputElement).value),origin);
 await options.screenshot({path:path.join(shots,'popup-connected.png')});
 assert.equal(f.service.broker.listProfiles()[0]?.label,'工作 Chrome');assert.deepEqual(errors,[]);
});

test('扩展重装后身份变了：在离线卡片点重新连接，粘贴配对码接回原来的身份、名称和授权',{timeout:90000},async t=>{
 const f=await unifiedFixture();let browser:Browser|undefined;t.after(async()=>{try{await browser?.close();}finally{await f.cleanup();}});
 const origin=`http://127.0.0.1:${f.config.port}`,errors:string[]=[],extension=path.join(f.config.dataDir,'extension');await cp(path.join(product,'dist/extension'),extension,{recursive:true});
 const connectionCode=(pairing:object)=>'sf-connect:'+Buffer.from(JSON.stringify({version:1,serviceUrl:origin,...pairing})).toString('base64url');
 const paste=async(page:Page,code:string)=>{await page.type('#setup-code',code);await page.click('#setup-form button[type=submit]');await page.waitForFunction(()=>document.querySelector('#status')?.getAttribute('data-state')==='connected');};
 let started=await launch(extension,f.config.dataDir);browser=started.browser;
 const first=await popup(browser,started.optionsUrl,errors),original=await f.pairings.create({label:'工作 Chrome',canManage:true});await paste(first,connectionCode(original));
 const [profile]=f.service.broker.listProfiles();assert.ok(profile);const client=f.service.state.createClient('只用这个 Chrome',[profile.id]);
 await browser.close();browser=undefined;for(let i=0;i<200&&f.service.broker.profiles.has(profile.id);i++)await new Promise(resolve=>setTimeout(resolve,25));assert.equal(f.service.broker.profiles.has(profile.id),false);

 // 新的用户数据目录就是重装：扩展存储是空的，会生成新身份，原来的令牌找不回来了。
 const reinstalled=path.join(f.config.dataDir,'reinstalled');await mkdir(reinstalled);started=await launch(extension,reinstalled);browser=started.browser;
 const options=await popup(browser,started.optionsUrl,errors);assert.notEqual((await options.evaluate(()=>(globalThis as any).chrome.runtime.sendMessage({type:'settings.get'}))).settings.profileId,profile.id);
 const dashboard=await browser.newPage();dashboard.on('pageerror',error=>errors.push(String(error)));await dashboard.setViewport({width:1200,height:900});await dashboard.goto(`${origin}/#${f.config.token}`);await dashboard.waitForFunction(()=>document.querySelector<HTMLElement>('#login')!.hidden);await dashboard.evaluate(()=>{location.hash='accounts';});await dashboard.waitForSelector('#accounts:not([hidden]) .profile-card');
 const press=(text:string)=>dashboard.evaluate(text=>{const target=[...document.querySelectorAll<HTMLButtonElement>('.profile-card button')].find(item=>item.textContent===text);if(!target)throw new Error('没有按钮 '+text);target.click();},text);
 await press('重新连接');await dashboard.waitForSelector('.reconnect-panel textarea');const code=await dashboard.$eval('.reconnect-panel textarea',e=>(e as HTMLTextAreaElement).value);
 await mkdir(shots,{recursive:true});await dashboard.screenshot({path:path.join(shots,'reconnect-card.png')});
 assert.equal(f.pairings.get(original.pairingId),undefined,'原配对作废');

 await options.bringToFront();await paste(options,code);
 assert.equal(await options.$eval('#profile-name',e=>e.textContent),'工作 Chrome','名称接回来了');assert.match(await options.$eval('#identity',e=>e.textContent||''),new RegExp(profile.id),'身份接回来了');
 assert.deepEqual(f.service.broker.listProfiles().map(item=>item.id),[profile.id],'还是原来那一个浏览器，没有多出一条');assert.ok(f.service.state.principal(client.id)?.profiles.includes(profile.id),'只授权给它的 Agent 不用重新授权');
 assert.equal(f.pairings.list().filter(item=>!item.revoked).length,1);assert.equal(f.pairings.list().find(item=>!item.revoked)?.canManage,true,'管理授权沿用');
 await dashboard.bringToFront();await dashboard.waitForFunction(()=>document.querySelector('.profile-card .badge')?.textContent==='已连接'&&!document.querySelector('.reconnect-panel'),{timeout:12000});

 // 已配对的扩展不能被一个码换掉身份。
 const other=await f.pairings.create({label:'别人的',profileId:'87654321-4321-4321-8321-ba0987654321'});await options.bringToFront();await options.click('#settings-toggle');await options.type('input[name=connectionCode]',connectionCode(other));await options.$eval('input[name=connectionCode]',e=>(e as HTMLInputElement).form!.requestSubmit());
 await options.waitForFunction(()=>document.querySelector('#save-result')?.textContent?.includes('另一浏览器'));assert.match(await options.$eval('#identity',e=>e.textContent||''),new RegExp(profile.id));assert.deepEqual(errors,[]);
});

test('登录页：手敲 4 位登录码能登录；在已打开的页面粘贴登录链接也能登录，地址里不留登录码',{timeout:60000},async t=>{
 const f=await unifiedFixture();let browser:Browser|undefined;t.after(async()=>{try{await browser?.close();}finally{await f.cleanup();}});
 const origin=`http://127.0.0.1:${f.config.port}`,errors:string[]=[],issue=async()=>await (await fetch(origin+'/session/code?short=1',{method:'POST',headers:{authorization:'Bearer '+f.config.token}})).json() as {code:string;shortCode:string};
 browser=await launchTestChrome({headless:true,args:['--no-first-run']});const page=await browser.newPage();page.on('pageerror',error=>errors.push(String(error)));await page.setViewport({width:1000,height:900});
 const loggedIn=()=>page.waitForFunction(()=>document.querySelector<HTMLElement>('#login')!.hidden,{timeout:8000}),loggedOut=()=>page.waitForFunction(()=>!document.querySelector<HTMLElement>('#login')!.hidden&&!!document.querySelector('#login-service')?.textContent?.includes('服务运行中'));
 await page.goto(origin+'/');await loggedOut();await mkdir(shots,{recursive:true});await page.screenshot({path:path.join(shots,'login-page.png'),fullPage:true});
 assert.equal(await page.evaluate(()=>document.activeElement?.id),'login-code','打开就能输入');assert.equal(await page.$eval('#manual-login',e=>(e as HTMLDetailsElement).open),false,'管理员密钥收起');
 await page.setViewport({width:400,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'手机宽度不横向滚动');await page.screenshot({path:path.join(shots,'login-page-mobile.png'),fullPage:true});await page.setViewport({width:1000,height:900});

 const first=await issue();await page.type('#login-code',first.shortCode.toLowerCase());await page.keyboard.press('Enter');await loggedIn();
 await page.click('#lock-dashboard');await loggedOut();

 // 和在地址栏粘贴一样：同一页面只改 # 后面，不重新加载。
 const second=await issue();await page.evaluate(()=>{(globalThis as any).sameDocument=true;});await page.goto(`${origin}/#${second.code}`);await loggedIn();
 assert.equal(await page.evaluate(()=>(globalThis as any).sameDocument),true,'确实没有重新加载');assert.equal(new URL(page.url()).hash,'#overview','地址里不留登录码');assert.deepEqual(errors,[]);
});

test('手动安装的扩展不知道服务地址：连不上时就地提示不打开页面，粘贴配对码不受默认地址影响',{timeout:60000},async t=>{
 const f=await unifiedFixture();let browser:Browser|undefined;t.after(async()=>{try{await browser?.close();}finally{await f.cleanup();}});
 const origin=`http://127.0.0.1:${f.config.port}`,errors:string[]=[],extension=path.join(f.config.dataDir,'extension');await cp(path.join(product,'dist/extension'),extension,{recursive:true});
 const started=await launch(extension,f.config.dataDir);browser=started.browser;
 const options=await popup(browser,started.optionsUrl,errors);await mkdir(shots,{recursive:true});
 assert.equal(await options.$eval('#setup-address',e=>(e as HTMLInputElement).value),'','不把默认的本机地址当成用户的服务');assert.equal(await options.evaluate(()=>document.activeElement?.id),'setup-address');
 await options.screenshot({path:path.join(shots,'popup-unknown-address.png')});
 await options.click('#setup-open');await options.waitForFunction(()=>document.querySelector('#setup-open-result')?.textContent?.includes('服务地址'));
 const pages=(await browser.pages()).length;await options.type('#setup-address','127.0.0.1:9');await options.click('#setup-open');await options.waitForFunction(()=>document.querySelector('#setup-open-result')?.textContent?.includes('连不上 http://127.0.0.1:9'),{timeout:8000});
 assert.equal((await browser.pages()).length,pages,'连不上时不打开报错页');await options.screenshot({path:path.join(shots,'popup-unreachable.png')});
 await options.click('#setup-form button[type=submit]');await options.waitForFunction(()=>document.querySelector('#setup-result')?.textContent?.includes('粘贴配对码'));
 const pairing=await f.pairings.create({label:'家里 Chrome'}),code='sf-connect:'+Buffer.from(JSON.stringify({version:1,serviceUrl:origin,...pairing})).toString('base64url');
 await options.type('#setup-code',code);await options.click('#setup-form button[type=submit]');await options.waitForFunction(()=>document.querySelector('#status')?.getAttribute('data-state')==='connected');
 assert.equal(await options.$eval('#service-address',e=>e.textContent),origin,'以配对码里的地址为准');assert.equal(f.service.broker.listProfiles()[0]?.label,'家里 Chrome');assert.deepEqual(errors,[]);
});

test('真实内网 IP：只填 IP 和端口，扩展能探测到服务并打开管理页，登录页说明下一步',{skip:!host,timeout:60000},async t=>{
 const start=process.env.PRODUCT_SERVICE_ROOT?(await import(pathToFileURL(path.join(product,'dist/http-server.js')).href)).startServer as typeof startServer:startServer;
 const f=await fixture({},(config,options)=>start({...config,directConnections:true,network:{host:host!,publicUrl:`http://${host}:${config.port}`,allowInsecureLan:true}},options));let browser:Browser|undefined;t.after(async()=>{try{await browser?.close();}finally{await f.cleanup();}});
 const origin=`http://${host}:${f.config.port}`,errors:string[]=[],extension=path.join(f.config.dataDir,'extension');await cp(path.join(product,'dist/extension'),extension,{recursive:true});
 const started=await launch(extension,f.config.dataDir);browser=started.browser;
 const options=await popup(browser,started.optionsUrl,errors);await options.type('#setup-address',`${host}:${f.config.port}`);await options.click('#setup-open');
 const opened=await browser.waitForTarget(target=>target.url().startsWith(origin));assert.equal(opened.url(),origin+'/#accounts');
 const dashboard=(await opened.page())!;await dashboard.waitForFunction(()=>!document.querySelector<HTMLElement>('#login')!.hidden);await dashboard.setViewport({width:1200,height:900});await mkdir(shots,{recursive:true});await dashboard.screenshot({path:path.join(shots,'login-lan.png')});
 await options.close();const reopened=await popup(browser,started.optionsUrl,errors);assert.equal(await reopened.$eval('#setup-address',e=>(e as HTMLInputElement).value),origin,'再次打开不用重填地址');assert.equal(await reopened.evaluate(()=>document.activeElement?.id),'setup-code');assert.deepEqual(errors,[]);
});
