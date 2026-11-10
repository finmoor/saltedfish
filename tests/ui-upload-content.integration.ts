import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {launchTestChrome} from './chrome-launch.js';
import {browserUploads,uploadContent} from '../extension/upload-content.js';

test('内容上传的最终检查尊重fieldset继承禁用，同时允许首个legend中的文件输入',async()=>{
 const browser=await launchTestChrome({headless:true});
 try{
  const page=await browser.newPage();await page.setContent('<fieldset disabled><legend><input id="allowed" type="file"></legend><input id="blocked" type="file"></fieldset>');
  const id=randomUUID();await browserUploads.receive('file.stage.begin',{id,filename:'synthetic.txt',size:1});await browserUploads.receive('file.stage.write',{id,offset:0,base64:'YQ=='});await browserUploads.receive('file.stage.finish',{id,sha256:createHash('sha256').update('a').digest('hex')});
  const session=await page.createCDPSession();
  const upload=async(selector:string)=>{const result=await session.send('Runtime.evaluate',{expression:`document.querySelector(${JSON.stringify(selector)})`,returnByValue:false});return uploadContent([id],result.result.objectId!, (method,params)=>session.send(method as any,params as any),async()=>{});};
  await assert.rejects(()=>upload('#blocked'),(error:any)=>error.code==='ELEMENT_CHANGED');assert.equal(await page.$eval('#blocked',e=>(e as HTMLInputElement).files!.length),0);
  await upload('#allowed');assert.equal(await page.$eval('#allowed',e=>(e as HTMLInputElement).files![0]!.name),'synthetic.txt');
 }finally{browserUploads.clear();await browser.close();}
});
