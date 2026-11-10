import {BrowserError,NOT_DISPATCHED,type JsonObject} from '../src/shared';
import {FILE_CHUNK_BYTES,FILE_MAX_BYTES,BROWSER_UPLOAD_BYTES} from '../src/file-limits';
interface Upload {id:string;filename:string;size:number;received:number;chunks:Uint8Array[];state:'receiving'|'verifying'|'ready';expires:number}
const fail=(message:string):never=>{throw new BrowserError('BROWSER_UPLOAD_INVALID',message,NOT_DISPATCHED);};
const validId=(id:unknown):id is string=>typeof id==='string'&&id.length===36&&/^[a-f0-9-]+$/.test(id);
export class BrowserUploads {
  private records=new Map<string,Upload>();
  constructor(private now=Date.now){}
  clear(){this.records.clear();}
  private prune(){for(const[id,file]of this.records)if(file.expires<=this.now())this.records.delete(id);}
  private get(id:unknown){this.prune();if(!validId(id))return fail('上传标识无效。');const file=this.records.get(id);if(!file)return fail('浏览器暂存文件不存在或已到期。');return file;}
  async receive(operation:string,args:JsonObject){
    this.prune();
    if(operation==='file.stage.begin'){
      const id=args.id,filename=args.filename,size=args.size;
      if(!validId(id)||typeof filename!=='string'||filename.length<1||filename.length>200||/[\\/:\x00-\x1f]/.test(filename)||!Number.isSafeInteger(size)||Number(size)<0||Number(size)>FILE_MAX_BYTES||this.records.has(id))return fail('上传元数据无效或重复。');
      if(this.records.size>=100||[...this.records.values()].reduce((sum,f)=>sum+f.size,Number(size))>BROWSER_UPLOAD_BYTES)throw new BrowserError('BROWSER_UPLOAD_CAPACITY','浏览器文件暂存已达上限，请等待当前上传完成。',NOT_DISPATCHED);
      this.records.set(id,{id,filename,size:Number(size),received:0,chunks:[],state:'receiving',expires:this.now()+5*60*1000});return{created:true};
    }
    if(operation==='file.stage.drop'){if(!Array.isArray(args.ids)||args.ids.length>100||!args.ids.every(validId))return fail('清理标识无效。');for(const id of args.ids)this.records.delete(id);return{cleared:true};}
    const file=this.get(args.id);
    if(operation==='file.stage.write'){
      if(file.state!=='receiving'||args.offset!==file.received||typeof args.base64!=='string'||args.base64.length>Math.ceil(FILE_CHUNK_BYTES/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.base64))return fail('文件块无效或顺序错误。');
      const bytes=Uint8Array.from(atob(args.base64),c=>c.charCodeAt(0));if(!bytes.length||bytes.length>FILE_CHUNK_BYTES||file.received+bytes.length>file.size)return fail('文件块长度不符合声明。');
      file.chunks.push(bytes);file.received+=bytes.length;return{nextOffset:file.received};
    }
    if(operation==='file.stage.finish'){
      if(file.state!=='receiving'||file.received!==file.size||typeof args.sha256!=='string'||args.sha256.length!==64||!/^[a-f0-9]+$/.test(args.sha256))return fail('文件尚未传完或校验值无效。');
      file.state='verifying';const bytes=new Uint8Array(file.size);let offset=0;for(const chunk of file.chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      const actual=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
      if(this.records.get(file.id)!==file)return fail('连接已变化，暂存文件已释放。');
      if(actual!==args.sha256){this.records.delete(file.id);throw new BrowserError('FILE_TRANSFER_HASH_MISMATCH','浏览器收到的文件校验失败，未设置网页文件。',NOT_DISPATCHED);}file.state='ready';return{ready:true,sha256:actual};
    }
    return fail('未知浏览器暂存操作。');
  }
  ready(ids:unknown){if(!Array.isArray(ids)||!ids.length||ids.length>100||new Set(ids).size!==ids.length)return fail('文件标识列表无效。');return ids.map(id=>{const file=this.get(id);if(file.state!=='ready')return fail('文件尚未完成校验。');return file;});}
  stats(){this.prune();return{files:this.records.size,bytes:[...this.records.values()].reduce((sum,f)=>sum+f.size,0)};}
}
export const browserUploads=new BrowserUploads();
const base64=(bytes:Uint8Array)=>{let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);};
const mimeTypes:Record<string,string>={txt:'text/plain',csv:'text/csv',json:'application/json',pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',zip:'application/zip',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',mp4:'video/mp4',m4v:'video/x-m4v',mov:'video/quicktime',webm:'video/webm',mkv:'video/x-matroska',avi:'video/x-msvideo',mp3:'audio/mpeg',m4a:'audio/mp4',wav:'audio/wav',aac:'audio/aac',ogg:'audio/ogg'};

export async function uploadContent(ids:unknown,elementId:string,send:(method:string,params:JsonObject)=>Promise<unknown>,assertActive:()=>Promise<void>){
  const files=browserUploads.ready(ids);let holder:string|undefined;
  try{
    const created=await send('Runtime.callFunctionOn',{objectId:elementId,functionDeclaration:'function(){return {element:this,files:[],parts:[]};}',returnByValue:false}) as JsonObject;
    holder=(created.result as JsonObject)?.objectId as string;if(!holder)throw new BrowserError('UPLOAD_PREPARE_FAILED','无法准备网页文件容器。',NOT_DISPATCHED);
    const call=async(functionDeclaration:string,args:unknown[]=[])=>{await assertActive();const result=await send('Runtime.callFunctionOn',{objectId:holder,functionDeclaration,arguments:args.map(value=>({value})),returnByValue:true}) as JsonObject;if(result.exceptionDetails)throw new BrowserError('UPLOAD_PREPARE_FAILED','网页文件准备失败，未设置输入框。',NOT_DISPATCHED);return(result.result as JsonObject)?.value as JsonObject;};
    for(const file of files){
      for(const chunk of file.chunks)await call('function(text){this.parts.push(Uint8Array.from(atob(text),c=>c.charCodeAt(0)));return true;}',[base64(chunk)]);
      await call('function(name,type){this.files.push(new File(this.parts,name,{type}));this.parts=[];return true;}',[file.filename,mimeTypes[file.filename.split('.').pop()!.toLowerCase()]||'application/octet-stream']);
    }
    const result=await call(`function(){const e=this.element;if(!e.isConnected||e.matches(':disabled')||e.type!=='file'||!e.multiple&&this.files.length>1)return {refused:true};let changed=false;try{const d=new DataTransfer();for(const f of this.files)d.items.add(f);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'files').set.call(e,d.files);changed=true;e.dispatchEvent(new Event('input',{bubbles:true,composed:true}));e.dispatchEvent(new Event('change',{bubbles:true,composed:true}));return {files:this.files.map(f=>({name:f.name,size:f.size}))};}catch{return {failed:true,changed};}}`);
    if(result?.refused)throw new BrowserError('ELEMENT_CHANGED','文件输入框已变化，未设置文件。',NOT_DISPATCHED);
    if(result?.failed)throw new BrowserError('UPLOAD_FAILED','设置网页文件时出错，请先核查输入框，不要重复上传。',result.changed?{phase:'execution',outcome:'unknown'}:NOT_DISPATCHED);
    return result;
  }finally{if(holder)await send('Runtime.releaseObject',{objectId:holder}).catch(()=>{});}
}
