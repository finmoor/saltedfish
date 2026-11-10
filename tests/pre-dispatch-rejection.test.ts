import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, fakeProfile } from './helpers.js';
import { adminPrincipal, type Principal } from '../src/auth.js';
import { BrowserError } from '../src/shared.js';
import type { Connection } from '../src/broker.js';

// 派发之前的拒绝不是“动作结果未知”：它们不能制造 unknown 记录，也不能隔离一个根本没碰过的标签页。
// 真正派发后的未知结果（超时、断线）仍然隔离，由 service.test.ts 的“超时写入只执行一次，必须显式恢复”守护。
async function until(predicate: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const evaluate = (f: Fixture, profileId: string, tabId: number, owner = 'agent-B') => f.service.invoke('chrome_evaluate', { profileId, tabId, expression: '1' }, owner);
const quarantined = (f: Fixture) => f.service.broker.stats().quarantinedTabs;

test('无标签页的写入在途时，对其他标签页的写入被明确拒绝，但不会把没碰过的标签页隔离；在途操作结束后立即可重试', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  let release!: () => void, evaluations = 0; const gate = new Promise<void>(resolve => { release = resolve; });
  const profile = await fakeProfile(f.config, 'A', async command => { if (command.operation === 'tabs.create') { await gate; return { tabId: 50 }; } if (command.operation === 'page.evaluate') evaluations++; return {}; });
  const creating = f.service.invoke('chrome_new_tab', { profileId: profile.id }, 'agent-A');
  await until(() => f.service.state.protection().running === 1);
  const refused = await evaluate(f, profile.id, 7);
  assert.equal(refused.error?.code, 'OPERATION_PENDING'); assert.equal(refused.error?.outcome, 'not_dispatched'); assert.equal(evaluations, 0);
  assert.equal(quarantined(f), 0, '被拒绝的写入没有碰过标签页，不能隔离它');
  release(); assert.equal((await creating).ok, true);
  const retry = await evaluate(f, profile.id, 7);
  assert.equal(retry.ok, true, JSON.stringify(retry.error)); assert.equal(evaluations, 1);
});

test('无标签页的 unknown 期间被拒绝的写入不留下隔离；管理员确认这条记录后，这些标签页立即恢复，管理页也没有遗留', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  let evaluations = 0;
  const profile = await fakeProfile(f.config, 'A', command => { if (command.operation === 'page.evaluate') evaluations++; return {}; });
  const lost = f.service.state.begin(profile.id, undefined, 'agent-A', 'chrome_new_tab'); f.service.state.finish(lost, 'unknown', 'COMMAND_TIMEOUT');
  for (const tabId of [3, 4]) {
    const blocked = await evaluate(f, profile.id, tabId);
    assert.equal(blocked.error?.code, 'RESULT_UNKNOWN', `tab ${tabId}`);
  }
  assert.equal(quarantined(f), 0, '拒绝本身不制造隔离');
  assert.equal(evaluations, 0);
  assert.equal((await f.service.invoke('chrome_recover_operation', { operationId: lost, acknowledged: true }, 'admin-owner')).ok, true);
  assert.equal(f.service.state.protection().unknown, 0);
  for (const tabId of [3, 4]) assert.equal((await evaluate(f, profile.id, tabId)).ok, true, `tab ${tabId} 确认后立即可写`);
  assert.equal(evaluations, 2);
});

test('隔离只是未知结果的内存镜像：数据库里已没有待核查记录的陈旧隔离会自动撤销；真实的未知结果仍然拦住写入', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const profile = await fakeProfile(f.config, 'A');
  const set = (f.service.broker as unknown as { quarantined: Set<string> }).quarantined;
  set.add(`${profile.id}:3`);
  assert.equal((await evaluate(f, profile.id, 3)).ok, true, '没有对应的待核查记录，陈旧隔离不再拦人');
  assert.equal(quarantined(f), 0);
  // 对照：同一个标签页上有未确认的 unknown 记录时，隔离照常生效，直到记录被确认
  const real = f.service.state.begin(profile.id, 3, 'agent-A', 'chrome_evaluate'); f.service.state.finish(real, 'unknown', 'COMMAND_TIMEOUT'); set.add(`${profile.id}:3`);
  assert.equal((await evaluate(f, profile.id, 3)).error?.code, 'RESULT_UNKNOWN'); assert.equal(quarantined(f), 1, '真实的未知结果保持隔离');
  assert.equal((await f.service.invoke('chrome_recover_tab', { profileId: profile.id, tabId: 3 }, 'admin-owner')).ok, true);
  assert.equal((await evaluate(f, profile.id, 3)).ok, true);
});

test('操作日志写不进去时业务命令没有发出：明确未派发，不隔离标签页，存储恢复后立即可写', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  let evaluations = 0;
  const profile = await fakeProfile(f.config, 'A', command => { if (command.operation === 'page.evaluate') evaluations++; return {}; });
  const begin = f.service.state.begin.bind(f.service.state);
  f.service.state.begin = () => { throw new Error('fixture SQLITE_FULL'); };
  const failed = await evaluate(f, profile.id, 7);
  assert.equal(failed.error?.code, 'OPERATION_JOURNAL_FAILED'); assert.equal(failed.error?.outcome, 'not_dispatched'); assert.equal(failed.error?.phase, 'precondition');
  assert.equal(evaluations, 0); assert.equal(quarantined(f), 0);
  f.service.state.begin = begin;
  assert.equal((await evaluate(f, profile.id, 7)).ok, true); assert.equal(evaluations, 1);
});

// ---- SEC-01：授权复查在焦点模拟等待之后、派发之前 ----
// 复查的位置不变（它正是“撤销后不得首次派发”的保护），变的是分类：此时业务命令还没有发出，记录为 failed、响应为 not_dispatched，不制造 unknown、不隔离标签页。
async function focusRace(t: { after: (callback: () => Promise<void>) => void }, revoke: (f: Fixture, profileId: string, principal: Principal) => void, makePrincipal: (f: Fixture) => Principal, expectedConnection = false) {
  const f = await fixture(); t.after(() => f.cleanup());
  const seen: string[] = []; let focusRequested!: () => void, releaseFocus!: () => void;
  const requested = new Promise<void>(resolve => { focusRequested = resolve; }), hold = new Promise<void>(resolve => { releaseFocus = resolve; });
  const profile = await fakeProfile(f.config, 'A', async command => {
    const enabled = (command.args.params as { enabled?: boolean } | undefined)?.enabled;
    seen.push(command.operation === 'page.cdp' ? `focus:${enabled}` : command.operation);
    if (command.operation === 'page.cdp' && enabled === true) { focusRequested(); await hold; }
    return {};
  });
  const principal = makePrincipal(f), connection = f.service.broker.profiles.get(profile.id) as Connection;
  const click = f.service.invoke('chrome_action', { profileId: profile.id, tabId: 7, action: 'click', x: 10, y: 10 }, `${principal.id}:race`, principal, expectedConnection ? connection : undefined);
  await requested; revoke(f, profile.id, principal); releaseFocus();
  return { f, profile, seen, result: await click };
}
function assertSettled({ f, seen, result }: Awaited<ReturnType<typeof focusRace>>, code: string, focusReturned = true) {
  assert.equal(result.ok, false); assert.equal(result.error?.code, code); assert.equal(result.error?.outcome, 'not_dispatched'); assert.equal(result.error?.phase, 'precondition');
  assert.ok(!seen.includes('page.action'), '业务命令没有发给扩展（撤销之后不得首次派发）');
  assert.deepEqual(seen.filter(item => item.startsWith('focus:')), focusReturned ? ['focus:true', 'focus:false'] : ['focus:true'], focusReturned ? '焦点模拟照常开启并归还' : '连接已换，归还命令也不会发给新连接');
  assert.equal(f.service.state.get(result.operationId!)!.state, 'failed', '操作记录是 failed，不是 unknown');
  assert.equal(f.service.state.protection().unknown, 0); assert.equal(quarantined(f), 0);
}
test('焦点模拟等待期间撤销客户端：动作没有派发，记为 failed，不制造 unknown、不隔离标签页，其他调用方随即可以写这个标签页', async t => {
  const created: { id?: string } = {};
  const race = await focusRace(t, f => { f.service.state.revokeClient(created.id!); }, f => { const key = f.service.state.createClient('撤销者'); created.id = key.id; return f.service.state.authenticate(key.token)!; });
  assertSettled(race, 'CLIENT_AUTHORIZATION_FAILED');
  assert.equal((await evaluate(race.f, race.profile.id, 7, 'someone-else')).ok, true);
});
test('焦点模拟等待期间远程授权失效（断线重连）：同样是未派发的 failed，不隔离', async t => {
  const race = await focusRace(t, (f, _profile, principal) => { f.service.state.remotePrincipals.delete(principal.id); }, f => {
    const principal: Principal = { id: 'remote:instance:agent', submissionScope: 'remote-submission:test', remoteAgentId: 'agent', label: '远程 · test', admin: false, profiles: '*', readOnly: false };
    f.service.state.remotePrincipals.set(principal.id, principal); return principal;
  });
  assertSettled(race, 'REMOTE_CONNECTION_CHANGED');
});
test('焦点模拟等待期间浏览器连接被替换（任务绑定的连接变了）：同样是未派发的 failed，不隔离', async t => {
  const race = await focusRace(t, (f, profileId) => { const original = f.service.broker.profiles.get(profileId)!; f.service.broker.profiles.set(profileId, { ...original, info: { ...original.info } }); }, () => adminPrincipal, true);
  assertSettled(race, 'CONNECTION_CHANGED', false);
  assert.equal(race.result.warnings?.[0]?.code, 'FOCUS_CLEANUP_FAILED');
});

test('对照：撤销发生在派发之后，才是真正的未知结果，仍然隔离（保护没有被放松）', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const profile = await fakeProfile(f.config, 'A', async command => { if (command.operation === 'page.evaluate') await new Promise(resolve => setTimeout(resolve, 1400)); return {}; });
  const timed = await f.service.invoke('chrome_evaluate', { profileId: profile.id, tabId: 7, expression: 'submit()', timeoutMs: 100 }, 'agent-A');
  assert.equal(timed.error?.code, 'COMMAND_TIMEOUT'); assert.equal(timed.error?.outcome, 'unknown');
  assert.equal(f.service.state.get(timed.operationId!)!.state, 'unknown'); assert.equal(quarantined(f), 1);
  assert.equal((await evaluate(f, profile.id, 7)).error?.code, 'RESULT_UNKNOWN');
});

test('broker.command 在发给扩展之前的拒绝（离线、连接已换、协调容量）都带 not_dispatched', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const profile = await fakeProfile(f.config, 'A', undefined, undefined, { capabilities: ['dialog-control'] });
  const original = f.service.broker.profiles.get(profile.id)!;
  const reject = async (action: () => Promise<unknown>, code: string) => { await assert.rejects(action, (error: unknown) => { const e = error as BrowserError; assert.equal(e.code, code); assert.equal(e.details.outcome, 'not_dispatched'); assert.equal(e.details.phase, 'precondition'); return true; }); };
  await reject(() => f.service.broker.command(profile.id, 'page.evaluate', { tabId: 1 }, 1000, { ...original } as Connection), 'CONNECTION_CHANGED');
  (f.service.broker as unknown as { controllers: Map<string, unknown> }).controllers = new Map(Array.from({ length: 4096 }, (_, index) => [String(index), {}]));
  await reject(() => f.service.broker.command(profile.id, 'page.evaluate', { tabId: 1 }, 1000, undefined, { principalId: 'p', owner: 'o' }), 'CONTROLLER_CAPACITY');
  await reject(() => f.service.broker.command('missing-profile', 'page.evaluate', { tabId: 1 }), 'PROFILE_OFFLINE');
});
