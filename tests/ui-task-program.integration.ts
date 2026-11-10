import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { launchTestChrome } from './chrome-launch.js';
import { fixture, fakeProfile, testDirectory } from './helpers.js';
import { projectDir } from '../src/config.js';
import { VERSION } from '../src/version.js';

test('真实管理页：条件/循环及结果绑定保存无损，总执行上限在桌面与390px可编辑且不溢出', async t => {
  const home = await testDirectory(); t.after(() => home.cleanup());
  const f = await fixture({ setup: { home: home.directory, entries: { codex: { command: 'fixture.exe', args: [], env: {} } }, verify: async () => ({ tools: 1, profiles: 1 }) } });
  t.after(() => f.cleanup());
  const profile = await fakeProfile(f.config, '测试浏览器', command => command.operation === 'tabs.list' ? [{ tabId: 7, windowId: 1, title: '合成页面', url: 'https://example.test/' }] : {});
  const flow = f.service.tasks.saveWorkflow(profile.id, { name: '条件循环编辑验收', maxExecutedSteps: 73, steps: [
    { operation: 'flow.set', args: { name: 'value', value: 'fixture' } },
    { operation: 'flow.repeat', args: { count: 2 } },
    { operation: 'page.action', args: { action: 'fill', selector: '#name', text: '' }, bindings: { text: 'value' }, saveAs: 'filled' },
    { operation: 'flow.end', args: {} },
  ] });
  const browser = await launchTestChrome({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.setViewport({ width: 1280, height: 1000 });
  await page.goto(`http://127.0.0.1:${f.config.port}/#${f.config.token}`);
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#login')!.hidden);
  await page.$eval('#advanced-nav', node => (node as HTMLDetailsElement).open = true);
  await page.click('nav a[href="#tasks"]'); await page.select('#task-profile', profile.id);
  await page.waitForSelector('#workflow-list .workflow');
  await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('#workflow-list button')].find(button => button.textContent === '编辑')!.click());
  await page.waitForFunction(() => (document.querySelector<HTMLInputElement>('#task-max-executed-steps')!).value === '73');
  assert.equal(await page.$$eval('.step-action', items => items.every(item => (item as HTMLSelectElement).value === 'advanced')), true);
  const originals = await page.$$eval('.step-json', items => items.map(item => JSON.parse((item as HTMLTextAreaElement).value)));
  assert.deepEqual(originals, flow.definition.steps);
  await page.$eval('#task-max-executed-steps', node => { (node as HTMLInputElement).value = '81'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#save-workflow');
  await page.waitForFunction(() => document.querySelector('#status')!.textContent!.includes('流程版本 2 已保存'));
  const updated = f.service.tasks.getWorkflow(profile.id, flow.id);
  assert.equal(updated.definition.maxExecutedSteps, 81); assert.deepEqual(updated.definition.steps, flow.definition.steps);
  await mkdir(path.join(projectDir, '.local', 'verification'), { recursive: true });
  for (const [width, name] of [[1280, 'desktop'], [390, 'mobile']] as const) {
    await page.setViewport({ width, height: 900 });
    await page.$eval('#task-max-executed-steps', node => node.scrollIntoView({ block: 'center' }));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${width}px`);
    const rect = await page.$eval('#task-max-executed-steps', node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right }; });
    assert.ok(rect.left >= 0 && rect.right <= width, `${width}px 控件完整可见`);
    await page.screenshot({ path: path.join(projectDir, '.local', 'verification', `task-program-${VERSION}-${name}.png`) });
  }
  assert.deepEqual(errors, []);
});
