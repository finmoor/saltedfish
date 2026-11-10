import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {type Browser} from 'puppeteer-core';
import {launchTestChrome} from './chrome-launch.js';
import {unifiedFixture} from './helpers.js';
import {VERSION} from '../src/version.js';

test('统一服务浏览器配对、独立管理授权和撤销持久化；当前服务页显示真实URL与主机',{timeout:30000},async t=>{
 const f=await unifiedFixture();let browser:Browser|undefined;t.after(async()=>{try{await browser?.close();}finally{await f.cleanup();}});
 browser=await launchTestChrome({headless:true});const page=await browser.newPage(),origin=`http://127.0.0.1:${f.config.port}`,errors:string[]=[];page.on('pageerror',error=>errors.push(String(error)));page.on('dialog',dialog=>void dialog.accept());
 await page.goto(origin+'/#'+f.config.token);await page.waitForFunction(()=>document.querySelector<HTMLElement>('#login')!.hidden);await page.click('nav a[href="#remote"]');await page.waitForSelector('#remote:not([hidden])');assert.equal(await page.$eval('#connected-service-url',e=>e.textContent),origin);assert.equal(await page.$eval('#connected-service-machine',e=>e.textContent),os.hostname());assert.equal(await page.$eval('#connected-service-version',e=>e.textContent),VERSION);assert.equal(await page.$('#remote-url'),null);assert.equal(await page.$('#remote-token'),null);
 await page.click('nav a[href="#accounts"]');await page.waitForSelector('#accounts:not([hidden])');await page.$eval('#add-browser',e=>(e as HTMLDetailsElement).open=true);await page.type('#pair-browser-label','合成测试浏览器');assert.equal(await page.$eval('#pair-browser-manage',e=>(e as HTMLInputElement).checked),false);await page.click('#pair-browser-manage');await page.click('#create-browser-pairing');await page.waitForFunction(()=>!document.querySelector<HTMLElement>('#browser-pairing-created')!.hidden);const code=await page.$eval('#browser-connection-code',e=>(e as HTMLTextAreaElement).value),record=JSON.parse(Buffer.from(code.slice(11),'base64url').toString('utf8'));assert.equal(record.serviceUrl,origin);assert.equal(record.managerToken.length,64);assert.equal(f.pairings.list()[0]!.canManage,true);
 const click=async(text:string)=>page.evaluate(text=>{const button=[...document.querySelectorAll<HTMLButtonElement>('#browser-pairings button')].find(b=>b.textContent===text);if(!button)throw new Error('Missing action');button.click();},text);
 await click('撤销管理权限');await page.waitForFunction(()=>!document.querySelector('#browser-pairings')!.textContent!.includes('允许打开管理页'));assert.equal(f.pairings.list()[0]!.canManage,false);assert.equal(f.pairings.list()[0]!.revoked,false);await click('撤销配对');await page.waitForFunction(()=>!document.querySelector('#browser-pairings .pairing-row'));assert.equal(f.pairings.list()[0]!.revoked,true);
 await page.click('#lock-dashboard');assert.equal(await page.$eval('#browser-connection-code',e=>(e as HTMLTextAreaElement).value),'');assert.deepEqual(errors,[]);
});
