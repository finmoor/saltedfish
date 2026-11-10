import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { projectDir } from '../src/config.js';
import { CAPABILITY } from '../src/shared.js';
import { interactionHarness } from './interaction-harness.js';
import { testDirectory } from './helpers.js';

// Chrome 应用商店版（scripts/build-extension.mjs --store）在真 Chrome 里：照常连上服务、能操作页面，
// 握手声明 store-build 而不是 self-update-v1，设置页没有“更新”，后台拒绝更新消息。
const html = `<!doctype html><meta charset="utf-8"><title>store</title><button id="go" onclick="this.textContent='clicked'">go</button>`;

test('应用商店版扩展：连得上、能操作，没有一键更新', { timeout: 180000 }, async t => {
  const temp = await testDirectory(); t.after(() => temp.cleanup());
  const dir = path.join(temp.directory, 'extension-store');
  await promisify(execFile)(process.execPath, ['scripts/build-extension.mjs', '--store', '--outdir', dir], { cwd: projectDir, windowsHide: true });
  const before = process.env.INTERACTION_EXTENSION; process.env.INTERACTION_EXTENSION = dir;
  let h: Awaited<ReturnType<typeof interactionHarness>>;
  try { h = await interactionHarness(t, html); } finally { if (before === undefined) delete process.env.INTERACTION_EXTENSION; else process.env.INTERACTION_EXTENSION = before; }

  const capabilities = h.service.broker.listProfiles()[0]!.capabilities ?? [];
  assert.ok(capabilities.includes(CAPABILITY.storeBuild), JSON.stringify(capabilities));
  assert.ok(!capabilities.includes(CAPABILITY.selfUpdateV1));

  const { page, call } = await h.open();
  await call('chrome_action', { action: 'click', selector: '#go' });
  assert.equal(await page.$eval('#go', element => element.textContent), 'clicked');

  const options = await h.browser.newPage();
  try {
    await options.goto(`chrome-extension://${new URL(h.worker.url()).hostname}/options.html`);
    for (const type of ['extension.update.offer', 'extension.update.restart']) {
      const reply = await options.evaluate(kind => (globalThis as any).chrome.runtime.sendMessage({ type: kind }), type) as { error?: string };
      assert.match(String(reply?.error), /应用商店/, type);
    }
    assert.equal(await options.$eval('#update-strip', element => (element as HTMLElement).hidden), true);
  } finally { await options.close(); }
});
