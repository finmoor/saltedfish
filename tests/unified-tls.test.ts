import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:https';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {testDirectory,freePort} from './helpers.js';
import {createTestCertificate} from './fixtures/test-certificate.js';
import {startServer} from '../src/http-server.js';

test('统一服务TLS续期重新加载不重启执行核心，错误证书保留原上下文',async()=>{
 const temp=await testDirectory(),port=await freePort(),cert=path.join(temp.directory,'cert.pem'),key=path.join(temp.directory,'key.pem');
 const first=createTestCertificate({dnsNames:['localhost'],ipAddresses:['127.0.0.1']}),second=createTestCertificate({dnsNames:['localhost'],ipAddresses:['127.0.0.1']});await writeFile(cert,first.cert);await writeFile(key,first.key);
 const app=await startServer({port,token:'a'.repeat(64),dataDir:temp.directory,outputLimit:24000,eventLimit:100,directConnections:true,network:{host:'127.0.0.1',publicUrl:`https://localhost:${port}`,tls:{cert,key}}});
 const get=(ca:string)=>new Promise<string>((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,path:'/health',servername:'localhost',ca,agent:false,headers:{host:`localhost:${port}`}},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve(text));});req.on('error',reject);req.end();});
 try{assert.equal(JSON.parse(await get(first.cert)).unified,true);const service=app.service;await writeFile(cert,second.cert);await writeFile(key,second.key);assert.deepEqual(await app.reloadTls(),{reloaded:true});assert.equal(app.service,service);await assert.rejects(()=>get(first.cert));assert.equal(JSON.parse(await get(second.cert)).unified,true);await writeFile(key,first.key);await assert.rejects(()=>app.reloadTls(),/无效|匹配/);assert.equal(JSON.parse(await get(second.cert)).unified,true);}finally{await app.close();await temp.cleanup();}
});
