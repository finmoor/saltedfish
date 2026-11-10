import {mkdir,readFile,writeFile,copyFile,rename,rm,lstat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
if(process.platform==='win32'){
 const root=fileURLToPath(new URL('..',import.meta.url)),folder=path.join(root,'dist/desktop');await mkdir(folder,{recursive:true});
 const compiler=path.join(process.env.WINDIR||'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
 const source=path.join(root,'src/desktop-launcher.cs'),hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
 const references=['mscorlib.dll','System.dll','System.Core.dll','System.Web.Extensions.dll'].map(name=>path.join(path.dirname(compiler),name));
 const flags=['/nologo','/noconfig','/nostdlib+','/codepage:65001','/target:winexe','/platform:x64','/optimize+',...references.map(file=>`/reference:${file}`)];
 const referenceHashes=Object.fromEntries(await Promise.all(references.map(async file=>[path.basename(file),await hash(file)])));
 const inputs={sourceSha256:await hash(source),compilerSha256:await hash(compiler),referenceHashes,flags};
 const key=createHash('sha256').update(JSON.stringify(inputs)).digest('hex'),cacheRoot=path.join(root,'.local/desktop-builds'),cache=path.join(cacheRoot,key),name='SaltedFish.Settings.exe';await mkdir(cacheRoot,{recursive:true});
 async function verify(){assert.equal((await lstat(cache)).isSymbolicLink(),false);const record=JSON.parse(await readFile(path.join(cache,'build.json'),'utf8'));assert.deepEqual(record.inputs,inputs);assert.equal(await hash(path.join(cache,name)),record.sha256,'桌面启动器缓存字节不匹配，请保留并核查缓存。');return record;}
 let record;
 try{record=await verify();}catch(error){if(error.code!=='ENOENT')throw error;const temporary=path.join(cacheRoot,key+'-'+randomUUID());await mkdir(temporary);try{
   await promisify(execFile)(compiler,[...flags,`/out:${path.join(temporary,name)}`,source],{windowsHide:true,maxBuffer:128*1024});
   record={inputs,sha256:await hash(path.join(temporary,name))};await writeFile(path.join(temporary,'build.json'),JSON.stringify(record,null,2));
   try{await rename(temporary,cache);}catch(error){if(!['EEXIST','ENOTEMPTY','EPERM'].includes(error.code))throw error;record=await verify();}
  }finally{assert.ok(path.resolve(temporary).startsWith(path.resolve(cacheRoot)+path.sep));await rm(temporary,{recursive:true,force:true});}}
 await copyFile(path.join(cache,name),path.join(folder,name));assert.equal(await hash(path.join(folder,name)),record.sha256);
 console.log('Windows 桌面设置启动器已按源码/编译器/选项指纹构建并核对缓存。');
}else console.log('此平台使用原管理页入口，不构建 Windows 桌面启动器。');
