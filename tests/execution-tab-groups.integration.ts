import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { cp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchTestChrome } from './chrome-launch.js';
import { fixture, freePort } from './helpers.js';
import { projectDir } from '../src/config.js';
import { adminPrincipal, bridgeToken } from '../src/auth.js';
import { groupColor } from '../src/agent-groups.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T | undefined | false>, label: string) {
  for (let i = 0; i < 100; i++) { const value = await read(); if (value) return value; await sleep(100); }
  throw new Error('等待超时：' + label);
}

// 真实 Chrome：标签组真的建起来、放得回去、结束时解散。标签组失败或没有组都不能影响工具调用本身。
test('标签组', async t => {
  const f = await fixture(), port = await freePort();
  const web = createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(`<!doctype html><title>page ${req.url}</title><button id="popup" onclick="window.open('/popup','login','width=420,height=320')">popup</button><a id="link" href="/linked" target="_blank">link</a>`); });
  let closeBrowser = async () => {};
  t.after(async () => { try { await closeBrowser(); } finally { web.closeAllConnections(); await new Promise<void>(r => web.close(() => r())); await f.cleanup(); } });
  await new Promise<void>(r => web.listen(port, '127.0.0.1', r));
  const ext = path.join(f.config.dataDir, 'extension'); await cp(path.join(process.env.PRODUCT_SERVICE_ROOT || projectDir, 'dist/extension'), ext, { recursive: true });
  await writeFile(path.join(ext, 'pairing.json'), JSON.stringify({ port: f.config.port, token: bridgeToken(f.config) }));
  const browser = await launchTestChrome({ headless: true, pipe: true, userDataDir: path.join(f.config.dataDir, 'chrome'), enableExtensions: [ext], args: ['--no-first-run'] });
  closeBrowser = () => browser.close();
  for (let i = 0; i < 150 && !f.service.broker.listProfiles().length; i++) await sleep(100);
  const profileId = f.service.broker.listProfiles()[0]!.id, page = (name: string) => `http://127.0.0.1:${port}/${name}`;
  const workerTarget = await browser.waitForTarget(target => target.type() === 'service_worker'), worker = (await workerTarget.worker())!;
  const chrome = <T>(script: string, ...values: unknown[]) => worker.evaluate(new Function('...values', `return (async()=>{${script}})()`) as never, ...(values as never[])) as Promise<T>;
  const tab = (tabId: number) => chrome<{ groupId: number; index: number; windowId: number; pinned: boolean }>('return chrome.tabs.get(values[0])', tabId);
  const session = () => { const sessionId = randomUUID(), owner = `admin:mcp:${sessionId}`; f.service.presence.heartbeat(adminPrincipal, { sessionId, owner, clientInfo: { name: 'test-client', version: '1.0' } });
    return { owner, end: () => f.service.presence.remove(adminPrincipal, { sessionId, owner }), call: (name: string, args: Record<string, unknown>) => f.service.invoke(name, { profileId, ...args }, owner) }; };
  const plain = (name: string, args: Record<string, unknown>) => f.service.invoke(name, { profileId, ...args }, 'not-a-session');
  const open = async (call: (name: string, args: Record<string, unknown>) => Promise<any>, name: string, extra = {}) => { const result = await call('chrome_new_tab', { url: page(name), ...extra }); assert.equal(result.ok, true, JSON.stringify(result.error)); return result.data as { tabId: number; windowId: number; group?: { groupId: number; title: string } }; };
  const groups = () => chrome<{ id: number; title: string; color: string; windowId: number }[]>('return chrome.tabGroups.query({})');

  await t.test('会话开的标签页进同一个组，标题是 Agent 名字，颜色按 Agent 固定', async () => {
    const s = session(), first = await open(s.call, 'a'), second = await open(s.call, 'b');
    assert.ok(first.group, '结果带组信息'); assert.equal(first.group.title, adminPrincipal.label); assert.equal(second.group?.groupId, first.group.groupId, '不建第二个组');
    const [group] = await groups(); assert.equal(group!.title, adminPrincipal.label); assert.equal(group!.color, groupColor('admin'));
    assert.equal((await tab(first.tabId)).groupId, first.group.groupId); assert.equal((await tab(second.tabId)).groupId, first.group.groupId);
    const [view] = await f.service.groups.list(profileId);
    assert.equal(view!.online, true); assert.equal(view!.session?.client, 'test-client'); assert.deepEqual(view!.tabs.map(item => item.tabId).sort(), [first.tabId, second.tabId].sort());
    s.end();
    await until(async () => !(await groups()).length, '会话结束后组解散');
    assert.equal((await tab(first.tabId)).groupId, -1, '标签页留着'); assert.deepEqual(await f.service.groups.list(profileId), []);
    assert.deepEqual(await chrome('return (await chrome.storage.local.get("agentGroups")).agentGroups'), [], '记录也清掉');
    await plain('chrome_close_tab', { tabId: first.tabId }); await plain('chrome_close_tab', { tabId: second.tabId });
  });

  await t.test('不是 MCP 会话的调用不建组，工具结果和原来一样', async () => {
    const opened = await open(plain, 'task');
    assert.equal(opened.group, undefined); assert.equal((await tab(opened.tabId)).groupId, -1); assert.equal((await groups()).length, 0);
    await plain('chrome_close_tab', { tabId: opened.tabId });
  });

  await t.test('接管用户的标签页时进组，释放后回到原位', async () => {
    const user = await open(plain, 'user'), right = await open(plain, 'right'), s = session(), own = await open(s.call, 'own');
    const before = await tab(user.tabId);
    const claimed = await s.call('chrome_claim_tab', { tabId: user.tabId }); assert.equal(claimed.ok, true, JSON.stringify(claimed.error));
    assert.equal((claimed.data as any).group.groupId, own.group!.groupId); assert.equal((await tab(user.tabId)).groupId, own.group!.groupId); assert.notEqual((await tab(user.tabId)).index, before.index, '组是连续的，标签页被挪走了');
    const released = await s.call('chrome_release_tab', { tabId: user.tabId }); assert.equal(released.ok, true, JSON.stringify(released.error));
    const after = await tab(user.tabId); assert.equal(after.groupId, -1); assert.equal(after.index, before.index, '回到原来的位置');
    const again = await s.call('chrome_claim_tab', { tabId: user.tabId }); assert.equal(again.ok, true);
    assert.equal(f.service.broker.leaseSnapshot().length, 1);
    s.end();
    await until(async () => !(await groups()).length, '解散');
    assert.equal((await tab(user.tabId)).index, before.index, '解散时也放回去'); assert.equal(f.service.broker.leaseSnapshot().length, 0, '占用解除');
    for (const tabId of [user.tabId, right.tabId, own.tabId]) await plain('chrome_close_tab', { tabId });
  });

  await t.test('固定的标签页、用户自己的组不移动，只记占用', async () => {
    const pinned = await open(plain, 'pinned'), mine = await open(plain, 'mine'), s = session();
    await chrome('await chrome.tabs.update(values[0],{pinned:true})', pinned.tabId);
    const groupId = await chrome<number>('const id=await chrome.tabs.group({tabIds:[values[0]]});await chrome.tabGroups.update(id,{title:"我的"});return id', mine.tabId);
    const onPinned = await s.call('chrome_claim_tab', { tabId: pinned.tabId }), onGroup = await s.call('chrome_claim_tab', { tabId: mine.tabId });
    assert.equal(onPinned.ok, true); assert.equal((onPinned.data as any).group, undefined); assert.equal((await tab(pinned.tabId)).pinned, true); assert.equal((await tab(pinned.tabId)).groupId, -1);
    assert.equal(onGroup.ok, true); assert.equal((onGroup.data as any).group, undefined); assert.equal((await tab(mine.tabId)).groupId, groupId);
    s.end(); await sleep(300);
    assert.equal((await tab(mine.tabId)).groupId, groupId, '用户的组不解散');
    await s.call('chrome_release_tab', { tabId: pinned.tabId }); await s.call('chrome_release_tab', { tabId: mine.tabId });
    for (const tabId of [pinned.tabId, mine.tabId]) await plain('chrome_close_tab', { tabId });
  });

  await t.test('弹窗不移动，按打开它的标签页算到这个组', async () => {
    const s = session(), opened = await open(s.call, 'opener');
    const ready = await s.call('chrome_wait', { tabId: opened.tabId, expression: 'document.readyState==="complete"' }); assert.equal(ready.ok, true, JSON.stringify(ready.error));
    await chrome('await chrome.tabs.update(values[0],{active:true})', opened.tabId);
    const clicked = await s.call('chrome_action', { tabId: opened.tabId, action: 'click', selector: '#popup' }); assert.equal(clicked.ok, true, JSON.stringify(clicked.error));
    const view = await until(async () => { const [group] = await f.service.groups.list(profileId); return group?.tabs.some(item => item.popup) ? group : undefined; }, '弹窗出现在组里');
    const popup = view.tabs.find(item => item.popup)!;
    const direct = await s.call('chrome_evaluate', { tabId: popup.tabId, expression: '1+1' }); assert.equal(direct.ok, true, JSON.stringify(direct.error));
    const joined = await s.call('chrome_claim_tab', { tabId: popup.tabId }); assert.equal(joined.ok, true); assert.equal((joined.data as any).group, undefined, '接管弹窗也不移动');
    assert.equal((await chrome<{ type: string }>('const t=await chrome.tabs.get(values[0]);return chrome.windows.get(t.windowId)', popup.tabId)).type, 'popup');
    await s.call('chrome_release_tab', { tabId: popup.tabId }); await plain('chrome_close_tab', { tabId: popup.tabId });
    s.end(); await until(async () => !(await groups()).length, '解散'); await plain('chrome_close_tab', { tabId: opened.tabId });
  });

  const refused = (result: any, code: string) => { assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.error.code, code, JSON.stringify(result.error)); assert.equal(result.error.outcome, 'not_dispatched'); assert.equal(result.operationId, undefined, '被拒绝的写操作不留操作记录'); };
  const wrote = (result: any) => assert.equal(result.ok, true, JSON.stringify(result.error));

  await t.test('写操作只能在本会话的标签页上，读不受限', async () => {
    const s = session(), outside = await open(plain, 'outside'), own = await open(s.call, 'own');
    wrote(await s.call('chrome_evaluate', { tabId: outside.tabId, expression: '1+1', readOnly: true }));
    wrote(await s.call('chrome_inspect', { tabId: outside.tabId }));
    refused(await s.call('chrome_evaluate', { tabId: outside.tabId, expression: 'document.title="改了"' }), 'TAB_OUTSIDE_GROUP');
    refused(await s.call('chrome_navigate', { tabId: outside.tabId, url: page('moved') }), 'TAB_OUTSIDE_GROUP');
    refused(await s.call('chrome_close_tab', { tabId: outside.tabId }), 'TAB_OUTSIDE_GROUP');
    assert.equal((await tab(outside.tabId)).groupId, -1); assert.doesNotMatch(String(((await plain('chrome_evaluate', { tabId: outside.tabId, expression: 'document.title' })).data)), /改了/);
    wrote(await s.call('chrome_evaluate', { tabId: own.tabId, expression: '1+1' }));
    wrote(await s.call('chrome_claim_tab', { tabId: outside.tabId })); wrote(await s.call('chrome_evaluate', { tabId: outside.tabId, expression: '1+1' }));
    wrote(await s.call('chrome_release_tab', { tabId: outside.tabId })); refused(await s.call('chrome_evaluate', { tabId: outside.tabId, expression: '1+1' }), 'TAB_OUTSIDE_GROUP');
    wrote(await s.call('chrome_release_tab', { tabId: own.tabId })); wrote(await s.call('chrome_evaluate', { tabId: own.tabId, expression: '1+1' }));
    wrote(await s.call('chrome_evaluate', { tabId: 2147483000, expression: '1' }).then(result => { assert.notEqual(result.error?.code, 'TAB_OUTSIDE_GROUP', '不存在的标签页报不存在'); return { ok: true }; }));
    wrote(await plain('chrome_evaluate', { tabId: outside.tabId, expression: '1+1' }));
    const pinned = await open(plain, 'pinned'); await chrome('await chrome.tabs.update(values[0],{pinned:true})', pinned.tabId);
    refused(await s.call('chrome_evaluate', { tabId: pinned.tabId, expression: '1+1' }), 'TAB_OUTSIDE_GROUP');
    wrote(await s.call('chrome_claim_tab', { tabId: pinned.tabId })); wrote(await s.call('chrome_evaluate', { tabId: pinned.tabId, expression: '1+1' }));
    const started = performance.now(); for (let i = 0; i < 100; i++) await f.service.broker.command(profileId, 'group.check', { tabId: own.tabId, owner: s.owner }); t.diagnostic(`group.check 平均 ${((performance.now() - started) / 100).toFixed(2)}ms`);
    s.end(); await until(async () => !(await groups()).length, '解散');
    for (const tabId of [outside.tabId, own.tabId, pinned.tabId]) await plain('chrome_close_tab', { tabId });
  });

  await t.test('另一个会话的标签组：写和接管都被拒绝，它结束后才能接管', async () => {
    const a = session(), b = session(), held = await open(a.call, 'held');
    refused(await b.call('chrome_evaluate', { tabId: held.tabId, expression: '1+1' }), 'TAB_OUTSIDE_GROUP');
    refused(await b.call('chrome_claim_tab', { tabId: held.tabId }), 'TAB_CLAIMED');
    a.end(); await until(async () => !(await groups()).length, '解散');
    const taken = await b.call('chrome_claim_tab', { tabId: held.tabId }); wrote(taken); assert.ok((taken.data as any).group, '进了 b 的组');
    b.end(); await until(async () => !(await groups()).length, '解散'); await plain('chrome_close_tab', { tabId: held.tabId });
  });

  await t.test('用户拖走算收回：占用解除，不能写也不能再接管，拖回来恢复', async () => {
    const s = session(), own = await open(s.call, 'own'), user = await open(plain, 'user');
    wrote(await s.call('chrome_claim_tab', { tabId: user.tabId })); assert.equal(f.service.broker.leaseSnapshot().length, 1);
    await chrome('await chrome.tabs.ungroup(values[0])', user.tabId);
    await until(async () => !f.service.broker.leaseSnapshot().length, '占用解除');
    refused(await s.call('chrome_evaluate', { tabId: user.tabId, expression: '1+1' }), 'TAB_TAKEN_BACK');
    refused(await s.call('chrome_claim_tab', { tabId: user.tabId }), 'TAB_TAKEN_BACK');
    wrote(await s.call('chrome_evaluate', { tabId: user.tabId, expression: '1+1', readOnly: true }));
    await chrome('await chrome.tabs.ungroup(values[0])', own.tabId);
    await until(async () => (await s.call('chrome_evaluate', { tabId: own.tabId, expression: '1+1' })).error?.code === 'TAB_TAKEN_BACK', 'Agent 自己开的也能收回');
    assert.equal((await groups()).length, 0, '最后一个标签页被拖走，组没了');
    assert.deepEqual(await f.service.groups.list(profileId), []);
    refused(await s.call('chrome_claim_tab', { tabId: own.tabId }), 'TAB_TAKEN_BACK');
    s.end(); await sleep(300);
    assert.deepEqual(await chrome('return (await chrome.storage.local.get("agentReturned")).agentReturned'), {}, '会话结束时清掉');
    for (const tabId of [own.tabId, user.tabId]) await plain('chrome_close_tab', { tabId });
  });

  await t.test('拖回组里恢复；拖进组不算授权，接管后才算', async () => {
    const s = session(), own = await open(s.call, 'own'), keep = await open(s.call, 'keep'), groupId = own.group!.groupId, user = await open(plain, 'dragged');
    await chrome('await chrome.tabs.ungroup(values[0])', own.tabId);
    await until(async () => (await s.call('chrome_evaluate', { tabId: own.tabId, expression: '1+1' })).error?.code === 'TAB_TAKEN_BACK', '收回');
    await chrome('await chrome.tabs.group({tabIds:[values[0]],groupId:values[1]})', own.tabId, groupId);
    await until(async () => (await s.call('chrome_evaluate', { tabId: own.tabId, expression: '1+1' })).ok, '拖回来恢复');
    await chrome('await chrome.tabs.group({tabIds:[values[0]],groupId:values[1]})', user.tabId, groupId); await sleep(200);
    refused(await s.call('chrome_evaluate', { tabId: user.tabId, expression: '1+1' }), 'TAB_OUTSIDE_GROUP');
    wrote(await s.call('chrome_claim_tab', { tabId: user.tabId })); wrote(await s.call('chrome_evaluate', { tabId: user.tabId, expression: '1+1' }));
    s.end(); await until(async () => !(await groups()).length, '解散');
    for (const tabId of [own.tabId, keep.tabId, user.tabId]) await plain('chrome_close_tab', { tabId });
  });

  await t.test('组里页面打开的链接自动算这个会话的', async () => {
    const s = session(), opened = await open(s.call, 'links');
    wrote(await s.call('chrome_wait', { tabId: opened.tabId, expression: 'document.readyState==="complete"' }));
    await chrome('await chrome.tabs.update(values[0],{active:true})', opened.tabId);
    wrote(await s.call('chrome_action', { tabId: opened.tabId, action: 'click', selector: '#link' }));
    const view = await until(async () => { const [group] = await f.service.groups.list(profileId); return group && group.tabs.length > 1 ? group : undefined; }, '链接进组');
    const linked = view.tabs.find(item => item.tabId !== opened.tabId)!;
    await until(async () => (await s.call('chrome_evaluate', { tabId: linked.tabId, expression: '1+1' })).ok, '不用接管就能写');
    s.end(); await until(async () => !(await groups()).length, '解散');
    for (const tabId of [opened.tabId, linked.tabId]) await plain('chrome_close_tab', { tabId });
  });

  await t.test('新标签页开在组所在窗口；别的窗口的标签页在原窗口建组', async () => {
    const s = session(), first = await open(s.call, 'first');
    const other = await chrome<{ id: number; tabs: { id: number }[] }>('return chrome.windows.create({url:"about:blank",focused:true})');
    const next = await open(s.call, 'next'); assert.equal(next.windowId, first.windowId); assert.equal(next.group?.groupId, first.group!.groupId);
    const held = await s.call('chrome_claim_tab', { tabId: other.tabs[0]!.id }); assert.equal(held.ok, true, JSON.stringify(held.error));
    const second = (held.data as any).group; assert.ok(second); assert.notEqual(second.groupId, first.group!.groupId, '不跨窗口搬');
    assert.equal((await tab(other.tabs[0]!.id)).windowId, other.id, '原窗口还在');
    s.end(); await until(async () => !(await groups()).length, '两个组都解散');
    await chrome('await chrome.windows.remove(values[0])', other.id);
    for (const tabId of [first.tabId, next.tabId]) await plain('chrome_close_tab', { tabId });
  });

  await t.test('页面上结束并释放：解除占用，通知不进用户事件', async () => {
    const s = session(), user = await open(plain, 'held'), held = await s.call('chrome_claim_tab', { tabId: user.tabId }); assert.equal(held.ok, true);
    const groupId = (held.data as any).group.groupId as number, extensionId = new URL(worker.url()).host;
    const options = await browser.newPage(); await options.goto(`chrome-extension://${extensionId}/options.html`);
    const reply = await options.evaluate(id => (globalThis as any).chrome.runtime.sendMessage({ type: 'group.release', groupId: id }), groupId); await options.close();
    assert.deepEqual(reply, { released: true });
    await until(async () => !f.service.broker.leaseSnapshot().length, '占用解除'); assert.equal((await tab(user.tabId)).groupId, -1);
    const events = await s.call('chrome_events', { limit: 100 }); assert.ok(!JSON.stringify(events.data).includes('group.released'));
    const shown = await f.service.groups.show(profileId, groupId); assert.deepEqual(shown, { shown: false }, '组已经没了');
    s.end(); await plain('chrome_close_tab', { tabId: user.tabId });
  });

  await t.test('客户端断线重连换了会话：同一个 Agent 原来的标签页写时自动接回；换了网站或别的 Agent 的不接回，报错写明原来属于谁', async () => {
    const first = session(), opened = await open(first.call, 'resume'), claimed = await open(plain, 'resume-claimed');
    wrote(await first.call('chrome_claim_tab', { tabId: claimed.tabId }));
    const moved = await open(first.call, 'resume-moved');
    first.end();
    await until(async () => !(await groups()).length, '会话结束后组解散');
    await plain('chrome_navigate', { tabId: moved.tabId, url: `http://localhost:${port}/elsewhere` });
    const second = session();
    const resumed = await second.call('chrome_evaluate', { tabId: opened.tabId, expression: 'document.title="接回"' });
    wrote(resumed); assert.equal(resumed.warnings?.[0]?.code, 'TAB_REJOINED', JSON.stringify(resumed.warnings)); assert.match(resumed.warnings[0].message, /已自动接回/);
    const [group] = await groups(); assert.ok(group); assert.equal((await tab(opened.tabId)).groupId, group.id, '进了新会话的组');
    wrote(await second.call('chrome_evaluate', { tabId: opened.tabId, expression: '1+1' })); assert.equal((await second.call('chrome_evaluate', { tabId: opened.tabId, expression: '2' })).warnings, undefined, '只提示一次');
    const back = await second.call('chrome_evaluate', { tabId: claimed.tabId, expression: '1+1' });
    wrote(back); assert.equal(back.warnings?.[0]?.code, 'TAB_REJOINED');
    assert.equal((await tab(claimed.tabId)).groupId, group.id, '接管来的也接回（结束时照样放回原位）');
    const elsewhere = await second.call('chrome_evaluate', { tabId: moved.tabId, expression: '1+1' });
    refused(elsewhere, 'TAB_OUTSIDE_GROUP'); assert.match(elsewhere.error!.message, /本 Agent 已结束的会话.*换到了别的网站/);
    // 别的 Agent：报错写明原来是谁的，不自动拿走。
    const grant = f.service.state.createClient('另一个 Agent', '*'), other = f.service.state.authenticate(grant.token)!, sessionId = randomUUID(), owner = `${other.id}:mcp:${sessionId}`;
    f.service.presence.heartbeat(other, { sessionId, owner, clientInfo: { name: 'other', version: '1' } });
    const third = session(), left = await open(third.call, 'resume-left'); third.end();
    await until(async () => (await groups()).every(item => item.id === group.id), '第三个会话的组解散');
    const foreign = await f.service.invoke('chrome_evaluate', { profileId, tabId: left.tabId, expression: '1+1' }, owner, other);
    refused(foreign, 'TAB_OUTSIDE_GROUP'); assert.match(foreign.error!.message, new RegExp(`另一个 Agent「${adminPrincipal.label}」`));
    f.service.presence.remove(other, { sessionId, owner });
    second.end();
    await until(async () => !(await groups()).length, '第二个会话的组解散');
    for (const tabId of [opened.tabId, claimed.tabId, moved.tabId, left.tabId]) await plain('chrome_close_tab', { tabId });
  });

  await t.test('服务端对账：会话消失后解散，第一轮不动', async () => {
    const s = session(), opened = await open(s.call, 'crash');
    await f.service.groups.reconcile(); assert.equal((await groups()).length, 1, '会话活着');
    (f.service.presence as any).sessions.clear();
    await f.service.groups.reconcile(); assert.equal((await groups()).length, 1, '第一轮只记下');
    await f.service.groups.reconcile(); await until(async () => !(await groups()).length, '第二轮解散');
    await plain('chrome_close_tab', { tabId: opened.tabId });
  });
});
