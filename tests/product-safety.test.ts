import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, fakeProfile } from './helpers.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

test('旧interaction-v4扩展不会被新版服务静默派发执行路径', async () => {
  const f = await fixture(); let dispatched = 0;
  try {
    const profile = await fakeProfile(f.config, 'v4 extension', command => { dispatched++; return command.operation === 'tabs.list' ? [] : {}; });
    assert.ok(Array.isArray(profile.handshake.capabilities) && profile.handshake.capabilities.includes('interaction-v5'));
    const connection = f.service.broker.profiles.get(profile.id)!;
    connection.info.capabilities = connection.info.capabilities!.filter(capability => capability !== 'interaction-v5');
    assert.ok(connection.info.capabilities.includes('interaction-v4'));
    const file = path.join(f.config.dataDir, 'upload-fixture.txt'); await writeFile(file, 'fixture');
    for (const [name, args] of [
      ['chrome_inspect', {}], ['chrome_find', { locator: { role: 'textbox' } }], ['chrome_screenshot', {}],
      ['chrome_action', { action: 'type', selector: '#field', text: 'must not arrive' }],
      ['chrome_action', { action: 'press', selector: '#field', key: '!' }],
      ['chrome_wait', { selector: '#field' }], ['chrome_upload', { selector: '#file', paths: [file] }],
      ['chrome_batch', { steps: [{ operation: 'page.action', args: { action: 'fill', selector: '#field', text: 'must not arrive' } }] }],
    ] as const) {
      const result = await f.service.invoke(name, { profileId: profile.id, tabId: 1, ...args }, 'capability-test');
      assert.equal(result.error?.code, 'EXTENSION_UPDATE_REQUIRED', name);
      assert.equal(result.error?.outcome, 'not_dispatched', name);
      assert.equal(result.operationId, undefined, 'no operation was dispatched or journaled');
    }
    assert.equal(dispatched, 0, 'even focus emulation must remain undispatched');
    assert.equal((await f.service.invoke('chrome_tabs', { profileId: profile.id }, 'capability-test')).ok, true);
    assert.equal(dispatched, 1, 'read-only directory remains available to locate the old extension');
  } finally { await f.cleanup(); }
});

test('老扩展能力不够时在派发前拒绝；离线账号保留身份且按授权隔离', async () => {
  const f = await fixture(); let dispatched = 0;
  try {
    const p = await fakeProfile(f.config, 'legacy', () => { dispatched++; return {}; });
    f.service.broker.profiles.get(p.id)!.info.capabilities = [];
    for (const [name, args] of [
      ['chrome_find', { tabId: 1, locator: { role: 'button' } }], ['chrome_action', { tabId: 1, action: 'click', locator: { name: 'x' } }],
      ['chrome_wait', { tabId: 1, urlContains: 'example' }], ['chrome_wait_tab', { openerTabId: 1, excludeTabIds: [] }], ['chrome_pause_profile', {}],
      ['chrome_inspect', {tabId:1}], ['chrome_action', {tabId:1,action:'fill',selector:'#disabled',text:'must-not-write'}],
      ['chrome_batch', {tabId:1,steps:[{operation:'page.action',args:{action:'click',selector:'#trigger'}},{operation:'page.dialog',args:{accept:false}}]}],
    ] as const) assert.equal((await f.service.invoke(name, { profileId: p.id, ...args }, 'test')).error?.code, 'EXTENSION_UPDATE_REQUIRED');
    assert.equal(dispatched, 0); p.socket.close();
    await new Promise(resolve => p.socket.once('close', resolve)); await new Promise(resolve => setTimeout(resolve, 20));
    const profiles = await f.service.invoke('chrome_profiles', {}, 'test'); assert.equal((profiles.data as any).profiles.find((item: any) => item.id === p.id).online, false);
    const grant = f.service.state.createClient('other', ['different']);
    const hidden = await f.service.invoke('chrome_profiles', {}, 'other', f.service.state.authenticate(grant.token)); assert.equal((hidden.data as any).profiles.length, 0);
  } finally { await f.cleanup(); }
});

test('未知结果仍允许显示窗口核查，但不能写入；故障图片读取遵守账号授权', async () => {
  const f = await fixture(); const calls: string[] = [];
  try {
    const p = await fakeProfile(f.config, 'A', command => { calls.push(command.operation); return command.operation === 'page.screenshot' ? { mimeType: 'image/png', data: 'dGVzdA==' } : {}; });
    const id = f.service.state.begin(p.id, 1, 'test', 'chrome_action'); f.service.state.finish(id, 'unknown', 'CONNECTION_LOST');
    assert.equal((await f.service.invoke('chrome_focus_tab', { profileId: p.id, tabId: 1 }, 'test')).ok, true);
    assert.equal((await f.service.invoke('chrome_action', { profileId: p.id, tabId: 1, action: 'click', selector: '#x' }, 'test')).error?.code, 'RESULT_UNKNOWN');
    const shot = await f.service.invoke('chrome_screenshot', { profileId: p.id, tabId: 1 }, 'test'); const artifactId = (shot.data as any).artifactId;
    const allowed = f.service.state.createClient('allowed', [p.id], true), denied = f.service.state.createClient('denied', ['other'], true);
    const url = `http://127.0.0.1:${f.config.port}/results/${artifactId}`;
    const image = await fetch(url, { headers: { authorization: `Bearer ${allowed.token}` } }); assert.equal(image.status, 200); assert.equal(await image.text(), 'test');
    assert.equal((await fetch(url, { headers: { authorization: `Bearer ${denied.token}` } })).status, 404);
    assert.equal((await fetch(url)).status, 401); assert.deepEqual(calls.filter(name => name === 'page.action'), []);
    assert.equal(f.service.state.get(id)?.acknowledgedAt, null);
  } finally { await f.cleanup(); }
});
