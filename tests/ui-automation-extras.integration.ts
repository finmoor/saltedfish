import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { type Browser } from 'puppeteer-core';
import { launchTestChrome } from './chrome-launch.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { unifiedFixture, freePort } from './helpers.js';
import { projectDir } from '../src/config.js';

// 真实 Chrome 里走一遍无人值守发布流程用到的新能力：脚本试跑、replMode、后台作业、元素截图存文件、按标签页等下载、自动下载设置、保持标签页。
const page = `<!doctype html><html><body style="margin:0"><div id="box" style="width:200px;height:100px;background:#147d64"></div>
<button id="one" onclick="save(1)">one</button><button id="three" onclick="save(3)">three</button>
<script>function save(count){for(let i=0;i<count;i++){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify({i})],{type:'application/json'}));a.download='export-'+Date.now()+'-'+i+'.json';document.body.append(a);a.click();a.remove();}}</script></body></html>`;
const pngSize = (base64: string) => { const bytes = Buffer.from(base64, 'base64'); return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]; };

test('真实 Chrome：试跑不隔离、replMode、后台作业、元素截图存文件、按标签页等下载与自动下载设置、保持标签页', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
  const f = await unifiedFixture(), origin = `http://127.0.0.1:${f.config.port}`, extension = path.join(f.config.dataDir, 'extension'), userData = path.join(f.config.dataDir, 'chrome');
  const outputs = path.join(path.dirname(f.config.dataDir), path.basename(f.config.dataDir) + '-输出'), downloads = path.join(outputs, 'downloads');
  let browser: Browser | undefined, sdk: Client | undefined, transport: StreamableHTTPClientTransport | undefined;
  const web = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(page); });
  const webPort = await freePort(); await new Promise<void>(resolve => web.listen(webPort, '127.0.0.1', resolve));
  t.after(async () => { try { await transport?.terminateSession().catch(() => {}); await sdk?.close(); await browser?.close(); } finally { await new Promise<void>(resolve => web.close(() => resolve())); await rm(outputs, { recursive: true, force: true }); await f.cleanup(); } });
  await mkdir(downloads, { recursive: true });
  await cp(path.join(process.env.PRODUCT_SERVICE_ROOT || projectDir, 'dist/extension'), extension, { recursive: true });
  const pairing = await f.pairings.create({ label: '新能力测试' }); await writeFile(path.join(extension, 'pairing.json'), JSON.stringify({ port: f.config.port, serviceUrl: origin, ...pairing }));
  // 不用 Browser.setDownloadBehavior：它会绕过 Chrome 的“下载多个文件”拦截。下载目录写进新配置的偏好，不碰真实的下载目录。
  await mkdir(path.join(userData, 'Default'), { recursive: true });
  await writeFile(path.join(userData, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }));
  browser = await launchTestChrome({ headless: true, pipe: true, enableExtensions: [extension], userDataDir: userData, args: ['--no-first-run'] });
  for (let i = 0; i < 100 && !f.service.broker.listProfiles().length; i++) await new Promise(resolve => setTimeout(resolve, 50));
  const profile = f.service.broker.listProfiles()[0]!; assert.ok(profile); assert.equal(profile.sameMachine, true);
  const client = f.service.state.createClient('新能力验收', [profile.id], false, true);
  sdk = new Client({ name: 'automation-extras', version: '1' }); transport = new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { requestInit: { headers: { authorization: 'Bearer ' + client.token } } }); await sdk.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => (await sdk!.callTool({ name, arguments: { profileId: profile.id, ...args } }, undefined, { timeout: 60000 })).structuredContent as any;
  const value = (result: any) => result.data?.value ?? result.data;

  const opened = await call('chrome_new_tab', { url: `http://127.0.0.1:${webPort}/` }); assert.ok(opened.ok, JSON.stringify(opened.error)); const tabId = opened.data.tabId;
  assert.ok((await call('chrome_wait', { tabId, selector: '#box' })).ok);

  // 改动页面之前就抛错：确定没副作用，不隔离；先改页面再抛错：结果不明，隔离。
  const early = await call('chrome_evaluate', { tabId, expression: '(()=>{const rows=Array.from(document.querySelectorAll("div"));if(rows.length)throw new Error("没有数据");})()' });
  assert.equal(early.error.code, 'JAVASCRIPT_ERROR'); assert.equal(early.error.outcome, 'not_dispatched');
  const pure = await call('chrome_evaluate', { tabId, expression: 'Array.from(document.querySelectorAll("button")).map(b=>b.textContent)' });
  assert.deepEqual(value(pure), ['one', 'three']);
  assert.ok((await call('chrome_evaluate', { tabId, expression: 'document.body.dataset.ok="1"' })).ok, '之后的写入照常');
  const late = await call('chrome_evaluate', { tabId, expression: '(()=>{document.body.dataset.late="1";throw new Error("后来才错")})()' });
  assert.equal(late.error.code, 'JAVASCRIPT_ERROR'); assert.equal(late.error.outcome, 'unknown');
  assert.equal((await call('chrome_evaluate', { tabId, expression: '1' })).error.code, 'RESULT_UNKNOWN');
  assert.ok((await call('chrome_recover_tab', { tabId })).ok);

  // replMode：重复粘贴含顶层 const 的脚本。
  assert.equal(value(await call('chrome_evaluate', { tabId, expression: 'const total = 1; total', replMode: true })), 1);
  assert.equal(value(await call('chrome_evaluate', { tabId, expression: 'const total = 2; total', replMode: true })), 2);
  assert.equal(value(await call('chrome_evaluate', { tabId, expression: 'await Promise.resolve(3)', replMode: true })), 3);

  // 带表达式的 wait 超时不隔离。
  const waited = await call('chrome_wait', { tabId, expression: 'document.body.dataset.never === "1"', timeoutMs: 400 });
  assert.equal(waited.error.code, 'WAIT_TIMEOUT'); assert.equal(waited.error.outcome, 'not_dispatched');
  assert.ok((await call('chrome_evaluate', { tabId, expression: 'document.title="作业"' })).ok);

  // 后台作业：语句、分号、行尾注释都行；进度、结果存文件、失败、找不到。
  const job = await call('chrome_job_start', { tabId, expression: 'const rows = [1, 2, 3];\nasync report => { report({ done: 1 }); await new Promise(resolve => setTimeout(resolve, 300)); report({ done: 3 }); return { rows }; }; // 抓数脚本\n' });
  assert.ok(job.ok, JSON.stringify(job.error)); const jobId = job.data.jobId;
  const running = await call('chrome_job_status', { tabId, jobId }); assert.equal(running.data.state, 'running');
  const done = await call('chrome_job_status', { tabId, jobId, waitMs: 10000, savePath: path.join(outputs, '数据.json') });
  assert.equal(done.data.state, 'done', JSON.stringify(done)); assert.deepEqual(done.data.progress, { done: 3 });
  assert.deepEqual(JSON.parse(await readFile(path.join(outputs, '数据.json'), 'utf8')), { rows: [1, 2, 3] });
  const failing = await call('chrome_job_start', { tabId, expression: '(async () => { await 0; throw new Error("接口失败") })()' });
  const failed = await call('chrome_job_status', { tabId, jobId: failing.data.jobId, waitMs: 5000 });
  assert.equal(failed.data.state, 'failed'); assert.match(failed.data.error, /接口失败/);
  assert.ok((await call('chrome_evaluate', { tabId, expression: '1' })).ok, '作业失败不隔离标签页');
  assert.equal((await call('chrome_job_status', { tabId, jobId: '00000000-0000-4000-8000-000000000000' })).data.state, 'missing');

  // 元素截图、clip、存文件不回图。
  const element = await call('chrome_screenshot', { tabId, selector: '#box' });
  assert.ok(element.ok, JSON.stringify(element.error));
  const image = (await sdk.callTool({ name: 'chrome_screenshot', arguments: { profileId: profile.id, tabId, clip: { x: 10, y: 10, width: 50, height: 40 } } })).content as { type: string; data?: string }[];
  assert.deepEqual(pngSize(image.find(item => item.type === 'image')!.data!), [50, 40]);
  const saved = await call('chrome_screenshot', { tabId, selector: '#box', savePath: path.join(outputs, '方块.png'), returnImage: false });
  assert.ok(saved.ok, JSON.stringify(saved.error)); assert.deepEqual(pngSize((await readFile(path.join(outputs, '方块.png'))).toString('base64')), [200, 100]);

  // 按标签页等下载：第一个下载放行并带上来源标签页；同一页面连续三个，后两个被 Chrome 拦下，等待超时提示网站设置。
  assert.ok((await call('chrome_action', { tabId, action: 'click', selector: '#one' })).ok);
  const first = await call('chrome_wait_download', { tabId, timeoutMs: 15000 });
  assert.ok(first.ok, JSON.stringify(first.error)); assert.equal(first.data.tabId, tabId);
  const listed = await call('chrome_downloads', { downloadId: first.data.downloadId });
  assert.equal((listed.data.items ?? listed.data)[0].tabId, tabId);
  assert.equal((await call('chrome_site_permission', { tabId })).data.setting, 'ask');
  assert.ok((await call('chrome_action', { tabId, action: 'click', selector: '#three' })).ok);
  const second = await call('chrome_wait_download', { tabId, since: first.data.sequence, timeoutMs: 10000 });
  const afterSecond = second.ok ? second.data.sequence : first.data.sequence;
  const blocked = await call('chrome_wait_download', { tabId, since: afterSecond, timeoutMs: 1500 });
  assert.equal(blocked.error.code, 'DOWNLOAD_WAIT_TIMEOUT'); assert.match(blocked.error.message, /chrome_site_permission/);
  const allowed = await call('chrome_site_permission', { tabId, setting: 'allow' });
  assert.ok(allowed.ok, JSON.stringify(allowed.error)); assert.equal(allowed.data.setting, 'allow');
  assert.ok((await call('chrome_navigate', { tabId, action: 'reload' })).ok);
  assert.ok((await call('chrome_wait', { tabId, selector: '#three' })).ok);
  const before = (await readdir(downloads)).length;
  assert.ok((await call('chrome_action', { tabId, action: 'click', selector: '#three' })).ok);
  let since = blocked.error ? afterSecond : 0;
  for (let i = 0; i < 3; i++) { const next = await call('chrome_wait_download', { tabId, since, timeoutMs: 10000 }); assert.ok(next.ok, `允许后第 ${i + 1} 个下载：${JSON.stringify(next.error)}`); since = next.data.sequence; }
  assert.equal((await readdir(downloads)).length - before, 3);

  // 保持标签页（高级工具）。
  const kept = await call('chrome_keep_tab', { tabId });
  assert.ok(kept.ok, JSON.stringify(kept.error)); assert.equal(kept.data.autoDiscardable, false);
  const tabs = await call('chrome_tabs', {}); assert.equal(tabs.data.items.find((tab: any) => tab.tabId === tabId).autoDiscardable, false);
  assert.equal((await call('chrome_keep_tab', { tabId, keep: false })).data.autoDiscardable, undefined);
  const profiles = (await sdk.callTool({ name: 'chrome_profiles', arguments: {} })).structuredContent as any; assert.equal(profiles.data.profiles[0].sameMachine, true);
  assert.ok((await call('chrome_close_tab', { tabId })).ok);
  console.log(JSON.stringify({ probe: true, replMode: true, jobs: true, elementScreenshot: true, tabDownloads: true, blockedHint: true, sitePermission: true, keepTab: true }));
});
