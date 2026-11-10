import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {networkInterfaces} from 'node:os';
import path from 'node:path';
import {type Browser,type Page,type Target} from 'puppeteer-core';
import {launchTestChrome} from './chrome-launch.js';
import {fixture,testDirectory} from './helpers.js';
import {startServer} from '../src/http-server.js';
import {projectDir} from '../src/config.js';
import {privateAddress} from '../src/service-address.js';

// 真实 Chrome + 真实服务走一遍一键更新：真实的文件夹选择框和 Chrome 授权由 self-update-dialogs.ps1 应答。
// 要有桌面，会弹出一个 Chrome 窗口，所以不进发行门禁，改了更新流程时手动跑 npm run test:self-update。
// CHROME_TEST_EXECUTABLE 可以指向正式版 Chrome，用的是独立的临时配置。
// 用本机的内网 IP：真实用户的服务常在另一台电脑，扩展页面要能下载私网地址上的更新包。
const host=Object.values(networkInterfaces()).flat().find(item=>item?.family==='IPv4'&&!item.internal&&privateAddress(item.address))?.address??'127.0.0.1';
const answers=path.join(projectDir,'tests/self-update-dialogs.ps1'),built=path.join(projectDir,'dist/extension');
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const manifestOf=async(folder:string)=>JSON.parse(await readFile(path.join(folder,'manifest.json'),'utf8'));
async function pretendOlder(folder:string,version:string){await writeFile(path.join(folder,'manifest.json'),JSON.stringify({...await manifestOf(folder),version,version_name:'旧版本'}));}
function answerDialogs(browser:Browser,folder:string,log:string,seconds=25){return spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',answers,folder,log,String(browser.process()!.pid),String(seconds)],{stdio:'ignore',windowsHide:true});}
async function openOptions(browser:Browser,id:string){const page=await browser.newPage();await page.goto(`chrome-extension://${id}/options.html`);return page;}
const updatedPage=(target:Target)=>target.url().endsWith('options.html#updated');
const title=(page:Page)=>page.$eval('#update-title',element=>element.textContent||'');
const stuck=(page:Page,log:string)=>async(error:unknown):Promise<never>=>{throw new Error(`${error}\n页面提示：${await page.$eval('#update-result',element=>element.textContent).catch(()=>'页面已关闭')}\n选择框记录：${await readFile(log,'utf8').catch(()=>'无')}`);};

test('一键更新：选错文件夹被拦下，选对后更新并保持配对；第二次不用再选文件夹',{timeout:150000},async t=>{
 const f=await fixture({},config=>startServer({...config,directConnections:true,network:{host,publicUrl:`http://${host}:${config.port}`,allowInsecureLan:true}})),work=await testDirectory();let browser:Browser|undefined;
 t.after(async()=>{try{await browser?.close();}finally{await f.cleanup();await work.cleanup();}});
 const release=await manifestOf(built),folder=path.join(work.directory,'loaded-extension'),wrong=path.join(work.directory,'unpacked-copy'),log=path.join(work.directory,'dialogs.log');
 const pairing=await f.pairings.create({label:'更新测试'});
 await cp(built,folder,{recursive:true});await cp(built,wrong,{recursive:true});await pretendOlder(folder,'0.0.1');
 await writeFile(path.join(folder,'pairing.json'),JSON.stringify({serviceUrl:`http://${host}:${f.config.port}`,pairingId:pairing.pairingId,token:pairing.token}));
 await mkdir(path.join(work.directory,'chrome'));
 const launch=()=>launchTestChrome({headless:false,pipe:true,enableExtensions:[folder],userDataDir:path.join(work.directory,'chrome'),args:['--no-first-run','--no-default-browser-check','--lang=en-US','--window-size=900,700'],defaultViewport:null});
 browser=await launch();
 const worker=await browser.waitForTarget(target=>target.type()==='service_worker'),id=new URL(worker.url()).hostname;
 // 手动加载扩展时开发者模式是开着的；关着的话重载后扩展会被停用。
 const manager=await browser.newPage();await manager.goto('chrome://extensions');await manager.evaluate(()=>(globalThis as any).chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true}));
 for(let i=0;i<100&&!f.service.broker.listProfiles().length;i++)await sleep(100);
 const profileId=f.service.broker.listProfiles()[0]?.id;assert.ok(profileId,'扩展要先连上服务');

 const first=await openOptions(browser,id);await first.waitForSelector('#update-strip:not([hidden])',{timeout:10000});
 assert.match(await title(first),new RegExp(release.version_name.replaceAll('.','\\.')));
 const wrongBefore=await readFile(path.join(wrong,'background.js'),'utf8'),oldVersion=(await manifestOf(folder)).version;
 let dialogs=answerDialogs(browser,wrong,log);await sleep(1200);await first.click('#update-button');
 await first.waitForFunction(()=>/不是 Chrome 正在加载/.test(document.querySelector('#update-result')?.textContent||''),{timeout:25000}).catch(stuck(first,log));dialogs.kill();
 assert.equal(await first.$eval('#update-folder',element=>(element as HTMLElement).hidden),false,'选错时给出查看文件夹位置的入口');
 assert.equal(await readFile(path.join(wrong,'background.js'),'utf8'),wrongBefore);assert.equal((await manifestOf(folder)).version,oldVersion);
 assert.equal((await readFile(log,'utf8')).includes('folder picker'),true);

 dialogs=answerDialogs(browser,folder,log);await sleep(1200);await first.click('#update-button');
 const clicked=Date.now(),updated=(await (await browser.waitForTarget(updatedPage,{timeout:40000}).catch(stuck(first,log))).page())!;dialogs.kill();
 await updated.waitForSelector('#update-strip:not([hidden])',{timeout:10000});
 assert.match(await title(updated),/已更新到/);
 assert.equal(await updated.evaluate(()=>(globalThis as any).chrome.runtime.getManifest().version),release.version);
 assert.equal((await readFile(path.join(folder,'background.js'))).equals(await readFile(path.join(built,'background.js'))),true,'文件换成了服务带的版本');
 for(let i=0;i<100&&f.service.broker.profiles.get(profileId)?.info.version!==release.version;i++)await sleep(100);
 assert.equal(f.service.broker.profiles.get(profileId)?.info.version,release.version,'重载后用原来的身份和配对重新连上了');
 assert.ok(Date.now()-clicked<20000,'点更新到重新连上不超过 20 秒');

 // 第二次：过了一段时间再更新。浏览器重启过，文件夹还记得，不再弹选择框，只有 Chrome 的授权。
 await browser.close();await writeFile(log,'');await pretendOlder(folder,'0.0.2');
 browser=await launch();
 const second=await openOptions(browser,id);await second.waitForSelector('#update-strip:not([hidden])',{timeout:15000});assert.equal(await second.$eval('#update-button',element=>element.textContent),'更新');
 dialogs=answerDialogs(browser,folder,log);await sleep(1200);await second.click('#update-button');
 const again=(await (await browser.waitForTarget(updatedPage,{timeout:40000}).catch(stuck(second,log))).page())!;dialogs.kill();
 await again.waitForFunction(()=>/已更新到/.test(document.querySelector('#update-title')?.textContent||''),{timeout:10000});
 assert.equal(await again.evaluate(()=>(globalThis as any).chrome.runtime.getManifest().version),release.version);
 assert.equal((await readFile(log,'utf8')).includes('folder picker'),false,'第二次不再弹选择框');
});
