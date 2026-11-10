import test, { mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectDir } from '../src/config.js';
import { installDom, readExtension, flush, FakeEvent, type FakeElement } from './fake-dom.js';

// 扩展弹窗（extension/options.ts）连同真实 options.html 在假 DOM 里运行：chrome.runtime 用脚本化的假实现。
// 核对 ui:12：保存账号设置必须给出可见反馈，被后台忽略的配对密钥和失败响应不能静默。
const profile = { profileId: '12345678-1234-4234-8234-1234567890ab', label: '个人', port: 17422, enabled: true };
let instance = 0;
async function mountOptions(t: TestContext, script: (message: any) => unknown = () => ({ saved: true, profileId: profile.profileId }), initial: Record<string, unknown> = {}, probe: (url: string) => Promise<unknown> = async () => ({})) {
  const sent: any[] = [],state={settings:{...profile},status:{state:'connecting',message:'正在连接本机服务'},instanceId:'instance',activities:[] as {tabId:number;operation:string}[],...initial};
  const chrome:any = { runtime: { id:'e'.repeat(32), sendMessage: async (message: any) => { sent.push(message); if (message.type === 'settings.get') return structuredClone(state); const response:any=await script(message);if(response?.saved)for(const key of ['label','port','enabled'])if(message[key]!==undefined)(state.settings as any)[key]=message[key];return response; }, getURL: (file: string) => file, getManifest: () => ({ name: 'SaltedFish', version: '0.3.7', version_name: '0.3.0-beta.8' }) }, storage: { local: { get: async () => ({}) } }, tabs: { getCurrent: async () => undefined, create: async () => ({}) }, windows: {} };
  class FormDataStub { constructor(private form: FakeElement) {} get(name: string) { return this.form.elements.namedItem(name)?.value ?? null; } has(name: string) { return !!this.form.elements.namedItem(name)?.checked; } }
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const dom = installDom(readExtension('options.html'), { chrome, FormData: FormDataStub, fetch: probe, window: { confirm: () => true, close: () => {} } });
  t.after(() => { dom.uninstall(); mock.timers.reset(); });
  await import(pathToFileURL(path.join(projectDir, 'extension', 'options.ts')).href + `?instance=${++instance}`);
  await flush();
  const $ = (selector: string) => { const node = dom.doc.querySelector(selector); if (!node) throw new Error(`弹窗里没有 ${selector}`); return node; };
  const form = $('#settings'), field = (name: string) => form.elements.namedItem(name)!;
  const submit = async (token: string) => { field('connectionCode').value = token; form.dispatchEvent(new FakeEvent('submit', true)); await flush(); };
  const saves = () => sent.filter(message => message.type === 'settings.save');
  return { dom, $, sent, saves, field, submit,state,chrome,async tick(){mock.timers.tick(2000);await flush();} };
}
const goodToken = 'sf-connect:'+Buffer.from(JSON.stringify({version:1,serviceUrl:'http://127.0.0.1:17422',pairingId:profile.profileId,token:'ab12'.repeat(16)})).toString('base64url');

test('弹窗：配对密钥格式不对（被截断）时不发送、不清空输入，并说明原因', async t => {
  const m = await mountOptions(t);
  await m.submit('ab12'.repeat(10));
  assert.equal(m.saves().length, 0, '格式明显错误的密钥不应交给后台（后台会静默忽略或写入无效密钥）');
  assert.match(m.$('#save-result').textContent, /浏览器配对码/); assert.equal(m.$('#save-result').dataset.error, 'true');
  assert.equal(m.field('connectionCode').value, 'ab12'.repeat(10), '保留输入，方便用户补全');
});

test('弹窗：配对码前后空白被去除并保持原始大小写，成功后清空输入并提示', async t => {
  const m = await mountOptions(t);
  await m.submit(`  ${goodToken}\n`);
  assert.equal(m.saves().length, 1); assert.equal(m.saves()[0].connectionCode, goodToken); assert.equal(m.saves()[0].serviceUrl,'http://127.0.0.1:17422');assert.equal('label' in m.saves()[0],false);assert.equal('enabled' in m.saves()[0],false,'高级设置不覆盖名称或控制开关');
  assert.equal(m.field('connectionCode').value, ''); assert.match(m.$('#save-result').textContent, /已保存/); assert.match(m.$('#save-result').textContent, /连接设置/); assert.equal(m.$('#save-result').dataset.error, 'false');
});

test('弹窗：不填密钥时保留现有配对，消息里不带 token 字段', async t => {
  const m = await mountOptions(t);
  await m.submit('');
  assert.equal(m.saves().length, 1); assert.equal('connectionCode' in m.saves()[0], false); assert.match(m.$('#save-result').textContent, /已保存/); assert.equal(m.saves()[0].serviceUrl,'http://127.0.0.1:17422');
});

test('弹窗：后台返回 error 或没有保存时显示原因，不清空密钥输入', async t => {
  let reply: unknown = { error: 'Error: 配置身份已变化或尚未确认' };
  const m = await mountOptions(t, () => reply);
  await m.submit(goodToken);
  assert.match(m.$('#save-result').textContent, /保存失败.*配置身份已变化/); assert.equal(m.$('#save-result').dataset.error, 'true'); assert.equal(m.field('connectionCode').value, goodToken);
  assert.doesNotMatch(m.$('#save-result').textContent, /Error:/, '后台序列化出来的 "Error: " 前缀不展示给用户');
  reply = { saved: false }; await m.submit(goodToken);
  assert.match(m.$('#save-result').textContent, /保存失败.*设置未保存/);
  reply = undefined; await m.submit(goodToken); assert.match(m.$('#save-result').textContent, /保存失败/, '后台没有响应同样显示失败');
});

test('弹窗：消息发送本身抛错（例如扩展后台已失效）也不是静默', async t => {
  const m = await mountOptions(t, () => { throw new Error('Extension context invalidated.'); });
  await m.submit(goodToken);
  assert.match(m.$('#save-result').textContent, /保存失败.*Extension context invalidated/); assert.equal(m.field('connectionCode').value, goodToken);
  m.$('#pause-toggle').click(); await flush();
  assert.match(m.$('#control-result').textContent, /Extension context invalidated/, '暂停/继续失败在首屏控制区可见');
});

test('弹窗：重新提交时先清掉上一次的提示，成功后暂停/继续也有反馈', async t => {
  let fail = true; const m = await mountOptions(t, () => fail ? { error: '连接失败' } : { saved: true, profileId: profile.profileId });
  await m.submit(goodToken); assert.match(m.$('#save-result').textContent, /连接失败/);
  fail = false; await m.submit(goodToken); assert.doesNotMatch(m.$('#save-result').textContent, /连接失败/); assert.match(m.$('#save-result').textContent, /已保存/);
  m.$('#pause-toggle').click(); await flush(); assert.equal(m.saves().at(-1).enabled, false, '暂停会发送 enabled:false');assert.equal(m.$('#control-result').textContent,'');assert.match(m.$('#status').textContent,/已暂停所有 Agent/);
});

test('顶部改名独立保存，轮询不覆盖草稿，取消不改变设置',async t=>{
 const m=await mountOptions(t);m.$('#edit-name').click();m.$('#profile-name-input').value='工作浏览器';await m.tick();
 assert.equal(m.$('#profile-name-input').value,'工作浏览器');m.$('#cancel-name').click();assert.equal(m.saves().length,0);assert.equal(m.$('#name-form').hidden,true);
 m.$('#edit-name').click();m.$('#profile-name-input').value=' 工作浏览器 ';m.$('#name-form').dispatchEvent(new FakeEvent('submit',true));await flush();
 assert.deepEqual(m.saves(),[{type:'settings.save',label:'工作浏览器'}]);assert.equal(m.$('#profile-name').textContent,'工作浏览器');assert.equal(m.$('#name-form').hidden,true);assert.equal(m.state.settings.enabled,true);assert.equal(m.state.settings.port,17422);
});
test('改名失败保留草稿，临时出现的在途操作阻止保存',async t=>{
 let failing=true;const m=await mountOptions(t,()=>failing?{error:'保存不可用'}:{saved:true,profileId:profile.profileId});
 m.$('#edit-name').click();m.$('#profile-name-input').value='新名称';m.$('#name-form').dispatchEvent(new FakeEvent('submit',true));await flush();
 assert.equal(m.$('#profile-name-input').value,'新名称');assert.equal(m.$('#name-form').hidden,false);assert.match(m.$('#name-result').textContent,/保存不可用/);
 failing=false;m.state.activities=[{tabId:7,operation:'page.action'}];const before=m.saves().length;m.$('#name-form').dispatchEvent(new FakeEvent('submit',true));await flush();
 assert.equal(m.saves().length,before);assert.match(m.$('#name-result').textContent,/正在操作/);assert.equal(m.$('#profile-name-input').value,'新名称');
});

test('点击设置只调用一次服务通信，收到已验证登录地址后复用当前Chrome管理页',async t=>{
 const m=await mountOptions(t),calls:any[]=[],tabs:any[]=[],code='a'.repeat(64);let resolve!:(value:unknown)=>void;
 const send=m.chrome.runtime.sendMessage;m.chrome.runtime.sendMessage=async(message:any)=>{if(message.type!=='service.open')return send(message);calls.push(message);return new Promise(done=>{resolve=done;});};
 m.chrome.tabs.query=async()=>[{id:1,windowId:2,url:'http://127.0.0.1:17422/#'+code},{id:3,windowId:4,url:'http://127.0.0.1:17422/#overview'}];m.chrome.tabs.update=async(id:number,options:unknown)=>tabs.push({id,options});m.chrome.windows.update=async()=>{};m.chrome.tabs.create=async()=>{throw Error('不应新开');};
 const click=new FakeEvent('click',true);m.$('#open-workbench').dispatchEvent(click);m.$('#open-workbench').click();await flush();assert.equal(click.defaultPrevented,true);assert.equal(calls.length,1);assert.deepEqual(calls[0],{type:'service.open',target:'overview'});assert.equal(tabs.length,0);
 await m.tick();assert.match(m.$('#settings-launch-message').textContent,/正在打开/);
 resolve({ok:true,authenticated:true,url:`http://127.0.0.1:17422/?target=overview#${code}`});await flush();assert.equal(tabs.length,1);assert.equal(tabs[0].id,3,'不复用仍在消费登录码的标签');assert.match(m.$('#settings-launch-message').textContent,/已打开当前服务的管理页/);
 await m.tick();assert.match(m.$('#settings-launch-message').textContent,/已打开当前服务的管理页/);assert.equal(m.$('#settings-launch-fallback').hidden,true);
});

test('缺少服务通信权限时不谎报成功，显式备用入口才打开原管理页',async t=>{
 const m=await mountOptions(t),tabs:any[]=[];m.chrome.tabs.query=async()=>[{id:7,windowId:2,url:'http://127.0.0.1:17422/#overview'}];m.chrome.tabs.update=async(id:number,options:unknown)=>tabs.push({id,options});m.chrome.windows.update=async()=>{};
 m.$('#open-workbench').click();await flush();assert.equal(tabs.length,0);assert.equal(m.$('#settings-launch-result').dataset.error,'true');assert.match(m.$('#settings-launch-message').textContent,/有效的管理入口/);assert.equal(m.$('#settings-launch-fallback').hidden,false);
 m.$('#settings-launch-fallback').click();await flush();assert.equal(tabs.length,1);assert.equal(tabs[0].options.url,'http://127.0.0.1:17422/#overview');assert.match(m.$('#settings-launch-message').textContent,/当前服务的登录页/);
});

test('服务通信返回其他端口或错误目标时不打开，错误响应不透出敏感内容',async t=>{
 const m=await mountOptions(t),secret='sensitive-native-output';let queried=0,reply:any={ok:true,url:'http://127.0.0.1:17423/?target=overview#'+'a'.repeat(64)};const send=m.chrome.runtime.sendMessage;m.chrome.runtime.sendMessage=async(message:any)=>message.type==='service.open'?reply:send(message);m.chrome.tabs.query=async()=>{queried++;return[];};
 m.$('#open-workbench').click();await flush();assert.equal(queried,0);assert.equal(m.$('#settings-launch-result').dataset.error,'true');
 reply={ok:false,error:{code:'SETTINGS_UNAVAILABLE',message:secret}};m.$('#open-workbench').click();await flush();assert.equal(queried,0);assert.doesNotMatch(m.$('#settings-launch-message').textContent,new RegExp(secret));
});

const unpaired={status:{state:'unpaired',message:'请填写服务管理页生成的浏览器配对码。'}},lan='http://192.168.1.10:18445';
const lanCode='sf-connect:'+Buffer.from(JSON.stringify({version:1,serviceUrl:lan,pairingId:profile.profileId,token:'ab12'.repeat(16)})).toString('base64url');

test('没配对时只显示连接引导；下载包带来的地址预填好，光标直接在配对码上',async t=>{
 const m=await mountOptions(t,undefined,{...unpaired,serviceKnown:true,settings:{...profile,serviceUrl:lan}});
 assert.equal(m.$('#setup').hidden,false);assert.equal(m.$('#workspace').hidden,true);assert.equal(m.$('#setup-address').value,lan);assert.equal(m.dom.doc.activeElement?.id,'setup-code');
 m.$('#setup-address').value='192.168.1.11:18445';await m.tick();assert.equal(m.$('#setup-address').value,'192.168.1.11:18445','轮询不覆盖正在输入的地址');
});

test('不知道服务地址时不把默认本机地址当成用户的服务，配对后回到正常页面并刷新设置里的地址',async t=>{
 const m=await mountOptions(t,undefined,{...unpaired,serviceKnown:false,settings:{...profile,serviceUrl:'http://127.0.0.1:17422'}});
 assert.equal(m.$('#setup-address').value,'');assert.equal(m.dom.doc.activeElement?.id,'setup-address');
 m.state.status={state:'connected',message:''};m.state.settings={...profile,serviceUrl:lan} as any;await m.tick();
 assert.equal(m.$('#setup').hidden,true);assert.equal(m.$('#workspace').hidden,false);assert.equal(m.field('serviceUrl').value,lan);
});

test('只填 IP 和端口也能打开管理页：补全协议、先确认连得上、记住地址，再打开浏览器页',async t=>{
 const probed:string[]=[],tabs:any[]=[];const m=await mountOptions(t,undefined,{...unpaired,serviceKnown:false},async url=>{probed.push(url);return{};});
 m.chrome.tabs.query=async()=>[];m.chrome.tabs.create=async(options:any)=>tabs.push(options);
 m.$('#setup-address').value=' 192.168.1.10:18445/ ';m.$('#setup-open').click();await flush();
 assert.deepEqual(probed,[lan+'/health']);assert.deepEqual(m.saves(),[{type:'settings.save',serviceUrl:lan}]);assert.deepEqual(tabs,[{url:lan+'/#accounts',active:true}]);assert.equal(m.$('#setup-open').disabled,false);assert.equal(m.$('#setup-open-result').textContent,'');
});

test('公网域名补 HTTPS，协议写明时照用，不合法的地址说明原因且不探测',async t=>{
 const probed:string[]=[];const m=await mountOptions(t,undefined,{...unpaired,serviceKnown:false},async url=>{probed.push(url);return{};});m.chrome.tabs.query=async()=>[];m.chrome.tabs.create=async()=>{};
 m.$('#setup-address').value='saltedfish.example.com';m.$('#setup-open').click();await flush();assert.equal(probed.at(-1),'https://saltedfish.example.com/health');
 m.$('#setup-address').value='http://example.com';m.$('#setup-open').click();await flush();assert.match(m.$('#setup-open-result').textContent,/需要HTTPS/);assert.equal(m.$('#setup-open-result').dataset.error,'true');
 const count=probed.length;m.$('#setup-address').value='';m.$('#setup-open').click();await flush();assert.match(m.$('#setup-open-result').textContent,/请填写服务地址/);assert.equal(probed.length,count);
});

test('地址连不上时就地提示，不保存也不打开标签页',async t=>{
 const m=await mountOptions(t,undefined,{...unpaired,serviceKnown:false},async()=>{throw new TypeError('Failed to fetch');});
 m.chrome.tabs.query=async()=>{throw Error('不应打开');};m.$('#setup-address').value='192.168.1.10:18445';m.$('#setup-open').click();await flush();
 assert.match(m.$('#setup-open-result').textContent,/连不上 http:\/\/192\.168\.1\.10:18445/);assert.equal(m.$('#setup-open-result').dataset.error,'true');assert.equal(m.saves().length,0);assert.equal(m.$('#setup-open').disabled,false);
});

test('粘贴配对码只发配对码：预填的默认地址和配对码里的地址不同也能连上',async t=>{
 const m=await mountOptions(t,undefined,{...unpaired,serviceKnown:true,settings:{...profile,serviceUrl:'http://127.0.0.1:17422'}});
 m.$('#setup-code').value='  '+lanCode+'\n';m.$('#setup-form').dispatchEvent(new FakeEvent('submit',true));await flush();
 assert.deepEqual(m.saves(),[{type:'settings.save',connectionCode:lanCode}]);assert.equal(m.$('#setup-code').value,'');assert.equal(m.$('#setup-result').textContent,'');
});

test('带原身份的配对码交给后台判断：重装后没配对的扩展要能接回原来的身份',async t=>{
 const code='sf-connect:'+Buffer.from(JSON.stringify({version:1,serviceUrl:lan,pairingId:profile.profileId,token:'ab12'.repeat(16),profileId:'87654321-4321-4321-8321-ba0987654321',label:'原来的 Chrome'})).toString('base64url');
 const m=await mountOptions(t,undefined,{...unpaired});m.$('#setup-code').value=code;m.$('#setup-form').dispatchEvent(new FakeEvent('submit',true));await flush();
 assert.deepEqual(m.saves(),[{type:'settings.save',connectionCode:code}]);assert.equal(m.$('#setup-result').textContent,'');
});

test('配对码有问题时留在引导里说明原因，保留输入',async t=>{
 const m=await mountOptions(t,()=>({error:'Error: 此配对属于另一浏览器，当前浏览器身份没有改变。'}),{...unpaired});
 const submit=async(value:string)=>{m.$('#setup-code').value=value;m.$('#setup-form').dispatchEvent(new FakeEvent('submit',true));await flush();};
 await submit('');assert.match(m.$('#setup-result').textContent,/请先粘贴配对码/);assert.equal(m.saves().length,0);
 await submit('abc');assert.match(m.$('#setup-result').textContent,/配对码/);assert.equal(m.saves().length,0);assert.equal(m.$('#setup-code').value,'abc');
 await submit(lanCode);assert.match(m.$('#setup-result').textContent,/另一浏览器/);assert.doesNotMatch(m.$('#setup-result').textContent,/^Error:/);assert.equal(m.$('#setup-code').value,lanCode);assert.equal(m.$('#setup').hidden,false);
});

test('已配对但服务连不上时，打开管理页就地提示，不给通往报错页的备用入口',async t=>{
 const m=await mountOptions(t);const send=m.chrome.runtime.sendMessage;m.chrome.runtime.sendMessage=async(message:any)=>message.type==='service.open'?{unreachable:true}:send(message);m.chrome.tabs.query=async()=>{throw Error('不应打开');};
 m.$('#open-workbench').click();await flush();assert.match(m.$('#settings-launch-message').textContent,/连不上 http:\/\/127\.0\.0\.1:17422/);assert.equal(m.$('#settings-launch-result').dataset.error,'true');assert.equal(m.$('#settings-launch-fallback').hidden,true);
});

const newer={service:{canManage:false,extensionRelease:{version:'0.3.8',versionName:'0.3.0-beta.9'}}},diskVersion=(version:string)=>async(url:string)=>url==='manifest.json'?new Response(JSON.stringify({version})):new Response('{}');
test('有新版本：服务没带版本时不显示',async t=>{
 const m=await mountOptions(t);assert.equal(m.$('#update-strip').hidden,true);
});

test('有新版本：版本相同时不显示',async t=>{
 const m=await mountOptions(t,undefined,{service:{canManage:false,extensionRelease:{version:'0.3.7',versionName:'0.3.0-beta.8'}}});await flush();assert.equal(m.$('#update-strip').hidden,true);
});

test('有新版本：服务回滚到旧版本时不提示降级',async t=>{
 const m=await mountOptions(t,undefined,{service:{canManage:false,extensionRelease:{version:'0.3.6',versionName:'0.3.0-beta.7'}}});await flush();assert.equal(m.$('#update-strip').hidden,true);
});

test('有新版本：服务带的版本更新时显示版本和按钮',async t=>{
 const m=await mountOptions(t,undefined,newer,diskVersion('0.3.7') as any);await flush();assert.equal(m.$('#update-strip').hidden,false);assert.match(m.$('#update-title').textContent,/0\.3\.0-beta\.9/);assert.equal(m.$('#update-button').textContent,'更新');
});

test('有新版本：工具栏弹窗里点更新只打开标签页，不在弹窗里走文件夹选择',async t=>{
 const created:any[]=[],m=await mountOptions(t,undefined,newer,diskVersion('0.3.7') as any);await flush();m.chrome.tabs.create=async(page:any)=>{created.push(page);return{};};
 m.$('#update-button').click();await flush();
 assert.deepEqual(created,[{url:'options.html'}]);assert.equal(m.sent.some(message=>message.type==='extension.update.offer'),false);
});

test('有新版本：文件已经换过时不选文件夹，点重新加载直接重启',async t=>{
 const m=await mountOptions(t,()=>({restarting:true}),newer,diskVersion('0.3.8') as any);await flush();assert.equal(m.$('#update-button').textContent,'重新加载');
 m.$('#update-button').click();await flush();assert.equal(m.sent.filter(message=>message.type==='extension.update.restart').length,1);
});

test('有新版本：Agent 正在操作时不能更新',async t=>{
 const m=await mountOptions(t,undefined,{...newer,activities:[{tabId:1,operation:'page.action'}]},diskVersion('0.3.7') as any);await flush();
 assert.equal(m.$('#update-button').disabled,true);assert.match(m.$('#update-detail').textContent,/Agent 正在操作/);
});

test('连接设置在打开管理页旁边，默认收起，点一下在原地展开，再点收起',async t=>{
 const m=await mountOptions(t),toggle=m.$('#settings-toggle'),panel=m.$('#browser-settings');
 assert.equal(toggle.parentNode,m.$('#open-workbench').parentNode);assert.equal(panel.parentNode,toggle.parentNode?.parentNode,'表单就在服务这张卡片里');
 assert.equal(panel.hidden,true);assert.equal(toggle.getAttribute('aria-expanded'),'false');
 toggle.click();await flush();assert.equal(panel.hidden,false);assert.equal(toggle.getAttribute('aria-expanded'),'true');
 toggle.click();await flush();assert.equal(panel.hidden,true);assert.equal(toggle.getAttribute('aria-expanded'),'false');
});
