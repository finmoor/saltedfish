import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchTestChrome } from './chrome-launch.js';
import { fixture, freePort } from './helpers.js';
import { projectDir } from '../src/config.js';
import { bridgeToken } from '../src/auth.js';

// 真实 Chrome：挂住的调用不能锁死标签页；确定失败不能被记成结果未知，只有真的不确定才暂停写入。
test('失败结果分类与挂住的调用', async t => {
  const f = await fixture(), port = await freePort(), closed = await freePort();
  // 元素足够多，一轮查找要几百毫秒，到期时大概率正在查找：CDP 会中断它，回一条笼统的 Internal error。
  const heavy = `<!doctype html><title>heavy</title>${'<div><span>row</span></div>'.repeat(30000)}`;
  const web = createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(req.url === '/heavy' ? heavy : '<!doctype html><title>t</title><button id="b">b</button>'); });
  let closeBrowser = async () => {};
  t.after(async () => { try { await closeBrowser(); } finally { web.closeAllConnections(); await new Promise<void>(r => web.close(() => r())); await f.cleanup(); } });
  await new Promise<void>(r => web.listen(port, '127.0.0.1', r));
  const ext = path.join(f.config.dataDir, 'extension'); await cp(path.join(process.env.PRODUCT_SERVICE_ROOT || projectDir, 'dist/extension'), ext, { recursive: true });
  await writeFile(path.join(ext, 'pairing.json'), JSON.stringify({ port: f.config.port, token: bridgeToken(f.config) }));
  const browser = await launchTestChrome({ headless: true, pipe: true, userDataDir: path.join(f.config.dataDir, 'chrome'), enableExtensions: [ext], args: ['--no-first-run'] });
  closeBrowser = () => browser.close();
  for (let i = 0; i < 150 && !f.service.broker.listProfiles().length; i++) await new Promise(r => setTimeout(r, 100));
  const profileId = f.service.broker.listProfiles()[0]!.id, owner = 'failure-outcomes', page = `http://127.0.0.1:${port}/`;
  const invoke = (name: string, args: Record<string, unknown>) => f.service.invoke(name, { profileId, ...args }, owner);
  const open = async () => { const opened = await invoke('chrome_new_tab', { url: page }); assert.equal(opened.ok, true, JSON.stringify(opened.error)); const tabId = (opened.data as any).tabId as number; const ready = await invoke('chrome_wait', { tabId, expression: 'document.readyState === "complete"' }); assert.equal(ready.ok, true, JSON.stringify(ready.error)); return tabId; };
  const expectFailure = async (name: string, args: Record<string, unknown>, code: string, outcome: string) => { const result = await invoke(name, args); assert.equal(result.ok, false, name); assert.equal(result.error?.code, code, JSON.stringify(result.error)); assert.equal(result.error?.outcome, outcome, JSON.stringify(result.error)); return result; };
  const writable = async (tabId: number) => { const result = await invoke('chrome_evaluate', { tabId, expression: '1 + 1' }); assert.equal(result.ok, true, JSON.stringify(result.error)); assert.equal(result.data, 2); };

  await t.test('永不返回的 Promise 到期结束，恢复后标签页和配置都能继续用', async () => {
    const tabId = await open(), started = Date.now();
    await expectFailure('chrome_evaluate', { tabId, expression: 'new Promise(()=>{})', timeoutMs: 300 }, 'SCRIPT_TIMEOUT', 'unknown');
    assert.ok(Date.now() - started < 3000, '到期就返回，不等服务端兜底');
    const blocked = await expectFailure('chrome_evaluate', { tabId, expression: '1' }, 'RESULT_UNKNOWN', 'not_dispatched');
    assert.match(blocked.error!.message, /没有确认/); assert.doesNotMatch(blocked.error!.message, /超时|断线/);
    const recovered = await invoke('chrome_recover_tab', { tabId }); assert.equal(recovered.ok, true, JSON.stringify(recovered.error));
    await writable(tabId);
    const other = await open();
    const closing = await invoke('chrome_close_tab', { tabId }); assert.equal(closing.ok, true, JSON.stringify(closing.error));
    assert.equal((await invoke('chrome_close_tab', { tabId: other })).ok, true);
  });

  await t.test('未恢复时也能关闭挂住过的标签页，配置不会被占用标记拖住', async () => {
    const tabId = await open();
    await expectFailure('chrome_evaluate', { tabId, expression: 'new Promise(()=>{})', timeoutMs: 300 }, 'SCRIPT_TIMEOUT', 'unknown');
    await new Promise(r => setTimeout(r, 1000));
    assert.equal((await invoke('chrome_recover_tab', { tabId })).ok, true);
    await invoke('chrome_close_tab', { tabId });
  });

  await t.test('原始 CDP 挂住同样到期收尾，调试连接自动恢复', async () => {
    const tabId = await open();
    await expectFailure('chrome_cdp', { tabId, method: 'Runtime.evaluate', params: { expression: 'new Promise(()=>{})', awaitPromise: true }, timeoutMs: 300 }, 'OPERATION_HUNG', 'unknown');
    const recovered = await invoke('chrome_recover_tab', { tabId }); assert.equal(recovered.ok, true, JSON.stringify(recovered.error));
    await writable(tabId);
    await invoke('chrome_close_tab', { tabId });
  });

  await t.test('大页面上目标一直找不到：到期算没有派发，不暂停写入', async () => {
    const opened = await invoke('chrome_new_tab', { url: page + 'heavy' }); assert.equal(opened.ok, true, JSON.stringify(opened.error)); const tabId = (opened.data as any).tabId as number;
    for (let i = 0; i < 80; i++) { const loaded = await invoke('chrome_evaluate', { tabId, expression: "document.readyState==='complete'&&document.querySelectorAll('div').length" }); if (loaded.data) break; await new Promise(r => setTimeout(r, 100)); }
    for (const timeoutMs of [500, 800, 1100, 1400]) await expectFailure('chrome_action', { tabId, action: 'click', locator: { role: 'button', name: '不存在的按钮' }, timeoutMs }, 'ACTIONABILITY_TIMEOUT', 'not_dispatched');
    for (const timeoutMs of [500, 800, 1100]) await expectFailure('chrome_wait', { tabId, locator: { role: 'button', name: '不存在的按钮' }, timeoutMs }, 'WAIT_TIMEOUT', 'not_dispatched');
    await writable(tabId);
    await invoke('chrome_close_tab', { tabId });
  });

  await t.test('确定失败不暂停写入', async () => {
    const tabId = await open();
    const download = await expectFailure('chrome_download', { url: page, filename: '../../sf-escape.html' }, 'DOWNLOAD_REJECTED', 'not_dispatched');
    assert.match(download.error!.message, /没有开始/);
    await writable(tabId);
    await expectFailure('chrome_cdp', { tabId, method: 'Nope.missing', params: {} }, 'CDP_COMMAND_REJECTED', 'not_dispatched');
    await writable(tabId);
    await expectFailure('chrome_cdp', { tabId, method: 'Runtime.evaluate', params: { expression: 123 } }, 'CDP_COMMAND_REJECTED', 'not_dispatched');
    await writable(tabId);
    await expectFailure('chrome_evaluate', { tabId, expression: '1 +' }, 'JAVASCRIPT_SYNTAX_ERROR', 'not_dispatched');
    await writable(tabId);
    await expectFailure('chrome_wait', { tabId, expression: 'return true' }, 'JAVASCRIPT_SYNTAX_ERROR', 'not_dispatched');
    await writable(tabId);
    await expectFailure('chrome_navigate', { tabId, url: `http://127.0.0.1:${closed}/` }, 'NAVIGATION_FAILED', 'not_dispatched');
    await writable(tabId);
    await expectFailure('chrome_new_tab', { url: page, windowId: 987654 }, 'TAB_CREATE_REJECTED', 'not_dispatched');
    await writable(tabId);
    // 关一个不存在的标签页：要的结果已经达成（0.3.19 起），不报错，也不留待核查记录。
    const gone = await invoke('chrome_close_tab', { tabId: 987654 });
    assert.equal(gone.ok, true, JSON.stringify(gone.error)); assert.equal((gone.data as any).alreadyClosed, true);
    await writable(tabId);
    assert.equal(f.service.state.protection().unknown, 0, '没有留下待核查记录');
    await invoke('chrome_close_tab', { tabId });
  });

  await t.test('改动页面之前就抛错（含找不到元素）：试跑证明没有副作用，不暂停写入', async () => {
    for (const expression of ['throw new Error("boom")', 'document.querySelector("#nope").click()']) {
      const tabId = await open();
      await expectFailure('chrome_evaluate', { tabId, expression }, 'JAVASCRIPT_ERROR', 'not_dispatched');
      await writable(tabId);
      await invoke('chrome_close_tab', { tabId });
    }
  });

  await t.test('改了页面之后才抛错，或者是拒绝的 Promise（试跑拦下 Promise 和 async），不能证明没有副作用，仍暂停写入，但说明不再提超时断线', async () => {
    for (const expression of ['document.body.dataset.boom="1";throw new Error("boom")', '(async()=>{document.body.dataset.boom="1";await 0;throw new Error("boom")})()', 'Promise.reject(new Error("boom"))']) {
      const tabId = await open();
      await expectFailure('chrome_evaluate', { tabId, expression }, 'JAVASCRIPT_ERROR', 'unknown');
      const blocked = await expectFailure('chrome_evaluate', { tabId, expression: '1' }, 'RESULT_UNKNOWN', 'not_dispatched');
      assert.doesNotMatch(blocked.error!.message, /超时|断线/);
      assert.equal((await invoke('chrome_recover_tab', { tabId })).ok, true);
      await writable(tabId);
      await invoke('chrome_close_tab', { tabId });
    }
  });

  await t.test('raw 无障碍树不含卡号，截图结果能读回，宽松定位不分大小写', async () => {
    const tabId = await open();
    const typed = await invoke('chrome_evaluate', { tabId, expression: "document.body.innerHTML='<label>卡号 <input id=card></label><label>城市 <input id=city></label><button>Submit Order</button>';document.querySelector('#card').value='4111111111111111';document.querySelector('#city').value='上海';true" });
    assert.equal(typed.ok, true, JSON.stringify(typed.error));
    const raw = await invoke('chrome_accessibility', { tabId, mode: 'raw', maxCharacters: 24000 }); assert.equal(raw.ok, true, JSON.stringify(raw.error));
    const artifactId = (raw.data as any).artifactId as string | undefined;
    const text = artifactId ? JSON.stringify((await f.service.invoke('chrome_read_result', { artifactId, offset: 0, limit: 200000 }, owner)).data) : JSON.stringify(raw.data);
    assert.ok(!text.includes('4111111111111111'), '卡号不出现在 raw 无障碍树里'); assert.ok(text.includes('上海'), '普通字段的值保留');
    const found = await invoke('chrome_find', { tabId, locator: { name: 'submit', exact: false } }); assert.equal(found.ok, true, JSON.stringify(found.error));
    const shot = await invoke('chrome_screenshot', { tabId }); assert.equal(shot.ok, true, JSON.stringify(shot.error));
    const read = await f.service.invoke('chrome_read_result', { artifactId: (shot.data as any).artifactId }, owner); assert.equal(read.ok, true, JSON.stringify(read.error));
    assert.equal(read.image?.mimeType, 'image/png'); assert.ok(Buffer.from(read.image!.data, 'base64').subarray(1, 4).toString() === 'PNG');
    await invoke('chrome_close_tab', { tabId });
  });

  await t.test('受限客户端的标签列表隐藏扩展页和地址', async () => {
    const tabId = await open(), worker = await browser.waitForTarget(target => target.type() === 'service_worker'), secret = `chrome-extension://${new URL(worker.url()).hostname}/options.html`;
    const settings = await browser.newPage(); await settings.goto(secret);
    const client = f.service.state.createClient('受限', [profileId]), principal = f.service.state.authenticate(client.token)!;
    const listed = await f.service.invoke('chrome_tabs', { profileId, limit: 100 }, 'client', principal); assert.equal(listed.ok, true, JSON.stringify(listed.error));
    const tabs = (listed.data as any).items as any[]; assert.ok(tabs.some(tab => tab.adminPage === true && tab.url === ''), JSON.stringify(tabs)); assert.ok(!JSON.stringify(tabs).includes('options.html'), '地址不可见'); assert.ok(tabs.some(tab => tab.tabId === tabId && tab.url === page), '普通标签不受影响');
    const admin = await invoke('chrome_tabs', { limit: 100 }); assert.ok(JSON.stringify(admin.data).includes('options.html'), '管理员仍能看到');
    await settings.close(); await invoke('chrome_close_tab', { tabId });
  });

  await t.test('调试器还没接上的标签页上并发读取，不会报上下文未就绪', async () => {
    for (let round = 0; round < 30; round++) {
      const tab = await browser.newPage(); await tab.goto(page);
      const listed = await invoke('chrome_tabs', { limit: 100 }), tabId = (listed.data as any).items.filter((item: any) => item.url === page).at(-1).tabId as number;
      const reads = await Promise.all([1, 2, 3].map(() => invoke('chrome_inspect', { tabId })));
      for (const read of reads) assert.equal(read.ok, true, `第 ${round} 轮：${JSON.stringify(read.error)}`);
      await tab.close();
    }
  });

  await t.test('服务和浏览器时钟差一小时也照常执行', async () => {
    const tabId = await open(), real = Date.now;
    Date.now = () => real() - 3600_000;
    try { await writable(tabId); } finally { Date.now = real; }
    await invoke('chrome_close_tab', { tabId });
  });
});
