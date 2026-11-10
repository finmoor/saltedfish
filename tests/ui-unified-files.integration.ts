import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdir,writeFile,unlink,open,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {randomUUID,createHash,randomBytes} from 'node:crypto';
import path from 'node:path';
import {type Browser} from 'puppeteer-core';
import {launchTestChrome} from './chrome-launch.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {unifiedFixture,freePort} from './helpers.js';
import {projectDir} from '../src/config.js';
import {registerNativeSettings,unregisterNativeSettings,nativeSettingsHostName} from '../src/native-settings-registration.js';
import {windowsDesktopRegistry} from '../src/desktop-registration.js';
import {FILE_CHUNK_BYTES,FILE_MAX_BYTES} from '../src/file-limits.js';

test('直连真实Chrome文件流程：服务内容上传不依赖助手，下载导出按需使用实际Native助手且不读取真实用户文件',{skip:process.platform!=='win32',timeout:90000},async t=>{
 const f=await unifiedFixture(),origin=`http://127.0.0.1:${f.config.port}`,helperData=path.join(f.config.dataDir,'helper'),downloads=path.join(f.config.dataDir,'synthetic-downloads'),extension=path.join(f.config.dataDir,'extension');
 let browser:Browser|undefined,registered=false,sdk:Client|undefined,transport:StreamableHTTPClientTransport|undefined;
 const payload=Buffer.from('Synthetic direct transfer 测试文件\n'.repeat(19000)),sha=createHash('sha256').update(payload).digest('hex');
 const web=createServer((request,response)=>{if(request.url==='/download'){response.writeHead(200,{'content-type':'application/octet-stream','content-disposition':'attachment; filename="synthetic-download.bin"'});response.end(payload);}else{response.writeHead(200,{'content-type':'text/html; charset=utf-8'});response.end('<!doctype html><html><body><input id="upload" type="file" multiple><p id="events">0</p><script>upload.addEventListener("change",()=>events.textContent=String(Number(events.textContent)+1))</script></body></html>');}});
 const webPort=await freePort();await new Promise<void>(resolve=>web.listen(webPort,'127.0.0.1',resolve));
 const registry=windowsDesktopRegistry('native'),key='HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\'+nativeSettingsHostName(f.config.port);assert.equal(await registry.read(key),null);
 t.after(async()=>{try{await transport?.terminateSession().catch(()=>{});await sdk?.close();await browser?.close();}finally{try{if(registered)await unregisterNativeSettings({dataDir:helperData,port:f.config.port});assert.equal(await registry.read(key),null);}finally{await new Promise<void>(resolve=>web.close(()=>resolve()));await f.cleanup();}}});
 await mkdir(downloads,{recursive:true});await cp(path.join(process.env.PRODUCT_SERVICE_ROOT||projectDir,'dist/extension'),extension,{recursive:true});const pairing=await f.pairings.create({label:'文件测试'});await writeFile(path.join(extension,'pairing.json'),JSON.stringify({port:f.config.port,serviceUrl:origin,...pairing}));
 browser=await launchTestChrome({headless:true,pipe:true,enableExtensions:[extension],userDataDir:path.join(f.config.dataDir,'chrome'),args:['--no-first-run']});
 const control=await browser.target().createCDPSession();await control.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
 for(let i=0;i<100&&!f.service.broker.listProfiles().length;i++)await new Promise(resolve=>setTimeout(resolve,50));const profile=f.service.broker.listProfiles()[0]!;assert.ok(profile);assert.equal(profile.connectionType,'direct');
 const client=f.service.state.createClient('合成文件验收',[profile.id]);sdk=new Client({name:'unified-file-test',version:'1'});transport=new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+client.token}}});await sdk.connect(transport);
 const call=async(name:string,args:Record<string,unknown>={})=>(await sdk!.callTool({name,arguments:{profileId:profile.id,...args}},undefined,{timeout:60000})).structuredContent as any;
 const begin=await call('chrome_file_begin',{filename:'合成上传.txt',size:payload.length,sha256:sha,submissionId:randomUUID()});assert.ok(begin.ok);const transferId=begin.data.transferId;
 for(let offset=0;offset<payload.length;offset+=FILE_CHUNK_BYTES)assert.ok((await call('chrome_file_write',{transferId,offset,base64:payload.subarray(offset,offset+FILE_CHUNK_BYTES).toString('base64')})).ok);
 assert.ok((await call('chrome_file_commit',{transferId})).ok);
 const opened=await call('chrome_new_tab',{url:`http://127.0.0.1:${webPort}`});assert.ok(opened.ok);const tabId=opened.data.tabId;assert.ok((await call('chrome_claim_tab',{tabId})).ok);
 // 先关掉同机路径，验证服务向浏览器传内容这条路；后面再打开，验证 Chrome 直接读本机文件。
 f.service.config.uploadByPath='never';assert.equal(f.service.broker.listProfiles()[0]!.sameMachine,true);
 const uploaded=await call('chrome_upload',{tabId,selector:'#upload',transferIds:[transferId],timeoutMs:30000});assert.equal(uploaded.ok,true,JSON.stringify(uploaded.error));assert.equal(f.service.transfers.stats().uploadFileLeases,0);
 const content=await call('chrome_evaluate',{tabId,expression:'(async()=>{const f=document.querySelector("#upload").files[0];return {name:f.name,size:f.size,sha256:Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await f.arrayBuffer())),v=>v.toString(16).padStart(2,"0")).join("")}})()'});assert.ok(content.ok);const returned=content.data?.value??content.data;assert.deepEqual(returned,{name:'合成上传.txt',size:payload.length,sha256:sha});
 const raw=await call('chrome_cdp',{tabId,method:'DOM.setFileInputFiles',params:{files:[path.join(downloads,'not-a-real-file.txt')],nodeId:1}});assert.equal(raw.error.code,'FILE_LOCATION_REQUIRED');
 f.service.config.uploadByPath='auto';
 const allowed=path.join(path.dirname(f.config.dataDir),path.basename(f.config.dataDir)+'-成片'),video=path.join(allowed,'第3集 原片.mov'),size=FILE_MAX_BYTES+3*1024*1024;t.after(()=>rm(allowed,{recursive:true,force:true}));
 await mkdir(allowed,{recursive:true});const handle=await open(video,'w');try{await handle.truncate(size);}finally{await handle.close();}
  const local=await call('chrome_upload',{tabId,selector:'#upload',paths:[video]});assert.equal(local.ok,true,JSON.stringify(local.error));assert.equal(local.data.transport,'path');assert.deepEqual(local.data.files,[{name:'第3集 原片.mov',size}]);
 const picked=await call('chrome_evaluate',{tabId,expression:'(()=>{const f=document.querySelector("#upload").files;return {count:f.length,name:f[0].name,size:f[0].size,type:f[0].type,events:document.querySelector("#events").textContent}})()'});const seen=picked.data?.value??picked.data;
 assert.deepEqual(seen,{count:1,name:'第3集 原片.mov',size,type:'video/quicktime',events:'2'});
 const secret=path.join(f.config.dataDir,'secret.txt');await writeFile(secret,'synthetic');assert.equal((await call('chrome_cdp',{tabId,method:'DOM.setFileInputFiles',params:{files:[secret],nodeId:1}})).error.code,'UPLOAD_PATH_NOT_ALLOWED','数据目录里的文件');
 const started=await call('chrome_download',{url:`http://127.0.0.1:${webPort}/download`,filename:'synthetic-download.bin'});assert.ok(started.ok);const downloadId=started.data.downloadId;
 let complete=false;for(let i=0;i<100;i++){const list=await call('chrome_downloads',{downloadId});if(list.data?.[0]?.state==='complete'||list.data?.items?.[0]?.state==='complete'){complete=true;break;}await new Promise(resolve=>setTimeout(resolve,50));}assert.ok(complete);
 const submissionId=randomUUID(),missing=await call('chrome_file_export',{downloadId,submissionId});assert.equal(missing.error.code,'BROWSER_HELPER_REQUIRED');
 await mkdir(helperData,{recursive:true});await writeFile(path.join(helperData,'config.json'),JSON.stringify({port:f.config.port,token:randomBytes(32).toString('hex')}));await cp(path.join(projectDir,'dist/extension'),path.join(helperData,'extension'),{recursive:true});
 await registerNativeSettings({dataDir:helperData,port:f.config.port},{command:process.execPath,args:[path.join(process.env.PRODUCT_SERVICE_ROOT||projectDir,'dist/cli.js')]},{extensionDirs:[extension]});registered=true;
 const exported=await call('chrome_file_export',{downloadId,submissionId});assert.equal(exported.ok,true,JSON.stringify(exported.error));assert.equal(exported.data.sha256,sha);assert.equal(exported.data.size,payload.length);
 await unlink(path.join(downloads,'synthetic-download.bin'));const cached=await call('chrome_file_export',{downloadId,submissionId});assert.equal(cached.data.transferId,exported.data.transferId);assert.equal(cached.data.deduplicated,true);
 // 服务核对的大小和 Chrome 读到的对不上（路径其实不在这台电脑、文件被换过）：报结果不明，标签页暂停写入。
 const check=(f.service as any).localUploadFiles.bind(f.service);(f.service as any).localUploadFiles=async(...input:unknown[])=>(await check(...input)).map((file:any)=>({...file,size:file.size+1}));
 const mismatch=await call('chrome_upload',{tabId,selector:'#upload',paths:[video]});assert.equal(mismatch.error.code,'UPLOAD_FILE_MISMATCH');assert.equal(mismatch.error.outcome,'unknown');(f.service as any).localUploadFiles=check;
 assert.equal((await call('chrome_close_tab',{tabId})).error.code,'RESULT_UNKNOWN');assert.ok((await call('chrome_recover_tab',{tabId})).ok);
 assert.ok((await call('chrome_close_tab',{tabId})).ok);console.log(JSON.stringify({directUpload:true,localPathUpload:size,nativeDownloadExport:true,testBytes:payload.length,sha256:sha,realUserFilesRead:false}));
});
