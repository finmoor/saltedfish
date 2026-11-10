import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {launchTestChrome} from './chrome-launch.js';
import {unifiedFixture} from './helpers.js';
import {projectDir} from '../src/config.js';
import {VERSION} from '../src/version.js';

test('统一服务：真实Chrome直接配对、管理页同源登录、新增Agent生成HTTP配置，不需要Native Messaging中转',{timeout:60000},async t=>{
 const f=await unifiedFixture();let browser:import('puppeteer-core').Browser|undefined;t.after(async()=>{try{await browser?.close();}finally{await f.cleanup();}});const origin=`http://127.0.0.1:${f.config.port}`,pairing=await f.pairings.create({label:'测试浏览器',canManage:true});
 const extension=path.join(f.config.dataDir,'extension');await cp(path.join(process.env.PRODUCT_SERVICE_ROOT||projectDir,'dist/extension'),extension,{recursive:true});await writeFile(path.join(extension,'pairing.json'),JSON.stringify({port:f.config.port,serviceUrl:origin,...pairing}));
 browser=await launchTestChrome({headless:true,pipe:true,enableExtensions:[extension],userDataDir:path.join(f.config.dataDir,'chrome'),args:['--no-first-run']});
 const worker=await browser.waitForTarget(target=>target.type()==='service_worker');const extensionId=new URL(worker.url()).hostname;
 const options=await browser.newPage(),errors:string[]=[];options.on('pageerror',error=>errors.push(String(error)));await options.goto(`chrome-extension://${extensionId}/options.html`);await options.waitForFunction(()=>document.querySelector('#status')?.getAttribute('data-state')==='connected');
 const profile=f.service.broker.listProfiles()[0]!;assert.equal(profile.connectionType,'direct');assert.equal(f.pairings.get(pairing.pairingId)?.profileId,profile.id);assert.equal(await options.$eval('#service-address',e=>e.textContent),origin);
 assert.equal(await options.$('#open-local'),null);assert.equal(await options.$('#open-remote'),null);
 const dashboard=await browser.newPage();await dashboard.goto(origin+'/#overview');await dashboard.waitForFunction(()=>!document.querySelector<HTMLElement>('#login')!.hidden);assert.equal(f.sessions.stats().sessions,0);
 await options.bringToFront();await options.click('#open-workbench');await dashboard.waitForFunction(()=>document.querySelector<HTMLElement>('#login')!.hidden&&!document.querySelector<HTMLElement>('#overview')!.hidden);assert.equal(new URL(dashboard.url()).origin,origin);assert.equal(f.sessions.stats().pendingCodes,0);
 await dashboard.bringToFront();await dashboard.click('nav a[href="#agents"]');await dashboard.waitForSelector('#add-agent');await dashboard.click('#add-agent');await dashboard.waitForSelector('#agent-add-dialog[open]');await dashboard.select('#new-agent-profile',profile.id);
 await dashboard.type('#new-agent-name','Codex · 另一台电脑');await dashboard.click('#create-agent');await dashboard.waitForFunction(()=>!document.querySelector<HTMLElement>('#agent-created')!.hidden);const snippet=await dashboard.$eval('#new-agent-configuration',e=>(e as HTMLTextAreaElement).value);assert.ok(snippet.includes(origin+'/mcp'));assert.ok(snippet.includes('tool_input_schema_max_bytes = 32768'));assert.equal(f.service.state.listClients().length,1);
 await dashboard.click('#close-agent-add');
 // 高级工具开关：新 Agent 默认关，管理页打开后写进授权记录。
 const added=()=>f.service.state.listClients().find(item=>item.label==='Codex · 另一台电脑')!;await dashboard.waitForSelector('[data-action="advanced"]');assert.equal(added().advancedTools,false);await dashboard.click('[data-action="advanced"]');for(let i=0;i<100&&!added().advancedTools;i++)await new Promise(r=>setTimeout(r,20));assert.equal(added().advancedTools,true);await dashboard.waitForFunction(()=>document.querySelector<HTMLInputElement>('[data-action="advanced"]')?.checked===true);
 await dashboard.goto(origin+'/#accounts');await dashboard.waitForSelector('#pair-browser-label');await dashboard.$eval('#add-browser',e=>(e as HTMLDetailsElement).open=true);await dashboard.type('#pair-browser-label','第二个浏览器');await dashboard.click('#create-browser-pairing');await dashboard.waitForFunction(()=>!document.querySelector<HTMLElement>('#browser-pairing-created')!.hidden);const code=await dashboard.$eval('#browser-connection-code',e=>(e as HTMLTextAreaElement).value);assert.ok(code.startsWith('sf-connect:'));assert.equal(f.pairings.list().length,2);
 await options.bringToFront();await options.waitForFunction(()=>document.querySelector('#group-list')?.textContent?.includes('现在没有 Agent 在用这个浏览器'));
 const out=path.join(projectDir,'.local/verification',`unified-ui-${VERSION}-${Date.now()}`);await mkdir(out,{recursive:true});await options.setViewport({width:1440,height:1000});await options.screenshot({path:path.join(out,'extension-desktop.png'),fullPage:true});await options.setViewport({width:390,height:844});assert.equal(await options.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await options.screenshot({path:path.join(out,'extension-mobile.png'),fullPage:true});await dashboard.goto(origin+'/#remote');await dashboard.waitForSelector('#remote:not([hidden])');await dashboard.screenshot({path:path.join(out,'service-page.png'),fullPage:true});assert.deepEqual(errors,[]);console.log(JSON.stringify({directChrome:true,nativeHostRegistered:false,serviceUrl:origin,screenshots:out}));
});
