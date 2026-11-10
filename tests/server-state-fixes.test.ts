import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { WebSocket } from 'ws';
import { Broker } from '../src/broker.js';
import { StateStore } from '../src/state-store.js';
import { AgentGroups } from '../src/agent-groups.js';
import { AgentPresence } from '../src/agent-presence.js';
import { CAPABILITY, errorInfo } from '../src/shared.js';
import { adminPrincipal } from '../src/auth.js';
import { fixture, fakeProfile, testDirectory } from './helpers.js';
import type { TaskRecord } from '../src/tasks.js';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('U32：命令超时清掉协调条目，不累积到 4096 上限；观察到弹窗的条目保留给迟到的弹窗保护', async () => {
  const broker = new Broker(), socket = { readyState: 1, send() {}, close() {} } as unknown as WebSocket;
  broker.connect({ id: 'p', instanceId: 'one', label: 'one', version: 'test', userAgent: 'test', capabilities: [CAPABILITY.dialogControl] } as never, socket);
  const controllers = (broker as unknown as { controllers: Map<string, { dialogObserved: boolean }> }).controllers;
  const controller = { principalId: 'a', owner: 'o' };
  const first = broker.command('p', 'page.evaluate', { tabId: 1 }, 10, undefined, controller).catch(errorInfo);
  const second = broker.command('p', 'page.evaluate', { tabId: 2 }, 10, undefined, controller).catch(errorInfo);
  assert.equal(controllers.size, 2);
  [...controllers.values()][1]!.dialogObserved = true;
  assert.equal((await first as { code: string }).code, 'COMMAND_TIMEOUT'); await second;
  assert.equal(controllers.size, 1, '只留下观察到弹窗的那条');
});

test('U31：没进组的租约（固定标签页等）属于已失联的会话时，对账两轮后释放；任务 owner 不受影响', async () => {
  const leases = new Map<number, string>(), released: [number, string][] = [];
  const broker: any = {
    profiles: new Map([['p', { info: { capabilities: [CAPABILITY.tabGroupsV1] } }]]),
    async command() { return []; },
    release(_: string, tabId: number, owner: string) { released.push([tabId, owner]); leases.delete(tabId); return { released: true }; },
    holder: (_: string, tabId: number) => leases.get(tabId),
    leaseSnapshot: () => [...leases].map(([tabId, owner]) => ({ profileId: 'p', tabId, owner, expires: Infinity })),
  };
  const presence = new AgentPresence(() => undefined), groups = new AgentGroups(broker, presence);
  try {
    leases.set(1, 'a:mcp:' + randomUUID()); leases.set(2, 'a:mcp-http:' + randomUUID()); leases.set(3, 'a:task:' + randomUUID());
    await groups.reconcile(); assert.equal(released.length, 0, '第一轮只记下');
    await groups.reconcile();
    assert.deepEqual(released.map(item => item[0]).sort(), [1, 2], '会话 owner 的租约释放，任务的不动');
  } finally { groups.close(); }
});

const db = (store: StateStore) => (store as unknown as { db: DatabaseSync }).db;
test('U59：任务操作超过 500 条时，未确认的 running/unknown 仍完整返回并标出截断', async t => {
  const temp = await testDirectory(); const store = new StateStore(temp.directory); t.after(async () => { store.close(); await temp.cleanup(); });
  for (let i = 0; i < 600; i++) store.finish(store.begin('p', 1, 'o', 'chrome_action'), 'succeeded');
  const stuck = store.begin('p', 1, 'o', 'chrome_action');
  const early = store.begin('p', 1, 'o', 'chrome_action'); db(store).prepare('UPDATE operations SET started_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', early); store.finish(early, 'unknown');
  const page = store.taskOperationPage('p', 'o');
  assert.ok(page.operations.some(item => item.id === stuck), '最新的 running 在里面');
  assert.ok(page.operations.some(item => item.id === early), '很早的 unknown 也在里面');
  assert.equal(page.truncated, true);
  assert.ok(page.operations.length <= 502);
});

test('U60：一行损坏的任务记录不会让 tasks()/task() 抛错，其余记录照常读出', async t => {
  const temp = await testDirectory(); const store = new StateStore(temp.directory); t.after(async () => { store.close(); await temp.cleanup(); });
  const now = new Date().toISOString();
  store.saveTask({ id: 'good', profileId: 'p', status: 'succeeded', updatedAt: now } as never);
  db(store).prepare('INSERT INTO task_records(id,profile_id,status,data,updated_at) VALUES(?,?,?,?,?)').run('bad', 'p', 'succeeded', '{not json', new Date(Date.now() + 1000).toISOString());
  assert.deepEqual((store.tasks() as { id: string }[]).map(item => item.id), ['good']);
  assert.equal(store.task('bad'), undefined);
  assert.ok(store.skippedTaskRecords >= 1);
});

test('U62：本地异常（变量缺失）让任务失败后，同配置排队的后续任务暂停而不自动派发', async () => {
  const f = await fixture(); let writes = 0;
  try {
    const p = await fakeProfile(f.config, 'stop', c => c.operation === 'tabs.list' ? [{ tabId: 1 }] : (c.operation === 'page.action' && writes++, {}));
    const bad = { name: 'bad', captureOnFailure: false, steps: [{ operation: 'page.action', args: { action: 'fill', selector: '#x', text: 'x' }, bindings: { text: 'missing.title' } }] };
    const next = { name: 'next', captureOnFailure: false, steps: [{ operation: 'page.action', args: { action: 'fill', selector: '#x', text: 'y' } }] };
    const first = f.service.tasks.submit(p.id, 1, bad, adminPrincipal), second = f.service.tasks.submit(p.id, 1, next, adminPrincipal);
    for (let i = 0; i < 100 && f.service.tasks.get(p.id, first.id).status !== 'failed'; i++) await pause(20);
    await pause(500);
    assert.equal(f.service.tasks.get(p.id, first.id).reason, 'TASK_VARIABLE_MISSING');
    assert.equal(f.service.tasks.get(p.id, second.id).status, 'paused'); assert.equal(writes, 0);
  } finally { await f.cleanup(); }
});

test('U61：远程主体的任务按跨重连稳定的 submissionScope 作结果 owner，诊断也按它找回操作', async () => {
  const f = await fixture();
  try {
    const p = await fakeProfile(f.config, 'quota', c => c.operation === 'tabs.list' ? [{ tabId: 1 }] : {});
    const principal = { ...adminPrincipal, id: 'remote:agent:conn-1', submissionScope: 'remote-submission:abc' };
    const job = f.service.tasks.submit(p.id, 1, { name: 'q', captureOnFailure: false, steps: [{ operation: 'page.action', args: { action: 'fill', selector: '#x', text: 'x' } }] }, principal);
    for (let i = 0; i < 100 && f.service.tasks.get(p.id, job.id).status !== 'succeeded'; i++) await pause(20);
    const record = f.service.tasks.get(p.id, job.id) as TaskRecord;
    assert.equal(record.quotaScope, 'remote-submission:abc');
    assert.equal(f.service.state.taskOperations(p.id, `remote-submission:abc:task:${job.id}`).length, 1);
    assert.equal(f.service.tasks.diagnostics(p.id, job.id).operations.length, 1);
  } finally { await f.cleanup(); }
});
