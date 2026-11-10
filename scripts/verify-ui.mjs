import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { loadConfig, projectDir } from '../dist/config.js';
// 经测试的公用入口启动 Chrome，免得全新配置每次启动都记一次 Windows 登录失败；Node 24 直接加载 .ts。
import { launchTestChrome } from '../tests/chrome-launch.ts';

const config = await loadConfig();
const browser = await launchTestChrome({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  await page.goto(`http://127.0.0.1:${config.port}/#${config.token}`);
  await page.waitForFunction(() => document.querySelector('#login').hidden);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  assert.ok((await page.$eval('h1', node => node.textContent)).includes('浏览器工作台'));
  await mkdir(path.join(projectDir, '.local', 'verification'), { recursive: true });
  await page.screenshot({ path: path.join(projectDir, '.local', 'verification', 'dashboard.png'), fullPage: true });
  assert.equal(errors.length, 0);
  console.log('PASS 连接控制台载入、自动配对和在线配置展示');
} finally { await browser.close(); }
