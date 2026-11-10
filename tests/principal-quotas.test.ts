import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { fixture, fakeProfile, testDirectory } from './helpers.js';
import { StateStore } from '../src/state-store.js';
import { adminPrincipal, type Principal } from '../src/auth.js';

// 单个主体不能占满服务：并发有按主体的上限并给管理员留名额；结果文件按主体计配额并给管理员留余量；
// 任务去重收据有时间/容量回收（保护期远长于重试窗口）、按主体上限，撤销客户端即释放。
async function until(predicate: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
const newClient = (f: Awaited<ReturnType<typeof fixture>>, label: string) => f.service.state.authenticate(f.service.state.createClient(label).token)!;
// 与 HTTP /rpc 相同的 owner 约定：以“主体 id:”开头
const invoke = (f: Awaited<ReturnType<typeof fixture>>, principal: Principal, name: string, args: Record<string, unknown>) => f.service.invoke(name, args, `${principal.id}:test`, principal);

test('单个非管理员主体并发有上限（PRINCIPAL_BUSY），其他主体和管理员不受影响，释放后恢复', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  f.config.maxPendingRequests = 16; // 每个主体最多 2 个
  let running = 0, release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const profile = await fakeProfile(f.config, 'A', async command => { if (command.operation === 'page.evaluate') { running++; await gate; } return {}; });
  const a = newClient(f, 'A'), b = newClient(f, 'B');
  const call = (principal: Principal, tabId: number) => invoke(f, principal, 'chrome_evaluate', { profileId: profile.id, tabId, expression: '1' });
  const pending = [call(a, 1), call(a, 2)];
  await until(() => running === 2);
  const refused = await call(a, 3);
  assert.equal(refused.error?.code, 'PRINCIPAL_BUSY'); assert.equal(refused.error?.outcome, 'not_dispatched'); assert.match(refused.error!.message, /其他客户端和管理员不受影响/);
  assert.equal(running, 2, '被拒绝的操作没有到达扩展');
  // 豁免的恢复类操作仍可用
  assert.notEqual((await invoke(f, a, 'chrome_release_tab', { profileId: profile.id, tabId: 9 })).error?.code, 'PRINCIPAL_BUSY');
  pending.push(call(b, 4), f.service.invoke('chrome_evaluate', { profileId: profile.id, tabId: 5, expression: '1' }, 'admin', adminPrincipal));
  await until(() => running === 4);
  release(); for (const result of await Promise.all(pending)) assert.equal(result.ok, true);
  assert.equal((await call(a, 6)).ok, true, '释放后恢复');
});

test('全局上限保持，并为管理员保留名额：非管理员只能用到 cap - 1/8，管理员可以用满', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  f.config.maxPendingRequests = 8; // 每个主体 1 个，非管理员总共最多 7 个在途，最后一个名额留给管理员
  let running = 0, release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const profile = await fakeProfile(f.config, 'A', async command => { if (command.operation === 'page.evaluate') { running++; await gate; } return {}; });
  const call = (principal: Principal, tabId: number) => invoke(f, principal, 'chrome_evaluate', { profileId: profile.id, tabId, expression: '1' });
  const clients = Array.from({ length: 8 }, (_, i) => newClient(f, `c${i}`)), pending: Promise<unknown>[] = [];
  for (let i = 0; i < 7; i++) pending.push(call(clients[i]!, i + 1));
  await until(() => running === 7);
  const reserved = await call(clients[7]!, 8);
  assert.equal(reserved.error?.code, 'SERVER_BUSY'); assert.match(reserved.error!.message, /保留给管理员/); assert.equal(reserved.error?.outcome, 'not_dispatched');
  pending.push(f.service.invoke('chrome_evaluate', { profileId: profile.id, tabId: 9, expression: '1' }, 'admin', adminPrincipal));
  await until(() => running === 8);
  const full = await f.service.invoke('chrome_evaluate', { profileId: profile.id, tabId: 10, expression: '1' }, 'admin', adminPrincipal);
  assert.equal(full.error?.code, 'SERVER_BUSY', '全局上限对管理员也生效'); assert.equal(running, 8);
  release(); await Promise.all(pending);
});

test('结果文件配额：单个主体最多 1/4，非管理员合计留 10% 给管理员；超出的结果不落盘但业务不判失败，管理员仍能保存', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  f.config.resultByteLimit = 1_000_000; f.config.outputLimit = 50; // 单个主体 250000，非管理员合计 900000；每个结果约 100002 字节
  const profile = await fakeProfile(f.config, 'A', () => 'x'.repeat(100000));
  const save = async (principal: Principal) => { const result = await invoke(f, principal, 'chrome_evaluate', { profileId: profile.id, tabId: 1, expression: '1' }); assert.equal(result.ok, true, '业务动作本身成功'); return result; };
  const stored = (result: Awaited<ReturnType<typeof save>>) => (result.data as { saved?: boolean; artifactId?: string }).saved === true;
  const first = newClient(f, 'first');
  assert.ok(stored(await save(first))); assert.ok(stored(await save(first)));
  const over = await save(first);
  assert.equal(over.warnings?.[0]?.code, 'RESULT_STORAGE_FAILED'); assert.match(over.warnings![0]!.message, /已达配额/); assert.ok(!stored(over));
  for (let i = 0; i < 3; i++) { const other = newClient(f, `other${i}`); assert.ok(stored(await save(other))); assert.ok(stored(await save(other))); }
  const squeezed = await save(newClient(f, 'late'));
  assert.equal(squeezed.warnings?.[0]?.code, 'RESULT_STORAGE_FAILED'); assert.match(squeezed.warnings![0]!.message, /保留给管理员/);
  const admin = await f.service.invoke('chrome_evaluate', { profileId: profile.id, tabId: 1, expression: '1' }, 'admin', adminPrincipal);
  assert.ok(stored(admin), '管理员仍能保存');
});

// ---- 任务去重收据 ----
async function receipts() {
  const temp = await testDirectory(), store = new StateStore(temp.directory);
  const db = (store as unknown as { db: DatabaseSync }).db;
  const insert = (principal: string, count: number, ageMs: number, prefix = principal) => {
    const statement = db.prepare('INSERT INTO task_submissions(profile_id,principal_id,submission_id,fingerprint,task_id,created_at) VALUES(?,?,?,?,?,?)');
    db.exec('BEGIN'); for (let i = 0; i < count; i++) statement.run('p', principal, `${prefix}-${i}`, 'f', `task-${prefix}-${i}`, new Date(Date.now() - ageMs - i).toISOString()); db.exec('COMMIT');
  };
  const count = (principal?: string) => Number((principal ? db.prepare('SELECT count(*) AS n FROM task_submissions WHERE principal_id=?').get(principal) : db.prepare('SELECT count(*) AS n FROM task_submissions').get())!.n);
  const check = (principal: Pick<Principal, 'id' | 'admin' | 'submissionScope'>) => store.asSubmitter(principal, () => store.assertSubmissionCapacity());
  return { store, db, insert, count, check, dir: temp.directory, async done() { try { store.close(); } catch { /* 用例里已经关闭过 */ } await temp.cleanup(); } };
}
const client = (id: string): Pick<Principal, 'id' | 'admin' | 'submissionScope'> => ({ id, admin: false });
const HOUR = 3600 * 1000;

test('收据按主体限额：占满的主体收到 SUBMISSION_QUOTA 与恢复时间，其他主体和管理员不受影响，保护期内的收据一条都不删', async t => {
  const r = await receipts(); t.after(() => r.done());
  r.insert('client-a', 2000, 1 * HOUR);
  assert.throws(() => r.check(client('client-a')), (error: { code: string; message: string }) => error.code === 'SUBMISSION_QUOTA' && /24 小时保护期/.test(error.message) && /撤销该客户端/.test(error.message));
  assert.equal(r.count('client-a'), 2000);
  r.check(client('client-b')); r.check(adminPrincipal);
  // 远程主体按 submissionScope 计
  r.insert('remote-submission:o:d:agent', 2000, 1 * HOUR);
  assert.throws(() => r.check({ id: 'remote:d:agent', admin: false, submissionScope: 'remote-submission:o:d:agent' }), { code: 'SUBMISSION_QUOTA' });
  r.check({ id: 'remote:d:other', admin: false, submissionScope: 'remote-submission:o:d:other' });
});

test('收据回收：超过 30 天的删除；占满时只回收超过 24 小时保护期的最旧收据，保护期内的永远保留（断线重试仍返回原收据）', async t => {
  const r = await receipts(); t.after(() => r.done());
  r.insert('old', 5, 31 * 24 * HOUR); r.check(client('whoever'));
  assert.equal(r.count('old'), 0, '超过 30 天的收据被清除');
  // 主体上限：1000 条旧 + 1000 条新，占满时只回收旧的最老 100 条
  r.insert('mixed', 1000, 25 * HOUR, 'oldmix'); r.insert('mixed', 1000, 1 * HOUR, 'fresh');
  r.check(client('mixed'));
  assert.equal(r.count('mixed'), 1900);
  assert.equal(Number(r.db.prepare("SELECT count(*) AS n FROM task_submissions WHERE principal_id='mixed' AND submission_id LIKE 'fresh-%'").get()!.n), 1000, '保护期内的 1000 条一条都没少');
  assert.ok(r.store.taskSubmission('p', 'mixed', 'fresh-0'), '原收据仍可按 submissionId 查到');
});

test('收据总容量：非管理员为管理员保留 1000 条；占满且都在保护期内则明确拒绝；过了保护期自动回收', async t => {
  const r = await receipts(); t.after(() => r.done());
  for (let i = 0; i < 5; i++) r.insert(`c${i}`, 1800, 1 * HOUR);
  assert.throws(() => r.check(client('latecomer')), { code: 'SUBMISSION_CAPACITY' });
  r.check(adminPrincipal);
  r.insert('admin', 1000, 1 * HOUR);
  assert.throws(() => r.check(adminPrincipal), (error: { code: string; message: string }) => error.code === 'SUBMISSION_CAPACITY' && /24 小时/.test(error.message));
  assert.equal(r.count(), 10000, '拒绝时没有删除任何受保护的收据');
  r.db.prepare("UPDATE task_submissions SET created_at=? WHERE principal_id='c0'").run(new Date(Date.now() - 26 * HOUR).toISOString());
  r.check(adminPrincipal);
  assert.ok(r.count() < 10000, '过了保护期的最旧收据被回收');
});

test('撤销客户端同时释放它的收据（占满额度后的恢复路径）', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const key = f.service.state.createClient('占满者'), r = await receipts(); t.after(() => r.done());
  const db = (f.service.state as unknown as { db: DatabaseSync }).db;
  const statement = db.prepare('INSERT INTO task_submissions(profile_id,principal_id,submission_id,fingerprint,task_id,created_at) VALUES(?,?,?,?,?,?)');
  db.exec('BEGIN'); for (let i = 0; i < 2000; i++) statement.run('p', key.id, `s${i}`, 'f', `t${i}`, new Date().toISOString()); db.exec('COMMIT');
  assert.throws(() => f.service.state.asSubmitter(client(key.id), () => f.service.state.assertSubmissionCapacity()), { code: 'SUBMISSION_QUOTA' });
  assert.equal(f.service.state.revokeClient(key.id), true);
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM task_submissions WHERE principal_id=?').get(key.id)!.n), 0);
});

test('旧库升级：补 created_at 列并给旧收据从现在起算保留期；旧收据仍按 submissionId 返回原任务，且不会立刻被回收', async t => {
  const r = await receipts(); t.after(() => r.done());
  r.db.exec('DROP INDEX task_submissions_age'); r.db.exec('ALTER TABLE task_submissions DROP COLUMN created_at');
  r.db.prepare('INSERT INTO task_submissions(profile_id,principal_id,submission_id,fingerprint,task_id) VALUES(?,?,?,?,?)').run('p', 'legacy-client', 'legacy-1', 'f', 'legacy-task');
  r.store.close();
  const reopened = new StateStore(r.dir);
  try {
    const db = (reopened as unknown as { db: DatabaseSync }).db;
    assert.ok(db.prepare('PRAGMA table_info(task_submissions)').all().some(column => column.name === 'created_at'));
    const stamped = String(db.prepare("SELECT created_at FROM task_submissions WHERE submission_id='legacy-1'").get()!.created_at);
    assert.ok(Math.abs(Date.now() - Date.parse(stamped)) < 60000, '从升级时刻起算');
    assert.deepEqual({ ...reopened.taskSubmission('p', 'legacy-client', 'legacy-1') }, { fingerprint: 'f', task_id: 'legacy-task' });
    reopened.asSubmitter(client('legacy-client'), () => reopened.assertSubmissionCapacity());
    assert.ok(reopened.taskSubmission('p', 'legacy-client', 'legacy-1'), '升级后立刻回收不到旧收据');
  } finally { reopened.close(); }
});

test('经 chrome_task_submit：占满的客户端新的 submissionId 被 SUBMISSION_QUOTA 拒绝（未入队），已有 submissionId 的断线重试仍返回原收据', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const profile = await fakeProfile(f.config, 'A', command => command.operation === 'tabs.list' ? [{ tabId: 7 }] : {});
  const key = f.service.state.createClient('提交者'), principal = f.service.state.authenticate(key.token)!, other = newClient(f, '另一个客户端');
  const plan = (submissionId: string) => ({ profileId: profile.id, tabId: 7, name: 'quota', submissionId, captureOnFailure: false, steps: [{ operation: 'page.evaluate', args: { expression: '1' } }] });
  const original = randomUUID(), fresh = randomUUID();
  const first = await invoke(f, principal, 'chrome_task_submit', plan(original)), firstId = (first.data as { id: string }).id;
  assert.equal(first.ok, true);
  const db = (f.service.state as unknown as { db: DatabaseSync }).db, statement = db.prepare('INSERT INTO task_submissions(profile_id,principal_id,submission_id,fingerprint,task_id,created_at) VALUES(?,?,?,?,?,?)');
  db.exec('BEGIN'); for (let i = 0; i < 2000; i++) statement.run('p', key.id, `filler-${i}`, 'f', `t${i}`, new Date().toISOString()); db.exec('COMMIT');
  const jobsBefore = f.service.state.tasks().length;
  const blocked = await invoke(f, principal, 'chrome_task_submit', plan(fresh));
  assert.equal(blocked.error?.code, 'SUBMISSION_QUOTA'); assert.equal(blocked.error?.outcome, 'not_dispatched'); assert.equal(f.service.state.tasks().length, jobsBefore, '被拒绝的提交没有创建任务');
  const retry = await invoke(f, principal, 'chrome_task_submit', plan(original));
  assert.equal(retry.ok, true); assert.equal((retry.data as { id: string; deduplicated?: boolean }).id, firstId); assert.equal((retry.data as { deduplicated?: boolean }).deduplicated, true);
  assert.equal((await invoke(f, other, 'chrome_task_submit', plan(fresh))).ok, true, '其他客户端不受影响');
  assert.equal((await f.service.invoke('chrome_task_submit', plan(randomUUID()), 'admin', adminPrincipal)).ok, true);
});
