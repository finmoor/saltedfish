import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { type Browser, type HTTPRequest } from 'puppeteer-core';
import { launchTestChrome } from './chrome-launch.js';
import { fixture, fakeProfile, testDirectory } from './helpers.js';

async function harness(t: TestContext) {
  const home = await testDirectory(), entry = { command: 'fixture.exe', args: ['mcp'], env: {} };
  const f = await fixture({ setup: { home: home.directory, entries: { claude: entry, opencode: entry }, verify: async () => ({ tools: 51, profiles: 2 }) } });
  let browser: Browser | undefined;
  t.after(async () => { await browser?.close(); await f.cleanup(); await home.cleanup(); });
  const tabsA = [{ tabId: 7, title: 'A7' }, { tabId: 8, title: 'A8' }];
  const a = await fakeProfile(f.config, 'A', command => command.operation === 'tabs.list' ? tabsA : {});
  const b = await fakeProfile(f.config, 'B', command => command.operation === 'tabs.list' ? [{ tabId: 7, title: 'B7' }] : {});
  const flow = f.service.tasks.saveWorkflow(a.id, { name: '参数流程', parameters: [{ name: 'query' }], steps: [{ operation: 'page.action', args: { action: 'fill', selector: '#x', text: '{{query}}' } }] });
  browser = await launchTestChrome({ headless: true });
  const page = await browser.newPage(); page.on('dialog', dialog => void dialog.accept());
  const errors: string[] = []; page.on('pageerror', error => errors.push(String(error))); t.after(() => assert.deepEqual(errors, []));
  await page.goto(`http://127.0.0.1:${f.config.port}/#${f.config.token}`);
  await page.waitForSelector(`#task-profile option[value="${a.id}"]`);await page.click('#advanced-nav summary');await page.click('nav a[href="#tasks"]');await page.select('#task-profile',a.id);
  await page.waitForSelector(`#workflow-list [data-workflow-id="${flow.id}"] input`);
  // 接入卡片仅在用户进入主机辅助配置后检测和加载。

  async function click(scope: string, text: string, wait = true) {
    if(scope.startsWith('#setup'))await setup();
    await page.evaluate((scope, text) => [...document.querySelectorAll<HTMLButtonElement>(`${scope} button`)].find(button => button.textContent === text)!.click(), scope, text);
    if (wait) await page.waitForFunction((scope, text) => ![...document.querySelectorAll<HTMLButtonElement>(`${scope} button`)].some(button => button.textContent === text && button.disabled), {}, scope, text);
  }
  async function hold(route: string, tool?: string) {
    let request: HTTPRequest | undefined, ready!: () => void; const seen = new Promise<void>(resolve => { ready = resolve; });
    await page.setRequestInterception(true);
    page.on('request', current => {
      if (!request && new URL(current.url()).pathname === route && (!tool || JSON.parse(current.postData() || '{}').name === tool)) { request = current; ready(); }
      else void current.continue();
    });
    return { seen, release: () => request!.continue() };
  }
  async function fill(selector: string, value: string) { await page.$eval(selector, (node, value) => { (node as HTMLInputElement).value = value; node.dispatchEvent(new Event('input', { bubbles: true })); }, value); }
  async function setup(){await page.$eval('#advanced-nav',e=>(e as HTMLDetailsElement).open=true);await page.click('nav a[href="#setup"]');await page.waitForSelector('#setup-clients .setup-card');const summary='#setup-clients .setup-card[data-client="claude"] .setup-advanced';if(!await page.$eval(summary,e=>(e as HTMLDetailsElement).open))await page.click(summary+' summary');}
  return { f, home, page, a, b, flow, tabsA, click, hold, fill, setup };
}

test('目标标签关闭后保持未选择，不回退到其他标签', async t => {
  const h = await harness(t); await h.page.select('#task-tab', '7'); h.tabsA.shift();
  await h.page.click('#task-tabs-refresh'); await h.page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#task-tabs-refresh')!.disabled);
  assert.equal(await h.page.$eval('#task-tab', node => (node as HTMLSelectElement).value), '');
});

test('任务轮询保留用户的键盘焦点和详情按钮，不在点击前替换整行',async t=>{
 const h=await harness(t);await h.page.select('#task-tab','7');await h.fill('#workflow-list input[data-parameter]','focus test');await h.click('#workflow-list','预览本次步骤');await h.click('#workflow-list','在选定标签页运行',false);
 await h.page.waitForFunction(()=>document.querySelector('#task-list')!.textContent!.includes('已完成'));await h.page.focus('#task-list .row-actions button:first-child');
 await new Promise(r=>setTimeout(r,2300));assert.equal(await h.page.evaluate(()=>document.activeElement===document.querySelector('#task-list .row-actions button:first-child')),true);
 await h.page.keyboard.press('Enter');await h.page.waitForFunction(()=>document.querySelector<HTMLDialogElement>('#task-detail')!.open);
});

test('流程已受理但响应丢失时，界面重试沿用 submissionId，不重复建立任务',async t=>{
 const h=await harness(t);await h.page.select('#task-tab','7');await h.fill('#workflow-list input[data-parameter]','retry once');await h.click('#workflow-list','预览本次步骤');
 const ids:string[]=[];await h.page.setRequestInterception(true);
 h.page.on('request',current=>{void(async()=>{
  const payload=current.postData()?JSON.parse(current.postData()!):undefined;
  if(payload?.name==='chrome_workflow_run'){
   ids.push(payload.args.submissionId);
   if(ids.length===1){const result=await fetch(current.url(),{method:'POST',headers:current.headers(),body:current.postData()});assert.ok(result.ok);await result.arrayBuffer();await current.abort('failed');return;}
  }
  await current.continue();
 })().catch(error=>{throw error;});});
 await h.click('#workflow-list','在选定标签页运行');
 assert.equal(h.f.service.state.tasks().length,1);
 const reply=h.page.waitForResponse(response=>new URL(response.url()).pathname==='/rpc'&&JSON.parse(response.request().postData()||'{}').name==='chrome_workflow_run');
 await h.click('#workflow-list','在选定标签页运行',false);assert.equal((await (await reply).json()).data.deduplicated,true);
 assert.equal(ids.length,2);assert.match(ids[0]!,/^[a-f0-9-]{36}$/);assert.equal(ids[1],ids[0]);assert.equal(h.f.service.state.tasks().length,1);
});
test('切换账号不能沿用相同数字的 tabId', async t => {
  const h = await harness(t); await h.page.select('#task-tab', '7'); await h.page.select('#task-profile', h.b.id);
  await h.page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#task-tabs-refresh')!.disabled);
  assert.equal(await h.page.$eval('#task-tab', node => (node as HTMLSelectElement).value), '');
});
test('预览等待期间修改参数，旧响应不能重新开启运行按钮', async t => {
  const h = await harness(t); await h.fill('#workflow-list input[data-parameter]', 'old'); const gate = await h.hold('/rpc', 'chrome_workflow_preview');
  await h.click('#workflow-list', '预览本次步骤', false); await gate.seen; await h.fill('#workflow-list input[data-parameter]', 'new'); await gate.release();
  await h.page.waitForFunction(() => ![...document.querySelectorAll<HTMLButtonElement>('#workflow-list button')].find(node => node.textContent === '预览本次步骤')!.disabled);
  assert.equal(await h.page.$eval('#workflow-list', node => [...node.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '在选定标签页运行')!.disabled), true);
  assert.equal(h.f.service.state.tasks().length, 0);
});
test('配置预览等待期间改变位置，旧响应不能提供接入按钮', async t => {
  const h = await harness(t), gate = await h.hold('/setup/preview');
  await h.click('#setup-clients .setup-card[data-client="claude"]', '预览接入', false); await gate.seen;
  await h.page.select('#setup-clients .setup-card[data-client="claude"] .setup-scope', 'custom'); await h.fill('#setup-clients .setup-card[data-client="claude"] .setup-target', path.join(h.home.directory, 'custom.json'));
  await gate.release(); await h.page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#setup-clients .setup-card[data-client="claude"] > button')!.disabled);
  assert.equal(await h.page.$$eval('#setup-clients .setup-card[data-client="claude"] .setup-result button', nodes => nodes.length), 0);
});
test('配置输入失焦产生的重复 change 不清空确认结果，实际鼠标接入成功', async t => {
  const h = await harness(t);await h.setup(); await h.page.select('#setup-clients .setup-card[data-client="claude"] .setup-scope', 'project');
  await h.page.type('#setup-clients .setup-card[data-client="claude"] .setup-target', h.home.directory);
  await h.page.click('#setup-clients .setup-card[data-client="claude"] > button'); await h.page.waitForSelector('#setup-clients .setup-card[data-client="claude"] .setup-result button');
  await h.page.click('#setup-clients .setup-card[data-client="claude"] .setup-result button'); await h.page.waitForFunction(() => document.querySelector('#setup-clients .setup-card[data-client="claude"] .setup-result')!.textContent!.includes('已验证 51'));
  assert.ok(JSON.parse(await readFile(path.join(h.home.directory, '.mcp.json'), 'utf8')).mcpServers['saltedfish']);
});
test('刷新账号连接保留同账号的流程参数和客户端接入草稿', async t => {
  const h = await harness(t); await h.fill('#workflow-list input[data-parameter]', 'draft');
  await h.setup();
  await h.page.select('#setup-clients .setup-card[data-client="claude"] .setup-scope', 'custom'); await h.fill('#setup-clients .setup-card[data-client="claude"] .setup-target', 'C:/custom/config.json');
  await h.page.click('#refresh-all'); await h.page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#refresh-all')!.disabled);
  assert.equal(await h.page.$eval('#workflow-list input[data-parameter]', node => (node as HTMLInputElement).value), 'draft');
  assert.equal(await h.page.$eval('#setup-clients .setup-card[data-client="claude"] .setup-target', node => (node as HTMLInputElement).value), 'C:/custom/config.json');
});
test('普通步骤切换高级编辑保留刚输入的内容', async t => {
  const h = await harness(t); await h.page.click('#task-composer summary'); await h.fill('.step-target', '客户名称'); await h.fill('.step-value', '多行\n刚输入内容');
  await h.page.select('.step-action', 'advanced');
  const step = await h.page.$eval('.step-json', node => JSON.parse((node as HTMLTextAreaElement).value)); assert.equal(step.operation, 'page.action'); assert.equal(step.args.text, '多行\n刚输入内容');
  step.args.text = '高级编辑后的新值'; await h.fill('.step-json', JSON.stringify(step)); await h.page.select('.step-action', 'fill');
  assert.equal(await h.page.$eval('.step-value', node => (node as HTMLTextAreaElement).value), '高级编辑后的新值');
  await h.page.select('.step-action', 'advanced'); step.args = { action: 'click', locator: { role: 'link', name: '明细' } }; await h.fill('.step-json', JSON.stringify(step)); await h.page.select('.step-action', 'click');
  assert.equal(await h.page.$eval('.step-strategy', node => (node as HTMLSelectElement).value), 'link');
  assert.equal(await h.page.$eval('.step-target', node => (node as HTMLInputElement).value), '明细');
});
test('流程入队后同一次预览不能再次提交，需要重新预览', async t => {
  const h = await harness(t); await h.page.select('#task-tab', '7'); await h.fill('#workflow-list input[data-parameter]', 'once'); await h.click('#workflow-list', '预览本次步骤');
  await h.click('#workflow-list', '在选定标签页运行', false); await h.page.waitForFunction(() => document.querySelector('#task-list')!.textContent!.includes('已完成'));
  assert.equal(await h.page.$eval('#workflow-list', node => [...node.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '在选定标签页运行')!.disabled), true);
  await h.click('#workflow-list', '在选定标签页运行', false); assert.equal(h.f.service.state.tasks().length, 1);
  await h.click('#workflow-list', '预览本次步骤'); assert.equal(await h.page.$eval('#workflow-list', node => [...node.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '在选定标签页运行')!.disabled), false);
});
test('已绑定账号的编辑流程不能经普通任务入口直接运行到另一账号', async t => {
  const h = await harness(t); await h.click('#workflow-list', '编辑'); await h.fill('.step-value', '固定内容');
  await h.page.select('#task-profile', h.b.id); await h.page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#task-tabs-refresh')!.disabled); await h.page.select('#task-tab', '7');
  await h.page.click('#task-form button[type=submit]'); await h.page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#task-form button[type=submit]')!.disabled);
  assert.equal(h.f.service.state.tasks().length, 0); assert.ok(await h.page.$eval('#status', node => node.textContent!.includes('另一个账号')));
});
