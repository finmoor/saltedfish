import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fixture, fakeProfile } from './helpers.js';

// 永不再连接的配置（重建了配置 ID、卸载重装扩展、删除了 Chrome 配置）上的 unknown 不能把管理页永远卡在“有操作需要先核查”：
// 管理员可以明确声明放弃——先预览、再带着看到的数量二次确认，只改数据库，不碰浏览器。
// 常规保护不变：配置只是暂时离线时，chrome_recover_operation 仍要求先回到原配置核查页面。
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function until(predicate: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
const admin = (f: Fixture) => ({ authorization: `Bearer ${f.config.token}` });
const base = (f: Fixture) => `http://127.0.0.1:${f.config.port}`;
const preview = (f: Fixture, profileId: string, headers: Record<string, string> = admin(f)) => fetch(`${base(f)}/profiles/abandon?profileId=${profileId}`, { headers });
const abandon = (f: Fixture, body: Record<string, unknown>, headers: Record<string, string> = admin(f)) => fetch(`${base(f)}/profiles/abandon`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
// 一个已经离开的配置，名下有一条带标签页、一条无标签页的待核查记录
async function goneProfile(f: Fixture) {
  const profile = await fakeProfile(f.config, '旧配置');
  const tabbed = f.service.state.begin(profile.id, 7, 'agent', 'chrome_evaluate'); f.service.state.finish(tabbed, 'unknown', 'COMMAND_TIMEOUT');
  const tabless = f.service.state.begin(profile.id, undefined, 'agent', 'chrome_new_tab'); f.service.state.finish(tabless, 'unknown', 'COMMAND_TIMEOUT');
  const closed = once(profile.socket, 'close'); profile.socket.close(); await closed; await until(() => f.service.broker.profiles.size === 0);
  return { id: profile.id, tabbed, tabless };
}

test('常规保护不变：配置暂时离线时不能确认它的未知操作，错误里指明了配置已不存在时的出路', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const gone = await goneProfile(f);
  for (const operationId of [gone.tabbed, gone.tabless]) {
    const refused = await f.service.invoke('chrome_recover_operation', { operationId, acknowledged: true }, 'dashboard:test');
    assert.equal(refused.error?.code, 'PROFILE_OFFLINE'); assert.equal(refused.error?.outcome, 'not_dispatched');
    assert.match(refused.error!.message, /暂时离线/); assert.match(refused.error!.message, /已经不存在/); assert.match(refused.error!.message, /POST \/profiles\/abandon/);
  }
  assert.equal(f.service.state.protection().unknown, 2);
});

test('预览列出要放弃的记录和最后在线时间；放弃需要管理员、需要看到的数量、需要显式确认', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const gone = await goneProfile(f);
  const shown = await (await preview(f, gone.id)).json() as any;
  assert.equal(shown.online, false); assert.equal(shown.canAbandon, true); assert.equal(shown.label, '旧配置'); assert.equal(shown.unknown, 2); assert.equal(shown.running, 0);
  assert.equal(typeof shown.lastSeen, 'string'); assert.deepEqual(shown.operations.map((item: { id: string }) => item.id).sort(), [gone.tabbed, gone.tabless].sort());
  assert.ok(shown.operations.every((item: object) => !('owner' in item)), '预览不外露调用方 owner');
  // 非管理员（本机普通客户端）既看不到预览也不能放弃：路由对它们不存在
  const client = f.service.state.createClient('普通客户端'), headers = { authorization: `Bearer ${client.token}` };
  assert.equal((await preview(f, gone.id, headers)).status, 404);
  assert.equal((await abandon(f, { profileId: gone.id, expectedUnknown: 2, confirm: true }, headers)).status, 404);
  assert.equal((await fetch(`${base(f)}/profiles/abandon?profileId=${gone.id}`)).status, 401);
  // 缺少确认、数量对不上：都不改任何东西
  assert.equal((await abandon(f, { profileId: gone.id, expectedUnknown: 2 })).status, 400);
  const stale = await abandon(f, { profileId: gone.id, expectedUnknown: 1, confirm: true });
  assert.equal(stale.status, 400); assert.equal(((await stale.json()) as any).error.code, 'ABANDON_COUNT_CHANGED');
  assert.equal(f.service.state.protection().unknown, 2);
  assert.equal(f.service.listProfiles().some(profile => profile.id === gone.id), true);
});

test('放弃：一次确认该配置全部未知操作并从列表移除，管理页汇总归零；之后它重新连接仍可正常使用', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const gone = await goneProfile(f);
  // 名下遗留的隔离和租约一并释放
  const broker = f.service.broker as unknown as { quarantined: Set<string> };
  f.service.broker.claim(gone.id, 7, 'someone', 600); broker.quarantined.add(`${gone.id}:7`);
  const done = await abandon(f, { profileId: gone.id, expectedUnknown: 2, confirm: true });
  assert.equal(done.status, 200);
  assert.deepEqual(await done.json(), { abandoned: true, profileId: gone.id, acknowledged: 2, forgotten: true, replayed: false });
  assert.equal(f.service.state.protection().unknown, 0); assert.equal(f.service.state.protection().profiles.length, 0);
  assert.equal(f.service.listProfiles().some(profile => profile.id === gone.id), false);
  assert.equal(f.service.broker.stats().leases, 0); assert.equal(f.service.broker.stats().quarantinedTabs, 0);
  assert.equal(f.service.state.list(gone.id, 'unknown', 0, 10).total, 2, '操作记录本身保留，只是已确认');
  assert.equal(((await (await fetch(`${base(f)}/dashboard`, { headers: admin(f) })).json()) as any).protection.unknown, 0);
  // 再放弃一次：没有可放弃的了，无害
  const again = await (await abandon(f, { profileId: gone.id, expectedUnknown: 0, confirm: true })).json() as { abandoned: boolean; acknowledged: number; forgotten: boolean };
  assert.deepEqual([again.abandoned, again.acknowledged, again.forgotten], [true, 0, false]);
  // 同一个配置 ID 之后重新连接：重新登记，写入不被任何残留拦住
  let evaluated = 0;
  const back = await fakeProfile(f.config, '回来了', command => { if (command.operation === 'page.evaluate') evaluated++; return {}; }, gone.id);
  assert.equal(back.handshake.type, 'ready');
  assert.equal((await f.service.invoke('chrome_evaluate', { profileId: gone.id, tabId: 7, expression: '1' }, 'agent')).ok, true); assert.equal(evaluated, 1);
});

test('在线的配置不能放弃（要回到页面核查）；仍有运行中的操作也不能放弃；两种拒绝都不改任何东西', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const online = await fakeProfile(f.config, '在线配置');
  const lost = f.service.state.begin(online.id, 3, 'agent', 'chrome_evaluate'); f.service.state.finish(lost, 'unknown', 'COMMAND_TIMEOUT');
  const shown = await (await preview(f, online.id)).json() as any;
  assert.equal(shown.online, true); assert.equal(shown.canAbandon, false);
  const refused = await abandon(f, { profileId: online.id, expectedUnknown: 1, confirm: true });
  assert.equal(refused.status, 400); assert.equal(((await refused.json()) as any).error.code, 'PROFILE_ONLINE');
  assert.equal(f.service.state.protection().unknown, 1);
  // 离线后，还有一个运行中的操作（刚发出、尚未完成）
  const closed = once(online.socket, 'close'); online.socket.close(); await closed; await until(() => f.service.broker.profiles.size === 0);
  const running = f.service.state.begin(online.id, 4, 'agent', 'chrome_evaluate');
  assert.equal(((await (await preview(f, online.id)).json()) as any).canAbandon, false);
  const blocked = await abandon(f, { profileId: online.id, expectedUnknown: 1, confirm: true });
  assert.equal(((await blocked.json()) as any).error.code, 'OPERATION_RUNNING'); assert.equal(f.service.state.protection().unknown, 1);
  f.service.state.finish(running, 'unknown', 'SERVICE_RESTARTED');
  assert.equal((await abandon(f, { profileId: online.id, expectedUnknown: 2, confirm: true })).status, 200);
});

test('预览一个完全不存在的配置：PROFILE_NOT_FOUND', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const missing = await preview(f, randomUUID());
  assert.equal(missing.status, 400); assert.equal(((await missing.json()) as any).error.code, 'PROFILE_NOT_FOUND');
});

test('管理页汇总（/dashboard）里每个待核查的配置带上在线状态、名称和最后在线时间，分得清暂时离线和很久没出现', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const gone = await goneProfile(f);
  const live = await fakeProfile(f.config, '在线配置');
  const lost = f.service.state.begin(live.id, 3, 'agent', 'chrome_evaluate'); f.service.state.finish(lost, 'unknown', 'COMMAND_TIMEOUT');
  const { protection } = await (await fetch(`${base(f)}/dashboard`, { headers: admin(f) })).json() as { protection: { unknown: number; profiles: Array<{ profileId: string; unknown: number; running: number; online: boolean; label?: string; lastSeen?: string }> } };
  assert.equal(protection.unknown, 3);
  const entry = (id: string) => protection.profiles.find(item => item.profileId === id)!;
  assert.deepEqual([entry(gone.id).online, entry(gone.id).label, entry(gone.id).unknown], [false, '旧配置', 2]); assert.equal(typeof entry(gone.id).lastSeen, 'string');
  assert.deepEqual([entry(live.id).online, entry(live.id).label, entry(live.id).unknown], [true, '在线配置', 1]); assert.equal(typeof entry(live.id).lastSeen, 'string');
});

test('配置断开时记下最后在线时间（之前只在连接和改名时更新）', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const profile = await fakeProfile(f.config, '记录最后在线');
  const lastSeen = () => f.service.state.knownProfiles().find(item => item.id === profile.id)!.lastSeen;
  const connected = lastSeen(); await new Promise(resolve => setTimeout(resolve, 30));
  const closed = once(profile.socket, 'close'); profile.socket.close(); await closed; await until(() => f.service.broker.profiles.size === 0);
  await until(() => lastSeen() > connected);
  assert.ok(Date.parse(lastSeen()) > Date.parse(connected));
});
