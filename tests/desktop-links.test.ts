import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardLoginUrl, isDesktopSettingsUrl, parseDesktopUrl } from '../src/desktop-links.js';
import { fixture, fakeProfile } from './helpers.js';
import { bridgeToken } from '../src/auth.js';
import { spawn } from 'node:child_process';
import { access, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { projectDir } from '../src/config.js';
import { testDirectory } from './helpers.js';

const profile='00000000-0000-4000-8000-000000000001';
test('桌面设置入口只接受当前安装和明确白名单目标，不规范化危险或歧义输入',()=>{
  for(const route of ['overview','setup','remote','agents']) assert.deepEqual(parseDesktopUrl(`saltedfish-17423://settings/${route}`,17423),{port:17423,target:{route}});
  assert.deepEqual(parseDesktopUrl(`saltedfish-17423://settings/agents?profile=${profile}&add=1`,17423),{port:17423,target:{route:'agents',profile,add:'1'}});
  const bad=[
    'http://127.0.0.1:17423/#remote','saltedfish-17424://settings/remote','saltedfish-1023://settings/remote','saltedfish-65536://settings/remote',
    'saltedfish-017423://settings/remote','saltedfish-17423://other/remote','saltedfish-17423://user@settings/remote','saltedfish-17423://settings:5/remote',
    'saltedfish-17423://settings/../remote','saltedfish-17423://settings/%72emote','saltedfish-17423://settings/remote#ignored',
    'saltedfish-17423://settings/remote?url=https://other.test','saltedfish-17423://settings/remote?add=1',`saltedfish-17423://settings/setup?profile=${profile}`,
    'saltedfish-17423://settings/agents?add=1&add=1','saltedfish-17423://settings/agents?add=0','saltedfish-17423://settings/agents?add=1&',
    'saltedfish-17423://settings/agents?profile=other','saltedfish-17423://settings/remote?','saltedfish-17423://settings/tasks',
    'saltedfish-17423://settings/remote" --logout-all',' saltedfish-17423://settings/remote','saltedfish-17423://settings/remote\n',
    'saltedfish-17423:\\settings\\remote','saltedfish-17423://settings/agents?add=%31','saltedfish-17423://settings/agents?add=1&&profile='+profile,
  ];
  for(const value of bad) assert.throws(()=>parseDesktopUrl(value,17423),/设置入口无效/,value);
});

test('桌面管理登录URL固定回环源，只携带白名单目标和一次性码',()=>{
  const code='a'.repeat(64),url=new URL(dashboardLoginUrl(17423,code,{route:'agents',profile,add:'1'}));
  assert.equal(url.origin,'http://127.0.0.1:17423');assert.equal(url.pathname,'/');assert.equal(url.searchParams.get('target'),'agents');assert.equal(url.searchParams.get('profile'),profile);assert.equal(url.searchParams.get('add'),'1');assert.equal(url.hash,'#'+code);
  assert.equal(dashboardLoginUrl(17423,code,undefined,true),`http://127.0.0.1:17423/?onboarding=1#${code}`);
  assert.throws(()=>dashboardLoginUrl(0,code,{route:'remote'}));assert.throws(()=>dashboardLoginUrl(17423,'not-a-code',{route:'remote'}));
  assert.throws(()=>dashboardLoginUrl(17423,code,{route:'remote',profile}));
  assert.equal(isDesktopSettingsUrl('saltedfish-17424://settings/remote'),true);assert.equal(isDesktopSettingsUrl('https://example.test/saltedfish-17423:'),false);
  for(const whitespace of ['\t','\r','\n'])assert.equal(isDesktopSettingsUrl(`saltedfish-17${whitespace}423://settings/remote`),true);
});

test('普通Agent显式打开桌面管理协议在派发前拒绝，配对令牌仍不能签发登录码',async t=>{
  const f=await fixture();t.after(()=>f.cleanup());let dispatched=0;
  const p=await fakeProfile(f.config,'测试',()=>{dispatched++;return {};});
  const credential=f.service.state.createClient('普通Agent'),principal=f.service.state.authenticate(credential.token)!;
  const url=`saltedfish-${f.config.port}://settings/remote`;
  const cases:[string,Record<string,unknown>][]=[['chrome_new_tab',{url}],['chrome_navigate',{tabId:1,url}],['chrome_cdp',{tabId:1,method:'Page.navigate',params:{url}}],['chrome_batch',{tabId:1,steps:[{operation:'page.navigate',args:{url}}]}]];
  for(const[name,args]of cases){const result=await f.service.invoke(name,{profileId:p.id,...args},'desktop-guard',principal);assert.equal(result.error?.code,'ADMIN_PAGE_PROTECTED',name);assert.equal(result.error?.outcome,'not_dispatched');}
  for(const whitespace of ['\t','\r','\n']){const result=await f.service.invoke('chrome_new_tab',{profileId:p.id,url:url.replace('saltedfish-','saltedfish-'+whitespace)},'desktop-guard',principal);assert.equal(result.error?.code,'ADMIN_PAGE_PROTECTED');assert.equal(result.error?.outcome,'not_dispatched');}
  assert.equal(dispatched,0);
  for(const token of [bridgeToken(f.config),credential.token]){
    const response=await fetch(`http://127.0.0.1:${f.config.port}/session/code`,{method:'POST',headers:{authorization:`Bearer ${token}`}});assert.ok([401,403].includes(response.status));
  }
  assert.equal(f.sessions.stats().pendingCodes,0);
});

test('真实CLI拒绝额外参数、错误安装端口或禁止打开浏览器，不生成配置或签码',async t=>{
  const temp=await testDirectory();t.after(()=>temp.cleanup());const directory=path.join(temp.directory,'desktop data'),token='b'.repeat(64);
  async function run(args:string[]){
    const child=spawn(process.execPath,['--import','tsx',path.join(projectDir,'src/cli.ts'),...args],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,CHROME_MCP_DATA_DIR:directory,SALTEDFISH_NO_BROWSER:'1'}});
    let output='';child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>output+=value);
    const timeout=setTimeout(()=>child.kill(),10000);
    const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}).finally(()=>clearTimeout(timeout));
    assert.notEqual(code,0);assert.ok(!output.includes(token));return output;
  }
  for(const args of [['desktop-open','saltedfish-17423://settings/remote','--logout-all'],['desktop-open','saltedfish-17423://settings/remote?command=stop'],['desktop','anything']]){
    await run(args);await assert.rejects(access(directory));
  }
  await mkdir(directory);const config=JSON.stringify({port:17423,token});await writeFile(path.join(directory,'config.json'),config);
  assert.match(await run(['desktop-open','saltedfish-17424://settings/remote']),/设置入口无效/);
  assert.match(await run(['desktop-open','saltedfish-17423://settings/remote']),/未启用自动打开浏览器/);
  assert.equal(await readFile(path.join(directory,'config.json'),'utf8'),config);await assert.rejects(access(path.join(directory,'service.pid')));await assert.rejects(access(path.join(directory,'service.log')));
});
