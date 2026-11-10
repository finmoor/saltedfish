import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { type Browser } from 'puppeteer-core';
import { launchTestChrome } from './chrome-launch.js';
import { fixture, freePort } from './helpers.js';
import { projectDir } from '../src/config.js';
import type { JsonObject } from '../src/shared.js';
import { bridgeToken } from '../src/auth.js';
import { startServer } from '../src/http-server.js';

const f = await fixture();
const browsers: Browser[] = [];
const web = createServer(async (request, response) => {
  if (request.url === '/api/data') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ answer: 42, source: 'fixture' })); }
  else if (request.url === '/download') { response.setHeader('content-disposition', 'attachment; filename="fixture.txt"'); response.end('download works'); }
  else if (request.url === '/frame') response.end('<!doctype html><html><body><input id="frame-input"><button id="frame-button" onclick="document.body.dataset.clicked=\'yes\'">Frame button</button></body></html>');
  else { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(await readFile(path.join(projectDir, 'tests', 'fixtures', 'page.html'))); }
});
const webPort = await freePort();
await new Promise<void>(resolve => web.listen(webPort, '127.0.0.1', resolve));
const address = web.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
const fixtureUrl = `http://127.0.0.1:${address.port}/`;
const report: string[] = [];
const check = (name: string) => { report.push(name); console.log(`PASS ${name}`); };
async function waitFor<T>(condition: () => Promise<T | undefined | false>, timeout = 15000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) { const result = await condition(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Timed out waiting for test condition');
}
async function call(name: string, args: JsonObject, owner = 'browser-test'): Promise<unknown> {
  const result = await f.service.invoke(name, args, owner);
  if (!result.ok && args.tabId) {
    const diagnostic = await f.service.invoke('chrome_inspect', { profileId: args.profileId, tabId: args.tabId, textLimit: 1000 }, owner);
    await mkdir(path.join(projectDir, '.local/verification'), { recursive: true });
    await writeFile(path.join(projectDir, '.local/verification/browser-failure.json'), JSON.stringify({ name, args, error: result.error, diagnostic }, null, 2));
  }
  assert.equal(result.ok, true, JSON.stringify(result.error || result.data));
  const data = result.data as JsonObject;
  return data?.saved ? JSON.parse(await readFile(String(data.path), 'utf8')) : result.data;
}

try {
  const extensionDir = path.join(f.config.dataDir, 'extension');
  await cp(path.join(projectDir, 'dist', 'extension'), extensionDir, { recursive: true });
  await writeFile(path.join(extensionDir, 'pairing.json'), JSON.stringify({ port: f.config.port, token: bridgeToken(f.config) }));
  const ids: string[] = [];
  for (const label of ['fixture-account-A', 'fixture-account-B']) {
    const before = new Set(f.service.broker.listProfiles().map(profile => profile.id));
    const browser = await launchTestChrome({ headless: true, pipe: true,
      userDataDir: path.join(f.config.dataDir, label), enableExtensions: [extensionDir],
      args: ['--no-first-run', '--no-default-browser-check', '--site-per-process'],
    });
    browsers.push(browser);
    const profile = await waitFor(async () => f.service.broker.listProfiles().find(entry => !before.has(entry.id)));
    ids.push(profile.id); await call('chrome_rename_profile', { profileId: profile.id, label });
  }
  assert.notEqual(ids[0], ids[1]); check('两个真实 Chrome 配置独立接入，固定 ID 不同');
  const a = await call('chrome_new_tab', { profileId: ids[0], url: fixtureUrl }) as JsonObject;
  const b = await call('chrome_new_tab', { profileId: ids[1], url: fixtureUrl }) as JsonObject;
  const first = { profileId: ids[0]!, tabId: a.tabId };
  const second = { profileId: ids[1]!, tabId: b.tabId };
  await call('chrome_wait', { ...first, expression: 'document.readyState === "complete"' });
  await call('chrome_wait', { ...second, expression: 'document.readyState === "complete"' });
  await call('chrome_evaluate', { ...first, expression: 'localStorage.setItem("account", "A"); document.cookie="account=A; path=/"; true' });
  await call('chrome_evaluate', { ...second, expression: 'localStorage.setItem("account", "B"); document.cookie="account=B; path=/"; true' });
  assert.equal(await call('chrome_evaluate', { ...first, expression: 'localStorage.getItem("account")' }), 'A');
  assert.equal(await call('chrome_evaluate', { ...second, expression: 'document.cookie' }), 'account=B');
  check('相同网站的 Cookie / localStorage 按配置隔离');
  const inspect = await call('chrome_inspect', first) as { elements: { name: string; ref: string }[] };
  assert.ok(!JSON.stringify(inspect).includes('do-not-include-in-inspect'));
  const button = inspect.elements.find(element => element.name === 'Increment'); assert.ok(button);
  await call('chrome_inspect', { ...first, offset: 1, limit: 3 });
  await call('chrome_action', { ...first, ref: button.ref, action: 'click' });
  assert.equal(await call('chrome_evaluate', { ...first, expression: 'document.querySelector("#count").textContent' }), '1');
  check('结构化读取、元素 ref 与真实输入事件点击');
  await call('chrome_action', { ...first, action: 'type', selector: '#name', text: '键盘测试' });
  await call('chrome_action', { ...first, action: 'press', selector: '#name', key: 'a', modifiers: 2 });
  await call('chrome_action', { ...first, action: 'press', selector: '#name', key: 'Z' });
  assert.equal(await call('chrome_evaluate', { ...first, expression: 'document.querySelector("#name").value' }), 'Z');
  check('聚焦指定输入框、中文输入与 Ctrl+A/字符按键');
  const batch = await call('chrome_batch', { ...first, steps: [
    { operation: 'page.action', args: { action: 'fill', selector: '#name', text: '多账号测试' } },
    { operation: 'page.action', args: { action: 'select', selector: '#choice', values: ['two'] } },
    { operation: 'page.action', args: { action: 'click', selector: '#increment' } },
    { operation: 'page.wait', args: { expression: 'document.querySelector("#count").textContent === "2"' } },
  ] }) as JsonObject;
  assert.equal(batch.completed, true);
  assert.equal(await call('chrome_evaluate', { ...first, expression: 'document.querySelector("#name").value' }), '多账号测试');
  const failed = await f.service.invoke('chrome_batch', { ...first, steps: [
    { operation: 'page.action', args: { action: 'click', selector: '#increment' } },
    { operation: 'page.evaluate', args: { expression: 'document.body.dataset.planned = "1"; throw new Error("planned failure")' } },
    { operation: 'page.action', args: { action: 'click', selector: '#increment' } },
  ] }, 'browser-test');
  assert.equal(failed.ok, false); assert.equal(f.service.state.get(failed.operationId!)!.state,'unknown');
  assert.equal((await call('chrome_inspect',{...first,scopeSelector:'#count'}) as any).text,'3');
  await call('chrome_recover_operation',{operationId:failed.operationId,acknowledged:true});
  check('批量填表/等待与中途失败停止，未重复提交');
  await call('chrome_action', { ...first, action: 'fill', selector: '#shadow-input', text: 'shadow text' });
  await call('chrome_action', { ...first, action: 'click', selector: '#shadow-button' });
  assert.equal(await call('chrome_evaluate', { ...first, expression: 'document.querySelector("#shadow").shadowRoot.querySelector("#shadow-result").textContent' }), 'shadow-clicked');
  check('open Shadow DOM 定位、填表和点击');
  const contextData = await call('chrome_contexts', first) as { contexts: JsonObject[] };
  const child = contextData.contexts.find(context => String(context.origin).includes(`localhost:${address.port}`) && (context.auxData as JsonObject)?.isDefault);
  assert.ok(child, JSON.stringify(contextData));
  const childTarget = { ...first, contextId: child.id, sessionId: child.sessionId };
  await call('chrome_action', { ...childTarget, action: 'fill', selector: '#frame-input', text: 'iframe text' });
  assert.equal(await call('chrome_evaluate', { ...childTarget, expression: 'document.querySelector("#frame-input").value' }), 'iframe text');
  await call('chrome_action', { ...childTarget, action: 'click', selector: '#frame-button' });
  assert.equal(await call('chrome_evaluate', { ...childTarget, expression: 'document.body.dataset.clicked' }), 'yes');
  check('跨源 iframe 上下文路由与填表');
  await call('chrome_network_start', first);
  await call('chrome_action', { ...first, action: 'click', selector: '#request' });
  await call('chrome_wait', { ...first, expression: 'document.querySelector("#response").textContent.includes("42")' });
  const events = await call('chrome_events', { ...first, method: 'Network.responseReceived', limit: 100 }) as { items: { params: JsonObject }[] };
  const event = events.items.find(item => String((item.params.response as JsonObject)?.url).endsWith('/api/data')); assert.ok(event);
  const body = await call('chrome_network_body', { ...first, requestId: event.params.requestId }) as { body: string };
  assert.equal(JSON.parse(body.body).answer, 42); check('网络事件捕获和完整响应体读取');
  const upload = path.join(f.config.dataDir, 'upload-fixture.txt'); await writeFile(upload, 'upload works');
  await call('chrome_upload', { ...first, selector: '#upload', paths: [upload] });
  assert.equal(await call('chrome_evaluate', { ...first, expression: 'document.querySelector("#filename").textContent' }), 'upload-fixture.txt');
  check('本机绝对路径上传，不经过文件选择窗口');
  const downloadDir = path.join(f.config.dataDir, 'downloads'); await mkdir(downloadDir);
  const browserSession = await browsers[0]!.target().createCDPSession();
  await browserSession.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
  const download = await call('chrome_download', { profileId: ids[0], url: `${fixtureUrl}download` }) as { downloadId: number };
  await waitFor(async () => {
    const downloads = await call('chrome_downloads', { profileId: ids[0], downloadId: download.downloadId }) as { state: string }[];
    return downloads[0]?.state === 'complete';
  });
  check('按账号下载及完成状态跟踪');
  const beforeShot = await call('chrome_tabs', { profileId: first.profileId }) as { items: { tabId: number; active: boolean }[] };
  const screenshot = await f.service.invoke('chrome_screenshot', { ...first, fullPage: true }, 'browser-test');
  assert.equal(screenshot.ok, true, JSON.stringify(screenshot.error)); assert.ok(screenshot.image?.data);
  const afterShot = await call('chrome_tabs', { profileId: first.profileId }) as { items: { tabId: number; active: boolean }[] };
  assert.equal(afterShot.items.find(tab => tab.active)?.tabId, beforeShot.items.find(tab => tab.active)?.tabId);
  await mkdir(path.join(projectDir, '.local', 'verification'), { recursive: true });
  await writeFile(path.join(projectDir, '.local', 'verification', 'browser-fixture.png'), Buffer.from(screenshot.image!.data, 'base64'));
  check('整页截图与本地原图保存');
  const fixturePage = (await browsers[0]!.pages()).find(page => page.url() === fixtureUrl)!;
  const pageSession = await fixturePage.createCDPSession();
  const windowInfo = await pageSession.send('Browser.getWindowForTarget');
  await pageSession.send('Browser.setWindowBounds', { windowId: windowInfo.windowId, bounds: { windowState: 'minimized' } });
  await call('chrome_batch', { ...first, steps: [
    { operation: 'page.action', args: { action: 'click', selector: '#increment' } },
    { operation: 'page.wait', args: { expression: 'document.querySelector("#count").textContent === "4"' } },
  ] });
  const minimizedShot = await f.service.invoke('chrome_screenshot', first, 'browser-test');
  assert.equal(minimizedShot.ok, true, JSON.stringify(minimizedShot.error));
  check('最小化窗口中的批量点击、条件等待及截图');
  const ax = await call('chrome_accessibility', first) as { nodes: unknown[] }; assert.ok(ax.nodes.length);
  const title = await call('chrome_cdp', { ...first, method: 'Runtime.evaluate', params: { expression: 'document.title', returnByValue: true } }) as JsonObject;
  assert.ok(title.result); check('Chrome 无障碍树与底层 CDP 命令');
  await call('chrome_claim_tab', first, 'one');
  assert.equal((await f.service.invoke('chrome_action', { ...first, action: 'click', selector: '#increment' }, 'two')).error?.code, 'TAB_CLAIMED');
  await call('chrome_release_tab', first, 'one'); check('真实浏览器多客户端标签页占用');
  await call('chrome_detach_tab', first);
  await call('chrome_evaluate', { ...first, expression: 'true' }); check('调试连接释放后按需重连');
  const extra = await call('chrome_new_tab', { profileId: first.profileId, url: fixtureUrl, windowId: a.windowId }) as JsonObject;
  const extraTarget = { profileId: first.profileId, tabId: extra.tabId };
  await call('chrome_wait', { ...extraTarget, expression: 'document.readyState === "complete"' });
  await Promise.all([first, extraTarget].map(target => call('chrome_batch', { ...target, steps: [
    { operation: 'page.action', args: { action: 'click', selector: '#increment' } },
    { operation: 'page.evaluate', args: { expression: 'document.querySelector("#count").textContent' } },
  ] })));
  assert.equal(await call('chrome_evaluate', { ...first, expression: 'document.querySelector("#count").textContent' }), '5');
  assert.equal(await call('chrome_evaluate', { ...extraTarget, expression: 'document.querySelector("#count").textContent' }), '1');
  await call('chrome_close_tab', extraTarget);
  check('同一窗口多个标签页并发视觉任务串行执行，不串页');
  await f.close();
  Object.assign(f, await startServer(f.config));
  await waitFor(async () => f.service.broker.listProfiles().length === 2, 45000);
  assert.deepEqual(f.service.broker.listProfiles().map(profile => profile.id).sort(), [...ids].sort());
  assert.equal(await call('chrome_evaluate', { ...first, expression: 'localStorage.getItem("account")' }), 'A');
  assert.equal(await call('chrome_evaluate', { ...second, expression: 'localStorage.getItem("account")' }), 'B');
  check('服务重启后两个真实扩展自动重连，配置身份及存储保持');

  const workerTarget = browsers[0]!.targets().find(target => target.type() === 'service_worker' && target.url().endsWith('/background.js'))!;
  const worker = await workerTarget.worker(); assert.ok(worker);
  const settingsPage = await browsers[0]!.newPage();
  await settingsPage.goto(workerTarget.url().replace(/background\.js$/, 'options.html'));
  await settingsPage.evaluate(() => chrome.runtime.sendMessage({ type: 'settings.save', enabled: false }));
  await waitFor(async () => !f.service.broker.listProfiles().some(profile => profile.id === first.profileId));
  assert.equal(await worker.evaluate(async () => {
    const settings = (await chrome.storage.local.get('settings')).settings;
    if (!settings || typeof settings !== 'object' || !('enabled' in settings)) throw new Error('Missing extension settings');
    return settings.enabled;
  }), false);
  await settingsPage.evaluate(() => chrome.runtime.sendMessage({ type: 'settings.save', enabled: true }));
  await waitFor(async () => f.service.broker.listProfiles().some(profile => profile.id === first.profileId), 45000);
  if (!settingsPage.isClosed()) await settingsPage.close();
  check('扩展设置暂停后停止接管，显式重新允许后恢复同一身份');

  await browsers[0]!.close();
  await waitFor(async () => !f.service.broker.listProfiles().some(profile => profile.id === first.profileId));
  browsers[0] = await launchTestChrome({ headless: true, pipe: true, userDataDir: path.join(f.config.dataDir, 'fixture-account-A'), enableExtensions: [extensionDir], args: ['--no-first-run', '--no-default-browser-check', '--site-per-process'] });
  await waitFor(async () => f.service.broker.listProfiles().some(profile => profile.id === first.profileId), 45000);
  const reopened = await call('chrome_new_tab', { profileId: first.profileId, url: fixtureUrl }) as JsonObject;
  const reopenedTarget = { profileId: first.profileId, tabId: reopened.tabId };
  await call('chrome_wait', { ...reopenedTarget, expression: 'document.readyState === "complete"' });
  assert.equal(await call('chrome_evaluate', { ...reopenedTarget, expression: 'localStorage.getItem("account")' }), 'A');
  assert.equal(await call('chrome_evaluate', { ...second, expression: 'localStorage.getItem("account")' }), 'B');
  check('Chrome 进程重开保持配置 ID 和存储，另一账号继续工作');
  const found = await call('chrome_find', { ...reopenedTarget, locator: { role: 'textbox', name: 'Display name' } }) as { elements: { ref: string }[] };
  assert.equal(found.elements.length, 1);
  await call('chrome_action', { ...reopenedTarget, action: 'fill', locator: { label: 'Display name' }, text: '语义定位成功' });
  assert.equal(await call('chrome_evaluate', { ...reopenedTarget, expression: 'document.querySelector("#name").value' }), '语义定位成功');
  const ambiguity = await f.service.invoke('chrome_action', { ...reopenedTarget, action: 'click', locator: { role: 'button', name: 'Same action' } }, 'browser-test');
  assert.equal(ambiguity.ok, false); assert.equal(ambiguity.error!.code, 'AMBIGUOUS_SELECTOR');
  await call('chrome_action', { ...reopenedTarget, action: 'fill', locator: { label: 'Shadow input' }, text: '语义 shadow' });
  check('语义名称/标签及 Shadow DOM 定位成功，多匹配明确拒绝');
  await call('chrome_evaluate', { ...reopenedTarget, expression: 'const el=document.createElement("div");el.id="temporary";el.textContent="处理中";document.body.append(el);setTimeout(()=>{el.remove();document.body.dataset.ready="yes";const done=document.createElement("p");done.textContent="结果已确认";document.body.append(done)},200);true' });
  await call('chrome_wait', { ...reopenedTarget, selector: '#temporary', state: 'hidden' });
  await call('chrome_wait', { ...reopenedTarget, textContains: '结果已确认', urlContains: `127.0.0.1:${address.port}` });
  check('动态元素消失、结果文字和 URL 条件核验');
  const submitted = await call('chrome_task_submit', { ...reopenedTarget, name: '可见弹窗流程', visible: true, steps: [
    { operation: 'page.action', args: { action: 'click', locator: { role: 'button', name: 'Open details' } } },
    { operation: 'tabs.wait', args: { urlContains: '/frame' } },
    { operation: 'page.action', args: { action: 'fill', selector: '#frame-input', text: '新标签流程' } },
    { operation: 'page.wait', args: { selector: '#frame-button' } },
  ] }) as { id: string };
  const finished = await waitFor(async () => { const task = await call('chrome_task', { profileId: first.profileId, taskId: submitted.id }) as any; if (['failed','needs_review'].includes(task.status)) throw new Error(JSON.stringify(task)); return task.status === 'succeeded' ? task : false; });
  assert.notEqual(finished.tabId, reopenedTarget.tabId);
  assert.equal(await call('chrome_evaluate', { profileId: first.profileId, tabId: finished.tabId, expression: 'document.querySelector("#frame-input").value' }), '新标签流程');
  await call('chrome_close_tab', { profileId: first.profileId, tabId: finished.tabId });
  check('可见任务队列跟随明确 opener 的新标签页，并完成后续操作');
  const offlineUrl = `${fixtureUrl}?offline-fixture`;
  const offlineTab = await call('chrome_new_tab', { profileId: first.profileId, url: offlineUrl }) as JsonObject;
  const offlineTarget = { profileId: first.profileId, tabId: offlineTab.tabId };
  await call('chrome_wait', { ...offlineTarget, expression: 'document.readyState === "complete"' });
  const offlinePage = (await browsers[0]!.pages()).find(page => page.url() === offlineUrl); assert.ok(offlinePage);
  try {
    await offlinePage.setOfflineMode(true);
    const job = await call('chrome_task_submit', { ...offlineTarget, name: '断网即停', captureOnFailure: false, stepTimeoutMs: 5000, steps: [
      { operation: 'page.navigate', args: { url: `${fixtureUrl}offline-check` } },
      { operation: 'page.action', args: { action: 'click', selector: '#increment' } },
    ] }) as { id: string; principalId: string };
    const stopped = await waitFor(async () => { const item = await call('chrome_task', { profileId: first.profileId, taskId: job.id }) as any; return ['needs_review','failed'].includes(item.status) ? item : false; });
    assert.equal(stopped.reason, 'NAVIGATION_FAILED'); assert.equal(stopped.nextStep, 0); assert.equal(stopped.steps[1].state, 'pending');
    const attempts = f.service.state.taskOperations(first.profileId, `${job.principalId}:task:${job.id}`); assert.equal(attempts.length, 1); assert.equal(attempts[0]!.tool, 'chrome_navigate');
    assert.equal(await call('chrome_evaluate', { ...second, expression: 'localStorage.getItem("account")' }), 'B');
    const observed=await call('chrome_inspect',offlineTarget) as any;assert.ok(observed.url);
    await waitFor(async()=>f.service.stats().activeTaskProfiles===0);
    await call('chrome_recover_operation',{operationId:attempts[0]!.id,acknowledged:true});
    await offlinePage.setOfflineMode(false); await call('chrome_navigate', { ...offlineTarget, url: fixtureUrl });
    await call('chrome_wait', { ...offlineTarget, locator: { label: 'Display name' } });
    assert.equal((await call('chrome_task', { profileId: first.profileId, taskId: job.id }) as any).nextStep, 0);
  } finally { await offlinePage.setOfflineMode(false).catch(() => {}); await call('chrome_close_tab', offlineTarget); }
  check('单页断网时导航失败只派发一次，后续点击不执行；另一账号与恢复联网保持正常');
  await call('chrome_pause_profile', { profileId: first.profileId });
  await waitFor(async () => !f.service.broker.listProfiles().some(profile => profile.id === first.profileId));
  const worker2 = browsers[0]!.targets().find(target => target.type() === 'service_worker' && target.url().endsWith('/background.js'))!;
  const controlPage = await browsers[0]!.newPage(); await controlPage.goto(worker2.url().replace(/background\.js$/, 'options.html'));
  await controlPage.waitForFunction(() => document.querySelector('#pause-toggle')?.textContent === '继续连接'); await controlPage.click('#pause-toggle');
  await waitFor(async () => f.service.broker.listProfiles().some(profile => profile.id === first.profileId)); await controlPage.close();
  check('控制台暂停账号后保持停止，扩展直接继续按钮恢复原身份');
  await writeFile(path.join(projectDir, '.local', 'verification', 'browser-report.json'), JSON.stringify({ date: new Date().toISOString(), chrome: await browsers[0]!.version(), checks: report }, null, 2));
  console.log(`浏览器集成验证通过：${report.length} 项`);
} finally {
  await Promise.all(browsers.map(browser => browser.close()));
  await new Promise<void>(resolve => web.close(() => resolve()));
  await f.close();
  await f.cleanup();
}
