import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { fixture, fakeProfile, testDirectory } from './helpers.js';
import { StateStore } from '../src/state-store.js';
import { pageItems } from '../src/shared.js';
import type { TaskRecord } from '../src/tasks.js';

// chrome_tasks 只读由 SQLite 触发器维护的任务摘要（不含 steps），不再每次解析最多 600 条完整任务 JSON；
// 但返回内容必须和原先逐条解析完整记录的实现完全一致（过滤、排序、分页、内存里更新的运行中记录）。
type Fixture = Awaited<ReturnType<typeof fixture>>;
const db = (store: StateStore) => (store as unknown as { db: DatabaseSync }).db;
let clock = Date.parse('2026-01-01T00:00:00Z');
function record(profileId: string, name: string, stepCount: number, status: TaskRecord['status'] = 'succeeded', id: string = randomUUID()): TaskRecord {
  const stamp = new Date(clock += 1000).toISOString();
  return { id, profileId, tabId: 7, initialTabId: 7, principalId: 'admin', name, status, nextStep: stepCount, createdAt: stamp, updatedAt: stamp, visible: false,
    steps: Array.from({ length: stepCount }, (_, index) => ({ operation: 'page.action', action: 'click', state: 'succeeded' as const, startedAt: stamp, finishedAt: stamp, operationId: randomUUID(), verification: 'matched' as const, code: index % 7 ? undefined : 'OK' })) };
}
// 原实现：解析全部完整记录，再在内存里过滤、排序、分页。
function referenceList(f: Fixture, profileId: string, offset: number, limit: number, status?: string, query = '') {
  const tasks = f.service.tasks as unknown as { unpersisted: Map<string, TaskRecord>; jobs: Map<string, { record: TaskRecord }> };
  const records = new Map((f.service.state.tasks() as TaskRecord[]).map(task => [task.id, task]));
  for (const task of tasks.unpersisted.values()) records.set(task.id, task);
  for (const job of tasks.jobs.values()) records.set(job.record.id, job.record);
  return pageItems([...records.values()].filter(task => task.profileId === profileId && (!status || task.status === status) && `${task.name} ${task.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)).map(({ steps, ...task }) => ({ ...task, totalSteps: steps.length })), offset, limit);
}

test('列表结果与逐条解析完整记录的原实现完全一致：账号、状态、名称/ID 搜索（含大小写与非 ASCII）、排序、分页', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const names = ['Alpha 结算', 'beta ÄPFEL', 'Gamma', 'İstanbul 订单', 'delta 结算'], statuses: TaskRecord['status'][] = ['succeeded', 'failed', 'needs_review', 'cancelled'];
  for (let index = 0; index < 60; index++) f.service.state.saveTask(record(index % 3 ? 'profile-A' : 'profile-B', `${names[index % names.length]} #${index}`, index % 9, statuses[index % statuses.length]));
  for (const [profileId, status, query] of [['profile-A', undefined, ''], ['profile-B', undefined, ''], ['profile-A', 'failed', ''], ['profile-A', undefined, '结算'], ['profile-A', undefined, 'apfel'], ['profile-A', undefined, 'ÄPFEL'], ['profile-A', 'needs_review', 'GAMMA'], ['profile-B', undefined, 'İSTANBUL'], ['profile-A', undefined, 'no-such-task'], ['nobody', undefined, '']] as const) {
    for (const [offset, limit] of [[0, 10], [10, 10], [0, 100], [35, 7]] as const) {
      assert.deepEqual(f.service.tasks.list(profileId, offset, limit, status, query), referenceList(f, profileId, offset, limit, status, query), JSON.stringify({ profileId, status, query, offset, limit }));
    }
  }
  const all = f.service.tasks.list('profile-A', 0, 100); assert.equal(all.total, 40); assert.ok(all.items.every(item => !('steps' in item) && typeof item.totalSteps === 'number'));
});

test('运行中和尚未落盘的记录用内存里的最新版本覆盖摘要，和原实现一致', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const inMemory = f.service.tasks as unknown as { unpersisted: Map<string, TaskRecord>; jobs: Map<string, { record: TaskRecord }> };
  const persisted = record('p', '已落盘的任务', 2, 'running'), unsaved = record('p', '只在内存里的任务', 5, 'paused'), stale = record('p', '旧名字', 1, 'queued');
  f.service.state.saveTask(persisted); f.service.state.saveTask(stale);
  inMemory.unpersisted.set(unsaved.id, unsaved);
  inMemory.jobs.set(stale.id, { record: { ...stale, name: '内存里的新名字', status: 'running', steps: [...stale.steps, ...stale.steps, ...stale.steps], updatedAt: new Date(clock += 5000).toISOString() } });
  const listed = f.service.tasks.list('p', 0, 10);
  assert.deepEqual(listed, referenceList(f, 'p', 0, 10));
  assert.equal(listed.items[0]!.name, '内存里的新名字'); assert.equal((listed.items[0] as { totalSteps: number }).totalSteps, 3); assert.equal(listed.total, 3);
  assert.equal(f.service.tasks.list('p', 0, 10, 'queued').total, 0, '按内存里的最新状态过滤，而不是摘要里的旧状态');
});

test('只解析摘要：500 条、每条 200 步的上限历史，一次列表解析的 JSON 字符数比完整记录小一个数量级以上', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  let full = 0;
  for (let index = 0; index < 500; index++) { const task = record('heavy', `任务 ${index}`, 200); full += JSON.stringify(task).length; f.service.state.saveTask(task); }
  const original = JSON.parse; let parsed = 0;
  JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => { parsed += String(text).length; return original(text, reviver); }) as typeof JSON.parse;
  let listed: ReturnType<typeof f.service.tasks.list>;
  try { listed = f.service.tasks.list('heavy', 0, 10); } finally { JSON.parse = original; }
  assert.equal(listed.total, 500); assert.equal(listed.items.length, 10);
  assert.ok(full > 5_000_000, `夹具应当足够大：${full}`);
  assert.ok(parsed < full / 10, `列表解析了 ${parsed} 字符，完整记录共 ${full} 字符`);
  assert.deepEqual(listed, referenceList(f, 'heavy', 0, 10));
});

test('摘要由触发器随任务记录同步：新增、更新、保留策略删除，以及旧运行时的直接写入', async t => {
  const temp = await testDirectory(), store = new StateStore(temp.directory); t.after(async () => { try { store.close(); } catch { /* 已关闭 */ } await temp.cleanup(); });
  const summaries = (profile = 'p') => store.taskSummaries(profile) as Array<{ id: string; status: string; totalSteps: number; name: string; steps?: unknown }>;
  const first = record('p', '第一个', 3, 'queued'); store.saveTask(first);
  assert.deepEqual(summaries().map(item => [item.id, item.status, item.totalSteps, 'steps' in item]), [[first.id, 'queued', 3, false]]);
  store.saveTask({ ...first, status: 'succeeded', updatedAt: new Date(clock += 1000).toISOString(), steps: [...first.steps, ...first.steps] } as TaskRecord);
  assert.deepEqual(summaries().map(item => [item.status, item.totalSteps]), [['succeeded', 6]], '同一任务反复保存只有一行摘要，且是最新内容');
  // 旧版本运行时（不认识摘要表）直接写 task_records：触发器仍然让摘要保持最新
  const legacy = record('p', '旧运行时写入', 1, 'failed');
  db(store).prepare('INSERT INTO task_records(id,profile_id,status,data,updated_at) VALUES(?,?,?,?,?)').run(legacy.id, legacy.profileId, legacy.status, JSON.stringify(legacy), legacy.updatedAt);
  db(store).prepare('UPDATE task_records SET status=?,data=? WHERE id=?').run('needs_review', JSON.stringify({ ...legacy, status: 'needs_review', reason: 'X' }), legacy.id);
  const viaLegacy = summaries().find(item => item.id === legacy.id)!; assert.equal(viaLegacy.status, 'needs_review');
  // 保留策略：终态任务只留最新 500 条，被删除的任务摘要同步消失
  for (let index = 0; index < 505; index++) store.saveTask(record('p', `批量 ${index}`, 0));
  const kept = new Set((store.tasks() as TaskRecord[]).map(task => task.id));
  assert.equal(db(store).prepare('SELECT count(*) AS n FROM task_records').get()!.n, db(store).prepare('SELECT count(*) AS n FROM task_summaries').get()!.n);
  assert.ok(summaries().every(item => kept.has(item.id)), '摘要里没有已被删除的任务');
});

test('旧库升级：没有摘要表的库打开时回填，损坏的记录既不阻止写入也不阻止启动', async t => {
  const temp = await testDirectory(); let store = new StateStore(temp.directory); t.after(async () => { try { store.close(); } catch { /* 已关闭 */ } await temp.cleanup(); });
  const older = record('p', '升级前的任务', 4), newer = record('p', '升级前的另一个任务', 1, 'failed');
  store.saveTask(older); store.saveTask(newer);
  // 还原成旧库：没有摘要表和触发器
  for (const trigger of ['insert', 'update', 'delete']) db(store).exec(`DROP TRIGGER task_records_summary_${trigger}`);
  db(store).exec('DROP TABLE task_summaries');
  db(store).prepare('INSERT INTO task_records(id,profile_id,status,data,updated_at) VALUES(?,?,?,?,?)').run('broken', 'p', 'succeeded', '{not json', new Date(clock += 1000).toISOString());
  store.close();
  store = new StateStore(temp.directory);
  const rows = store.taskSummaries('p') as Array<{ id: string; totalSteps: number }>;
  assert.deepEqual(rows.map(item => [item.id, item.totalSteps]).sort(), [[older.id, 4], [newer.id, 1]].sort(), '回填了两条有效记录，损坏的那条被跳过');
  assert.doesNotThrow(() => db(store).prepare('UPDATE task_records SET status=? WHERE id=?').run('failed', 'broken'), '损坏的记录不会让触发器抛错');
  assert.doesNotThrow(() => store.saveTask(record('p', '之后的写入', 0)));
});
