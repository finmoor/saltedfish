import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,cp,readdir,rm,access,stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {parseCodex} from '../src/codex-config.js';
import {CODEX_TOOL_SCHEMA_MAX_BYTES} from '../src/client-config.js';
import {ensureHome,runningRecord,serviceStatus} from '../src/npm-runtime.js';
import {projectDir,type Config} from '../src/config.js';
import {freePort,testDirectory,fakeProfile} from './helpers.js';
import {windowsDesktopRegistry} from '../src/desktop-registration.js';
import {unregisterNativeSettings,unpackedExtensionOrigin} from '../src/native-settings-registration.js';

const exec=promisify(execFile),json=async(f:string)=>JSON.parse((await readFile(f,'utf8')).replace(/^\uFEFF/,''));
const hash=async(f:string)=>createHash('sha256').update(await readFile(f)).digest('hex');
const exists=async(f:string)=>access(f).then(()=>true,()=>false);
const npm=process.env.npm_execpath||process.env.SALTEDFISH_TEST_NPM!;
// Linux 的 npm 安装走 HTTP，目录修订在请求头里；其他系统走 launcher，在环境变量里。
const localHttp=process.platform==='linux',revision=localHttp?{codex:'http_headers',opencode:'headers',name:'X-SaltedFish-Catalog-Version'}:{codex:'env',opencode:'environment',name:'SALTEDFISH_CATALOG_VERSION'};
async function desktopProductionSnapshot(){if(process.platform!=='win32')return '';const script="$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Classes');try{$items=@($key.GetSubKeyNames()|Where-Object{$_ -match '^saltedfish-[0-9]+$'}|Sort-Object|ForEach-Object{$item=$key.OpenSubKey($_);$command=$item.OpenSubKey('shell\\open\\command');try{[ordered]@{name=$_;owner=$item.GetValue('SaltedFishInstallation');command=$(if($command){$command.GetValue('')})}}finally{if($command){$command.Dispose()};$item.Dispose()}});ConvertTo-Json -InputObject $items -Compress -Depth 4}finally{$key.Dispose()}";return(await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true})).stdout.trim();}
async function nativeProductionSnapshot(){if(process.platform!=='win32')return '';const script="$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Google\\Chrome\\NativeMessagingHosts');if(-not $key){[Console]::Write('[]');exit};try{$items=@($key.GetSubKeyNames()|Where-Object{$_ -match '^com\\.saltedfish\\.settings\\.p[0-9]+$'}|Sort-Object|ForEach-Object{$item=$key.OpenSubKey($_);try{[ordered]@{name=$_;owner=$item.GetValue('SaltedFishInstallation');manifest=$item.GetValue('')}}finally{$item.Dispose()}});ConvertTo-Json -InputObject $items -Compress -Depth 4}finally{$key.Dispose()}";return(await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true})).stdout.trim();}
// 场景清单与 promote-npm 共用同一份：缺项、多项或顺序变化，测试末尾和冻结时都会拒绝。
const scenarios=await import(new URL('../scripts/release-evidence.mjs',import.meta.url).href);
// Windows 的多个真实 npm 解包会累计数分钟；整套安装验收留足预算，产品调用和性能门禁的时限另行验证。
test('npm 分发在独立前缀真实安装，本机/网关/升级/一次信任完整验收', {timeout:process.platform==='win32'?900000:480000}, async t=>{
  assert.ok(npm,'Run with npm run test:npm, or SALTEDFISH_TEST_NPM pointing at npm-cli.js');
  const temp=await testDirectory(),root=temp.directory,home=path.join(root,'用户 home'),prefix=path.join(root,'npm prefix');
  const desktopRegistryRoot='HKCU\\Software\\SaltedFish\\Tests\\Desktop_'+randomUUID().replaceAll('-',''),desktopBefore=await desktopProductionSnapshot();
  const nativeRegistryRoot='HKCU\\Software\\SaltedFish\\Tests\\Native_'+randomUUID().replaceAll('-',''),nativeBefore=await nativeProductionSnapshot();
  // 候选记录由 package:npm 写入，含上一发行版 previous；其他机器（如 Linux）用 SALTEDFISH_TEST_PACKAGE_RECORD 指向改写过路径的同结构记录。
  const packed=await json(process.env.SALTEDFISH_TEST_PACKAGE_RECORD||path.join(projectDir,'.local/last-npm-package.json'));
  const packageRoot=path.join(prefix,process.platform==='win32'?'node_modules':'lib/node_modules','saltedfish'),entry=path.join(packageRoot,'dist/npm-cli.js');
  // 合成的下一版要比当前新、格式合法：0.3.0-beta.N 后面接 .upgrade-test；0.3.19 这种接不了，改成下一个补丁号的预发布（0.3.20-upgrade-test）。
  const later=(version:string,label:string)=>version.includes('-')?`${version}.${label}`:version.replace(/\d+$/,patch=>`${Number(patch)+1}-${label}`);
  const baseVersion=packed.version,nextVersion=later(baseVersion,'upgrade-test'),brokenVersion=later(baseVersion,'broken-test');
  const checks:string[]=[],report:any={version:baseVersion,platform:process.platform,packageSha256:packed.sha256,sourceFingerprint:packed.sourceFingerprint,normalizedSourceFingerprint:packed.normalizedSourceFingerprint,provenance:packed.provenance,time:new Date().toISOString(),checks,passed:false};
  async function command(args:string[],allowFailure=false,launcher=entry,scopeHome=home){
    const targetArgs=path.basename(launcher)==='launcher.mjs'?args:[...args,'--home',scopeHome];
    const child=spawn(process.execPath,[launcher,...targetArgs],{windowsHide:true,env:{...process.env,SALTEDFISH_TEST_DESKTOP_REGISTRY_ROOT:desktopRegistryRoot,SALTEDFISH_TEST_NATIVE_REGISTRY_ROOT:nativeRegistryRoot,PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
    child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
    const timer=setTimeout(()=>child.kill(),45000);
    const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}).finally(()=>clearTimeout(timer));
    if(!allowFailure)assert.equal(code,0,stderr||stdout);return {code,stdout,stderr};
  }
  const status=async()=>JSON.parse((await command(['status'])).stdout);
  async function nativeState(scopeHome=home,enabled=true,extra?:string){
    const dataDir=path.join(scopeHome,'data/local'),folder=path.join(dataDir,'native-settings');if(process.platform!=='win32'){assert.equal(await exists(path.join(folder,'registration.json')),false);return;}
    const config=await json(path.join(dataDir,'config.json')),key=nativeRegistryRoot+'\\com.saltedfish.settings.p'+config.port,tree=await windowsDesktopRegistry('native').read(key);
    if(!enabled){assert.equal(tree,null);assert.equal(await exists(path.join(folder,'host.json')),false);return;}
    const saved=await json(path.join(folder,'registration.json')),manifest=await json(path.join(folder,'host.json'));assert.equal(saved.registryRoot,nativeRegistryRoot);assert.equal(saved.port,config.port);assert.deepEqual(saved.entry,{command:process.execPath,args:[path.join(scopeHome,'launcher.mjs')]});assert.ok(tree);assert.equal(tree.values.find(value=>value.name==='')?.value,path.join(folder,'host.json'));assert.equal(manifest.path,path.join(folder,'SaltedFish.NativeSettings.exe'));assert.ok(manifest.allowed_origins.includes(unpackedExtensionOrigin(path.join(dataDir,'extension'))));if(extra)assert.ok(manifest.allowed_origins.includes(unpackedExtensionOrigin(extra)));
    for(const[name,sha]of [['SaltedFish.NativeSettings.exe',saved.runnerSha256],['native-launch.json',saved.descriptorSha256],['host.json',saved.manifestSha256]])assert.equal(await hash(path.join(folder,name)),sha);
  }
  const installNpm=async(target:string)=>exec(process.execPath,[npm,'install','-g',target,'--prefix',prefix,'--ignore-scripts','--offline','--no-audit','--no-fund'],{windowsHide:true,maxBuffer:3*1024*1024,timeout:process.platform==='win32'?120000:60000});
  async function clientProbe(callback?:(c:Client)=>Promise<void>){const config=(await json(path.join(home,'data/local/mcp-config.json'))).mcpServers['saltedfish'];const transport=new StdioClientTransport({...config,env:{...process.env,...config.env},stderr:'pipe'}),client=new Client({name:'npm-test',version:'1'});try{await client.connect(transport,{timeout:8000});assert.equal((await client.listTools()).tools.length,46);assert.equal(client.getServerVersion()?.title,'SaltedFish');if(callback)await callback(client);return client.getServerVersion()?.version;}finally{await client.close();}}
  async function variant(version:string,broken=false){
    const folder=path.join(root,version);await cp(packed.stage,folder,{recursive:true});const pkg=await json(path.join(folder,'package.json'));pkg.version=version;await writeFile(path.join(folder,'package.json'),JSON.stringify(pkg,null,2)+'\n');
    const vf=path.join(folder,'dist/version.js');await writeFile(vf,(await readFile(vf,'utf8')).replaceAll(baseVersion,version));if(broken)await writeFile(path.join(folder,'dist/npm-worker.js'),'this is invalid JavaScript');
    const manifest=await json(path.join(folder,'saltedfish-release.json'));manifest.version=version;manifest.files={};
    // npm 会根据各依赖的 files 规则重新过滤；候选版本必须像真实打包一样重算发行清单。
    const listing=JSON.parse((await exec(process.execPath,[npm,'pack','--dry-run','--json','--ignore-scripts'],{cwd:folder,windowsHide:true,maxBuffer:12*1024*1024})).stdout)[0];
    for(const item of listing.files)if(item.path!=='saltedfish-release.json')manifest.files[item.path]=await hash(path.join(folder,item.path));
    await writeFile(path.join(folder,'saltedfish-release.json'),JSON.stringify(manifest,null,2));const output=JSON.parse((await exec(process.execPath,[npm,'pack','--json','--ignore-scripts'],{cwd:folder,windowsHide:true,maxBuffer:12*1024*1024})).stdout)[0];return path.join(folder,output.filename);
  }
  async function check(name:string,fn:()=>Promise<void>){let passed=false;await t.test(name,async()=>{await fn();checks.push(name);passed=true;});if(!passed||t.signal.aborted)throw new Error(`Test stopped after: ${name}`);}
  const codex=path.join(root,'codex.toml'),opencode=path.join(root,'opencode.jsonc'),extraExtension=path.join(root,'original loaded extension');let initialPid:number,config:Config,credentials:Record<string,string>,clientConfigBefore:string,clientConfigBeforeText:string;
  try{
    // “真实上一发行版升级/回滚、拒绝不兼容降级”是唯一覆盖降级保护的包层面场景，不能因记录缺 previous 而静默跳过。
    // 只有确实没有更早的发行版（首个版本）时，才允许显式设置 SALTEDFISH_ALLOW_NO_PREVIOUS=1；报告会记下 previousScenario: skipped，promote-npm 需要同一个开关才放行。
    if(!packed.previous){assert.equal(process.env.SALTEDFISH_ALLOW_NO_PREVIOUS,'1','候选记录没有 previous（上一发行版）。package:npm 会从 release/ 自动写入；确认没有更早发行时才设置 SALTEDFISH_ALLOW_NO_PREVIOUS=1。');report.previousScenario='skipped';}
    await check('离线 npm 安装与实际命令 shim，安装无后台或配置副作用',async()=>{
      assert.equal(await hash(packed.target),packed.sha256);await installNpm(packed.target);assert.equal(await exists(home),false);
      const shim=path.join(prefix,process.platform==='win32'?'saltedfish.cmd':'bin/saltedfish');assert.ok(await exists(shim));
      const value=process.platform==='win32'?await exec('powershell.exe',['-NoProfile','-Command','& $env:SALTEDFISH_TEST_BIN version'],{env:{...process.env,SALTEDFISH_TEST_BIN:shim},windowsHide:true}):await exec(shim,['version'],{env:{...process.env,PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH}});
      assert.equal(value.stdout.trim(),baseVersion);assert.equal(await exists(home),false);
    });
    await check('安装本机后台与稳定配对路径，真实 SDK 握手发现 46 工具',async()=>{
      await command(['install','--local','--port',String(await freePort()),'--no-connect']);const s=await status();assert.equal(s.active.version,baseVersion);assert.equal(s.services[0].state,'running');initialPid=s.services[0].pid;
      config={...await json(path.join(home,'data/local/config.json')),dataDir:path.join(home,'data/local')};
      const extension=await json(path.join(config.dataDir,'extension/manifest.json'));assert.equal(extension.name,'SaltedFish');const pairing=await json(path.join(config.dataDir,'extension/pairing.json'));assert.equal(pairing.token,'');assert.equal(pairing.serviceUrl,`http://127.0.0.1:${config.port}`);
      assert.equal(await clientProbe(),baseVersion);credentials={};for(const f of await readdir(path.join(config.dataDir,'clients')))credentials[f]=await hash(path.join(config.dataDir,'clients',f));
      const launched=(await json(path.join(config.dataDir,'mcp-config.json'))).mcpServers['saltedfish'];assert.deepEqual(launched.args,[path.join(home,'launcher.mjs'),'mcp']);
      if(process.platform==='win32'){const desktop=await json(path.join(config.dataDir,'desktop/registration.json'));assert.equal(desktop.registryRoot,desktopRegistryRoot);assert.equal(desktop.port,config.port);assert.deepEqual(desktop.entry,{command:process.execPath,args:[path.join(home,'launcher.mjs')]});}
      else assert.equal(await exists(path.join(config.dataDir,'desktop/registration.json')),false,'非Windows不注册桌面入口');
      await nativeState();if(process.platform==='win32'){await cp(path.join(config.dataDir,'extension'),extraExtension,{recursive:true});await command(['desktop','register','--extension-dir',extraExtension]);await nativeState(home,true,extraExtension);await exec(process.execPath,[path.join(projectDir,'scripts/smoke-native-settings.mjs'),config.dataDir],{windowsHide:true,timeout:30000});}
      const parallel=await Promise.all([command(['start'],true),command(['start'],true)]);assert.ok(parallel.some(r=>r.code===0));assert.equal((await status()).services[0].pid,initialPid);
    });
    await check('Codex/OpenCode 一次信任、原配置保留与重复接入幂等',async()=>{
      await writeFile(codex,'approval_policy="on-request"\nsandbox_mode="read-only"\n');await writeFile(opencode,'{ // keep\n "permissions":[{"action":"shell","resource":"*","effect":"deny"}]}');
      await command(['connect','--clients','codex','--config',codex,'--trust-browser']);await command(['connect','--clients','opencode','--config',opencode,'--trust-browser']);
      const c=parseCodex(await readFile(codex,'utf8'));assert.equal(c.mcp_servers['saltedfish'].default_tools_approval_mode,'approve');assert.equal(c.approval_policy,'on-request');assert.equal(c.sandbox_mode,'read-only');if(localHttp){const server=c.mcp_servers['saltedfish'];assert.match(server.http_headers.Authorization,/^Bearer /);assert.ok(!server.http_headers.Authorization.includes(config.token),'Codex 使用独立凭据');assert.equal(server.args,undefined);assert.equal((await stat(codex)).mode&0o777,0o600,'令牌只有本用户能读');}else{assert.ok(await exists(c.mcp_servers['saltedfish'].env.CHROME_MCP_TOKEN_FILE),'Codex 使用独立凭据');assert.deepEqual(c.mcp_servers['saltedfish'].args,[path.join(home,'launcher.mjs'),'mcp']);}
      const text=await readFile(opencode,'utf8');assert.ok(text.includes('// keep'));assert.ok(text.includes('saltedfish_*'));assert.ok(text.includes('"deny"'));clientConfigBefore=await hash(codex);clientConfigBeforeText=await readFile(codex,'utf8');
      const before=JSON.parse((await command(['connect','--history'])).stdout).changes.length;await command(['connect','--clients','codex','--config',codex,'--trust-browser']);assert.equal(JSON.parse((await command(['connect','--history'])).stdout).changes.length,before);
    });
    await check('显式 stop 阻止 MCP 自动重启，start 后原凭据继续工作',async()=>{
      await command(['stop']);assert.equal((await status()).services[0].state,'stopped');await assert.rejects(clientProbe());assert.equal((await status()).services[0].state,'stopped');
      assert.notEqual((await command(['desktop-open',process.platform==='win32'?'invalid-settings-uri':`saltedfish-${config.port}://settings/remote`],true)).code,0);assert.equal((await status()).services[0].state,'stopped','非法地址/非Windows不能先启动服务');
      await command(['start']);assert.equal(await clientProbe(),baseVersion);
      const control=(await json(path.join(home,'run/local.json'))).port;assert.ok(control>=49152,`私有控制口 ${control} 不在高位段，可能撞上 fetch 拒连的端口`);
    });
    if(process.platform==='win32')await check('状态记录短暂文件共享锁释放后继续读取，不误判离线',async()=>{
      const child=spawn('powershell.exe',['-NoProfile','-Command',"$h=[IO.File]::Open($env:SALTEDFISH_LOCK_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None); try { [Console]::WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Milliseconds 500 } finally { $h.Dispose() }"],{windowsHide:true,env:{...process.env,SALTEDFISH_LOCK_FILE:path.join(home,'run/local.json')},stdio:['ignore','pipe','pipe']});
      const done=new Promise<number|null>((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('error',reject);child.once('exit',code=>{if(code)reject(new Error('File-lock fixture failed'));});});assert.equal((await status()).services[0].state,'running');assert.equal(await done,0);
    });
    await check('同一 npm 包的 gateway 后台、电脑离线首次接入与管理鉴权',async()=>{
      await command(['gateway','init','--port',String(await freePort()),'--local-port',String(await freePort())]);const state=await status();assert.equal(state.services[1].state,'running');
      const target=path.join(root,'remote-codex.toml');await command(['gateway','connect','--clients','codex','--config',target,'--trust-browser']);assert.equal(parseCodex(await readFile(target,'utf8')).mcp_servers['saltedfish'].default_tools_approval_mode,'approve');
      const record=(await runningRecord(home,'gateway'))!;assert.equal((await fetch(`http://127.0.0.1:${record.port}/status`,{headers:{authorization:'Bearer wrong'}})).status,403);
      const other=await ensureHome(path.join(root,'other-home'));await cp(path.join(home,'run/gateway.json'),path.join(other,'run/gateway.json'));await assert.rejects(serviceStatus(other,'gateway'),/其他安装/);
      const settings=await json(path.join(home,'data/gateway/gateway.json')),agent=settings.agents.find((a:any)=>a.label==='codex');const c=new Client({name:'gateway-npm-test',version:'1'}),tr=new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${settings.localPort}/mcp`),{requestInit:{headers:{authorization:`Bearer ${agent.token}`}}});try{await c.connect(tr);assert.equal((await c.listTools()).tools.length,64,'旧网关没有目录开关，保持原有工具');assert.equal((await c.callTool({name:'chrome_profiles',arguments:{}})).isError,true);}finally{await c.close();}
    });
    let upgraded:string;
    await check('npm 更新不改变运行版本、PID、固定入口或客户端配置',async()=>{
      upgraded=await variant(nextVersion);const before=await status();await installNpm(upgraded);const after=await status();assert.equal(after.packageVersion,nextVersion);assert.equal(after.active.version,baseVersion);assert.equal(after.services[0].pid,before.services[0].pid);assert.equal(after.services[1].pid,before.services[1].pid);assert.equal(await clientProbe(),baseVersion);assert.equal(await hash(codex),clientConfigBefore);
    });
    await check('执行中升级拒绝，不打断或重放原操作',async()=>{
      let release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);let calls=0;
      const fake=await fakeProfile(config,'npm-busy',async command=>{if(command.operation==='page.action'){calls++;entered();await gate;}return {done:true};});
      try{await clientProbe(async c=>{const call=c.callTool({name:'chrome_action',arguments:{profileId:fake.id,tabId:7,action:'click',x:2,y:2}});call.catch(()=>{});try{await started;const before=(await status()).services[0].pid;const denied=await command(['upgrade','--no-fetch'],true);assert.notEqual(denied.code,0);assert.match(denied.stderr,/任务/);assert.equal((await status()).services[0].pid,before);release();assert.equal((await call).isError,false);assert.equal(calls,1);}finally{release();await call.catch(()=>{});}});}finally{release();fake.socket.terminate();}
    });
    await check('明确 upgrade 切换两个角色，配对/六份凭据/一次信任保持',async()=>{
      const pairing=await hash(path.join(config.dataDir,'extension/pairing.json')),before=parseCodex(await readFile(codex,'utf8'));await command(['upgrade','--no-fetch']);const s=await status();assert.equal(s.active.version,nextVersion);assert.ok(s.services.every((x:any)=>x.state==='running'&&x.version===nextVersion));assert.equal(await hash(path.join(config.dataDir,'extension/pairing.json')),pairing);for(const[f,h]of Object.entries(credentials))assert.equal(await hash(path.join(config.dataDir,'clients',f)),h);
      const updated=parseCodex(await readFile(codex,'utf8'));assert.equal(updated.mcp_servers['saltedfish'][revision.codex][revision.name],nextVersion);before.mcp_servers['saltedfish'][revision.codex][revision.name]=nextVersion;assert.deepEqual(updated,before,'仅变更目录修订，不改变已有策略或入口');assert.equal(JSON.parse(await readFile(opencode,'utf8').then(text=>text.replace('// keep',''))).mcp.servers['saltedfish'][revision.opencode][revision.name],nextVersion);assert.equal(await clientProbe(),nextVersion);
      await nativeState(home,true,extraExtension);
    });
    await check('跨版本 rollback 保留当前用户数据与信任，固定 MCP 入口继续可用',async()=>{
      await command(['rollback']);const s=await status();assert.equal(s.active.version,baseVersion);assert.ok(s.services.every((x:any)=>x.version===baseVersion));
      const text=await readFile(codex,'utf8');assert.deepEqual(parseCodex(text),parseCodex(clientConfigBeforeText),'回滚后完整配置语义一致，包括目录修订与权限');assert.equal(text.split('[mcp_servers.')[0],clientConfigBeforeText.split('[mcp_servers.')[0],'服务条目之外字节保持');assert.equal(await clientProbe(),baseVersion);
      await nativeState(home,true,extraExtension);
    });
    await check('升级和回滚保持显式停止的本机服务，不为更新扩展短暂启动',async()=>{
      await command(['stop']);const before=await hash(path.join(home,'logs/local.log'));await command(['upgrade','--no-fetch']);let state=await status();assert.equal(state.active.version,nextVersion);assert.equal(state.services[0].state,'stopped');assert.equal(state.services[0].stoppedExplicitly,true);assert.equal(await hash(path.join(home,'logs/local.log')),before);
      await command(['rollback']);state=await status();assert.equal(state.active.version,baseVersion);assert.equal(state.services[0].state,'stopped');assert.equal(await hash(path.join(home,'logs/local.log')),before);await command(['start']);
    });
    await check('校验损坏在停服前拒绝；启动失败回退两个角色',async()=>{
      const broken=await variant(brokenVersion,true);await installNpm(broken);const original=await readFile(path.join(packageRoot,'ui/index.html'));await writeFile(path.join(packageRoot,'ui/index.html'),'corrupt');const before=(await status()).services[0].pid;assert.notEqual((await command(['upgrade','--no-fetch'],true)).code,0);assert.equal((await status()).services[0].pid,before);await writeFile(path.join(packageRoot,'ui/index.html'),original);
      const failed=await command(['upgrade','--no-fetch'],true);assert.notEqual(failed.code,0);assert.match(failed.stderr,/恢复活动版本/);const s=await status();assert.equal(s.active.version,baseVersion);assert.ok(s.services.every((x:any)=>x.state==='running'&&x.version===baseVersion));assert.equal(await clientProbe(),baseVersion);
    });
    await check('升级后撤销一次信任仅影响此服务，日志有界可读且不泄漏令牌',async()=>{
      await command(['connect','--clients','codex','--config',codex,'--revoke-trust']);const c=parseCodex(await readFile(codex,'utf8'));assert.equal(c.mcp_servers['saltedfish'].default_tools_approval_mode,'prompt');assert.equal(c.sandbox_mode,'read-only');const logs=await command(['logs','--lines','20']);assert.ok(logs.stdout.includes('SaltedFish'));assert.ok(!logs.stdout.includes(config.token));
    });
    await check('强制停止保留已派发操作的 unknown，重启不重放',async()=>{
      let entered!:()=>void,release!:()=>void;const enteredPromise=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);let dispatched=0;
      const fake=await fakeProfile(config,'npm-force-stop',async cmd=>{if(cmd.operation==='page.action'){dispatched++;entered();await gate;}return {done:true};});
      try{await clientProbe(async c=>{const pending=c.callTool({name:'chrome_action',arguments:{profileId:fake.id,tabId:17,action:'click',x:2,y:2}});pending.catch(()=>{});try{await enteredPromise;await command(['stop','--force']);await pending.catch(()=>{});}finally{release();await pending.catch(()=>{});}});}finally{release();fake.socket.terminate();}
      assert.equal((await status()).services[0].state,'stopped');await command(['start']);
      await clientProbe(async c=>{const response=(await c.callTool({name:'chrome_operations',arguments:{profileId:fake.id,state:'unknown',limit:25}})).structuredContent as any;assert.ok(response.ok&&response.data.items.some((o:any)=>o.tool==='chrome_action'&&!o.acknowledgedAt));});assert.equal(dispatched,1);
    });
    await check('遗留管理锁需明确恢复，活进程锁不被抢占或杀死',async()=>{
      const lock=path.join(home,'manage.lock');await writeFile(lock,JSON.stringify({pid:process.pid,id:randomUUID()}));const denied=await command(['recover-lock'],true);assert.notEqual(denied.code,0);assert.ok(await exists(lock));await rm(lock);
      const child=spawn(process.execPath,['-e',''],{windowsHide:true,stdio:'ignore'});await new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});await writeFile(lock,JSON.stringify({pid:child.pid,id:randomUUID()}));assert.notEqual((await command(['start'],true)).code,0);await command(['recover-lock']);assert.equal(await exists(lock),false);await command(['start']);
    });
    await check('upgrade 自己下载新版再切换，不降级，连不上仓库不影响已装的包',async()=>{
      await installNpm(packed.target);const scope=path.join(root,'self fetch home'),run=(args:string[])=>command(args,false,entry,scope),version=async()=>(await json(path.join(packageRoot,'package.json'))).version;
      await run(['install','--port',String(await freePort()),'--local','--no-start']);
      const tarball=await readFile(upgraded);let tag=nextVersion,npmRequests=0;
      // 数 npm 发来的请求，不数下载次数：同样字节的包 npm 会直接用缓存。
      const registry=createServer((request,response)=>{
        if(request.headers['user-agent']?.startsWith('npm/'))npmRequests++;
        if(request.url?.endsWith('.tgz')){response.writeHead(200,{'content-type':'application/octet-stream'});response.end(tarball);return;}
        const {port}=registry.address() as AddressInfo,shasum=createHash('sha1').update(tarball).digest('hex');
        response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({name:'saltedfish','dist-tags':{beta:tag},versions:{[nextVersion]:{name:'saltedfish',version:nextVersion,bin:{saltedfish:'dist/npm-cli.js'},dist:{tarball:`http://127.0.0.1:${port}/saltedfish.tgz`,shasum}}}}));
      });
      await new Promise<void>(resolve=>registry.listen(0,'127.0.0.1',()=>resolve()));
      try{
        const url=`http://127.0.0.1:${(registry.address() as AddressInfo).port}/`;
        // 走真实的命令入口：npm 会在命令运行中替换它，Windows 上是正在执行的 .cmd。
        const shim=path.join(prefix,process.platform==='win32'?'saltedfish.cmd':'bin/saltedfish'),env={...process.env,SALTEDFISH_TEST_DESKTOP_REGISTRY_ROOT:desktopRegistryRoot,SALTEDFISH_TEST_NATIVE_REGISTRY_ROOT:nativeRegistryRoot,PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH};
        if(process.platform==='win32')await exec('powershell.exe',['-NoProfile','-Command','& $env:SALTEDFISH_TEST_BIN upgrade --registry $env:SALTEDFISH_TEST_REGISTRY --home $env:SALTEDFISH_TEST_HOME; exit $LASTEXITCODE'],{env:{...env,SALTEDFISH_TEST_BIN:shim,SALTEDFISH_TEST_REGISTRY:url,SALTEDFISH_TEST_HOME:scope},windowsHide:true,timeout:120000});
        else await exec(shim,['upgrade','--registry',url,'--home',scope],{env,timeout:120000});
        assert.equal(await version(),nextVersion,'新包装回原来的全局目录');assert.ok(await exists(shim),'命令入口还在');assert.ok(npmRequests>0,'经 npm 安装');const installed=npmRequests;
        assert.equal(JSON.parse((await run(['status'])).stdout).active.version,nextVersion,'由新包接着切换');
        const same=await run(['upgrade','--registry',url]);assert.equal(npmRequests,installed,'已经是最新就不下载');assert.equal(JSON.parse(same.stdout).active.version,nextVersion);
        tag=baseVersion;await run(['upgrade','--registry',url]);assert.equal(npmRequests,installed,'仓库里的版本更旧时不降级');assert.equal(await version(),nextVersion);
      }finally{await new Promise(resolve=>registry.close(resolve));}
      const offline=await run(['upgrade','--registry','http://127.0.0.1:9/']);assert.match(offline.stderr,/没有查到新版本/);assert.equal(JSON.parse(offline.stdout).active.version,nextVersion);
    });
    if(packed.previous)await check('真实上一发行版升级与回滚门槛，拒绝不兼容降级且数据和信任保持',async()=>{
      const legacyHome=path.join(root,'previous release home'),legacyConfig=path.join(root,'previous-codex.toml');
      const legacy=(args:string[])=>command(args,false,entry,legacyHome);
      try{
        assert.equal(await hash(packed.previous.target),packed.previous.sha256);await installNpm(packed.previous.target);
        // beta.5 之前的版本没有 --local，也不会在 Linux 上默认对外监听。
        await legacy(['install','--port',String(await freePort()),'--no-connect',...(scenarios.compareVersions(packed.previous.version,'0.3.0-beta.5')>=0?['--local']:[])]);
        await writeFile(legacyConfig,'approval_policy="on-request"\nsandbox_mode="read-only"\n');
        await legacy(['connect','--clients','codex','--config',legacyConfig,'--trust-browser']);
        // beta.5 之前写的是旧连接名：升级时迁移成 saltedfish，回滚后仍用新名称。
        const previousName=scenarios.compareVersions(packed.previous.version,'0.3.0-beta.5')>=0?'saltedfish':'feng-chrome';
        // beta.5 的 Codex 条目缺独立凭据（入口文件的 env 子表留在旧名称下），升级要补回来；其他版本的凭据不变。
        // beta.14 起 Linux 同机写的已经是 HTTP 条目，没有 env，令牌文件从上一版的凭据记录里取。
        const before=parseCodex(await readFile(legacyConfig,'utf8')),previousEntry=before.mcp_servers[previousName];
        const previousCredential:string|undefined=previousEntry.url?(await json(path.join(legacyHome,'data/local/clients/codex.json'))).tokenFile:previousEntry.env?.CHROME_MCP_TOKEN_FILE;
        if(previousEntry.url)assert.equal(previousEntry.http_headers.Authorization,`Bearer ${(await readFile(previousCredential!,'utf8')).trim()}`,'上一版的 HTTP 条目用的就是这份令牌');
        assert.equal(!previousCredential,packed.previous.version==='0.3.0-beta.5');
        await installNpm(packed.target);await legacy(['upgrade','--no-fetch']);
        assert.equal(JSON.parse((await legacy(['status'])).stdout).active.version,baseVersion);
        await nativeState(legacyHome);
        const upgraded=parseCodex(await readFile(legacyConfig,'utf8')).mcp_servers['saltedfish'],credentialPath=localHttp?previousCredential:upgraded.env.CHROME_MCP_TOKEN_FILE,credentialHash=await hash(credentialPath);
        assert.equal(upgraded[revision.codex][revision.name],baseVersion);if(localHttp){assert.equal(upgraded.http_headers.Authorization,`Bearer ${(await readFile(credentialPath,'utf8')).trim()}`,'旧入口换成 HTTP，沿用原来的令牌');assert.equal(upgraded.args,undefined);assert.equal(upgraded.env,undefined);}else if(previousCredential)assert.equal(credentialPath,previousCredential);
        const previousMeta=await json(path.join(legacyHome,'versions',packed.previous.version,'saltedfish-release.json'));
        const currentMeta=await json(path.join(legacyHome,'versions',baseVersion,'saltedfish-release.json'));
        const downgradeUnsupported=currentMeta.stateVersion>previousMeta.stateVersion;report.stateVersions={previous:previousMeta.stateVersion,current:currentMeta.stateVersion};
        const statePath=path.join(legacyHome,'data/local/state.sqlite'),stateHash=await hash(statePath);
        if(downgradeUnsupported){
          const rejected=await command(['rollback'],true,entry,legacyHome);assert.notEqual(rejected.code,0);assert.match(rejected.stderr,/拒绝回滚/);
          assert.equal(await hash(statePath),stateHash);report.incompatiblePreviousRollbackRejected=true;
        }else await legacy(['rollback']);
        const expectedVersion=downgradeUnsupported?baseVersion:packed.previous.version;
        await nativeState(legacyHome,downgradeUnsupported||await exists(path.join(legacyHome,'versions',packed.previous.version,'dist/native-settings-registration.js')));
        const state=JSON.parse((await legacy(['status'])).stdout);assert.equal(state.active.version,expectedVersion);
        const after=parseCodex(await readFile(legacyConfig,'utf8'));assert.equal(after.mcp_servers['saltedfish'][revision.codex][revision.name],expectedVersion);
        const expected=structuredClone(before),migrated=expected.mcp_servers[previousName];delete expected.mcp_servers[previousName];expected.mcp_servers['saltedfish']=migrated;if(!previousCredential)migrated.env=upgraded.env;if(localHttp){for(const key of['command','args','env'])delete migrated[key];migrated.url=upgraded.url;migrated.http_headers={...upgraded.http_headers,[revision.name]:expectedVersion};}else migrated.env.SALTEDFISH_CATALOG_VERSION=expectedVersion;
        expected.mcp_servers['saltedfish'].tool_input_schema_max_bytes=Math.max(CODEX_TOOL_SCHEMA_MAX_BYTES,expected.mcp_servers['saltedfish'].tool_input_schema_max_bytes||0);
        assert.deepEqual(after,expected);assert.equal(await hash(credentialPath),credentialHash);
        report.previousVersion=packed.previous.version;
      }finally{const stable=path.join(legacyHome,'launcher.mjs');if(await exists(stable))await command(['stop','--force'],false,stable);}
    });
    assert.deepEqual(checks,scenarios.npmScenarioNames(process.platform,!!packed.previous));report.passed=true;
  }finally{
    const cleanup=[];for(const role of ['local','gateway']){try{const stable=path.join(home,'launcher.mjs');if(await exists(stable))await command([...(role==='gateway'?['gateway']:[]),'stop','--force'],false,stable);}catch(e){cleanup.push(String(e));}}
    if(process.platform==='win32')try{const relative=desktopRegistryRoot.substring(5);assert.match(relative,/^Software\\SaltedFish\\Tests\\Desktop_[a-f0-9]{32}$/);await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command','[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($env:SALTEDFISH_TEST_KEY,$false)'],{windowsHide:true,env:{...process.env,SALTEDFISH_TEST_KEY:relative}});assert.equal(await desktopProductionSnapshot(),desktopBefore);report.desktopProductionRegistryPreserved=true;}catch(error){cleanup.push(String(error));}
    if(process.platform==='win32')try{for(const scopeHome of[home,path.join(root,'previous release home')]){const dataDir=path.join(scopeHome,'data/local');if(await exists(path.join(dataDir,'native-settings/registration.json'))){const saved=await json(path.join(dataDir,'native-settings/registration.json'));assert.equal(saved.registryRoot,nativeRegistryRoot);await unregisterNativeSettings({dataDir,port:saved.port});await nativeState(scopeHome,false);}}const relative=nativeRegistryRoot.substring(5);assert.match(relative,/^Software\\SaltedFish\\Tests\\Native_[a-f0-9]{32}$/);await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command','[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($env:SALTEDFISH_TEST_KEY,$false)'],{windowsHide:true,env:{...process.env,SALTEDFISH_TEST_KEY:relative}});assert.equal(await nativeProductionSnapshot(),nativeBefore);report.nativeProductionRegistryPreserved=true;}catch(error){cleanup.push(String(error));}
    report.cleanupErrors=cleanup;if(cleanup.length)report.passed=false;
    await mkdir(path.join(projectDir,'.local/verification'),{recursive:true});await writeFile(path.join(projectDir,`.local/verification/npm-${process.platform}-${baseVersion}.json`),JSON.stringify(report,null,2));
    if(!cleanup.length)await temp.cleanup();else console.error('Retained owned test directory:',root);
    assert.equal(cleanup.length,0,cleanup.join('\n'));
  }
});
