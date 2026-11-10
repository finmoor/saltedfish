import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {type Browser} from 'puppeteer-core';
import {launchTestChrome} from './chrome-launch.js';
import {fixture} from './helpers.js';
import {bridgeToken} from '../src/auth.js';
import {projectDir} from '../src/config.js';
import {VERSION} from '../src/version.js';
import {windowsDesktopRegistry} from '../src/desktop-registration.js';
import {registerNativeSettings,unregisterNativeSettings,nativeSettingsHostName,unpackedExtensionOrigin} from '../src/native-settings-registration.js';

test('Windows真实Chrome点击扩展设置经Native Messaging登录目标页，复用同配置标签且不依赖终端或外部协议', {skip:process.platform!=='win32',timeout:60000},async t=>{
 const f=await fixture(),extensionDir=path.join(f.config.dataDir,'extension'),registry=windowsDesktopRegistry('native');
 const key='HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\'+nativeSettingsHostName(f.config.port);
 let browser:Browser|undefined,registered=false,codeRequests=0;
 // Chrome 必须读取正式根中的唯一随机端口项；只在该项原先不存在时创建，finally 精确注销。
 assert.equal(await registry.read(key),null,'隔离端口不能占用已有本机通信入口');
 t.after(async()=>{try{await browser?.close();}finally{try{if(registered)await unregisterNativeSettings(f.config);assert.equal(await registry.read(key),null);}finally{await f.cleanup();}}});
 await cp(path.join(projectDir,'dist/extension'),extensionDir,{recursive:true});
 await writeFile(path.join(extensionDir,'pairing.json'),JSON.stringify({port:f.config.port,token:bridgeToken(f.config)}));
 await writeFile(path.join(f.config.dataDir,'config.json'),JSON.stringify(f.config));
 await registerNativeSettings(f.config,{command:process.execPath,args:[path.join(projectDir,'dist/cli.js')]});registered=true;
 f.server.on('request',request=>{if(request.url==='/session/code'&&request.method==='POST')codeRequests++;});
 browser=await launchTestChrome({headless:true,pipe:true,userDataDir:path.join(f.config.dataDir,'chrome'),enableExtensions:[extensionDir],args:['--no-first-run']});
 const worker=await browser.waitForTarget(target=>target.type()==='service_worker'),extensionOrigin=`chrome-extension://${new URL(worker.url()).host}/`;
 assert.equal(extensionOrigin,unpackedExtensionOrigin(extensionDir),'实际Chrome ID必须匹配安装器授权的路径ID');
 const options=await browser.newPage(),errors:string[]=[];options.on('pageerror',error=>errors.push(String(error)));
 await options.goto(extensionOrigin+'options.html');await options.waitForSelector('#open-workbench[aria-disabled="false"]');
 const profileId=f.service.broker.listProfiles()[0]?.id;assert.ok(profileId);
 // 预先打开未登录标签，首次点击必须真的完成登录，而不是沿用夹具注入的管理员会话。
 const dashboard=await browser.newPage();await dashboard.goto(`http://127.0.0.1:${f.config.port}/#overview`);
 await dashboard.waitForFunction(()=>!document.querySelector<HTMLElement>('#login')!.hidden);
 await dashboard.evaluate(()=>{window.name='native-messaging-same-profile';});
 assert.equal(f.sessions.stats().sessions,0);assert.equal(codeRequests,0);
 for(const [button,route]of[['open-workbench','overview']]as const){
  const before:number=codeRequests;await options.bringToFront();await options.click('#'+button);
  // 不拦截click，不替换sendNativeMessage。Chrome启动实际exe，exe->CLI->一次性码->真实管理页。
  await dashboard.waitForFunction(route=>location.hash.startsWith('#'+route)&&document.querySelector<HTMLElement>('#login')!.hidden&&!document.querySelector<HTMLElement>('#'+route)!.hidden,{timeout:20000},route);
  await options.waitForFunction(()=>document.querySelector('#settings-launch-message')?.textContent==='已打开当前服务的管理页。');
  assert.equal(codeRequests,before+1,'每次用户点击只签发一次登录码');assert.equal(f.sessions.stats().pendingCodes,0,'目标页已消费一次性登录码');
  assert.equal(await dashboard.evaluate(()=>window.name),'native-messaging-same-profile');assert.equal((await browser.pages()).filter(page=>page.url().startsWith(`http://127.0.0.1:${f.config.port}/`)).length,1);
  assert.equal(await dashboard.evaluate(()=>location.search),'','地址栏不残留登录参数');
 }
 const output=path.join(projectDir,'.local/verification',`native-settings-${VERSION}-${Date.now()}`);await mkdir(output,{recursive:true});
 await dashboard.screenshot({path:path.join(output,'native-open-overview.png'),fullPage:true});
 await options.screenshot({path:path.join(output,'extension-native-success.png'),fullPage:true});assert.deepEqual(errors,[]);
 console.log(JSON.stringify({nativeSettings:{realChromeNativeMessaging:true,routes:1,codeRequests,sameProfileReused:true,screenshots:output}}));
});
