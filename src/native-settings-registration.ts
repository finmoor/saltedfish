import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,readdir,mkdir,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {projectDir,type Config} from './config.js';
import {withManagementMutex} from './management-lock.js';
import {windowsDesktopRegistry,type DesktopEntry,type DesktopRegistry,type RegistryTree} from './desktop-registration.js';

type NativeConfig=Pick<Config,'dataDir'|'port'>;
export interface NativeSettingsRegistrationOptions {platform?:NodeJS.Platform;registry?:DesktopRegistry;binary?:string;registryRoot?:string;extensionDirs?:string[];extensionSource?:string;validateOnly?:boolean;storeExtensionIds?:readonly string[]}
const digest=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const Hash=z.string().regex(/^[a-f0-9]{64}$/);
const Entry=z.object({command:z.string().min(1).max(32768),args:z.array(z.string().max(32768)).max(8)}).strict();
const RecordSchema=z.object({product:z.literal('saltedfish-native-settings'),schemaVersion:z.literal(1),dataDir:z.string(),port:z.number().int().min(1024).max(65535),registryRoot:z.string(),runnerSha256:Hash,descriptorSha256:Hash,manifestSha256:Hash,entry:Entry,extensions:z.array(z.object({directory:z.string(),sha256:Hash}).strict()).min(1).max(32)}).strict();
type Registration=z.infer<typeof RecordSchema>;
const productionRoot='HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts';
const testRootPattern=/^HKCU\\Software\\SaltedFish\\Tests\\Native_[a-f0-9]{32}$/;
export function nativeSettingsRegistryRoot(value=process.env.SALTEDFISH_TEST_NATIVE_REGISTRY_ROOT){if(!value)return productionRoot;if(!testRootPattern.test(value))throw new Error('本机通信测试注册表根无效。');return value;}
export function nativeSettingsHostName(port:number){if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('本机通信端口无效。');return `com.saltedfish.settings.p${port}`;}
const samePath=(a:string,b:string)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const files=(config:NativeConfig)=>{const folder=path.join(path.resolve(config.dataDir),'native-settings');return{folder,runner:path.join(folder,'SaltedFish.NativeSettings.exe'),descriptor:path.join(folder,'native-launch.json'),manifest:path.join(folder,'host.json'),record:path.join(folder,'registration.json')};};
const text=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
const readOptional=async(file:string)=>readFile(file).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
async function atomic(file:string,value:Buffer|string){const temporary=file+'.'+randomUUID()+'.tmp';try{await writeFile(temporary,value,{flag:'wx',mode:0o600});for(let attempt=0;;attempt++)try{await rename(temporary,file);break;}catch(error){if(attempt===5||!['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code||''))throw error;await new Promise(resolve=>setTimeout(resolve,20*2**attempt));}}finally{await rm(temporary,{force:true});}}

// Chrome 应用商店版扩展的 ID（商店分配、固定，只有商店发布的包能用这个 ID，所以不用像已解压的扩展那样核对文件）。
// 第一次把商店版上传到开发者后台后填进来，Windows 本机设置入口和文件助手才认它。
export const STORE_EXTENSION_IDS:readonly string[]=[];
export function storeExtensionOrigin(id:string){if(!/^[a-p]{32}$/.test(id))throw new Error('应用商店扩展 ID 无效。');return `chrome-extension://${id}/`;}

// Chromium GenerateIdForPath: Windows FilePath 的 UTF-16 字节；仅统一盘符大小写。
// https://chromium.googlesource.com/chromium/src/+/main/components/crx_file/id_util.cc
export function unpackedExtensionOrigin(directory:string){
  if(!path.win32.isAbsolute(directory)||/[\0\r\n"]/.test(directory))throw new Error('扩展目录必须是 Windows 绝对路径。');
  const normalized=path.win32.resolve(directory).replace(/^[a-z]:/,value=>value.toUpperCase());
  const id=createHash('sha256').update(Buffer.from(normalized,'utf16le')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,value=>String.fromCharCode(97+parseInt(value,16)));
  return `chrome-extension://${id}/`;
}
async function extensionFingerprint(directory:string){
  const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));
  if(manifest.name!=='SaltedFish'||manifest.manifest_version!==3||manifest.background?.service_worker!=='background.js'||manifest.background?.type!=='module'||manifest.options_ui?.page!=='options.html'||Object.hasOwn(manifest,'key'))throw new Error('指定目录不是受支持的 SaltedFish 扩展，未授权。');
  const entries:string[]=[];
  const scan=async(folder:string,relative='')=>{for(const item of(await readdir(folder,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const name=relative?relative+'/'+item.name:item.name;if(name==='pairing.json')continue;if(item.isSymbolicLink())throw new Error('扩展中包含链接文件，未授权。');if(item.isDirectory())await scan(path.join(folder,item.name),name);else if(item.isFile())entries.push(name+'\0'+digest(await readFile(path.join(folder,item.name))));else throw new Error('扩展文件类型不受支持，未授权。');}};
  await scan(directory);return digest(entries.sort().join('\n'));
}
export function nativeSettingsRegistryTree(config:NativeConfig):RegistryTree{return{values:[{name:'',value:files(config).manifest,kind:'String'},{name:'SaltedFishInstallation',value:path.resolve(config.dataDir),kind:'String'}],keys:[]};}
function context(config:NativeConfig,options:NativeSettingsRegistrationOptions){nativeSettingsHostName(config.port);const root=options.registryRoot??nativeSettingsRegistryRoot();if(root!==productionRoot&&!testRootPattern.test(root))throw new Error('本机通信测试注册表根无效。');return{...files(config),root,key:root+'\\'+nativeSettingsHostName(config.port),registry:options.registry??windowsDesktopRegistry('native')};}
async function record(config:NativeConfig){const value=await readOptional(files(config).record);if(!value)return undefined;const saved=RecordSchema.parse(JSON.parse(value.toString('utf8')));if(!samePath(saved.dataDir,config.dataDir))throw new Error('本机通信入口属于其他安装，未修改。');return saved;}
const readyCache=new Map<string,{expires:number;pending:Promise<boolean>}>();
function invalidate(config:NativeConfig){for(const key of readyCache.keys())if(key.startsWith(path.resolve(config.dataDir)+'\0'))readyCache.delete(key);}
async function withFileLock<T>(config:NativeConfig,work:()=>Promise<T>){const folder=files(config).folder;await mkdir(folder,{recursive:true,mode:0o700});try{return await withManagementMutex(folder,work);}finally{invalidate(config);}}
async function trustedExtensions(config:NativeConfig,saved:Registration|undefined,options:NativeSettingsRegistrationOptions){
  const source=await extensionFingerprint(options.extensionSource??path.join(projectDir,'dist/extension'));
  const primary=path.resolve(config.dataDir,'extension'),explicit=(options.extensionDirs??[]).map(value=>path.resolve(value));
  if(explicit.length>31)throw new Error('扩展目录数量超过上限。');
  const directories=[...new Set([primary,...(saved?.extensions.map(value=>value.directory)??[]),...explicit])];
  if(directories.length>32)throw new Error('扩展目录数量超过上限。');
  const results=[];
  for(const directory of directories){
    unpackedExtensionOrigin(directory);
    const sha256=await extensionFingerprint(directory),previous=saved?.extensions.find(value=>value.directory===directory);
    // 默认副本与新增授权必须匹配本次发行；升级时保留仍与上次批准快照完全一致的原加载目录。
    if(sha256!==source&&(directory===primary||explicit.includes(directory)||sha256!==previous?.sha256))throw new Error('扩展目录与已验证的 SaltedFish 发行文件不一致，未授权。');
    results.push({directory,sha256});
  }
  return results.sort((a,b)=>a.directory.localeCompare(b.directory));
}
export async function registerNativeSettings(config:NativeConfig,entry:DesktopEntry,options:NativeSettingsRegistrationOptions={}){
  if((options.platform??process.platform)!=='win32')return{supported:false,registered:false};
  entry=Entry.parse(entry);if(!path.isAbsolute(entry.command)||/[\0\r\n"]/.test(entry.command)||entry.args.some(value=>/[\0\r\n]/.test(value)))throw new Error('本机通信启动参数无效。');
  return withFileLock(config,async()=>{const c=context(config,options);const work=async()=>{
    const saved=await record(config);if(saved&&(saved.port!==config.port||saved.registryRoot!==c.root)){
      const old=context({...config,port:saved.port},{...options,registryRoot:saved.registryRoot});
      if(await old.registry.read(old.key)||await readOptional(old.runner)||await readOptional(old.descriptor)||await readOptional(old.manifest))throw new Error('已有本机通信入口使用其他端口或注册位置，请先注销原入口。');
    }
    const expected=nativeSettingsRegistryTree(config),before=await c.registry.read(c.key);
    if(before&&!isDeepStrictEqual(before,expected))throw new Error('这个端口的本机通信入口已被其他程序或安装使用，未覆盖。');
    if(before&&!saved)throw new Error('发现没有本安装记录的本机通信入口，未覆盖。');
    const previous=new Map<string,Buffer|undefined>();for(const file of[c.runner,c.descriptor,c.manifest,c.record])previous.set(file,await readOptional(file));
    if(!saved&&[c.runner,c.descriptor,c.manifest].some(file=>previous.get(file)))throw new Error('本机通信文件已有其他内容，未覆盖。');
    if(saved)for(const[file,hash]of [[c.runner,saved.runnerSha256],[c.descriptor,saved.descriptorSha256],[c.manifest,saved.manifestSha256]])if(previous.get(file!)&&digest(previous.get(file!)!)!==hash)throw new Error('本机通信文件已被修改，未覆盖。');
    const extensions=await trustedExtensions(config,saved,options),allowedOrigins=[...new Set([...extensions.map(value=>unpackedExtensionOrigin(value.directory)),...(options.storeExtensionIds??STORE_EXTENSION_IDS).map(storeExtensionOrigin)])].sort();
    const binary=await readFile(options.binary??path.join(projectDir,'dist/native-settings/SaltedFish.NativeSettings.exe'));
    const descriptor=text({product:'saltedfish-native-settings',port:config.port,dataDir:path.resolve(config.dataDir),command:entry.command,args:entry.args,allowedOrigins});
    const manifest=text({name:nativeSettingsHostName(config.port),description:'SaltedFish settings',path:c.runner,type:'stdio',allowed_origins:allowedOrigins});
    const next:Registration={product:'saltedfish-native-settings',schemaVersion:1,dataDir:path.resolve(config.dataDir),port:config.port,registryRoot:c.root,runnerSha256:digest(binary),descriptorSha256:digest(descriptor),manifestSha256:digest(manifest),entry,extensions};
    try{
      for(const[file,value]of [[c.runner,binary],[c.descriptor,descriptor],[c.manifest,manifest],[c.record,text(next)]] as const)if(!previous.get(file)||digest(previous.get(file)!)!==digest(value))await atomic(file,value);
      if(!before)await c.registry.replace(c.key,null,expected);
      if(!isDeepStrictEqual(await c.registry.read(c.key),expected))throw new Error('本机通信入口登记未完成。');
    }catch(error){
      const current=await c.registry.read(c.key).catch(()=>undefined);if(!before&&current&&isDeepStrictEqual(current,expected))await c.registry.replace(c.key,current,null);
      for(const[file,value]of previous)if(value)await atomic(file,value);else await rm(file,{force:true});throw error;
    }
    return{supported:true,registered:true,host:nativeSettingsHostName(config.port),extensionCount:allowedOrigins.length};
  };return c.registry.withLock?c.registry.withLock(c.key,work):work();});
}
export async function unregisterNativeSettings(config:NativeConfig,options:NativeSettingsRegistrationOptions={}){
  if((options.platform??process.platform)!=='win32')return{supported:false,removed:false};
  return withFileLock(config,async()=>{const saved=await record(config);if(!saved)return{supported:true,removed:false};const original={...config,port:saved.port},c=context(original,{...options,registryRoot:saved.registryRoot});const work=async()=>{
    if(!isDeepStrictEqual(await record(config),saved))throw new Error('本机通信记录在注销前发生变化，未删除。');
    const before=await c.registry.read(c.key),expected=nativeSettingsRegistryTree(original);if(before&&!isDeepStrictEqual(before,expected))throw new Error('本机通信入口已被其他程序修改，未删除。');
    const previous=new Map<string,Buffer|undefined>();for(const file of[c.runner,c.descriptor,c.manifest,c.record])previous.set(file,await readOptional(file));
    for(const[file,hash]of [[c.runner,saved.runnerSha256],[c.descriptor,saved.descriptorSha256],[c.manifest,saved.manifestSha256]])if(previous.get(file!)&&digest(previous.get(file!)!)!==hash)throw new Error('本机通信文件已被修改，未删除。');
    if(options.validateOnly)return{supported:true,removed:false};
    if(before)await c.registry.replace(c.key,before,null);
    // 授权目录快照随 data 保留；回滚到旧版再升级时无需重新登记原扩展路径。
    try{for(const file of[c.runner,c.descriptor,c.manifest])await rm(file,{force:true});}catch(error){for(const[file,value]of previous)if(value&&!await readOptional(file))await atomic(file,value);if(before&&!await c.registry.read(c.key))await c.registry.replace(c.key,null,before);throw error;}
    return{supported:true,removed:!!before};
  };return c.registry.withLock?c.registry.withLock(c.key,work):work();});
}
export async function nativeSettingsReady(config:NativeConfig,options:NativeSettingsRegistrationOptions={}):Promise<boolean>{
  if((options.platform??process.platform)!=='win32')return false;
  const key=path.resolve(config.dataDir)+'\0'+config.port+'\0'+(options.registryRoot??process.env.SALTEDFISH_TEST_NATIVE_REGISTRY_ROOT??'');const cached=readyCache.get(key);if(cached&&cached.expires>Date.now())return cached.pending;
  const pending=(async()=>{try{const c=context(config,options),saved=await record(config);if(!saved||saved.port!==config.port||saved.registryRoot!==c.root)return false;for(const[file,hash]of [[c.runner,saved.runnerSha256],[c.descriptor,saved.descriptorSha256],[c.manifest,saved.manifestSha256]]){const value=await readOptional(file!);if(!value||digest(value)!==hash)return false;}return isDeepStrictEqual(await c.registry.read(c.key),nativeSettingsRegistryTree(config));}catch{return false;}})();
  readyCache.set(key,{expires:Date.now()+5000,pending});if(readyCache.size>128)readyCache.delete(readyCache.keys().next().value!);return pending;
}
