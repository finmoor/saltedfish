import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {testDirectory} from './helpers.js';
import {extensionArchive} from '../src/extension-download.js';
import {copyExtensionFiles} from '../src/extension-defaults.js';

function unzipStored(archive:Buffer){
 const files=new Map<string,string>();let offset=0;
 while(archive.readUInt32LE(offset)===0x04034b50){const size=archive.readUInt32LE(offset+18),nameLength=archive.readUInt16LE(offset+26),extra=archive.readUInt16LE(offset+28),start=offset+30+nameLength+extra;files.set(archive.toString('utf8',offset+30,offset+30+nameLength),archive.toString('utf8',start,start+size));offset=start+size;}
 return files;
}

test('下载的扩展只带服务地址：目录里的 pairing.json 有令牌也不进 ZIP，其他文件原样',async t=>{
 const {directory,cleanup}=await testDirectory();t.after(cleanup);
 const token='a'.repeat(64);await writeFile(path.join(directory,'pairing.json'),JSON.stringify({port:17422,token,managerToken:token}));await writeFile(path.join(directory,'options.js'),'console.log(1)');
 const archive=await extensionArchive(directory,'http://192.168.1.10:18445'),files=unzipStored(archive);
 assert.deepEqual(JSON.parse(files.get('pairing.json')!),{serviceUrl:'http://192.168.1.10:18445'});assert.equal(files.get('options.js'),'console.log(1)');assert.equal(archive.includes(token),false);
});

test('同步扩展目录：换成发行文件，新版多出来的文件和目录都删掉',async t=>{
 const {directory,cleanup}=await testDirectory();t.after(cleanup);
 const release=path.join(directory,'release'),target=path.join(directory,'target');await mkdir(release);await mkdir(path.join(target,'newer'),{recursive:true});
 await writeFile(path.join(release,'manifest.json'),'旧版');await writeFile(path.join(release,'pairing.json'),'{}');
 await writeFile(path.join(target,'manifest.json'),'新版');await writeFile(path.join(target,'pairing.json'),'配对');await writeFile(path.join(target,'icon-16.png'),Buffer.from([1,2,3]));await writeFile(path.join(target,'newer','file'),'x');
 await copyExtensionFiles(release,target);
 assert.deepEqual((await readdir(target)).sort(),['manifest.json','pairing.json']);assert.equal(await readFile(path.join(target,'manifest.json'),'utf8'),'旧版');
});
