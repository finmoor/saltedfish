import {createHash} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {zipArchive} from './zip.js';

// 下载包自带服务地址，扩展装好就知道管理页在哪。这个路由不鉴权，pairing.json 只写地址，令牌和配对码不进 ZIP。
export async function extensionArchive(directory:string,serviceUrl:string){
  const names=(await readdir(directory)).sort();
  return zipArchive(await Promise.all(names.map(async name=>[name,name==='pairing.json'?Buffer.from(JSON.stringify({serviceUrl})):await readFile(path.join(directory,name))] as [string,Buffer])));
}

// 这个服务带的扩展版本。开发环境可能还没构建扩展，这时不提示更新。
export async function extensionVersion(directory:string){
  try{const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));return{version:String(manifest.version),versionName:String(manifest.version_name||manifest.version)};}
  catch{return undefined;}
}

export async function extensionRelease(directory:string,serviceUrl:string){
  const version=await extensionVersion(directory);if(!version)throw new Error('这个服务没有带扩展文件。');
  return{...version,sha256:createHash('sha256').update(await extensionArchive(directory,serviceUrl)).digest('hex')};
}
