import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp,access,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {testDirectory} from './helpers.js';
import {windowsDesktopRegistry,type DesktopRegistry,type RegistryTree} from '../src/desktop-registration.js';
import {registerNativeSettings,unregisterNativeSettings,nativeSettingsReady,nativeSettingsRegistryRoot,nativeSettingsRegistryTree,unpackedExtensionOrigin} from '../src/native-settings-registration.js';

class Registry implements DesktopRegistry {
  entries=new Map<string,RegistryTree>();writes=0;failure=false;
  async read(key:string){return structuredClone(this.entries.get(key)??null);}
  async replace(key:string,expected:RegistryTree|null,next:RegistryTree|null){assert.deepEqual(this.entries.get(key)??null,expected);if(this.failure)throw new Error('fixture registry failure');this.writes++;if(next)this.entries.set(key,structuredClone(next));else this.entries.delete(key);}
}
const windows={skip:process.platform!=='win32'};
const absent=async(file:string)=>access(file).then(()=>false,()=>true);
async function scene(t:TestContext){
  const temp=await testDirectory();t.after(()=>temp.cleanup());const config={dataDir:path.join(temp.directory,'data'),port:54441},registry=new Registry(),binary=path.join(temp.directory,'fixture.exe'),extensionSource=path.join(temp.directory,'source');
  await mkdir(extensionSource,{recursive:true});await writeFile(path.join(extensionSource,'manifest.json'),JSON.stringify({name:'SaltedFish',manifest_version:3,background:{service_worker:'background.js',type:'module'},options_ui:{page:'options.html'}}));await writeFile(path.join(extensionSource,'background.js'),'// trusted');await writeFile(path.join(extensionSource,'options.html'),'<p>trusted</p>');await mkdir(config.dataDir);await cp(extensionSource,path.join(config.dataDir,'extension'),{recursive:true});await writeFile(path.join(config.dataDir,'extension/pairing.json'),'never-read-secret');await writeFile(binary,'fixture binary');
  const entry={command:process.execPath,args:[path.join(temp.directory,'trusted.js')]},options={platform:'win32' as const,registry,binary,extensionSource},folder=path.join(config.dataDir,'native-settings'),key='HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.saltedfish.settings.p54441';
  return{temp,config,registry,binary,entry,options,folder,key,extensionSource};
}
test('Windows已解压扩展ID遵循Chromium路径算法且不改变原ID',()=>{
  const directory='C:\\Users\\someone\\saltedfish\\extension';
  assert.equal(unpackedExtensionOrigin(directory),'chrome-extension://mmlmpplcipmnaienhgpiibndalincbdf/');assert.equal(unpackedExtensionOrigin('c:'+directory.slice(2)),unpackedExtensionOrigin(directory));
  assert.notEqual(unpackedExtensionOrigin(directory.toLowerCase()),unpackedExtensionOrigin(directory));assert.throws(()=>unpackedExtensionOrigin('relative'),/绝对路径/);
  assert.throws(()=>nativeSettingsRegistryRoot('HKLM\\Software\\Google\\Chrome\\NativeMessagingHosts'),/无效/);
});
test('Native注册精确允许当前扩展、幂等、预检不改状态、注销保留授权快照',windows,async t=>{
  const f=await scene(t);await registerNativeSettings(f.config,f.entry,f.options);assert.deepEqual(f.registry.entries.get(f.key),nativeSettingsRegistryTree(f.config));
  const host=JSON.parse(await readFile(path.join(f.folder,'host.json'),'utf8')),descriptor=JSON.parse(await readFile(path.join(f.folder,'native-launch.json'),'utf8'));
  assert.deepEqual(host.allowed_origins,[unpackedExtensionOrigin(path.join(f.config.dataDir,'extension'))]);assert.deepEqual(descriptor.allowedOrigins,host.allowed_origins);assert.equal(JSON.stringify(host).includes('never-read-secret'),false);
  const record=await readFile(path.join(f.folder,'registration.json'));await registerNativeSettings(f.config,f.entry,f.options);assert.deepEqual(await readFile(path.join(f.folder,'registration.json')),record);assert.equal(f.registry.writes,1);assert.equal(await nativeSettingsReady(f.config,f.options),true);
  await unregisterNativeSettings(f.config,{...f.options,validateOnly:true});assert.deepEqual(f.registry.entries.get(f.key),nativeSettingsRegistryTree(f.config));assert.equal(await absent(path.join(f.folder,'host.json')),false);
  await unregisterNativeSettings(f.config,f.options);assert.equal(f.registry.entries.size,0);assert.equal(await absent(path.join(f.folder,'host.json')),true);assert.deepEqual(await readFile(path.join(f.folder,'registration.json')),record);assert.equal(await nativeSettingsReady(f.config,f.options),false);
  await registerNativeSettings(f.config,f.entry,f.options);assert.equal(await nativeSettingsReady(f.config,f.options),true);
});
test('首次信任拒绝修改/伪造扩展，只允许显式目录；升级与注销后保留原目录',windows,async t=>{
  const f=await scene(t),extra=path.join(f.temp.directory,'loaded-extension');await cp(f.extensionSource,extra,{recursive:true});
  await writeFile(path.join(extra,'background.js'),'foreign');await assert.rejects(registerNativeSettings(f.config,f.entry,{...f.options,extensionDirs:[extra]}),/发行文件不一致/);assert.equal(f.registry.entries.size,0);
  await cp(f.extensionSource,extra,{recursive:true});await registerNativeSettings(f.config,f.entry,{...f.options,extensionDirs:[extra]});
  await writeFile(path.join(f.extensionSource,'background.js'),'// upgraded trusted');await cp(f.extensionSource,path.join(f.config.dataDir,'extension'),{recursive:true});
  await registerNativeSettings(f.config,f.entry,f.options);const origins=JSON.parse(await readFile(path.join(f.folder,'host.json'),'utf8')).allowed_origins;assert.equal(origins.length,2);assert.ok(origins.includes(unpackedExtensionOrigin(extra)));
  await unregisterNativeSettings(f.config,f.options);await registerNativeSettings(f.config,f.entry,f.options);assert.deepEqual(JSON.parse(await readFile(path.join(f.folder,'host.json'),'utf8')).allowed_origins,origins);
  await writeFile(path.join(extra,'background.js'),'changed later');await assert.rejects(registerNativeSettings(f.config,f.entry,f.options),/发行文件不一致/);
});
test('Native注册拒绝其他安装与外来注册项，不覆盖更改后的host',windows,async t=>{
  const f=await scene(t),foreign=nativeSettingsRegistryTree({...f.config,dataDir:path.join(f.temp.directory,'foreign')});f.registry.entries.set(f.key,foreign);await assert.rejects(registerNativeSettings(f.config,f.entry,f.options),/其他程序或安装/);assert.deepEqual(f.registry.entries.get(f.key),foreign);
  f.registry.entries.clear();await registerNativeSettings(f.config,f.entry,f.options);await writeFile(path.join(f.folder,'host.json'),'{}');await assert.rejects(registerNativeSettings(f.config,f.entry,f.options),/已被修改/);await assert.rejects(unregisterNativeSettings(f.config,f.options),/已被修改/);assert.equal(await nativeSettingsReady(f.config,f.options),false);
});
test('Native登记失败完整回退文件，丢失文件可修复；变更端口先注销',windows,async t=>{
  const f=await scene(t);f.registry.failure=true;await assert.rejects(registerNativeSettings(f.config,f.entry,f.options),/fixture registry failure/);for(const name of['host.json','native-launch.json','registration.json','SaltedFish.NativeSettings.exe'])assert.equal(await absent(path.join(f.folder,name)),true);
  f.registry.failure=false;await registerNativeSettings(f.config,f.entry,f.options);await rm(path.join(f.folder,'host.json'));await registerNativeSettings(f.config,f.entry,f.options);assert.equal(await nativeSettingsReady(f.config,f.options),true);
  await assert.rejects(registerNativeSettings({...f.config,port:54442},f.entry,f.options),/其他端口/);assert.equal(await nativeSettingsReady({...f.config,port:54442},f.options),false);
  await unregisterNativeSettings(f.config,f.options);await registerNativeSettings({...f.config,port:54442},f.entry,f.options);assert.equal(await nativeSettingsReady({...f.config,port:54442},f.options),true);
  assert.deepEqual(await registerNativeSettings(f.config,f.entry,{...f.options,platform:'linux'}),{supported:false,registered:false});
});
test('Native注册的并发更新由安装互斥保护',windows,async t=>{
  const f=await scene(t);let release!:()=>void,entered!:()=>void;const held=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve),original=f.registry.read.bind(f.registry);let block=true;
  f.registry.read=async key=>{if(block){block=false;entered();await held;}return original(key);};const first=registerNativeSettings(f.config,f.entry,f.options);await started;await assert.rejects(registerNativeSettings(f.config,f.entry,f.options),/另一个安装或恢复操作/);release();await first;
});
test('Native真实注册与PowerShell卸载只写隔离树、校验外来项并可重复执行',windows,async t=>{
  const f=await scene(t),root='HKCU\\Software\\SaltedFish\\Tests\\Native_'+randomUUID().replaceAll('-',''),registry=windowsDesktopRegistry('native'),options={...f.options,registryRoot:root,registry},key=root+'\\com.saltedfish.settings.p54441';
  const otherKey=root+'\\com.saltedfish.settings.p54442',other=nativeSettingsRegistryTree({...f.config,port:54442});
  t.after(async()=>{try{await unregisterNativeSettings(f.config,options);}finally{const current=await registry.read(otherKey);if(current)await registry.replace(otherKey,current,null);await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command','[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($env:SALTEDFISH_TEST_KEY,$false)'],{windowsHide:true,env:{...process.env,SALTEDFISH_TEST_KEY:root.substring(5)}});}});
  await registry.replace(otherKey,null,other);await registerNativeSettings(f.config,f.entry,options);assert.equal(await nativeSettingsReady(f.config,options),true);
  const env={...process.env,SALTEDFISH_TEST_COMMON:path.resolve('packaging/common.ps1'),SALTEDFISH_TEST_DATA:f.config.dataDir},run=async(suffix:string)=>promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command','. $env:SALTEDFISH_TEST_COMMON; Unregister-SaltedFishDesktop $env:SALTEDFISH_TEST_DATA '+suffix],{windowsHide:true,env});
  await run('-ValidateOnly');assert.deepEqual(await registry.read(key),nativeSettingsRegistryTree(f.config));await run('');assert.equal(await registry.read(key),null);assert.deepEqual(await registry.read(otherKey),other);assert.equal(await absent(path.join(f.folder,'registration.json')),false);await run('');
  await registerNativeSettings(f.config,f.entry,options);const own=(await registry.read(key))!,foreign=structuredClone(own);foreign.values.splice(1,0,{name:'Foreign',value:'keep',kind:'String'});await registry.replace(key,own,foreign);await assert.rejects(run('-ValidateOnly'));assert.deepEqual(await registry.read(key),foreign);await registry.replace(key,foreign,null);await registry.replace(key,null,own);
});
