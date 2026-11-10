import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {cp,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {type Browser} from 'puppeteer-core';
import {launchTestChrome} from './chrome-launch.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {unifiedFixture,fakeProfile} from './helpers.js';
import {projectDir} from '../src/config.js';
import {VERSION} from '../src/version.js';
import {encodeRemoteMachineReport,REMOTE_MACHINE_HEADER} from '../src/remote-protocol.js';

async function harness(t:TestContext,canManage=false){
 const f=await unifiedFixture(),origin=`http://127.0.0.1:${f.config.port}`,extension=path.join(f.config.dataDir,'extension'),pairing=await f.pairings.create({label:'原浏览器',canManage});
 let browser:Browser|undefined;const clients:{client:Client;transport:StreamableHTTPClientTransport}[]=[];
 t.after(async()=>{try{for(const item of clients){await item.transport.terminateSession().catch(()=>{});await item.client.close();}await browser?.close();}finally{await f.cleanup();}});
 await cp(path.join(process.env.PRODUCT_SERVICE_ROOT||projectDir,'dist/extension'),extension,{recursive:true});await writeFile(path.join(extension,'pairing.json'),JSON.stringify({port:f.config.port,serviceUrl:origin,...pairing}));
 browser=await launchTestChrome({headless:true,pipe:true,userDataDir:path.join(f.config.dataDir,'chrome'),enableExtensions:[extension],args:['--no-first-run']});
 const worker=await browser.waitForTarget(target=>target.type()==='service_worker'),options=await browser.newPage(),errors:string[]=[];options.on('pageerror',error=>errors.push(String(error)));await options.goto(`chrome-extension://${new URL(worker.url()).hostname}/options.html`);await options.waitForFunction(()=>document.querySelector('#status')?.getAttribute('data-state')==='connected');
 const profile=f.service.broker.listProfiles()[0]!;
 const connect=async(label:string,profiles:string[],machine=false)=>{
  const grant=f.service.state.createClient(label,profiles),client=new Client({name:label,version:'1'}),headers:Record<string,string>={authorization:'Bearer '+grant.token};
  if(machine)headers[REMOTE_MACHINE_HEADER]=encodeRemoteMachineReport({hostname:'Agent电脑',reportedAddresses:['172.17.0.1','192.0.2.30'],reportId:randomUUID(),reportedAt:new Date().toISOString(),reportSource:'setup_report'});
  const transport=new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers}});clients.push({client,transport});await client.connect(transport);return{grant,client};
 };
 return{f,origin,browser,options,profile,errors,connect};
}

test('扩展统一空态和当前服务入口：无管理授权直接进入对应服务登录页，无需Native Messaging',{timeout:30000},async t=>{
 const h=await harness(t);await h.options.waitForFunction(()=>document.querySelector('#group-list')?.textContent?.includes('还没有 Agent 获准使用这个浏览器，到管理页授权'),{polling:100});assert.equal(await h.options.$$('.agent-card').then(v=>v.length),0);assert.equal(await h.options.$('#add-agent'),null);assert.equal(await h.options.$('#agent-list'),null);assert.equal(await h.options.$('#open-local'),null);assert.equal(await h.options.$('#open-remote'),null);
 await h.options.click('#open-workbench');await h.options.waitForFunction(()=>document.querySelector('#settings-launch-message')?.textContent?.includes('请使用管理员身份登录'),{polling:100});const page=(await h.browser.pages()).find(page=>page.url().startsWith(h.origin));assert.ok(page);assert.equal(new URL(page.url()).origin,h.origin);assert.equal(h.f.sessions.stats().sessions,0);
 const out=path.join(projectDir,'.local/verification',`unified-empty-${Date.now()}`);await mkdir(out,{recursive:true});for(const width of[1440,390,320]){await h.options.setViewport({width,height:900});assert.equal(await h.options.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await h.options.screenshot({path:path.join(out,width+'.png'),fullPage:true});}assert.deepEqual(h.errors,[]);
});

test('真实 HTTP 会话开标签页：扩展页和管理页都按标签组显示，结束并释放后组解散',{timeout:40000},async t=>{
 const h=await harness(t,true),a=await h.connect('Claude Code',[h.profile.id]);h.f.service.state.createClient('还没用过',[h.profile.id]);
 const opened=await a.client.callTool({name:'chrome_new_tab',arguments:{profileId:h.profile.id,url:'data:text/html;charset=utf-8,<title>订单列表</title>'}}) as any;assert.equal(opened.isError,false,JSON.stringify(opened));
 await h.options.waitForFunction(()=>document.querySelector('#group-list .group-card')?.textContent?.includes('Claude Code'),{polling:100});
 const card=await h.options.$eval('#group-list',e=>e.textContent!);assert.match(card,/Claude Code.*会话 [0-9a-f]{6} · Claude Code 1 · 在线.*1 个标签页 · 上次操作.*使用中/);
 assert.doesNotMatch(card,/还没用过/,'授权列表留给管理页');
 assert.equal(opened.structuredContent.data.group.title,'Claude Code');
 await h.options.bringToFront();await h.options.focus('.group-actions button:last-of-type');await h.options.$eval('.group-card',e=>{(e as HTMLElement).dataset.before='1';});
 assert.equal((await a.client.callTool({name:'chrome_evaluate',arguments:{profileId:h.profile.id,tabId:opened.structuredContent.data.tabId,expression:'1'}}) as any).isError,false);
 await h.options.waitForFunction(()=>!document.querySelector<HTMLElement>('.group-card')!.dataset.before,{polling:100});assert.equal(await h.options.evaluate(()=>document.activeElement?.textContent),'结束并释放','卡片重建后焦点还在原来的按钮上');
 const out=path.join(projectDir,'.local/verification',`tab-groups-${Date.now()}`);await mkdir(out,{recursive:true});for(const width of[1440,390,320]){await h.options.setViewport({width,height:900});assert.equal(await h.options.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await h.options.screenshot({path:path.join(out,'extension-'+width+'.png'),fullPage:true});}
 const page=await h.browser.newPage();await page.goto(h.origin+'/#'+h.f.config.token);await page.waitForFunction(()=>document.querySelector<HTMLElement>('#login')!.hidden);await page.click('nav a[href="#agents"]');await page.waitForFunction(()=>document.querySelector('#group-list .group-card'));
 assert.equal(await page.$eval('#agents-groups-total',e=>e.textContent),'1');assert.match(await page.$eval('#group-list',e=>e.textContent!),/Claude Code.*会话 [0-9a-f]{6}.*1 个标签页/);
 for(const width of[1440,390]){await page.setViewport({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(out,'admin-'+width+'.png'),fullPage:true});}
 await page.evaluate(()=>document.querySelector<HTMLElement>('#group-list button')!.click());await new Promise(r=>setTimeout(r,500));await page.bringToFront();await page.evaluate(()=>document.querySelectorAll<HTMLElement>('#group-list button')[1]!.click());await page.waitForFunction(()=>document.querySelector('#agents-groups-total')?.textContent==='0',{polling:100});assert.match(await page.$eval('#group-list',e=>e.textContent!),/现在没有 Agent 在用浏览器/);
 assert.deepEqual(await h.f.service.groups.list(h.profile.id),[]);assert.deepEqual(h.errors,[]);
});

test('真实管理页统一Agent、HTTP会话、浏览器筛选和占用，新增授权直接生成配置',{timeout:30000},async t=>{
 const h=await harness(t,true),otherId=randomUUID(),pair=await h.f.pairings.create({label:'工作浏览器',profileId:otherId});await fakeProfile(h.f.config,'工作浏览器',()=>[{tabId:7,url:'https://example.test/'}],otherId,{pairing:pair});const a=await h.connect('Codex',[h.profile.id]),b=await h.connect('Claude',[otherId]);h.f.service.state.createClient('尚未连接',[h.profile.id]);assert.equal((await b.client.callTool({name:'chrome_claim_tab',arguments:{profileId:otherId,tabId:7}})).isError,false);
 const page=await h.browser.newPage();await page.goto(h.origin+'/#'+h.f.config.token);await page.waitForFunction(()=>document.querySelector<HTMLElement>('#login')!.hidden);await page.click('nav a[href="#agents"]');await page.waitForFunction(()=>document.querySelectorAll('#agent-list .agent-card').length===3);assert.match(await page.$eval('#agent-list',e=>e.textContent!),/Claude.*使用中.*标签 7/);
 await page.select('#agent-profile',h.profile.id);await page.waitForFunction(()=>document.querySelectorAll('#agent-list .agent-card').length===2);assert.doesNotMatch(await page.$eval('#agent-list',e=>e.textContent!),/Claude/);
 await page.click('#add-agent');await page.waitForSelector('#agent-add-dialog[open]');assert.equal(await page.$eval('#new-agent-profile',e=>(e as HTMLSelectElement).value),h.profile.id);await page.type('#new-agent-name','新的 Agent');await page.click('#create-agent');await page.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>('#new-agent-configuration')!.value.includes('/mcp'));const configuration=await page.$eval('#new-agent-configuration',e=>(e as HTMLTextAreaElement).value);assert.ok(configuration.includes(h.origin));assert.ok(configuration.includes('32768'));await page.click('#close-agent-add');await page.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>('#new-agent-configuration')!.value.length===0);
 const out=path.join(projectDir,'.local/verification',`unified-agent-${Date.now()}`);await mkdir(out,{recursive:true});for(const width of[1440,390]){await page.setViewport({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(out,width+'.png'),fullPage:true});}await b.client.callTool({name:'chrome_release_tab',arguments:{profileId:otherId,tabId:7}});assert.equal(h.f.service.state.authenticate(a.grant.token)?.id,a.grant.id);assert.deepEqual(h.errors,[]);
});

test('真实扩展改名草稿和选择区在轮询后保持，打开管理页登录当前服务',{timeout:30000},async t=>{
 const h=await harness(t,true);await h.connect('Codex',[h.profile.id],true);await h.options.click('#edit-name');await h.options.$eval('#profile-name-input',e=>{const input=e as HTMLInputElement;input.value='尚未保存的名称';input.focus();input.setSelectionRange(1,3);});await new Promise(resolve=>setTimeout(resolve,4300));assert.deepEqual(await h.options.$eval('#profile-name-input',e=>({value:(e as HTMLInputElement).value,start:(e as HTMLInputElement).selectionStart,end:(e as HTMLInputElement).selectionEnd,focused:document.activeElement===e})),{value:'尚未保存的名称',start:1,end:3,focused:true});await h.options.click('#cancel-name');
 await h.options.click('#open-workbench');const target=await h.browser.waitForTarget(p=>p.url().startsWith(h.origin)),page=await target.page();assert.ok(page);await page.waitForFunction(()=>document.querySelector<HTMLElement>('#login')!.hidden&&!document.querySelector<HTMLElement>('#overview')!.hidden,{polling:100});assert.deepEqual(h.errors,[]);
});
