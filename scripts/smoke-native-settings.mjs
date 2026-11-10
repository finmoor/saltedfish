import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';

// 验收已安装的 EXE -> 固定 npm/native launcher -> 当前 CLI 的原始帧转发。
const directory=path.resolve(process.argv[2]),read=async file=>JSON.parse(await readFile(path.join(directory,file),'utf8'));
const config=await read('config.json'),host=await read('native-settings/host.json');
assert.equal(host.name,`com.saltedfish.settings.p${config.port}`);
const child=spawn(host.path,[host.allowed_origins[0]],{windowsHide:true,stdio:['pipe','pipe','pipe']});
let output=Buffer.alloc(0),stderr=Buffer.alloc(0);
child.stdout.on('data',chunk=>{output=Buffer.concat([output,chunk]);if(output.length>4100)child.kill();});
child.stderr.on('data',chunk=>{stderr=Buffer.concat([stderr,chunk]);if(stderr.length>4100)child.kill();});
child.stdin.on('error',()=>{});
const request=Buffer.from(JSON.stringify({action:'open-settings',target:'setup'})),header=Buffer.alloc(4);header.writeUInt32LE(request.length);
const timer=setTimeout(()=>child.kill(),20000);
child.stdin.end(Buffer.concat([header,request]));
const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}).finally(()=>clearTimeout(timer));
assert.equal(exit,0,'Installed native settings host failed');assert.equal(stderr.length,0,'Native host emitted stderr');
assert.ok(output.length>4&&output.length<=4100,'Invalid native frame length');assert.equal(output.readUInt32LE(0),output.length-4);
const response=JSON.parse(output.subarray(4).toString('utf8'));assert.equal(response.ok,true,'Installed host did not return success');
const url=new URL(response.url);assert.equal(url.origin,`http://127.0.0.1:${config.port}`);assert.equal(url.pathname,'/');assert.equal(url.search,'?target=setup');
const code=url.hash.slice(1);assert.ok(/^[a-f0-9]{64}$/.test(code),'Invalid code format');assert.ok(code!==config.token,'Returned master credential');
const login=()=>fetch(url.origin+'/session',{method:'POST',headers:{authorization:`Bearer ${code}`},signal:AbortSignal.timeout(5000)});
const first=await login();assert.equal(first.status,200,'Native login code redemption failed');const session=await first.json();
try{assert.equal((await login()).status,401,'Native code could be reused');}
finally{assert.equal((await fetch(url.origin+'/session',{method:'DELETE',headers:{authorization:`Bearer ${session.token}`},signal:AbortSignal.timeout(5000)})).status,200);}
console.log('PASS installed Native Messaging launcher and single-use login');
