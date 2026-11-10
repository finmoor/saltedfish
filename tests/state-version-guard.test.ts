import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { testDirectory } from './helpers.js';
import { StateStore, REMOTE_RECEIPT_STATE_VERSION } from '../src/state-store.js';
import { STATE_VERSION } from '../src/version.js';

// 库的 user_version 是 npm 降级/回滚闸门读的“最低读取版本”。稳定远程收据落盘时把它抬到自己所需的最低值，
// 但只能升不能降：以后别的功能把版本抬得更高时，写一张远程收据不能把它写回去，否则兼容保护失效。
async function open() {
  const temp = await testDirectory(), store = new StateStore(temp.directory);
  const db = (store as unknown as { db: DatabaseSync }).db;
  const version = () => Number(db.prepare('PRAGMA user_version').get()!.user_version);
  const task = (profileId = 'A') => ({ id: randomUUID(), profileId, status: 'queued', updatedAt: new Date().toISOString() });
  const receipt = (principalId = 'remote-submission:test') => ({ principalId, id: randomUUID(), fingerprint: 'fixture' });
  return { store, db, version, task, receipt, async done() { try { store.close(); } catch { /* 已关闭 */ } await temp.cleanup(); } };
}

test('稳定远程收据所需的最低库版本是命名常量，并且不高于当前代码能读的版本', () => {
  assert.equal(REMOTE_RECEIPT_STATE_VERSION, 2);
  assert.ok(REMOTE_RECEIPT_STATE_VERSION <= STATE_VERSION, '要求的最低版本不能高于当前运行时自己能打开的版本');
});

test('写远程收据把库版本抬到所需最低值；普通收据不动它', async t => {
  const h = await open(); t.after(() => h.done());
  assert.equal(h.version(), 1);
  h.store.saveNewTask(h.task(), h.receipt('some-local-client'));
  assert.equal(h.version(), 1, '本机客户端的收据不需要新格式');
  h.store.saveNewTask(h.task(), h.receipt());
  assert.equal(h.version(), REMOTE_RECEIPT_STATE_VERSION);
});

test('库版本只升不降：别的功能已经把版本抬得更高时，再写远程收据不会把它写回去', async t => {
  const h = await open(); t.after(() => h.done());
  h.db.exec(`PRAGMA user_version=${REMOTE_RECEIPT_STATE_VERSION + 1}`);
  h.store.saveNewTask(h.task(), h.receipt());
  h.store.saveNewTask(h.task(), h.receipt('remote-submission:another-agent'));
  assert.equal(h.version(), REMOTE_RECEIPT_STATE_VERSION + 1);
});

test('抬高版本与收据同一个事务：收据没写成功就不抬高', async t => {
  const h = await open(); t.after(() => h.done());
  const duplicate = h.receipt(); h.store.saveNewTask(h.task(), duplicate);
  h.db.exec('PRAGMA user_version=1');
  assert.throws(() => h.store.saveNewTask(h.task(), duplicate), /UNIQUE/, '同一收据主键重复，整个事务回滚');
  assert.equal(h.version(), 1, '回滚连同版本一起撤销');
});
