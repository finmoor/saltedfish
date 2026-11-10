import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {z} from 'zod';
import {checkUploadFile,filePolicy} from './upload-policy.js';
import {FILE_CHUNK_BYTES,FILE_MAX_BYTES} from './file-limits.js';
import {BrowserError,NOT_DISPATCHED} from './shared.js';
export const NativeFileRequest=z.object({action:z.literal('read-download'),path:z.string().min(1).max(4096),offset:z.number().int().min(0),length:z.number().int().min(1).max(FILE_CHUNK_BYTES),snapshot:z.string().length(64).regex(/^[a-f0-9]+$/).optional()}).strict();
export interface NativeFileChunk {offset:number;size:number;snapshot:string;base64:string;eof:boolean}
const denied=()=>new BrowserError('LOCAL_FILE_ACCESS_DENIED','本机助手只读取存在的普通文件，SaltedFish 的数据目录和网络共享路径除外。',NOT_DISPATCHED);
/** 只有已登记扩展可到达调用处，路径是扩展按 downloadId 从 Chrome 的下载记录里取的；助手和同机导出（file-transfer.ts）用同一条规则：只拦数据目录和网络共享。 */
export async function readNativeDownload(config:{dataDir:string;token:string},input:unknown):Promise<NativeFileChunk>{
 const request=NativeFileRequest.parse(input);let file:string;
 try{file=await checkUploadFile(request.path,filePolicy(config));}catch{throw denied();}
 const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)).catch(()=>{throw denied();});
 try{
  const before=await handle.stat({bigint:true}),size=Number(before.size);if(!before.isFile()||size>FILE_MAX_BYTES||request.offset>size)throw denied();
  const stamp=(value:typeof before)=>createHmac('sha256',config.token).update(JSON.stringify([file,String(value.dev),String(value.ino),String(value.size),String(value.mtimeNs),String(value.ctimeNs)])).digest('hex');
  const snapshot=stamp(before);if(request.snapshot&&request.snapshot!==snapshot)throw new BrowserError('LOCAL_FILE_CHANGED','下载文件已变化，请先核对后再重新导出。',NOT_DISPATCHED);
  const bytes=Buffer.alloc(Math.min(request.length,size-request.offset));let received=0;
  while(received<bytes.length){const part=await handle.read(bytes,received,bytes.length-received,request.offset+received);if(!part.bytesRead)throw new BrowserError('LOCAL_FILE_CHANGED','下载文件读取不完整。',NOT_DISPATCHED);received+=part.bytesRead;}
  if(stamp(await handle.stat({bigint:true}))!==snapshot)throw new BrowserError('LOCAL_FILE_CHANGED','下载文件在读取期间变化。',NOT_DISPATCHED);
  return{offset:request.offset,size,snapshot,base64:bytes.toString('base64'),eof:request.offset+bytes.length===size};
 }finally{await handle.close();}
}
