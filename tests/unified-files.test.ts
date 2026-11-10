import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {testDirectory} from './helpers.js';
import {BrowserUploads} from '../extension/upload-content.js';
import {stageBrowserUploads} from '../src/browser-upload.js';
import {readNativeDownload} from '../src/native-files.js';
import {FileTransferManager} from '../src/file-transfer.js';
import {adminPrincipal} from '../src/auth.js';
import {FILE_CHUNK_BYTES} from '../src/file-limits.js';

test('服务文件按块进入浏览器暂存，内容校验、清理与连接变化边界',{timeout:10000},async t=>{
 const temp=await testDirectory();t.after(()=>temp.cleanup());const file=path.join(temp.directory,'合成文件.txt'),bytes=Buffer.alloc(FILE_CHUNK_BYTES+17,121);await writeFile(file,bytes);const storage=new BrowserUploads();
 const staged=await stageBrowserUploads([file],(operation,args)=>storage.receive(operation,args),()=>{});assert.equal(storage.stats().files,1);assert.equal(storage.ready(staged.ids)[0]!.received,bytes.length);await staged.release();assert.equal(storage.stats().files,0);
 const id=randomUUID();await storage.receive('file.stage.begin',{id,filename:'a.txt',size:1});await storage.receive('file.stage.write',{id,offset:0,base64:'YQ=='});await assert.rejects(()=>storage.receive('file.stage.finish',{id,sha256:'0'.repeat(64)}),/校验失败/);assert.equal(storage.stats().files,0);
 await storage.receive('file.stage.begin',{id,filename:'a.txt',size:1});storage.clear();assert.throws(()=>storage.ready([id]),/不存在/);
});

test('可选助手读 Chrome 下载的文件，数据目录拒绝、快照变化拒绝；服务器保存跨机器下载快照',async t=>{
 const temp=await testDirectory();t.after(()=>temp.cleanup());const helper=path.join(temp.directory,'helper'),downloads=path.join(temp.directory,'downloads');await mkdir(helper);await mkdir(downloads);
 const config={dataDir:helper,token:'b'.repeat(64)},file=path.join(downloads,'测试下载.bin'),bytes=Buffer.alloc(FILE_CHUNK_BYTES+5,33);await writeFile(file,bytes);await writeFile(path.join(helper,'secret.txt'),'synthetic-secret');
 const first=await readNativeDownload(config,{action:'read-download',path:file,offset:0,length:FILE_CHUNK_BYTES});assert.equal(first.size,bytes.length);assert.equal(first.eof,false);
 await assert.rejects(()=>readNativeDownload(config,{action:'read-download',path:path.join(helper,'secret.txt'),offset:0,length:20}),/数据目录/);
 const manager=new FileTransferManager({dataDir:path.join(temp.directory,'service')});t.after(()=>manager.close());const context={principal:adminPrincipal,profileId:randomUUID()},submissionId=randomUUID();
 const result=await manager.exportBrowserDownload(context,{downloadId:7,submissionId},{id:7,filename:'C:\\SyntheticDownloads\\测试下载.bin',state:'complete'},(offset,length,snapshot)=>readNativeDownload(config,{action:'read-download',path:file,offset,length,...(snapshot?{snapshot}:{})}));
 assert.equal(result.filename,'测试下载.bin');assert.equal(result.sha256,createHash('sha256').update(bytes).digest('hex'));const read=await manager.read(context,result.transferId,0,FILE_CHUNK_BYTES);assert.equal(Buffer.from(read.base64,'base64').compare(bytes.subarray(0,FILE_CHUNK_BYTES)),0);
 await writeFile(file,'changed');await assert.rejects(()=>readNativeDownload(config,{action:'read-download',path:file,offset:0,length:1,snapshot:first.snapshot}),/变化/);
 const cached=await manager.lookupExport(context,{downloadId:7,submissionId});assert.equal(cached?.transferId,result.transferId);assert.equal(cached?.deduplicated,true);
});
