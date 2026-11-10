import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, fakeProfile } from './helpers.js';
import { EXTENSION_CAPABILITIES } from '../src/shared.js';
import { staleCodeHint } from '../ui/extension-version.js';

// Chrome 有时沿用旧的后台脚本：manifest 是新的、跑的还是旧代码。
// 服务端按握手里的 version（manifest）和 codeVersion（编译进后台的版本）认出来，告诉 Agent 和管理页去重新加载，不叫人去更新。

test('staleCodeHint：manifest 比代码新才算；没带 codeVersion 的当 0.3.20 及更早；不是纯数字的版本号不判断', () => {
  assert.match(staleCodeHint({ version: '0.3.22', codeVersion: '0.3.21' }), /扩展文件已是 0\.3\.22，后台还在跑 0\.3\.21 的代码。到 chrome:\/\/extensions 找到 SaltedFish 点重新加载/);
  assert.match(staleCodeHint({ version: '0.3.21' }), /扩展文件已是 0\.3\.21，后台还在跑旧代码/);
  for (const profile of [{ version: '0.3.21', codeVersion: '0.3.21' }, { version: '0.3.20' }, { version: '0.3.18' }, { version: '0.0.1', codeVersion: '0.3.21' }, { version: 'test' }, { version: '0.3.0-beta.13' }, { version: '0.3.22', codeVersion: '0.3.22-dev' }, {}])
    assert.equal(staleCodeHint(profile), '', JSON.stringify(profile));
});

test('chrome_profiles 给代码没换上的浏览器带 extensionReload；新功能报 EXTENSION_UPDATE_REQUIRED 时说去重新加载', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const old = EXTENSION_CAPABILITIES.filter(capability => capability !== 'screenshot-v3');
  const stale = await fakeProfile(f.service.config, '旧代码', () => ({ mimeType: 'image/png', data: '' }), undefined, { version: '0.3.21', capabilities: old });
  const fresh = await fakeProfile(f.service.config, '新代码', undefined, undefined, { version: '0.3.21', codeVersion: '0.3.21' });
  const stuck = await fakeProfile(f.service.config, '重载过还是旧', undefined, undefined, { version: '0.3.22', codeVersion: '0.3.21' });
  t.after(() => { for (const profile of [stale, fresh, stuck]) profile.socket.close(); });
  const listed = await f.service.invoke('chrome_profiles', {}, 'admin');
  assert.equal(listed.ok, true, JSON.stringify(listed.error));
  const byId = new Map((listed.data as { profiles: { id: string; extensionReload?: string; codeVersion?: string }[] }).profiles.map(profile => [profile.id, profile]));
  assert.match(byId.get(stale.id)!.extensionReload!, /后台还在跑旧代码/);
  assert.equal(byId.get(fresh.id)!.extensionReload, undefined); assert.equal(byId.get(fresh.id)!.codeVersion, '0.3.21', '服务记下了握手带的代码版本');
  assert.match(byId.get(stuck.id)!.extensionReload!, /后台还在跑 0\.3\.21 的代码/);
  assert.match((listed.data as { note: string }).note, /extensionReload/);
  const refused = await f.service.invoke('chrome_screenshot', { profileId: stale.id, tabId: 7, scale: 0.5 }, 'admin');
  assert.equal(refused.error?.code, 'EXTENSION_UPDATE_REQUIRED');
  assert.match(refused.error!.message, /点重新加载.*未执行页面动作/);
});

test('握手的 codeVersion 超长时拒绝，和 version 同一个上限', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const long = await fakeProfile(f.service.config, '超长', undefined, undefined, { codeVersion: 'v'.repeat(65) }); t.after(() => long.socket.close());
  assert.notEqual(long.handshake.type, 'ready');
  const edge = await fakeProfile(f.service.config, '上限', undefined, undefined, { codeVersion: 'v'.repeat(64) }); t.after(() => edge.socket.close());
  assert.equal(edge.handshake.type, 'ready');
});
