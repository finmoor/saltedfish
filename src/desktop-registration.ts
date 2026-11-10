import {execFile,spawn} from 'node:child_process';
import {promisify,isDeepStrictEqual} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {projectDir,type Config} from './config.js';
import {withManagementMutex} from './management-lock.js';

const exec=promisify(execFile),digest=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
type DesktopConfig=Pick<Config,'dataDir'|'port'>;
export interface DesktopEntry {command:string;args:string[]}
export interface RegistryTree {values:{name:string;value:string;kind:string}[];keys:{name:string;tree:RegistryTree}[]}
export interface DesktopRegistry {read(key:string):Promise<RegistryTree|null>;replace(key:string,expected:RegistryTree|null,next:RegistryTree|null):Promise<void>;withLock?<T>(key:string,work:()=>Promise<T>):Promise<T>}
export interface DesktopRegistrationOptions {platform?:NodeJS.Platform;registry?:DesktopRegistry;binary?:string;registryRoot?:string;validateOnly?:boolean}
const Entry=z.object({command:z.string().min(1).max(32768),args:z.array(z.string().max(32768)).max(8)}).strict();
const RecordSchema=z.object({product:z.literal('saltedfish-desktop'),schemaVersion:z.literal(1),dataDir:z.string(),port:z.number().int().min(1024).max(65535),registryRoot:z.string(),runnerSha256:z.string().regex(/^[a-f0-9]{64}$/),descriptorSha256:z.string().regex(/^[a-f0-9]{64}$/),entry:Entry}).strict();
type Registration=z.infer<typeof RecordSchema>;
const productionRoot='HKCU\\Software\\Classes';
const testRootPattern=/^HKCU\\Software\\SaltedFish\\Tests\\Desktop_[a-f0-9]{32}$/;
export function desktopRegistryRoot(value=process.env.SALTEDFISH_TEST_DESKTOP_REGISTRY_ROOT){if(!value)return productionRoot;if(!testRootPattern.test(value))throw new Error('桌面入口测试注册表根无效。');return value;}
export function desktopScheme(port:number){if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('桌面入口端口无效。');return `saltedfish-${port}`;}
const samePath=(a:string,b:string)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const files=(config:DesktopConfig)=>{const folder=path.join(path.resolve(config.dataDir),'desktop');return{folder,runner:path.join(folder,'SaltedFish.Settings.exe'),descriptor:path.join(folder,'settings-launch.json'),record:path.join(folder,'registration.json')};};
const text=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
const readOptional=async(file:string)=>readFile(file).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
async function atomic(file:string,value:Buffer|string){const temporary=file+'.'+randomUUID()+'.tmp';try{await writeFile(temporary,value,{flag:'wx',mode:0o600});for(let attempt=0;;attempt++)try{await rename(temporary,file);break;}catch(error){if(attempt===5||!['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code||''))throw error;await new Promise(resolve=>setTimeout(resolve,20*2**attempt));}}finally{await rm(temporary,{force:true});}}
function registryTree(config:DesktopConfig):RegistryTree{return{values:[{name:'',value:'URL:SaltedFish settings',kind:'String'},{name:'SaltedFishInstallation',value:path.resolve(config.dataDir),kind:'String'},{name:'URL Protocol',value:'',kind:'String'}],keys:[{name:'shell',tree:{values:[],keys:[{name:'open',tree:{values:[],keys:[{name:'command',tree:{values:[{name:'',value:`"${files(config).runner}" "%1"`,kind:'String'}],keys:[]}}]}}]}}]};}
export function desktopRegistryTree(config:DesktopConfig){return registryTree(config);}

// 参数通过环境传递，不拼进 PowerShell 代码；命令值仅作注册表数据，绝不在这里执行。
const registryScript=String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$relative=$env:SALTEDFISH_REG_KEY.Substring(5)
function Read-Tree($key){
  if($null -eq $key){return $null}
  $values=@($key.GetValueNames()|Sort-Object -CaseSensitive|ForEach-Object{[ordered]@{name=$_;value=$key.GetValue($_,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);kind=$key.GetValueKind($_).ToString()}})
  $keys=@($key.GetSubKeyNames()|Sort-Object -CaseSensitive|ForEach-Object{$sub=$key.OpenSubKey($_);try{[ordered]@{name=$_;tree=(Read-Tree $sub)}}finally{$sub.Dispose()}})
  return [ordered]@{values=$values;keys=$keys}
}
function Snapshot{$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($relative);try{Read-Tree $key}finally{if($key){$key.Dispose()}}}
function Write-Tree($key,$tree){foreach($item in $tree.values){if($item.kind -ne 'String'){throw 'Unsupported registry kind'};$key.SetValue($item.name,[string]$item.value,[Microsoft.Win32.RegistryValueKind]::String)};foreach($item in $tree.keys){$sub=$key.CreateSubKey($item.name);try{Write-Tree $sub $item.tree}finally{$sub.Dispose()}}}
if($env:SALTEDFISH_REG_ACTION -eq 'read'){$value=Snapshot;if($null -eq $value){[Console]::Write('null')}else{[Console]::Write(($value|ConvertTo-Json -Depth 20 -Compress))};exit}
$mutex=[Threading.Mutex]::new($false,('Local\SaltedFishDesktop_'+$env:SALTEDFISH_REG_MUTEX));$taken=$false
try{
  if($env:SALTEDFISH_REG_LEASE -ne '1'){try{$taken=$mutex.WaitOne(5000)}catch [Threading.AbandonedMutexException]{$taken=$true};if(-not $taken){throw 'Desktop registration busy'}}
  $before=Snapshot;$expected=ConvertFrom-Json $env:SALTEDFISH_REG_EXPECTED
  if(($before|ConvertTo-Json -Depth 20 -Compress) -cne ($expected|ConvertTo-Json -Depth 20 -Compress)){throw 'Desktop registration changed'}
  $next=ConvertFrom-Json $env:SALTEDFISH_REG_NEXT
  if($null -eq $next){[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($relative,$false)}else{$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($relative);try{Write-Tree $key $next}finally{$key.Dispose()}}
  [Console]::Write('ok')
}finally{if($taken){$mutex.ReleaseMutex()};$mutex.Dispose()}
`;
export function windowsDesktopRegistry(kind:'desktop'|'native'='desktop'):DesktopRegistry{
  const leased=new Set<string>();
  const command=async(key:string,action:string,expected?:RegistryTree|null,next?:RegistryTree|null)=>{const leaf=kind==='native'?/^com\.saltedfish\.settings\.p\d+$/:/^saltedfish-\d+$/;if(!key.startsWith('HKCU\\Software\\')||!leaf.test(key.split('\\').at(-1)!))throw new Error('桌面入口注册表路径无效。');return(await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(registryScript,'utf16le').toString('base64')],{windowsHide:true,timeout:10000,maxBuffer:128*1024,env:{...process.env,SALTEDFISH_REG_KEY:key,SALTEDFISH_REG_ACTION:action,SALTEDFISH_REG_EXPECTED:JSON.stringify(expected??null),SALTEDFISH_REG_NEXT:JSON.stringify(next??null),SALTEDFISH_REG_MUTEX:digest(key),SALTEDFISH_REG_LEASE:leased.has(key)?'1':'0'}})).stdout.trim();};
  return{async read(key){return JSON.parse(await command(key,'read')) as RegistryTree|null;},async replace(key,expected,next){await command(key,'replace',expected,next);},async withLock<T>(key:string,work:()=>Promise<T>){
    const script=String.raw`$ErrorActionPreference='Stop';$mutex=[Threading.Mutex]::new($false,('Local\SaltedFishDesktop_'+$env:SALTEDFISH_REG_MUTEX));$taken=$false;try{try{$taken=$mutex.WaitOne(5000)}catch [Threading.AbandonedMutexException]{$taken=$true};if(-not $taken){throw 'Desktop registration busy'};[Console]::Out.WriteLine('locked');[Console]::Out.Flush();[void][Console]::In.ReadLine()}finally{if($taken){$mutex.ReleaseMutex()};$mutex.Dispose()}`;
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,env:{...process.env,SALTEDFISH_REG_MUTEX:digest(key)},stdio:['pipe','pipe','pipe']});let output='';child.stderr.resume();child.stdin.on('error',()=>{});
    const exited=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    try{await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('桌面入口锁等待超时。')),8000);child.stdout.on('data',data=>{output+=data;if(output.includes('locked')){clearTimeout(timer);resolve();}});exited.then(()=>{clearTimeout(timer);reject(new Error('桌面入口正在更新，请稍后重试。'));},reject);});leased.add(key);return await work();}
    finally{leased.delete(key);child.stdin.end('\n');const code=await exited; if(code!==0&&code!==null)throw new Error('桌面入口锁未正常结束。');}
  }};
}
function context(config:DesktopConfig,options:DesktopRegistrationOptions){desktopScheme(config.port);const root=options.registryRoot??desktopRegistryRoot();if(root!==productionRoot&&!testRootPattern.test(root))throw new Error('桌面入口测试注册表根无效。');return{...files(config),root,key:root+'\\'+desktopScheme(config.port),registry:options.registry??windowsDesktopRegistry()};}
async function record(config:DesktopConfig){const value=await readOptional(files(config).record);if(!value)return undefined;const saved=RecordSchema.parse(JSON.parse(value.toString('utf8')));if(!samePath(saved.dataDir,config.dataDir))throw new Error('桌面入口属于其他安装，未修改。');return saved;}
const readyCache=new Map<string,{expires:number;pending:Promise<boolean>}>();
function invalidate(config:DesktopConfig){for(const key of readyCache.keys())if(key.startsWith(path.resolve(config.dataDir)+'\0'))readyCache.delete(key);}
async function withFileLock<T>(config:DesktopConfig,work:()=>Promise<T>){const folder=files(config).folder;await mkdir(folder,{recursive:true,mode:0o700});try{return await withManagementMutex(folder,work);}finally{invalidate(config);}}

export async function registerDesktopLaunch(config:DesktopConfig,entry:DesktopEntry,options:DesktopRegistrationOptions={}){
  if((options.platform??process.platform)!=='win32')return{supported:false,registered:false};
  entry=Entry.parse(entry);if(!path.isAbsolute(entry.command)||/[\0\r\n"]/.test(entry.command)||entry.args.some(value=>/[\0\r\n]/.test(value)))throw new Error('桌面入口启动参数无效。');
  return withFileLock(config,async()=>{
    const c=context(config,options);const work=async()=>{const saved=await record(config);if(saved&&(saved.port!==config.port||saved.registryRoot!==c.root))throw new Error('已有桌面入口使用其他端口或注册位置，请先注销原入口。');
    const expectedTree=registryTree(config),before=await c.registry.read(c.key);
    if(before&&!isDeepStrictEqual(before,expectedTree))throw new Error('这个端口的桌面入口已被其他程序或安装使用，未覆盖。');
    if(before&&!saved)throw new Error('发现没有本安装记录的桌面入口，未覆盖。');
    await mkdir(c.folder,{recursive:true,mode:0o700});
    const previous=new Map<string,Buffer|undefined>();for(const file of [c.runner,c.descriptor,c.record])previous.set(file,await readOptional(file));
    if(!saved&&(previous.get(c.runner)||previous.get(c.descriptor)))throw new Error('桌面启动文件已有其他内容，未覆盖。');
    if(saved&&(previous.get(c.runner)&&digest(previous.get(c.runner)!)!==saved.runnerSha256||previous.get(c.descriptor)&&digest(previous.get(c.descriptor)!)!==saved.descriptorSha256))throw new Error('桌面启动文件已被修改，未覆盖。');
    const binary=await readFile(options.binary??path.join(projectDir,'dist/desktop/SaltedFish.Settings.exe'));
    const descriptor=text({product:'saltedfish-desktop',port:config.port,dataDir:path.resolve(config.dataDir),command:entry.command,args:entry.args});
    const next:Registration={product:'saltedfish-desktop',schemaVersion:1,dataDir:path.resolve(config.dataDir),port:config.port,registryRoot:c.root,runnerSha256:digest(binary),descriptorSha256:digest(descriptor),entry};
    try{
      if(!previous.get(c.runner)||digest(previous.get(c.runner)!)!==next.runnerSha256)await atomic(c.runner,binary);
      if(!previous.get(c.descriptor)||digest(previous.get(c.descriptor)!)!==next.descriptorSha256)await atomic(c.descriptor,descriptor);
      await atomic(c.record,text(next));
      if(!before)await c.registry.replace(c.key,null,expectedTree);
      if(!isDeepStrictEqual(await c.registry.read(c.key),expectedTree))throw new Error('桌面入口登记未完成。');
    }catch(error){
      const current=await c.registry.read(c.key).catch(()=>undefined);if(!before&&current&&isDeepStrictEqual(current,expectedTree))await c.registry.replace(c.key,current,null);
      for(const[file,value]of previous)if(value)await atomic(file,value);else await rm(file,{force:true});throw error;
    }
    return{supported:true,registered:true,scheme:desktopScheme(config.port)};};return c.registry.withLock?c.registry.withLock(c.key,work):work();
  });
}
export async function unregisterDesktopLaunch(config:DesktopConfig,options:DesktopRegistrationOptions={}){
  if((options.platform??process.platform)!=='win32')return{supported:false,removed:false};
  return withFileLock(config,async()=>{const saved=await record(config);if(!saved)return{supported:true,removed:false};const original={...config,port:saved.port},c=context(original,{...options,registryRoot:saved.registryRoot});const work=async()=>{if(!isDeepStrictEqual(await record(config),saved))throw new Error('桌面入口记录在注销前发生变化，未删除。');
    const before=await c.registry.read(c.key),expected=registryTree(original);if(before&&!isDeepStrictEqual(before,expected))throw new Error('桌面入口已被其他程序修改，未删除。');
    const runner=await readOptional(c.runner),descriptor=await readOptional(c.descriptor);if(runner&&digest(runner)!==saved.runnerSha256||descriptor&&digest(descriptor)!==saved.descriptorSha256)throw new Error('桌面启动文件已被修改，未删除。');
    if(options.validateOnly)return{supported:true,removed:false};
    const originalRecord=await readFile(c.record);if(before)await c.registry.replace(c.key,before,null);try{for(const file of[c.runner,c.descriptor,c.record])await rm(file,{force:true});}catch(error){for(const[file,value]of [[c.runner,runner],[c.descriptor,descriptor],[c.record,originalRecord]] as const)if(value&&!await readOptional(file))await atomic(file,value);if(before&&!await c.registry.read(c.key))await c.registry.replace(c.key,null,before);throw error;}return{supported:true,removed:!!before};};return c.registry.withLock?c.registry.withLock(c.key,work):work();});
}
export async function desktopLaunchReady(config:DesktopConfig,options:DesktopRegistrationOptions={}):Promise<boolean>{
  if((options.platform??process.platform)!=='win32')return false;
  const key=path.resolve(config.dataDir)+'\0'+config.port+'\0'+(options.registryRoot??process.env.SALTEDFISH_TEST_DESKTOP_REGISTRY_ROOT??'');const cached=readyCache.get(key);if(cached&&cached.expires>Date.now())return cached.pending;
  const pending=(async()=>{try{const c=context(config,options),saved=await record(config);if(!saved||saved.port!==config.port||saved.registryRoot!==c.root)return false;const[runner,descriptor,tree]=await Promise.all([readOptional(c.runner),readOptional(c.descriptor),c.registry.read(c.key)]);return!!runner&&!!descriptor&&digest(runner)===saved.runnerSha256&&digest(descriptor)===saved.descriptorSha256&&isDeepStrictEqual(tree,registryTree(config));}catch{return false;}})();
  readyCache.set(key,{expires:Date.now()+5000,pending});if(readyCache.size>128)readyCache.delete(readyCache.keys().next().value!);return pending;
}
