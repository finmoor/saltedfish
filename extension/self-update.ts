import {isNewerVersion} from '../ui/extension-version.js';

// 手动加载的扩展 Chrome 不会自动更新，扩展也不知道自己的文件夹在哪。所以让用户选一次文件夹，把校验过的包写进去，再重载自己。
// 必须在设置页标签里做：工具栏弹窗一失去焦点就关，文件夹选择框和 Chrome 的授权询问都走不完。
// 更新包走未加密的内网 HTTP 也没关系，真假由后台用配对密钥核对过的 version + sha256 决定；能伪造这个证明的人本来就能操作这个浏览器。
export interface UpdateOffer{version:string;versionName:string;sha256:string;serviceUrl:string}
export interface RunningManifest{name:string;version:string}
export type FolderHandle=FileSystemDirectoryHandle&{requestPermission(descriptor:{mode:'readwrite'}):Promise<PermissionState>};
export interface FolderStore{saved():Promise<FolderHandle|undefined>;remember(folder:FolderHandle):Promise<void>;forget():Promise<void>}
// wrongFolder 为真时页面给出“查看文件夹位置”的入口。
export class UpdateError extends Error{constructor(message:string,readonly wrongFolder=false){super(message);this.name='UpdateError';}}

const MANIFEST='manifest.json',REQUIRED=[MANIFEST,'background.js','options.html'],MAX_FILES=64,MAX_BYTES=64*1024*1024,FILE_NAME=/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const STORE='folders',KEY='extension';
const encoder=new TextEncoder();
const hex=(bytes:Uint8Array)=>Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
export const sha256=async(bytes:Uint8Array)=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource)));

// 服务的 ZIP 不压缩（src/zip.ts），这里只认这一种格式，其他一律拒绝。
export function readPackage(bytes:Uint8Array){
  const invalid=()=>new UpdateError('更新包格式不对，已停止，文件没有改动。'),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),end=bytes.length-22,decoder=new TextDecoder();
  if(end<0||bytes.length>MAX_BYTES||view.getUint32(end,true)!==0x06054b50)throw invalid();
  const count=view.getUint16(end+10,true),files=new Map<string,Uint8Array>();let offset=view.getUint32(end+16,true);
  if(count>MAX_FILES)throw invalid();
  for(let index=0;index<count;index++){
    if(offset+46>end||view.getUint32(offset,true)!==0x02014b50||view.getUint16(offset+10,true)!==0)throw invalid();
    const size=view.getUint32(offset+24,true),nameLength=view.getUint16(offset+28,true),extra=view.getUint16(offset+30,true),comment=view.getUint16(offset+32,true),local=view.getUint32(offset+42,true);
    if(offset+46+nameLength>end||local+30>end||view.getUint32(local,true)!==0x04034b50)throw invalid();
    const name=decoder.decode(bytes.subarray(offset+46,offset+46+nameLength)),start=local+30+view.getUint16(local+26,true)+view.getUint16(local+28,true);
    if(!FILE_NAME.test(name)||start+size>end||files.has(name))throw invalid();
    files.set(name,bytes.subarray(start,start+size));offset+=46+nameLength+extra+comment;
  }
  return files;
}

export function checkPackage(files:Map<string,Uint8Array>,offer:UpdateOffer,running:RunningManifest){
  if(REQUIRED.some(name=>!files.has(name)))throw new UpdateError('更新包不完整，已停止，文件没有改动。');
  let manifest:{name?:unknown;version?:unknown;manifest_version?:unknown};
  try{manifest=JSON.parse(new TextDecoder().decode(files.get(MANIFEST)));}catch{throw new UpdateError('更新包格式不对，已停止，文件没有改动。');}
  if(manifest.name!==running.name||manifest.manifest_version!==3||manifest.version!==offer.version)throw new UpdateError('更新包和服务说的版本对不上，已停止，文件没有改动。');
  if(!isNewerVersion(offer.version,running.version))throw new UpdateError('服务带的扩展不比当前版本新，不用更新。');
}

async function writeFile(folder:FileSystemDirectoryHandle,name:string,bytes:Uint8Array){
  const writable=await (await folder.getFileHandle(name,{create:true})).createWritable();
  await writable.write(bytes as FileSystemWriteChunkType);await writable.close();
}
async function readExisting(folder:FileSystemDirectoryHandle,name:string){
  try{return new Uint8Array(await (await (await folder.getFileHandle(name)).getFile()).arrayBuffer());}
  catch(error){if((error as Error).name==='NotFoundError')return undefined;throw error;}
}

// 名字和内容都对也可能是另一份副本（比如用户解压的新文件夹），所以写一个随机文件，再从扩展自己的地址读回来：读得到才是 Chrome 正在加载的文件夹。
export async function isLoadedFolder(folder:FileSystemDirectoryHandle){
  const nonce=hex(crypto.getRandomValues(new Uint8Array(16))),name=`saltedfish-update-check-${nonce}.txt`;
  await writeFile(folder,name,encoder.encode(nonce));
  try{const response=await fetch(chrome.runtime.getURL(name),{cache:'no-store'});return response.ok&&await response.text()===nonce;}
  catch{return false;}
  finally{await folder.removeEntry(name).catch(()=>{});}
}

// manifest 最后写：中途失败时 Chrome 读到的还是旧版本。单个文件的写入是原子的，写失败的文件没变，只恢复已经写成的。
export async function applyPackage(folder:FileSystemDirectoryHandle,files:Map<string,Uint8Array>){
  const order=[...[...files.keys()].filter(name=>name!==MANIFEST),MANIFEST],previous=new Map<string,Uint8Array|undefined>(),touched:string[]=[];
  for(const name of order)previous.set(name,await readExisting(folder,name));
  try{for(const name of order){await writeFile(folder,name,files.get(name)!);touched.push(name);}}
  catch(error){
    const stuck:string[]=[];
    for(const name of touched.reverse()){
      try{const original=previous.get(name);if(original)await writeFile(folder,name,original);else await folder.removeEntry(name).catch(reason=>{if((reason as Error).name!=='NotFoundError')throw reason;});}
      catch{stuck.push(name);}
    }
    if(stuck.length)throw new UpdateError(`写入失败，${stuck.join('、')} 没能恢复。到管理页下载新的扩展包，覆盖这个文件夹，再到 chrome://extensions 重新加载。`);
    throw new UpdateError(`写入失败，文件已恢复，扩展没有更新：${(error as Error).message}`);
  }
}

const database=()=>new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('saltedfish-update',1);request.onupgradeneeded=()=>request.result.createObjectStore(STORE);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
async function transact<T>(mode:IDBTransactionMode,run:(store:IDBObjectStore)=>IDBRequest<T>){
  const opened=await database();
  try{return await new Promise<T>((resolve,reject)=>{const request=run(opened.transaction(STORE,mode).objectStore(STORE));request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
  finally{opened.close();}
}
export const folderStore:FolderStore={
  saved:()=>transact<FolderHandle|undefined>('readonly',store=>store.get(KEY)),
  remember:async folder=>{await transact('readwrite',store=>store.put(folder,KEY));},
  forget:async()=>{await transact('readwrite',store=>store.delete(KEY));},
};

// 重载后文件夹的授权就没了，Chrome 每次都可能再问一下，这一步要趁点击还有效时先做。
async function chooseFolder(folders:FolderStore){
  const saved=await folders.saved();
  if(saved){
    if(await saved.requestPermission({mode:'readwrite'})!=='granted')throw new UpdateError('没有得到编辑文件的允许，扩展没有更新。');
    return saved;
  }
  return await (globalThis as unknown as {showDirectoryPicker(options:object):Promise<FolderHandle>}).showDirectoryPicker({mode:'readwrite',id:'saltedfish-extension',startIn:'downloads'});
}

// 下载在哈希和真实性校验之前，所以大小和时间要在这里设限：整个下载（连接加读取）共用一个总超时，
// 按块读取、累计字节超过 MAX_BYTES 立即取消；Content-Length 只用来提前拒绝，不当作实际大小。
export const DOWNLOAD_TIMEOUT_MS=60_000;
export async function downloadPackage(url:string,fetcher:typeof fetch=fetch,timeoutMs=DOWNLOAD_TIMEOUT_MS){
  const failed=()=>new UpdateError('下载更新包失败，文件没有改动。请确认服务能连上，再试一次。'),tooBig=()=>new UpdateError('更新包太大，已停止，文件没有改动。');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetcher(url,{cache:'no-store',redirect:'error',signal:controller.signal}).catch(()=>undefined);
    if(!response?.ok||!response.body)throw failed();
    const declared=Number(response.headers.get('content-length')??0);
    if(declared>MAX_BYTES){await response.body.cancel().catch(()=>{});throw tooBig();}
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;
    for(;;){
      const {done,value}=await reader.read().catch(()=>{throw failed();});
      if(done)break;
      total+=value.byteLength;
      if(total>MAX_BYTES){await reader.cancel().catch(()=>{});throw tooBig();}
      chunks.push(value);
    }
    if(controller.signal.aborted)throw failed();
    const bytes=new Uint8Array(total);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.byteLength;}
    return bytes;
  }finally{clearTimeout(timer);}
}

// 用户在选择框里取消时返回 false，什么都不改。
export async function updateExtension(folders:FolderStore=folderStore){
  let folder:FolderHandle;
  try{folder=await chooseFolder(folders);}
  catch(error){if((error as Error).name==='AbortError')return false;if(error instanceof UpdateError)throw error;throw new UpdateError(`打不开这个文件夹：${(error as Error).message}`,true);}
  if(!await isLoadedFolder(folder).catch(()=>false)){await folders.forget();throw new UpdateError('这不是 Chrome 正在加载的扩展文件夹。点“查看文件夹位置”，看详情页的“加载来源”，再点更新选它。',true);}
  await folders.remember(folder);
  const offer=await chrome.runtime.sendMessage({type:'extension.update.offer'}) as UpdateOffer&{error?:string};
  if(offer?.error||!offer?.sha256)throw new UpdateError(String(offer?.error||'拿不到更新信息，请稍后重试。').replace(/^Error:\s*/,''));
  const bytes=await downloadPackage(offer.serviceUrl+'/download/extension.zip');
  if(await sha256(bytes)!==offer.sha256)throw new UpdateError('更新包校验失败，已停止，文件没有改动。');
  const files=readPackage(bytes);checkPackage(files,offer,chrome.runtime.getManifest());
  await applyPackage(folder,files);
  return true;
}

// 同一个文件夹被别的 Chrome 配置更新过，或者服务和浏览器在同一台电脑、升级时已经换了文件：这时只差重载，不用选文件夹。
export async function filesUpdated(version:string){
  try{const manifest=await (await fetch(chrome.runtime.getURL(MANIFEST),{cache:'no-store'})).json() as {version?:string};return typeof manifest.version==='string'&&!isNewerVersion(version,manifest.version);}
  catch{return false;}
}
