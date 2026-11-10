import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,access,rm} from 'node:fs/promises';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {testDirectory} from './helpers.js';
import {registerDesktopLaunch,unregisterDesktopLaunch,desktopLaunchReady,desktopRegistryRoot,desktopRegistryTree,windowsDesktopRegistry,type DesktopRegistry,type RegistryTree} from '../src/desktop-registration.js';

class Registry implements DesktopRegistry {
  entries=new Map<string,RegistryTree>();reads=0;writes=0;failure=false;
  async read(key:string){this.reads++;return structuredClone(this.entries.get(key)??null);}
  async replace(key:string,expected:RegistryTree|null,next:RegistryTree|null){assert.deepEqual(this.entries.get(key)??null,expected,'Registry changed');if(this.failure)throw new Error('test registry write failure');this.writes++;if(next)this.entries.set(key,structuredClone(next));else this.entries.delete(key);}
}
async function scene(t:TestContext){
  const temp=await testDirectory();t.after(()=>temp.cleanup());const config={dataDir:temp.directory,port:54431},registry=new Registry(),binary=path.join(temp.directory,'fixture.exe');await writeFile(binary,'fixture binary');
  const entry={command:process.execPath,args:[path.join(temp.directory,'trusted entry.js')]},options={platform:'win32' as const,registry,binary},key='HKCU\\Software\\Classes\\saltedfish-'+config.port;
  return{temp,config,registry,binary,entry,options,key,folder:path.join(temp.directory,'desktop')};
}
const absent=async(file:string)=>access(file).then(()=>false,()=>true);

test('桌面注册只写当前安装固定入口，重复登记幂等且Ready合并并发只读查询',async t=>{
  const f=await scene(t);await registerDesktopLaunch(f.config,f.entry,f.options);assert.deepEqual(f.registry.entries.get(f.key),desktopRegistryTree(f.config));
  const descriptor=JSON.parse(await readFile(path.join(f.folder,'settings-launch.json'),'utf8'));assert.deepEqual(descriptor,{product:'saltedfish-desktop',port:f.config.port,dataDir:f.config.dataDir,...f.entry});assert.equal(Object.hasOwn(descriptor,'token'),false);
  const before=await readFile(path.join(f.folder,'registration.json'),'utf8');await registerDesktopLaunch(f.config,f.entry,f.options);assert.equal(f.registry.writes,1);assert.equal(await readFile(path.join(f.folder,'registration.json'),'utf8'),before);
  const reads=f.registry.reads;assert.deepEqual(await Promise.all(Array.from({length:5},()=>desktopLaunchReady(f.config,f.options))),[true,true,true,true,true]);assert.equal(f.registry.reads,reads+1);
  assert.equal((await unregisterDesktopLaunch(f.config,f.options)).removed,true);assert.equal(await absent(path.join(f.folder,'registration.json')),true);assert.equal(await desktopLaunchReady(f.config,f.options),false);
});
test('其他安装或额外注册表字段不能被覆盖、删除，也不能冒充Ready',async t=>{
  const f=await scene(t),other=desktopRegistryTree({...f.config,dataDir:path.join(f.temp.directory,'other')});f.registry.entries.set(f.key,other);
  await assert.rejects(registerDesktopLaunch(f.config,f.entry,f.options),/其他程序或安装/);assert.deepEqual(f.registry.entries.get(f.key),other);assert.equal(await absent(path.join(f.folder,'settings-launch.json')),true);
  f.registry.entries.clear();await registerDesktopLaunch(f.config,f.entry,f.options);f.registry.entries.get(f.key)!.values.push({name:'Foreign',value:'keep',kind:'String'});
  await assert.rejects(unregisterDesktopLaunch(f.config,f.options),/已被其他程序修改/);assert.equal(await desktopLaunchReady(f.config,f.options),false);assert.equal(f.registry.entries.get(f.key)!.values.at(-1)!.value,'keep');
});
test('用户修改的启动文件保持，丢失文件可由同一登记修复',async t=>{
  const f=await scene(t);await registerDesktopLaunch(f.config,f.entry,f.options);const file=path.join(f.folder,'SaltedFish.Settings.exe');await writeFile(file,'changed by owner');
  await assert.rejects(registerDesktopLaunch(f.config,f.entry,f.options),/已被修改/);await assert.rejects(unregisterDesktopLaunch(f.config,f.options),/已被修改/);assert.equal(await readFile(file,'utf8'),'changed by owner');
  await rm(file);await registerDesktopLaunch(f.config,f.entry,f.options);assert.equal(await readFile(file,'utf8'),'fixture binary');
});
test('注册失败回退本轮文件，随后可重试，不留下不可恢复的锁',async t=>{
  const f=await scene(t);f.registry.failure=true;await assert.rejects(registerDesktopLaunch(f.config,f.entry,f.options),/test registry write failure/);assert.equal(await absent(path.join(f.folder,'registration.json')),true);assert.equal(await absent(path.join(f.folder,'SaltedFish.Settings.exe')),true);
  f.registry.failure=false;await registerDesktopLaunch(f.config,f.entry,f.options);assert.equal(await desktopLaunchReady(f.config,f.options),true);
});
test('并发登记拒绝第二个写入，完成后可正常重试',async t=>{
  const f=await scene(t);let release!:()=>void,entered!:()=>void;const held=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve),original=f.registry.read.bind(f.registry);let block=true;
  f.registry.read=async key=>{if(block){block=false;entered();await held;}return original(key);};const first=registerDesktopLaunch(f.config,f.entry,f.options);await started;
  await assert.rejects(registerDesktopLaunch(f.config,f.entry,f.options),/另一个安装或恢复操作/);release();await first;await registerDesktopLaunch(f.config,f.entry,f.options);assert.equal(await desktopLaunchReady(f.config,f.options),true);
});
test('端口变化必须先移除本安装旧入口，错误平台和无效测试根不写全局状态',async t=>{
  const f=await scene(t);await registerDesktopLaunch(f.config,f.entry,f.options);const changed={...f.config,port:54432};await assert.rejects(registerDesktopLaunch(changed,f.entry,f.options),/其他端口/);assert.equal(await desktopLaunchReady(changed,f.options),false);
  await unregisterDesktopLaunch(changed,f.options);assert.equal(f.registry.entries.size,0);assert.deepEqual(await registerDesktopLaunch(changed,f.entry,{...f.options,platform:'linux'}),{supported:false,registered:false});
  assert.throws(()=>desktopRegistryRoot('HKLM\\Software\\Classes'),/测试注册表根无效/);assert.throws(()=>desktopRegistryRoot('HKCU\\Software\\Other'),/测试注册表根无效/);
});
test('注销删除遇到文件占用时恢复已删启动器和原登记，释放占用后可重试',{skip:process.platform!=='win32'},async t=>{
  const f=await scene(t);await registerDesktopLaunch(f.config,f.entry,f.options);const descriptor=path.join(f.folder,'settings-launch.json'),before=await readFile(descriptor),saved=await readFile(path.join(f.folder,'registration.json'));
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$file=[IO.File]::Open($env:SALTEDFISH_TEST_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{[Console]::Out.WriteLine('locked');[Console]::Out.Flush();[void][Console]::In.ReadLine()}finally{$file.Dispose()}"],{windowsHide:true,env:{...process.env,SALTEDFISH_TEST_FILE:descriptor},stdio:['pipe','pipe','pipe']});child.stdin.on('error',()=>{});child.stderr.resume();const done=new Promise<number|null>((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});
  try{await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('error',reject);});await assert.rejects(unregisterDesktopLaunch(f.config,f.options));assert.deepEqual(f.registry.entries.get(f.key),desktopRegistryTree(f.config));assert.deepEqual(await readFile(descriptor),before);assert.deepEqual(await readFile(path.join(f.folder,'registration.json')),saved);assert.equal(await readFile(path.join(f.folder,'SaltedFish.Settings.exe'),'utf8'),'fixture binary');}
  finally{child.stdin.end('\n');assert.equal(await done,0);}assert.equal((await unregisterDesktopLaunch(f.config,f.options)).removed,true);
});
test('Windows真实注册表读写只使用自有隔离树，精确移除且保留同级项', {skip:process.platform!=='win32'},async t=>{
  const f=await scene(t),root='HKCU\\Software\\SaltedFish\\Tests\\Desktop_'+randomUUID().replaceAll('-',''),registry=windowsDesktopRegistry(),options={...f.options,registryRoot:root,registry};
  const otherKey=root+'\\saltedfish-54432',other=desktopRegistryTree({...f.config,port:54432});
  t.after(async()=>{try{await unregisterDesktopLaunch(f.config,options);}finally{const current=await registry.read(otherKey);if(current)await registry.replace(otherKey,current,null);const relative=root.substring(5);assert.match(relative,/^Software\\SaltedFish\\Tests\\Desktop_[a-f0-9]{32}$/);await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command','[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($env:SALTEDFISH_TEST_KEY,$false)'],{windowsHide:true,env:{...process.env,SALTEDFISH_TEST_KEY:relative}});}});
  await registry.replace(otherKey,null,other);await registerDesktopLaunch(f.config,f.entry,options);assert.equal(await desktopLaunchReady(f.config,options),true);await unregisterDesktopLaunch(f.config,options);assert.deepEqual(await registry.read(otherKey),other);assert.equal(await registry.read(root+'\\saltedfish-54431'),null);
  await registerDesktopLaunch(f.config,f.entry,options);const env={...process.env,SALTEDFISH_TEST_COMMON:path.resolve('packaging/common.ps1'),SALTEDFISH_TEST_DATA:f.config.dataDir};await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command','. $env:SALTEDFISH_TEST_COMMON; Unregister-SaltedFishDesktop $env:SALTEDFISH_TEST_DATA -ValidateOnly'],{windowsHide:true,env});assert.deepEqual(await registry.read(root+'\\saltedfish-54431'),desktopRegistryTree(f.config));assert.equal(await absent(path.join(f.folder,'settings-launch.json')),false);
  await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command','. $env:SALTEDFISH_TEST_COMMON; Unregister-SaltedFishDesktop $env:SALTEDFISH_TEST_DATA'],{windowsHide:true,env});assert.equal(await registry.read(root+'\\saltedfish-54431'),null);assert.deepEqual(await registry.read(otherKey),other);
});
test('专用GUI启动器只传递一个受限URI与固定dataDir，拒绝额外参数或引号输入',{skip:process.platform!=='win32'},async t=>{
  const f=await scene(t),probe=path.join(f.temp.directory,'probe.mjs'),result=path.join(f.temp.directory,'received.json');await writeFile(probe,"import{writeFile}from'node:fs/promises';import path from'node:path';await writeFile(path.join(process.env.CHROME_MCP_DATA_DIR,'received.json'),JSON.stringify({args:process.argv.slice(2),directory:process.env.CHROME_MCP_DATA_DIR}));");
  await registerDesktopLaunch(f.config,{command:process.execPath,args:[probe]},{...f.options,binary:path.resolve('dist/desktop/SaltedFish.Settings.exe')});const runner=path.join(f.folder,'SaltedFish.Settings.exe'),exec=promisify(execFile),url='saltedfish-'+f.config.port+'://settings/remote';
  await exec(runner,[url],{windowsHide:true,timeout:10000});assert.deepEqual(JSON.parse(await readFile(result,'utf8')),{args:['desktop-open',url],directory:f.config.dataDir});await rm(result);
  const uppercase='saltedfish-'+f.config.port+'://settings/agents?profile=AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';await exec(runner,[uppercase],{windowsHide:true,timeout:10000});assert.equal(JSON.parse(await readFile(result,'utf8')).args[1],uppercase);await rm(result);
  for(const args of [[url,'--extra'],['http://example.test/'],[url+'"'],['saltedfish-54432://settings/remote'],[url+'%22']]){await assert.rejects(exec(runner,args,{windowsHide:true,timeout:10000}));assert.equal(await absent(result),true);}
});
