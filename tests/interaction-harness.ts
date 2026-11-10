import assert from 'node:assert/strict';
import {cp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:http';
import {type Browser} from 'puppeteer-core';
import {launchTestChrome} from './chrome-launch.js';
import {fixture,freePort} from './helpers.js';
import {projectDir} from '../src/config.js';
import {bridgeToken} from '../src/auth.js';
import {pathToFileURL} from 'node:url';

// 所有页面、扩展和进程都在隔离测试目录，不接入日常 Chrome。
export async function interactionHarness(t:any,html:string,options:{chromeArgs?:string[]}={}){
 const oldServer=process.env.INTERACTION_SERVICE_ROOT?await import(pathToFileURL(path.join(process.env.INTERACTION_SERVICE_ROOT,'dist/http-server.js')).href):undefined;
 const f=await fixture({},oldServer?.startServer);let browser:Browser|undefined;
 const port=await freePort(),web=createServer((_req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(html);});
 await new Promise<void>(r=>web.listen(port,'127.0.0.1',r));
 t.after(async()=>{await browser?.close();web.closeAllConnections();await new Promise<void>(r=>web.close(()=>r()));await f.cleanup();});
 const ext=path.join(f.config.dataDir,'extension');await cp(process.env.INTERACTION_EXTENSION||path.join(projectDir,'dist/extension'),ext,{recursive:true});
 await writeFile(path.join(ext,'pairing.json'),JSON.stringify({port:f.config.port,token:bridgeToken(f.config)}));
 // INTERACTION_HEADFUL=1 时开带窗口的 Chrome（手动核对后台标签页这类和窗口有关的行为，会弹出窗口，不进门禁）。
 browser=await launchTestChrome({headless:!process.env.INTERACTION_HEADFUL,pipe:true,userDataDir:path.join(f.config.dataDir,'chrome'),enableExtensions:[ext],args:['--no-first-run','--site-per-process',...(options.chromeArgs||[])]});
 for(let i=0;i<100&&!f.service.broker.listProfiles().length;i++)await new Promise(r=>setTimeout(r,100));
 const profile=f.service.broker.listProfiles()[0];assert.ok(profile,'extension connected');
 const profileId=profile.id;
 const workerTarget=await browser.waitForTarget(x=>x.type()==='service_worker'),worker=await workerTarget.worker();assert.ok(worker);
 await worker.evaluate(()=>{const root=globalThis as any,original=chrome.debugger.sendCommand;root.__sfTestMetrics={calls:0,bytes:0,methods:{},trace:[]};chrome.debugger.sendCommand=function(...args:any[]){const m=root.__sfTestMetrics,start=performance.now();m.calls++;m.bytes+=JSON.stringify(args).length;m.methods[args[1]]=(m.methods[args[1]]||0)+1;const result=Reflect.apply(original,chrome.debugger,args);return result.finally(()=>{if(m.trace.length<10000)m.trace.push({method:args[1],type:args[2]?.type,ms:performance.now()-start});}); } as typeof original;});
 async function open(){
  const page=await browser!.newPage();await page.goto(`http://127.0.0.1:${port}/`);
  const tabs=await f.service.invoke('chrome_tabs',{profileId},'interaction-test');assert.ok(tabs.ok);
  const found=(tabs.data as any).items.filter((x:any)=>x.url===page.url()).at(-1);assert.ok(found);
  const target={profileId,tabId:found.tabId};
  const raw=(name:string,args:any={})=>f.service.invoke(name,{...target,...args},'interaction-test');
  const call=async(name:string,args:any={})=>{const result=await raw(name,args);assert.ok(result.ok,`${name}: ${JSON.stringify(result.error||result.data)}`);return result.data as any;};
  return {page,target,raw,call};
 }
 const metrics=()=>worker.evaluate(()=>structuredClone((globalThis as any).__sfTestMetrics));
 // 扩展设置页里的“显示 Agent 光标”“像真人一样操作”开关，和用户点它们走同一条消息。
 async function setting(name:'showCursor'|'humanInput',enabled:boolean){
  const options=await browser!.newPage();
  try{await options.goto(`chrome-extension://${new URL(workerTarget.url()).hostname}/options.html`);const result=await options.evaluate(([type,value])=>(globalThis as any).chrome.runtime.sendMessage({type,enabled:value}),[`settings.${name}`,enabled] as const);assert.equal(result?.[name],enabled,JSON.stringify(result));}
  finally{await options.close();}
 }
 const showCursor=(enabled:boolean)=>setting('showCursor',enabled),humanInput=(enabled:boolean)=>setting('humanInput',enabled);
 return {...f,browser,worker,profile,open,metrics,port,showCursor,humanInput};
}
