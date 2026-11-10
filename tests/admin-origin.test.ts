import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, fakeProfile, FAKE_CAPABILITIES } from './helpers.js';
import { adminOrigins, hiddenTabTitle, BrowserError, type WireCommand } from '../src/shared.js';
import { adminPrincipal, type Principal } from '../src/auth.js';

// 非管理员主体对本机管理页的保护：服务端这一半（命令附带管理页 origin、结果隐藏、导航拒绝、能力门禁）。
// 扩展按标签页当前 URL 实际拒绝的部分见 admin-guard-extension.test.ts。
async function setup(handler?: (command: WireCommand) => unknown, capabilities?: string[]) {
  const f = await fixture(), seen: WireCommand[] = [];
  const profile = await fakeProfile(f.config, 'A', command => { seen.push(command); return handler ? handler(command) : {}; }, undefined, capabilities ? { capabilities } : {});
  const restricted = f.service.state.authenticate(f.service.state.createClient('受限客户端').token)!;
  const readOnly = f.service.state.authenticate(f.service.state.createClient('只读客户端', '*', true).token)!;
  return { f, seen, profile, restricted, readOnly, origins: adminOrigins(f.config.port) };
}
const call = (f: Awaited<ReturnType<typeof setup>>['f'], principal: Principal, name: string, args: Record<string, unknown>) => f.service.invoke(name, args, `o-${principal.id}`, principal);

test('非管理员主体的标签页命令带着管理页 origin，管理员和不针对标签页的命令不带', async t => {
  const { f, seen, profile, restricted, origins } = await setup(command => command.operation === 'tabs.list' ? [] : {}); t.after(() => f.cleanup());
  const target = { profileId: profile.id, tabId: 1 };
  await call(f, restricted, 'chrome_evaluate', { ...target, expression: '1' });
  await call(f, restricted, 'chrome_batch', { ...target, steps: [{ operation: 'page.evaluate', args: { expression: '1' } }] });
  await call(f, restricted, 'chrome_cdp', { ...target, method: 'Runtime.evaluate', params: { expression: '1' } });
  await call(f, restricted, 'chrome_screenshot', target);
  await call(f, restricted, 'chrome_tabs', { profileId: profile.id });
  await call(f, adminPrincipal, 'chrome_evaluate', { ...target, expression: '2' });
  const by = (operation: string) => seen.filter(command => command.operation === operation);
  assert.deepEqual(by('page.evaluate').map(command => command.args.adminGuard), [origins, undefined]);
  // 原始 CDP 一条；截图自带的焦点模拟（开/关）两条 page.cdp 也同样带标记
  assert.deepEqual(by('page.batch').map(command => command.args.adminGuard), [origins]);
  assert.deepEqual(by('page.screenshot').map(command => command.args.adminGuard), [origins]);
  assert.deepEqual(by('page.cdp').map(command => command.args.adminGuard), [origins, origins, origins]);
  assert.equal(by('tabs.list').length, 1); assert.equal(by('tabs.list')[0]!.args.adminGuard, undefined);
});

test('视觉动作的焦点模拟命令同样带保护标记；扩展拒绝后不再发送“恢复”命令，操作记录是失败而不是未知', async t => {
  const { f, seen, profile, restricted } = await setup(command => { if (command.operation === 'page.cdp') throw new BrowserError('ADMIN_PAGE_PROTECTED', 'protected', { phase: 'precondition', outcome: 'not_dispatched' }); return {}; }); t.after(() => f.cleanup());
  const result = await call(f, restricted, 'chrome_action', { profileId: profile.id, tabId: 1, action: 'click', selector: '#b' });
  assert.equal(result.error?.code, 'ADMIN_PAGE_PROTECTED'); assert.equal(result.error?.outcome, 'not_dispatched');
  assert.deepEqual(seen.map(command => command.operation), ['page.cdp'], '只发出一次被拒绝的焦点命令，没有页面动作，也没有清理命令');
  assert.ok(Array.isArray(seen[0]!.args.adminGuard));
  assert.equal(f.service.state.list(profile.id, 'unknown', 0, 10).items.length, 0);
  assert.equal(f.service.state.list(profile.id, 'failed', 0, 10).items.length, 1);
  // 之后同一标签页的写操作不被未知结果挡住
  assert.equal((await call(f, adminPrincipal, 'chrome_evaluate', { profileId: profile.id, tabId: 1, expression: '1' })).ok, true);
});

test('客户端不能自带 adminGuard 来改写保护标记', async t => {
  const { f, profile } = await setup(); t.after(() => f.cleanup());
  for (const principal of [adminPrincipal]) {
    const result = await call(f, principal, 'chrome_evaluate', { profileId: profile.id, tabId: 1, expression: '1', adminGuard: [] });
    assert.equal(result.error?.code, 'INVALID_ARGUMENT');
  }
});

test('旧扩展（没有 admin-origin-v1）不能被非管理员主体用于标签页操作，管理员不受影响', async t => {
  const { f, seen, profile, restricted, readOnly } = await setup(undefined, FAKE_CAPABILITIES.filter(capability => capability !== 'admin-origin-v1')); t.after(() => f.cleanup());
  const target = { profileId: profile.id, tabId: 1 };
  for (const principal of [restricted, readOnly]) {
    const result = await call(f, principal, 'chrome_screenshot', target);
    assert.equal(result.error?.code, 'EXTENSION_UPDATE_REQUIRED'); assert.equal(result.error?.outcome, 'not_dispatched');
  }
  assert.equal(seen.length, 0);
  assert.equal((await call(f, adminPrincipal, 'chrome_evaluate', { ...target, expression: '1' })).ok, true);
});

test('标签页列表对非管理员隐藏管理页的 URL 和标题（标签仍可见），查询不能当探测旁路，管理员看到原样', async t => {
  const { f, profile, restricted, readOnly, origins } = await setup(command => command.operation === 'tabs.list' ? [
    { tabId: 1, windowId: 1, title: 'Secret Admin Title', url: `${origins[0]}/#${'a'.repeat(64)}` },
    { tabId: 2, windowId: 1, title: 'localhost 页', url: `${origins[1]}/?onboarding=1` },
    { tabId: 3, windowId: 1, title: '待跳转', url: 'about:blank', pendingUrl: `${origins[0]}/` },
    { tabId: 4, windowId: 1, title: 'Example', url: 'https://example.com/' },
  ] : {}); t.after(() => f.cleanup());
  const listing = async (principal: Principal, query?: string) => ((await call(f, principal, 'chrome_tabs', { profileId: profile.id, ...(query ? { query } : {}) })).data as { items: Record<string, unknown>[] }).items;
  for (const principal of [restricted, readOnly]) {
    const tabs = await listing(principal);
    assert.deepEqual(tabs.map(tab => tab.tabId), [1, 2, 3, 4]);
    for (const tab of tabs.slice(0, 3)) { assert.equal(tab.url, ''); assert.equal(tab.title, hiddenTabTitle); assert.equal(tab.adminPage, true); assert.ok(!JSON.stringify(tab).includes(String(f.config.port)), '管理页端口和登录片段不外露'); }
    assert.equal(tabs[3]!.url, 'https://example.com/');
    assert.deepEqual((await listing(principal, '127.0.0.1')).map(tab => tab.tabId), [], '按管理页地址搜索探测不到它');
    assert.deepEqual((await listing(principal, 'Secret Admin')).map(tab => tab.tabId), [], '按管理页真实标题搜索探测不到它');
  }
  const admin = await listing(adminPrincipal);
  assert.equal(admin[0]!.url, `${origins[0]}/#${'a'.repeat(64)}`); assert.equal(admin[0]!.title, 'Secret Admin Title');
});

test('导航、新建标签、批次导航和原始 Page.navigate 到管理页：对非管理员在服务端就拒绝，未派发；管理员可以', async t => {
  const { f, seen, profile, restricted, readOnly, origins } = await setup(); t.after(() => f.cleanup());
  const target = { profileId: profile.id, tabId: 1 }, url = `${origins[0]}/#overview`;
  const attempts: [string, Record<string, unknown>][] = [
    ['chrome_navigate', { ...target, url }], ['chrome_new_tab', { profileId: profile.id, url: `${origins[1]}/` }],
    ['chrome_batch', { ...target, steps: [{ operation: 'page.evaluate', args: { expression: '1' } }, { operation: 'page.navigate', args: { url } }] }],
    ['chrome_cdp', { ...target, method: 'Page.navigate', params: { url } }],
  ];
  for (const [name, args] of attempts) {
    const result = await call(f, restricted, name, args);
    assert.equal(result.error?.code, 'ADMIN_PAGE_PROTECTED', name); assert.equal(result.error?.outcome, 'not_dispatched', name);
  }
  assert.equal(seen.length, 0, '一条命令都没有发给扩展');
  assert.equal((await call(f, restricted, 'chrome_navigate', { ...target, url: 'https://example.com/' })).ok, true);
  assert.equal((await call(f, adminPrincipal, 'chrome_navigate', { ...target, url })).ok, true);
  assert.equal((await call(f, adminPrincipal, 'chrome_new_tab', { profileId: profile.id, url })).ok, true);
  void readOnly;
});

test('导航或新建标签的结果、批次嵌套结果里的管理页地址对非管理员隐藏', async t => {
  const { f, profile, restricted, origins } = await setup(command => {
    if (command.operation === 'page.navigate' || command.operation === 'tabs.create') return { tabId: 1, url: `${origins[0]}/#${'b'.repeat(64)}`, title: 'SaltedFish', status: 'complete' };
    if (command.operation === 'page.batch') return { completed: true, results: [{ index: 0, operation: 'page.navigate', result: { tabId: 1, url: `${origins[1]}/`, title: 'SaltedFish' } }, { index: 1, operation: 'page.evaluate', result: 'ok' }] };
    return {};
  }); t.after(() => f.cleanup());
  const origin = async (principal: Principal, name: string, args: Record<string, unknown>) => JSON.stringify((await call(f, principal, name, args)).data);
  for (const [name, args] of [['chrome_navigate', { profileId: profile.id, tabId: 1, url: 'https://example.com/' }], ['chrome_new_tab', { profileId: profile.id, url: 'https://example.com/' }],
    ['chrome_batch', { profileId: profile.id, tabId: 1, steps: [{ operation: 'page.navigate', args: { url: 'https://example.com/' } }, { operation: 'page.evaluate', args: { expression: '1' } }] }]] as [string, Record<string, unknown>][]) {
    const hidden = await origin(restricted, name, args), full = await origin(adminPrincipal, name, args);
    assert.ok(!hidden.includes(String(f.config.port)) && !hidden.includes('b'.repeat(64)), `${name}: ${hidden}`);
    assert.ok(hidden.includes(hiddenTabTitle), name); assert.ok(full.includes(String(f.config.port)), name);
  }
});

test('chrome_events 对非管理员隐藏管理页标签事件的 URL 和标题，其他事件和管理员看到的不变', async t => {
  const { f, profile, restricted, origins } = await setup(); t.after(() => f.cleanup());
  f.service.broker.addEvent(profile.id, 1, 'tabs.updated', { tabId: 1, url: `${origins[0]}/#${'c'.repeat(64)}`, title: 'SaltedFish' });
  f.service.broker.addEvent(profile.id, 2, 'tabs.updated', { tabId: 2, url: 'https://example.com/', title: 'Example' });
  const items = async (principal: Principal) => ((await call(f, principal, 'chrome_events', { profileId: profile.id, mode: 'raw', method: 'tabs.updated' })).data as { items: { params: Record<string, unknown> }[] }).items;
  const hidden = await items(restricted), full = await items(adminPrincipal);
  assert.equal(hidden[0]!.params.url, ''); assert.equal(hidden[0]!.params.title, hiddenTabTitle); assert.equal(hidden[0]!.params.adminPage, true);
  assert.equal(hidden[1]!.params.url, 'https://example.com/');
  assert.equal(full[0]!.params.url, `${origins[0]}/#${'c'.repeat(64)}`);
});
