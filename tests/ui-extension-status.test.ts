import test, { mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectDir } from '../src/config.js';
import { installDom, readExtension, flush } from './fake-dom.js';

// 扩展设置页的连接状态条（extension/options.ts + 真实 options.html，假 DOM）。
// 旧版后台（扩展尚未刷新）被新服务拒绝时，把“请刷新扩展”的说明放在状态条里；状态条按后台报告的 state 标记，出错时换成醒目的样式
// （样式本身的对比度见 tests/ui-contrast.test.ts，真实 Chrome 里的表现见 tests/ui-extension.integration.ts）。
const profile = { profileId: '12345678-1234-4234-8234-1234567890ab', label: '个人', port: 17422, enabled: true };
let instance = 0;
async function mountStatus(t: TestContext, status: { state: string; message: string }, extra:{enabled?:boolean;activities?:{tabId:number;operation:string}[]}={}) {
  const chrome = { runtime: { sendMessage: async (message: any) => message.type === 'settings.get' ? { settings: {...profile,enabled:extra.enabled??true}, status, instanceId: 'instance', activities: extra.activities??[] } : { saved: true, profileId: profile.profileId }, getURL: (file: string) => file }, storage: { local: { get: async () => ({}) } }, tabs: {}, windows: {} };
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const dom = installDom(readExtension('options.html'), { chrome, window: { confirm: () => true, close: () => {} } });
  t.after(() => { dom.uninstall(); mock.timers.reset(); });
  await import(pathToFileURL(path.join(projectDir, 'extension', 'options.ts')).href + `?status-instance=${++instance}`);
  await flush();
  const status$ = dom.doc.querySelector('#status'); if (!status$) throw new Error('弹窗里没有 #status');
  return {status:status$,doc:dom.doc};
}

test('弹窗：后台报告连接出错时，状态条显示后台给的说明并标记 data-state=error', async t => {
  const refresh = '这个扩展使用旧版握手，服务已拒绝并没有登记这个浏览器。请打开 chrome://extensions 刷新 SaltedFish 扩展（0.2.10 或更高）。';
  const {status:node} = await mountStatus(t, { state: 'error', message: refresh });
  assert.equal(node.textContent, refresh); assert.equal(node.dataset.state, 'error');
});

test('弹窗：正常连接时状态条标记为 connected，不套用出错样式', async t => {
  const {status:node,doc} = await mountStatus(t, { state: 'connected', message: '已连接本机服务' });
  assert.equal(node.textContent, '可供 Agent 使用 · 当前空闲'); assert.equal(node.dataset.state, 'connected');
  assert.equal(doc.querySelector('#browser-control-title')!.textContent,'浏览器控制');
  assert.equal(doc.querySelector('#pause-toggle')!.textContent,'暂停所有 Agent');
  assert.equal(doc.querySelector('#activity')!.textContent,'');
});

test('浏览器忙碌时显示操作数量，暂停时不误报可供使用或空闲',async t=>{
 const {status:node,doc}=await mountStatus(t,{state:'connected',message:'已连接本机服务'},{activities:[{tabId:7,operation:'page.action'}]});
 assert.equal(node.textContent,'可供 Agent 使用 · 正在执行 1 项操作');assert.match(doc.querySelector('#activity')!.textContent,/标签 7/);
});
test('暂停当前浏览器后显示恢复入口，即使后台残留connected也不显示可用',async t=>{
 const {status:node,doc}=await mountStatus(t,{state:'connected',message:'已连接本机服务'},{enabled:false});
 assert.equal(node.textContent,'已暂停所有 Agent · 可手动使用');assert.equal(node.dataset.state,'paused');assert.equal(doc.querySelector('#pause-toggle')!.textContent,'继续连接');
 assert.match(doc.querySelector('#pause-toggle')!.getAttribute('aria-label')!,/个人/);
});
test('重连中保留真实连接原因，不显示可供Agent使用',async t=>{
 const {status:node}=await mountStatus(t,{state:'reconnecting',message:'正在等待本机服务重新连接'});
 assert.equal(node.textContent,'正在等待本机服务重新连接');assert.equal(node.dataset.state,'reconnecting');
});
