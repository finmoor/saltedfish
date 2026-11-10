import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {FILE_CHUNK_BYTES,FILE_MAX_BYTES,BROWSER_UPLOAD_BYTES} from './file-limits.js';
import {BrowserError,NOT_DISPATCHED,type JsonObject} from './shared.js';
import {transferFilename} from './file-transfer-tools.js';
type Send=(operation:string,args:JsonObject)=>Promise<unknown>;

// 用户代理里的操作系统。认不出的一律当作不同机器，宁可多传内容也不把路径交给另一台电脑上的 Chrome。
const browserPlatform=(userAgent:string)=>/Windows NT/.test(userAgent)?'win32':/Macintosh|Mac OS X/.test(userAgent)?'darwin':/CrOS|Android/.test(userAgent)?undefined:/Linux|X11/.test(userAgent)?'linux':undefined;
/**
 * 扩展的直连是否来自服务所在的电脑。两端地址相同（回环或本机网卡）才算，经端口转发进来的另一台电脑通常换了操作系统，用用户代理再挡一层。
 * 转发到同系统的另一台电脑挡不住，新扩展设置文件后核对文件名和大小，对不上就报错。
 */
export function browserOnServiceMachine(remoteAddress:string|undefined,localAddress:string|undefined,userAgent:string,platform:string=process.platform){
 if(!remoteAddress||!localAddress)return false;
 const peer=remoteAddress.replace(/^::ffff:/,''),here=localAddress.replace(/^::ffff:/,'');
 return(peer===here||peer==='::1'||/^127\./.test(peer))&&browserPlatform(userAgent)===platform;
}

/** 路径已由调用方授权检查。只把文件内容送往浏览器，不把服务主机路径当成浏览器路径。 */
export async function stageBrowserUploads(paths:string[],send:Send,assertActive:()=>void){
 const ids:string[]=[];let total=0;
 const release=async()=>{if(ids.length)await send('file.stage.drop',{ids:[...ids]});};
 try{
  for(const file of paths){assertActive();const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
   try{const before=await handle.stat(),filename=transferFilename.parse(path.basename(file));if(!before.isFile()||before.size>FILE_MAX_BYTES||before.size+total>BROWSER_UPLOAD_BYTES)throw new BrowserError('BROWSER_UPLOAD_CAPACITY','浏览器和服务不在同一台电脑时，服务把文件内容传给浏览器，每个文件最多100 MiB、每批最多256 MiB。更大的文件请让浏览器连接同一台电脑上的 SaltedFish 服务，Chrome 会直接读取本机文件。',NOT_DISPATCHED);total+=before.size;
    const id=randomUUID();ids.push(id);await send('file.stage.begin',{id,filename,size:before.size});const hash=createHash('sha256'),buffer=Buffer.alloc(FILE_CHUNK_BYTES);
    for(let offset=0;offset<before.size;){assertActive();const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,before.size-offset),offset);if(!bytesRead)throw new BrowserError('FILE_UPLOAD_CHANGED','服务端文件在读取期间变化，未设置网页文件。',NOT_DISPATCHED);hash.update(buffer.subarray(0,bytesRead));const reply=await send('file.stage.write',{id,offset,base64:buffer.subarray(0,bytesRead).toString('base64')}) as {nextOffset?:number};offset+=bytesRead;if(reply.nextOffset!==offset)throw new BrowserError('FILE_TRANSFER_CORRUPT','浏览器接收的文件偏移不符，未设置网页文件。',NOT_DISPATCHED);}
    const after=await handle.stat();if(after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw new BrowserError('FILE_UPLOAD_CHANGED','服务端文件在读取期间变化，未设置网页文件。',NOT_DISPATCHED);
    assertActive();await send('file.stage.finish',{id,sha256:hash.digest('hex')});
   }finally{await handle.close();}
  }
  return{ids,release};
 }catch(error){await release().catch(()=>{});throw error;}
}
