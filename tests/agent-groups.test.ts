import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AgentGroups, groupColor, groupTitle } from '../src/agent-groups.js';
import { AgentPresence } from '../src/agent-presence.js';
import { CAPABILITY, errorInfo } from '../src/shared.js';
import type { Principal } from '../src/auth.js';

const principal = (id: string): Principal => ({ id, label: `Agent ${id}`, profiles: '*', readOnly: false, admin: false });
function harness(capabilities: string[] = [CAPABILITY.tabGroupsV1]) {
  const calls: [string, string, any][] = [], released: [string, number, string][] = [];
  const replies: Record<string, unknown> = { 'group.join': { grouped: true, groupId: 5, title: 'Agent a' }, 'group.dissolve': [], 'group.list': [], 'group.window': { windowId: 9 }, 'group.check': { member: true } };
  const leases = new Map<number, string>();
  const broker: any = {
    profiles: new Map([['p', { info: { capabilities } }]]),
    async command(profileId: string, operation: string, args: unknown) {
      calls.push([profileId, operation, args]);
      const reply = replies[operation];
      if (reply instanceof Error) throw reply;
      return reply;
    },
    release(profileId: string, tabId: number, owner: string) { released.push([profileId, tabId, owner]); if (tabId === 13) throw new Error('别人的占用'); return { released: true }; },
    holder: (_: string, tabId: number) => leases.get(tabId),
    leaseSnapshot: () => [...leases].map(([tabId, owner]) => ({ profileId: 'p', tabId, owner, expires: Infinity })),
  };
  const a = principal('a'), presence = new AgentPresence(id => (id === 'a' ? a : undefined)), groups = new AgentGroups(broker, presence), sessionId = randomUUID(), owner = 'a:mcp:' + sessionId;
  const start = () => presence.heartbeat(a, { sessionId, owner, clientInfo: { name: 'codex', version: '1' } });
  const end = () => presence.remove(a, { sessionId, owner });
  return { a, broker, calls, released, replies, leases, presence, groups, owner, sessionId, start, end, sent: (name: string) => calls.filter(call => call[1] === name) };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('组标题只有 Agent 名字且不超长，同一个 Agent 颜色固定', () => {
  assert.equal(groupColor('abc'), groupColor('abc'));
  assert.ok(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(groupColor)).size > 1);
  assert.equal(groupTitle('  Claude Code '), 'Claude Code');
  assert.equal([...groupTitle('很长的名字'.repeat(10))].length, 24);
  assert.equal(groupTitle('   '), 'Agent');
});

test('只有 MCP 会话进组：任务和普通 RPC 不建组', async t => {
  const h = harness(); t.after(() => h.groups.close());
  assert.equal(await h.groups.join(h.a, h.owner, 'p', 1, false), undefined);
  h.start();
  assert.equal(await h.groups.join(h.a, h.owner + ':task:1', 'p', 1, false), undefined);
  assert.equal(h.sent('group.join').length, 0);
  assert.deepEqual(await h.groups.join(h.a, h.owner, 'p', 1, true), { grouped: true, group: { groupId: 5, title: 'Agent a' } });
  assert.deepEqual(h.sent('group.join')[0]![2], { tabId: 1, owner: h.owner, agentId: 'a', title: 'Agent a', color: groupColor('a'), claimed: true });
  assert.equal(await h.groups.windowOf(h.a, h.owner, 'p'), 9);
});

test('旧扩展不发命令；会话的标签页进不了组不抛错，说明原因', async t => {
  const old = harness([]); t.after(() => old.groups.close());
  old.start();
  assert.equal(await old.groups.join(old.a, old.owner, 'p', 1, false), undefined);
  assert.equal(await old.groups.windowOf(old.a, old.owner, 'p'), undefined);
  assert.deepEqual(await old.groups.list(), []);
  assert.equal(old.calls.length, 0);
  const broken = harness(); t.after(() => broken.groups.close());
  broken.start(); broken.replies['group.join'] = new Error('Tabs cannot be edited right now');
  assert.deepEqual(await broken.groups.join(broken.a, broken.owner, 'p', 1, false), { grouped: false, reason: '扩展没有响应' });
  broken.replies['group.join'] = { grouped: false, reason: 'pinned' };
  assert.deepEqual(await broken.groups.join(broken.a, broken.owner, 'p', 1, false), { grouped: false, reason: '固定的标签页' });
  broken.replies['group.list'] = new Error('超时');
  assert.deepEqual(await broken.groups.list(), []);
});

test('会话结束解散组并释放占用；别人的占用不动', async t => {
  const h = harness(); t.after(() => h.groups.close());
  h.start(); h.replies['group.dissolve'] = [{ owner: h.owner, tabIds: [12, 13] }];
  h.end(); await flush();
  assert.deepEqual(h.sent('group.dissolve').map(call => call[2]), [{ owner: h.owner }]);
  assert.deepEqual(h.released, [['p', 12, h.owner], ['p', 13, h.owner]]);
});

test('会话结束时没进组的占用也解除，别人的不动', async t => {
  const h = harness(); t.after(() => h.groups.close());
  h.start(); h.leases.set(21, h.owner); h.leases.set(22, 'a:mcp:other');
  h.end(); await flush();
  assert.deepEqual(h.released, [['p', 21, h.owner]]);
});

test('用户在扩展里释放时，后台发来的通知也解除占用', t => {
  const h = harness(); t.after(() => h.groups.close());
  h.broker.onGroupReleased('p', h.owner, [4]);
  assert.deepEqual(h.released, [['p', 4, h.owner]]);
});

test('对账连续两轮看不到会话才解散，中间恢复心跳就不算结束', async t => {
  const h = harness(); t.after(() => h.groups.close());
  const record = { groupId: 5, windowId: 1, owner: h.owner, agentId: 'a', title: 'x', startedAt: 'x', tabs: [] };
  h.replies['group.list'] = [record];
  await h.groups.reconcile(); assert.equal(h.sent('group.dissolve').length, 0);
  h.start(); await h.groups.reconcile(); assert.equal(h.sent('group.dissolve').length, 0, '心跳回来了');
  h.end(); h.calls.length = 0; await flush(); h.calls.length = 0;
  await h.groups.reconcile(); assert.equal(h.sent('group.dissolve').length, 0, '第一轮只记下');
  await h.groups.reconcile(); assert.equal(h.sent('group.dissolve').length, 1, '第二轮才解散');
});

test('列表拼上会话信息，不带完整 owner', async t => {
  const h = harness(); t.after(() => h.groups.close());
  h.start(); const stop = h.presence.observe(h.a, h.owner, 'chrome_action', 'p', 1);
  h.replies['group.list'] = [{ groupId: 5, windowId: 1, owner: h.owner, agentId: 'a', title: 'Agent a', startedAt: 'now', color: 'red', tabs: [{ tabId: 1, title: '订单', active: true }, { tabId: 2, title: '登录', active: false, popup: true }] }, { groupId: 6, windowId: 1, owner: 'a:mcp:ffffff99', agentId: 'a', title: 'Agent a', startedAt: 'now', tabs: [] }];
  const [online, offline] = await h.groups.list('p'); stop();
  assert.equal(online!.online, true); assert.equal(online!.working, true); assert.equal(online!.sessionId, h.sessionId.slice(0, 6)); assert.equal(online!.session?.client, 'codex');
  assert.equal(online!.tabs[0]!.operation, 'chrome_action'); assert.equal(online!.tabs[1]!.operation, undefined); assert.equal(online!.profileId, 'p');
  assert.equal(offline!.online, false); assert.equal(offline!.working, false); assert.equal(offline!.sessionId, 'ffffff');
  assert.ok(!JSON.stringify(online).includes(h.sessionId), '完整会话 ID 不进页面');
});

test('页面上的结束并释放同样解除占用，浏览器离线时报错', async t => {
  const h = harness(); t.after(() => h.groups.close());
  h.replies['group.dissolve'] = [{ owner: h.owner, tabIds: [12] }];
  assert.deepEqual(await h.groups.release('p', 5), { released: true });
  assert.deepEqual(h.sent('group.dissolve')[0]![2], { groupId: 5 });
  assert.deepEqual(h.released, [['p', 12, h.owner]]);
  h.replies['group.dissolve'] = new Error('PROFILE_OFFLINE');
  await assert.rejects(h.groups.release('p', 5), /PROFILE_OFFLINE/);
});

test('写操作边界：只有本会话的标签页能写，拒绝时明确没有派发', async t => {
  const h = harness(); t.after(() => h.groups.close());
  const refused = (code: string) => (error: unknown) => { const info = errorInfo(error); return info.code === code && info.outcome === 'not_dispatched' && /未执行/.test(info.message); };
  await h.groups.assertWritable(h.a, h.owner, 'p', 1); assert.equal(h.sent('group.check').length, 0, '不是会话不查，任务和普通 RPC 不受限');
  h.start(); await h.groups.assertWritable(h.a, h.owner, 'p', 1); assert.deepEqual(h.sent('group.check')[0]![2], { tabId: 1, owner: h.owner });
  h.replies['group.check'] = { member: false, takenBack: false };
  await assert.rejects(h.groups.assertWritable(h.a, h.owner, 'p', 1), refused('TAB_OUTSIDE_GROUP'));
  h.leases.set(1, 'someone-else'); await assert.rejects(h.groups.assertWritable(h.a, h.owner, 'p', 1), refused('TAB_OUTSIDE_GROUP'));
  h.leases.set(1, h.owner); await h.groups.assertWritable(h.a, h.owner, 'p', 1);
  h.replies['group.check'] = { member: true, takenBack: true };
  await assert.rejects(h.groups.assertWritable(h.a, h.owner, 'p', 1), refused('TAB_TAKEN_BACK'), '用户收回的就算还占用着也不能写');
  await assert.rejects(h.groups.assertClaimable(h.a, h.owner, 'p', 1), refused('TAB_TAKEN_BACK'));
  h.replies['group.check'] = { missing: true }; await h.groups.assertWritable(h.a, h.owner, 'p', 1);
  h.replies['group.check'] = new Error('超时'); await h.groups.assertWritable(h.a, h.owner, 'p', 1);
});

test('旧扩展不查，写操作和原来一样', async t => {
  const old = harness([]); t.after(() => old.groups.close());
  old.start(); old.replies['group.check'] = { member: false };
  await old.groups.assertWritable(old.a, old.owner, 'p', 1); assert.equal(old.calls.length, 0);
});

test('别的会话组里的标签页不能接管，那个会话结束后可以', async t => {
  const h = harness(), other = randomUUID(), b = 'a:mcp:' + other; t.after(() => h.groups.close());
  h.start(); h.presence.heartbeat(h.a, { sessionId: other, owner: b });
  h.replies['group.check'] = { member: false, holder: b };
  await assert.rejects(h.groups.assertClaimable(h.a, h.owner, 'p', 1), (error: unknown) => errorInfo(error).code === 'TAB_CLAIMED' && errorInfo(error).outcome === 'not_dispatched');
  h.presence.remove(h.a, { sessionId: other, owner: b });
  await h.groups.assertClaimable(h.a, h.owner, 'p', 1);
});

test('关闭后不再收通知', t => {
  const h = harness(); h.groups.close(); t.after(() => undefined);
  assert.equal(h.presence.onEnded, undefined); assert.equal(h.broker.onGroupReleased, undefined);
});

test('断线重连后换了会话：同一个 Agent 原来会话的标签页没人占、还在原网站，写时自动接回；其他情况报错写明原来属于谁', async t => {
  const h = harness(); t.after(() => h.groups.close());
  const refused = (pattern: RegExp) => (error: unknown) => { const info = errorInfo(error); return info.code === 'TAB_OUTSIDE_GROUP' && info.outcome === 'not_dispatched' && pattern.test(info.message); };
  const endedAt = new Date(2026, 10, 3, 1, 5).toISOString();
  const former = (overrides: Record<string, unknown> = {}) => ({ owner: 'a:mcp:old', agentId: 'a', title: 'Agent a', endedAt, sameOrigin: true, claimed: true, ungrouped: true, pinned: false, ...overrides });
  h.start();
  h.replies['group.check'] = { member: false, former: former() };
  const note = await h.groups.assertWritable(h.a, h.owner, 'p', 1);
  assert.match(String(note), /已自动接回/); assert.match(String(note), /01:05/);
  assert.deepEqual(h.sent('group.join').at(-1)![2], { tabId: 1, owner: h.owner, agentId: 'a', title: 'Agent a', color: groupColor('a'), claimed: true }, '原来是接管来的，接回时也按接管放回原位');
  const joins = () => h.sent('group.join').length, before = joins();
  h.replies['group.check'] = { member: false, former: former({ sameOrigin: false }) };
  await assert.rejects(h.groups.assertWritable(h.a, h.owner, 'p', 1), refused(/本 Agent 已结束的会话.*换到了别的网站.*claim_tab/));
  h.replies['group.check'] = { member: false, former: former({ ungrouped: false }) };
  await assert.rejects(h.groups.assertWritable(h.a, h.owner, 'p', 1), refused(/没有自动接回/), '用户放进了自己的组，不自动拿走');
  h.replies['group.check'] = { member: false, former: former({ agentId: 'b', title: 'Agent b' }) };
  await assert.rejects(h.groups.assertWritable(h.a, h.owner, 'p', 1), refused(/另一个 Agent「Agent b」/));
  h.replies['group.check'] = { member: false, former: former() };
  h.leases.set(1, 'someone-else'); h.presence.heartbeat(h.a, { sessionId: randomUUID(), owner: 'someone-else' });
  await assert.rejects(h.groups.assertWritable(h.a, h.owner, 'p', 1), refused(/没有自动接回/), '别的会话正占用着');
  h.leases.delete(1);
  h.presence.heartbeat(h.a, { sessionId: 'old', owner: 'a:mcp:old' });
  await assert.rejects(h.groups.assertWritable(h.a, h.owner, 'p', 1), refused(/没有自动接回/), '原来的会话还活着（同一个 Agent 开了两个会话），不抢');
  assert.equal(joins(), before, '没接回的都不发 group.join');
  h.replies['group.check'] = { member: false, holder: 'b:mcp:x' };
  await assert.rejects(h.groups.assertWritable(h.a, h.owner, 'p', 1), refused(/另一个会话的标签组里/));
});
