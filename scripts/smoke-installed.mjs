import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, projectDir } from '../dist/config.js';
import { callService } from '../dist/mcp.js';

const config = await loadConfig();
const owner = `installed-check:${randomUUID()}`;
const opened = [];
const checks = [];
async function call(name, args = {}) {
  const result = await callService(config, name, args, owner);
  if (!result.ok) throw new Error(`${name}: ${JSON.stringify(result.error)} ${JSON.stringify(result.data || '')}`);
  return result.data;
}
const profiles = (await call('chrome_profiles')).profiles;
if (!profiles.length) throw new Error('没有已连接的 Chrome 配置，请先加载 .local/extension。');
console.log(`发现 ${profiles.length} 个现有 Chrome 配置：${profiles.map(profile => profile.label).join('、')}`);
const fixture = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end('<!doctype html><html><head><meta charset="utf-8"><title>Chrome MCP 连接验收 · 临时测试页</title></head><body><h1>Chrome MCP 连接验收</h1><input id="text"><button id="count" onclick="this.dataset.count=String(Number(this.dataset.count||0)+1)">测试按钮</button><p>此页仅用于本机验证，完成后自动关闭。</p></body></html>');
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${fixture.address().port}/`;
try {
  for (const profile of profiles) {
    const tab = await call('chrome_new_tab', { profileId: profile.id, url, active: process.argv.includes('--active') });
    const target = { profileId: profile.id, tabId: tab.tabId }; opened.push(target);
    await call('chrome_claim_tab', target);
    await call('chrome_wait', { ...target, expression: 'document.readyState === "complete"' });
    const marker = randomUUID();
    const batch = await call('chrome_batch', { ...target, steps: [
      { operation: 'page.action', args: { action: 'fill', selector: '#text', text: `验证 ${profile.label}` } },
      { operation: 'page.action', args: { action: 'click', selector: '#count' } },
      { operation: 'page.wait', args: { expression: 'document.querySelector("#count").dataset.count === "1"' } },
      { operation: 'page.evaluate', args: { expression: `localStorage.setItem('chromeMcpTest', ${JSON.stringify(marker)}); ({ text: document.querySelector('#text').value, count: document.querySelector('#count').dataset.count })` } },
    ] });
    if (batch.results[3].result.count !== '1') throw new Error(`按钮操作次数不符合预期：${JSON.stringify(batch.results)}`);
    checks.push({ label: profile.label, profileId: profile.id, tabId: tab.tabId, marker, verified: true });
    console.log(`PASS ${profile.label}: 明确路由、填表、点击一次、批量执行`);
  }
  for (const check of checks) {
    const marker = await call('chrome_evaluate', { profileId: check.profileId, tabId: check.tabId, expression: "localStorage.getItem('chromeMcpTest')" });
    if (marker !== check.marker) throw new Error(`配置隔离失败：${check.label}`);
  }
  console.log(checks.length > 1 ? `PASS ${checks.length} 个现有配置的同源存储互相隔离` : 'PASS 已接入配置的存储状态保持；跨配置隔离已在双浏览器测试中验证');
  const first = opened[0];
  const screenshot = await callService(config, 'chrome_screenshot', { ...first, fullPage: true }, owner);
  if (!screenshot.ok) throw new Error(JSON.stringify(screenshot.error));
  console.log('PASS 现有 Chrome 整页截图');
  const directory = path.join(projectDir, '.local', 'verification'); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'installed-profiles.json'), JSON.stringify({ time: new Date().toISOString(), profiles: checks.map(({ marker, ...rest }) => rest), screenshot: screenshot.data, passed: true }, null, 2));
} catch (error) {
  for (const target of opened) {
    const shot = await callService(config, 'chrome_screenshot', target, owner);
    console.error('诊断截图', JSON.stringify(shot.data || shot.error));
  }
  throw error;
} finally {
  for (const target of opened) {
    await call('chrome_release_tab', target).catch(() => {});
    await call('chrome_close_tab', target).catch(error => console.error(`请手动关闭测试标签页 ${target.tabId}: ${error.message}`));
  }
  await new Promise(resolve => { fixture.close(resolve); fixture.closeAllConnections(); });
}
