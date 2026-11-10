import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {projectDir} from '../src/config.js';
import {zipArchive} from '../src/zip.js';
import {applyPackage,checkPackage,filesUpdated,isLoadedFolder,readPackage,updateExtension,UpdateError,type FolderHandle,type FolderStore,type UpdateOffer} from '../extension/self-update.js';

// 扩展自我更新的逻辑：文件夹用内存假实现，chrome 和 fetch 用脚本化的假实现。
// 真实的文件夹选择框、Chrome 授权和重载见 tests/self-update.integration.ts。
const named=(name:string,message=name)=>Object.assign(new Error(message),{name});
const text=(value:string)=>new TextEncoder().encode(value);
const read=(bytes:Uint8Array|undefined)=>new TextDecoder().decode(bytes);
class FakeFolder{
  files=new Map<string,Uint8Array>();writes:string[]=[];removed:string[]=[];failOn='';permission:PermissionState='granted';permissionAsks=0;
  constructor(entries:Record<string,string>={}){for(const[name,value]of Object.entries(entries))this.files.set(name,text(value));}
  async getFileHandle(name:string,options:{create?:boolean}={}){
    if(!options.create&&!this.files.has(name))throw named('NotFoundError');
    return{getFile:async()=>new Blob([this.files.get(name) as BlobPart]),createWritable:async()=>{let data:Uint8Array=new Uint8Array();return{write:async(bytes:Uint8Array)=>{data=bytes;},close:async()=>{if(this.failOn===name)throw new Error('磁盘满了');this.files.set(name,Uint8Array.from(data));this.writes.push(name);}};}};
  }
  async removeEntry(name:string){this.removed.push(name);this.files.delete(name);}
  async requestPermission(){this.permissionAsks++;return this.permission;}
}
const asFolder=(folder:FakeFolder)=>folder as unknown as FolderHandle;
const running={name:'SaltedFish',version:'0.3.7'};
const manifest=(version='0.3.8',name='SaltedFish')=>JSON.stringify({manifest_version:3,name,version});
const zip=(entries:Record<string,string>)=>new Uint8Array(zipArchive(Object.entries(entries).map(([name,value])=>[name,Buffer.from(value)] as [string,Buffer])));
const release=(version='0.3.8')=>zip({'manifest.json':manifest(version),'background.js':'new background','options.html':'new page','pairing.json':'{"serviceUrl":"http://192.168.1.10:18445"}'});
const offerFor=(bytes:Uint8Array,version='0.3.8'):UpdateOffer=>({version,versionName:'0.3.0-beta.9',sha256:createHash('sha256').update(bytes).digest('hex'),serviceUrl:'http://192.168.1.10:18445'});
const installed=()=>new FakeFolder({'manifest.json':manifest('0.3.7'),'background.js':'old background','options.html':'old page','pairing.json':'{}'});

function memoryStore(saved?:FakeFolder){
  const calls={remembered:0,forgotten:0};let current=saved;
  const store:FolderStore={saved:async()=>current&&asFolder(current),remember:async folder=>{calls.remembered++;current=folder as unknown as FakeFolder;},forget:async()=>{calls.forgotten++;current=undefined;}};
  return{store,calls};
}
// loaded 是 Chrome 真正加载的文件夹：扩展地址读到的是它的文件。
function environment(t:{after(fn:()=>void):void},{loaded,offer,bytes,pick}:{loaded:FakeFolder;offer?:UpdateOffer|{error:string};bytes?:Uint8Array;pick?:()=>Promise<unknown>}){
  const sent:string[]=[],previous={fetch:globalThis.fetch,chrome:(globalThis as any).chrome,picker:(globalThis as any).showDirectoryPicker};
  (globalThis as any).chrome={runtime:{getURL:(name:string)=>'chrome-extension://self/'+name,getManifest:()=>running,sendMessage:async(message:{type:string})=>{sent.push(message.type);return offer;}}};
  globalThis.fetch=(async(url:string)=>{
    if(url.startsWith('chrome-extension://self/')){const file=loaded.files.get(url.slice(24));if(!file)throw new TypeError('Failed to fetch');return new Response(file as BodyInit);}
    return bytes?new Response(bytes as BodyInit):new Response('',{status:502});
  }) as typeof fetch;
  (globalThis as any).showDirectoryPicker=pick;
  t.after(()=>{globalThis.fetch=previous.fetch;(globalThis as any).chrome=previous.chrome;(globalThis as any).showDirectoryPicker=previous.picker;});
  return{sent};
}

test('更新包：读出服务生成的 ZIP，拒绝截断、压缩和带路径的条目',()=>{
 const files=readPackage(release());assert.deepEqual([...files.keys()].sort(),['background.js','manifest.json','options.html','pairing.json']);assert.equal(read(files.get('background.js')),'new background');
 assert.throws(()=>readPackage(release().subarray(0,100)),UpdateError);assert.throws(()=>readPackage(new Uint8Array(10)),UpdateError);
 const compressed=release(),view=new DataView(compressed.buffer,compressed.byteOffset),end=compressed.length-22,central=view.getUint32(end+16,true);view.setUint16(central+10,8,true);assert.throws(()=>readPackage(compressed),UpdateError);
 const traversal=zip({'aa.js':'x'}),second=new DataView(traversal.buffer,traversal.byteOffset),catalog=second.getUint32(traversal.length-22+16,true);traversal.set(text('..'),catalog+46);assert.throws(()=>readPackage(traversal),UpdateError);
});

// 一键更新不接受带路径的条目，图标放进子目录的话，装着旧扩展的用户就更新不了了。
test('更新包：manifest 声明的图标都能平铺写入，字节不变，尺寸和声明一致',()=>{
 const read=(name:string)=>readFileSync(path.join(projectDir,'extension',name)),manifest=JSON.parse(read('manifest.json').toString('utf8'));
 const icons=Object.entries<string>({...manifest.icons,...manifest.action.default_icon}),files=readPackage(zipArchive([['manifest.json',read('manifest.json')],...icons.map(([,name])=>[name,read(name)] as [string,Buffer])]));
 assert.equal(icons.length,4);
 for(const [size,name] of icons){const bytes=Buffer.from(files.get(name)!);assert.ok(bytes.equals(read(name)),name);assert.equal(bytes.readUInt32BE(16),Number(size));assert.equal(bytes.readUInt32BE(20),Number(size));}
});

test('更新包：名称、版本和必需文件都要对得上，不接受旧版本',()=>{
 const offer=offerFor(release());checkPackage(readPackage(release()),offer,running);
 assert.throws(()=>checkPackage(readPackage(zip({'manifest.json':manifest('0.3.8','别的扩展'),'background.js':'','options.html':''})),offer,running),/版本对不上/);
 assert.throws(()=>checkPackage(readPackage(release('0.3.9')),offer,running),/版本对不上/);
 assert.throws(()=>checkPackage(readPackage(zip({'manifest.json':manifest(),'background.js':''})),offer,running),/不完整/);
 assert.throws(()=>checkPackage(readPackage(release('0.3.7')),offerFor(release('0.3.7'),'0.3.7'),running),/不用更新/);
});

test('写入：manifest 最后写，全部成功后文件换成新版',async()=>{
 const folder=installed();await applyPackage(asFolder(folder),readPackage(release()));
 assert.equal(folder.writes.at(-1),'manifest.json');assert.equal(read(folder.files.get('background.js')),'new background');assert.equal(JSON.parse(read(folder.files.get('manifest.json'))).version,'0.3.8');
});

test('写入：中途失败时恢复原文件，新增的文件也删掉，版本号不变',async()=>{
 const folder=installed();folder.files.delete('pairing.json');folder.failOn='options.html';
 await assert.rejects(applyPackage(asFolder(folder),readPackage(release())),/文件已恢复/);
 assert.equal(read(folder.files.get('background.js')),'old background');assert.equal(JSON.parse(read(folder.files.get('manifest.json'))).version,'0.3.7');assert.equal(folder.files.has('pairing.json'),false);
});

test('写入：manifest 写失败时同样回到旧版本',async()=>{
 const folder=installed();folder.failOn='manifest.json';
 await assert.rejects(applyPackage(asFolder(folder),readPackage(release())),/磁盘满了/);folder.failOn='';
 assert.equal(read(folder.files.get('background.js')),'old background');assert.equal(read(folder.files.get('options.html')),'old page');
});

test('写入：恢复也失败时说清哪些文件要手动处理',async()=>{
 const folder=installed();folder.failOn='options.html';let attempts=0;const original=folder.getFileHandle.bind(folder);
 folder.getFileHandle=async(name:string,options?:{create?:boolean})=>{if(options?.create&&name==='background.js'&&++attempts>1)throw new Error('拒绝访问');return original(name,options);};
 await assert.rejects(applyPackage(asFolder(folder),readPackage(release())),error=>{assert.ok(error instanceof UpdateError);assert.match(error.message,/background\.js 没能恢复/);assert.match(error.message,/下载新的扩展包/);return true;});
});

test('文件夹确认：只有从扩展地址读得回随机文件才算，探针文件不留下',async t=>{
 const loaded=installed(),copy=installed();environment(t,{loaded});
 assert.equal(await isLoadedFolder(asFolder(loaded)),true);assert.equal(await isLoadedFolder(asFolder(copy)),false,'内容相同的副本不算');
 assert.deepEqual([...loaded.files.keys()].sort(),[...installed().files.keys()].sort());assert.deepEqual([...copy.files.keys()].sort(),[...installed().files.keys()].sort());
});

test('一键更新：第一次选文件夹，校验后写入并记住文件夹',async t=>{
 const loaded=installed(),bytes=release(),{store,calls}=memoryStore();environment(t,{loaded,offer:offerFor(bytes),bytes,pick:async()=>loaded});
 assert.equal(await updateExtension(store),true);
 assert.equal(JSON.parse(read(loaded.files.get('manifest.json'))).version,'0.3.8');assert.equal(calls.remembered,1);
});

test('一键更新：已记住文件夹时不再弹选择框，只请求授权',async t=>{
 const loaded=installed(),bytes=release(),{store}=memoryStore(loaded);let picks=0;
 environment(t,{loaded,offer:offerFor(bytes),bytes,pick:async()=>{picks++;return loaded;}});
 assert.equal(await updateExtension(store),true);assert.equal(picks,0);assert.equal(loaded.permissionAsks,1);
});

test('一键更新：用户取消选择框时什么都不改，也不报错',async t=>{
 const loaded=installed(),{store}=memoryStore();const{sent}=environment(t,{loaded,pick:async()=>{throw named('AbortError');}});
 assert.equal(await updateExtension(store),false);assert.deepEqual(sent,[]);assert.equal(read(loaded.files.get('background.js')),'old background');
});

test('一键更新：用户不允许编辑时停止，不退回选择框',async t=>{
 const loaded=installed(),{store}=memoryStore(loaded);loaded.permission='denied';let picks=0;
 environment(t,{loaded,pick:async()=>{picks++;return loaded;}});
 await assert.rejects(updateExtension(store),/没有得到编辑文件的允许/);assert.equal(picks,0);
});

test('一键更新：选错文件夹时不写入，忘掉记住的文件夹，并给出查看入口',async t=>{
 const loaded=installed(),wrong=installed(),{store,calls}=memoryStore(wrong);environment(t,{loaded,pick:async()=>loaded});
 await assert.rejects(updateExtension(store),error=>error instanceof UpdateError&&error.wrongFolder&&/加载来源/.test(error.message));
 assert.equal(calls.forgotten,1);assert.equal(read(wrong.files.get('background.js')),'old background');assert.equal(read(loaded.files.get('background.js')),'old background');
});

test('一键更新：包的哈希和证明过的不一样时不写入',async t=>{
 const loaded=installed(),{store}=memoryStore(),offer=offerFor(release());environment(t,{loaded,offer,bytes:release('0.3.9'),pick:async()=>loaded});
 await assert.rejects(updateExtension(store),/校验失败/);assert.equal(read(loaded.files.get('background.js')),'old background');assert.equal(JSON.parse(read(loaded.files.get('manifest.json'))).version,'0.3.7');
});

test('一键更新：后台拒绝或下载失败时不写入，原因讲给用户',async t=>{
 const loaded=installed(),{store}=memoryStore();environment(t,{loaded,offer:{error:'Error: 连上服务后才能更新。'},pick:async()=>loaded});
 await assert.rejects(updateExtension(store),error=>(error as Error).message==='连上服务后才能更新。');
 const again=installed();environment(t,{loaded:again,offer:offerFor(release()),pick:async()=>again});
 await assert.rejects(updateExtension(memoryStore().store),/下载更新包失败/);assert.equal(read(again.files.get('background.js')),'old background');
});

test('文件已经换过时只差重载：读的是硬盘上的版本，不是内存里的',async t=>{
 const loaded=new FakeFolder({'manifest.json':manifest('0.3.8')});environment(t,{loaded});
 assert.equal(await filesUpdated('0.3.8'),true);assert.equal(await filesUpdated('0.3.9'),false);
 loaded.files.delete('manifest.json');assert.equal(await filesUpdated('0.3.8'),false);
});
