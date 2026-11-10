import test from 'node:test';
import assert from 'node:assert/strict';
import {networkInterfaces} from 'node:os';
import {cp,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';import {pathToFileURL} from 'node:url';
import {type Browser} from 'puppeteer-core';
import {launchTestChrome} from './chrome-launch.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {fixture} from './helpers.js';import {startServer} from '../src/http-server.js';import {projectDir} from '../src/config.js';import {privateAddress} from '../src/service-address.js';

const host=Object.values(networkInterfaces()).flat().find(item=>item?.family==='IPv4'&&!item.internal&&privateAddress(item.address))?.address;
test('可信内网IP直连：真实HTTP管理页、WS扩展、MCP及非安全上下文的编号和复制完整可用',{skip:!host,timeout:90000},async t=>{
 const product=process.env.PRODUCT_SERVICE_ROOT||projectDir,start=process.env.PRODUCT_SERVICE_ROOT?(await import(pathToFileURL(path.join(product,'dist/http-server.js')).href)).startServer as typeof startServer:startServer;
 const f=await fixture({},(config,options)=>start({...config,directConnections:true,network:{host:host!,publicUrl:`http://${host}:${config.port}`,allowInsecureLan:true}},options));
 const origin=`http://${host}:${f.config.port}`,extension=path.join(f.config.dataDir,'extension');let profileId='',browser:Browser|undefined,sdk:Client|undefined,transport:StreamableHTTPClientTransport|undefined;
 t.after(async()=>{try{await transport?.terminateSession().catch(()=>{});await sdk?.close();await browser?.close();}finally{await f.cleanup();}});
 const pair=await f.pairings.create({label:'内网IP验收',canManage:true});await cp(path.join(product,'dist/extension'),extension,{recursive:true});await writeFile(path.join(extension,'pairing.json'),JSON.stringify({port:f.config.port,serviceUrl:origin,...pair}));
 browser=await launchTestChrome({headless:true,pipe:true,enableExtensions:[extension],userDataDir:path.join(f.config.dataDir,'chrome'),args:['--no-first-run']});
 const worker=await browser.waitForTarget(target=>target.type()==='service_worker'),extensionId=new URL(worker.url()).hostname,options=await browser.newPage(),errors:string[]=[];
 options.on('pageerror',error=>errors.push(String(error)));await options.goto(`chrome-extension://${extensionId}/options.html`);await options.waitForFunction(()=>document.querySelector('#status')?.getAttribute('data-state')==='connected');
 assert.equal(await options.$eval('#service-address',e=>e.textContent),origin);assert.match(await options.$eval('#service-connection-state',e=>e.textContent||''),/内网 HTTP/);assert.equal(f.service.broker.listProfiles()[0]?.connectionType,'direct');
 assert.equal(f.service.broker.listProfiles().length,1);profileId=f.service.broker.listProfiles()[0]!.id;assert.equal(f.pairings.get(pair.pairingId)?.profileId,profileId);
 const client=f.service.state.createClient('内网SDK',[profileId]);sdk=new Client({name:'lan-ip-test',version:'1'});transport=new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+client.token}}});await sdk.connect(transport);assert.equal((await sdk.listTools()).tools.length,46);
 const profiles=(await sdk.callTool({name:'chrome_profiles',arguments:{}})).structuredContent as any;assert.equal(profiles.data.profiles[0].id,profileId);
 const dashboard=await browser.newPage();dashboard.on('pageerror',error=>errors.push(String(error)));await dashboard.goto(origin+'/#overview');await dashboard.waitForSelector('#login:not([hidden])');
 const context=await dashboard.evaluate(()=>({secure:isSecureContext,randomUUID:typeof crypto.randomUUID}));assert.deepEqual(context,{secure:false,randomUUID:'undefined'});
 await options.bringToFront();await options.click('#open-workbench');await dashboard.waitForFunction(()=>document.querySelector<HTMLElement>('#login')!.hidden&&!document.querySelector<HTMLElement>('#overview')!.hidden);
 const generated=await dashboard.evaluate(async()=>{const module=await import(location.origin+'/random-id.js');return[module.randomId(),module.randomId()];});assert.notEqual(generated[0],generated[1]);assert.ok(generated.every(id=>/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)));
 await dashboard.goto(origin+'/#accounts');await dashboard.waitForSelector('#pair-browser-label');await dashboard.$eval('#add-browser',e=>(e as HTMLDetailsElement).open=true);await dashboard.type('#pair-browser-label','独立配对');await dashboard.click('#create-browser-pairing');await dashboard.waitForSelector('#browser-pairing-created:not([hidden])');
 const code=await dashboard.$eval('#browser-connection-code',e=>(e as HTMLTextAreaElement).value);assert.ok(code.startsWith('sf-connect:'));
 // 记录浏览器的兼容复制调用；测试不写入用户的系统剪贴板。
 await dashboard.evaluate(()=>{document.execCommand=((command:string)=>{(window as any).__copyProbe={command,text:(document.activeElement as HTMLTextAreaElement)?.value};return true;}) as typeof document.execCommand;});
 await dashboard.click('#copy-browser-pairing');assert.deepEqual(await dashboard.evaluate(()=>(window as any).__copyProbe),{command:'copy',text:code});assert.equal(await dashboard.$eval('#copy-browser-pairing',e=>e.textContent),'已复制');
 await dashboard.goto(origin+'/#remote');await dashboard.waitForSelector('#remote:not([hidden])');assert.equal(await dashboard.$eval('#connected-service-url',e=>e.textContent),origin);assert.equal(await dashboard.$eval('#connected-service-transport',e=>e.textContent),'内网 HTTP · 未加密');
 const output=path.join(projectDir,'.local/verification','unified-lan-ui-'+Date.now());await mkdir(output,{recursive:true});await options.setViewport({width:1440,height:1000});await options.screenshot({path:path.join(output,'extension.png'),fullPage:true});await dashboard.screenshot({path:path.join(output,'service.png'),fullPage:true});assert.deepEqual(errors,[]);
 console.log(JSON.stringify({lanIp:true,directWs:true,httpMcp:true,nativeHostRequired:false,secureContext:false,uuidFallback:true,copyFallback:true,screenshots:output}));
});
