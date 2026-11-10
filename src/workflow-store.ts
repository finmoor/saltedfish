import type { DatabaseSync } from 'node:sqlite';
import type { z } from 'zod';
import type { workflowDefinition } from './tools.js';
import { BrowserError } from './shared.js';

export interface StoredWorkflow {
  id: string; profileId: string; createdAt: string; updatedAt?: string; revision: string; version?: number; archivedAt?: string | null;
  definition: z.infer<typeof workflowDefinition>;
}
export class WorkflowStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS archived_workflows (id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_revisions (workflow_id TEXT NOT NULL,revision TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,
      PRIMARY KEY(workflow_id,revision),UNIQUE(workflow_id,version));`);
    // 派生摘要由SQLite触发器维护，旧版回滚后写入也不会留下陈旧缓存。
    db.exec(`CREATE TABLE IF NOT EXISTS workflow_summaries (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, archived INTEGER NOT NULL, created_at TEXT NOT NULL, summary TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workflow_summary_page ON workflow_summaries(profile_id,archived,created_at DESC,id DESC);`);
    for (const [table, archived] of [['workflows', 0], ['archived_workflows', 1]] as const) {
      const summary = (data: string) => `json_object(
        'id',json_extract(${data},'$.id'),'profileId',json_extract(${data},'$.profileId'),
        'createdAt',json_extract(${data},'$.createdAt'),'updatedAt',coalesce(json_extract(${data},'$.updatedAt'),json_extract(${data},'$.createdAt')),
        'revision',json_extract(${data},'$.revision'),'version',coalesce(json_extract(${data},'$.version'),1),
        'archivedAt',json_extract(${data},'$.archivedAt'),'stepCount',json_array_length(${data},'$.definition.steps'),
        'definition',json_object('name',json_extract(${data},'$.definition.name'),'description',coalesce(json_extract(${data},'$.definition.description'),''),
          'parameters',json(coalesce(json_extract(${data},'$.definition.parameters'),'[]'))))`;
      for (const operation of ['INSERT', 'UPDATE'] as const) db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_summary_${operation.toLowerCase()} AFTER ${operation} ON ${table}
        BEGIN INSERT OR REPLACE INTO workflow_summaries(id,profile_id,archived,created_at,summary)
          VALUES(new.id,new.profile_id,${archived},new.created_at,${summary('new.data')}); END;`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_summary_delete AFTER DELETE ON ${table} BEGIN DELETE FROM workflow_summaries WHERE id=old.id; END;`);
      db.exec(`INSERT OR IGNORE INTO workflow_summaries(id,profile_id,archived,created_at,summary)
        SELECT id,profile_id,${archived},created_at,${summary('data')} FROM ${table} WHERE id NOT IN (SELECT id FROM workflow_summaries);`);
    }
  }
  private decode(row?: Record<string, unknown>): StoredWorkflow | undefined {
    if (!row) return undefined;
    const value = JSON.parse(String(row.data)) as StoredWorkflow;
    return { ...value, version: value.version ?? 1, updatedAt: value.updatedAt ?? value.createdAt, archivedAt: value.archivedAt ?? null };
  }
  get(id: string, includeArchived = false) {
    return this.decode(this.db.prepare('SELECT data FROM workflows WHERE id=?').get(id)) || (includeArchived ? this.decode(this.db.prepare('SELECT data FROM archived_workflows WHERE id=?').get(id)) : undefined);
  }
  list(profileId: string, archived = false) {
    const table = archived ? 'archived_workflows' : 'workflows';
    return this.db.prepare(`SELECT data FROM ${table} WHERE profile_id=? ORDER BY created_at DESC LIMIT 1000`).all(profileId).map(row => this.decode(row)!);
  }
  page(profileId: string, archived: boolean, offset: number, limit: number, summary: boolean) {
    const total = Number(this.db.prepare('SELECT count(*) AS count FROM workflow_summaries WHERE profile_id=? AND archived=?').get(profileId, Number(archived))!.count);
    const rows = summary
      ? this.db.prepare('SELECT summary FROM workflow_summaries WHERE profile_id=? AND archived=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').all(profileId, Number(archived), limit, offset)
      : this.db.prepare(`SELECT data FROM ${archived ? 'archived_workflows' : 'workflows'} WHERE profile_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(profileId, limit, offset);
    const items = rows.map(row => summary ? JSON.parse(String(row.summary)) : this.decode(row)!);
    return { items, total, nextOffset: offset + limit < total ? offset + limit : null };
  }
  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  save(value: StoredWorkflow, expectedRevision?: string): StoredWorkflow {
    return this.transaction(() => {
      const old = this.get(value.id, true);
      if (expectedRevision ? !old || old.revision !== expectedRevision : !!old) throw new BrowserError('WORKFLOW_CHANGED', '流程已被其他操作修改，请重新读取最新版本再保存。');
      if (old && old.profileId !== value.profileId) throw new BrowserError('WORKFLOW_NOT_FOUND', '此账号没有该流程。');
      const table = value.archivedAt ? 'archived_workflows' : 'workflows';
      const count = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
      if (!this.db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(value.id) && count >= (value.archivedAt ? 1000 : 100)) throw new BrowserError('WORKFLOW_CAPACITY', value.archivedAt ? '归档流程达到 1000 个，请先整理已归档流程。' : '已有 100 个活动流程，请先归档不再使用的流程。');
      const seedOld = old && !this.db.prepare('SELECT 1 FROM workflow_revisions WHERE workflow_id=? AND revision=?').get(old.id, old.revision);
      const revisions = Number(this.db.prepare('SELECT COUNT(*) AS n FROM workflow_revisions WHERE workflow_id=?').get(value.id)?.n);
      if (revisions + (seedOld ? 1 : 0) + 1 > 50) throw new BrowserError('WORKFLOW_VERSION_CAPACITY', '此流程已有 50 个版本。可复制为新流程继续编辑，原历史仍保留。');
      const next = { ...value, createdAt: old?.createdAt ?? value.createdAt, version: (old?.version ?? 0) + 1, updatedAt: new Date().toISOString(), archivedAt: value.archivedAt ?? null };
      const encoded = JSON.stringify(next), oldEncoded = seedOld ? JSON.stringify(old) : '';
      const bytes = Number(this.db.prepare('SELECT COALESCE(SUM(LENGTH(CAST(data AS BLOB))),0) AS n FROM workflow_revisions').get()?.n);
      if (bytes + Buffer.byteLength(encoded) + Buffer.byteLength(oldEncoded) > 64 * 1024 * 1024) throw new BrowserError('WORKFLOW_HISTORY_CAPACITY', '流程历史超过 64 MiB，请先导出并整理不再需要的归档流程。');
      const insertRevision = this.db.prepare('INSERT INTO workflow_revisions(workflow_id,revision,version,data,created_at) VALUES(?,?,?,?,?)');
      if (seedOld) insertRevision.run(old!.id, old!.revision, old!.version ?? 1, oldEncoded, old!.updatedAt ?? old!.createdAt);
      insertRevision.run(next.id, next.revision, next.version, encoded, next.updatedAt);
      this.db.prepare('DELETE FROM workflows WHERE id=?').run(next.id); this.db.prepare('DELETE FROM archived_workflows WHERE id=?').run(next.id);
      this.db.prepare(`INSERT INTO ${table}(id,profile_id,data,created_at) VALUES(?,?,?,?)`).run(next.id, next.profileId, encoded, next.createdAt);
      return next;
    });
  }
  versions(id: string) {
    const rows = this.db.prepare('SELECT data FROM workflow_revisions WHERE workflow_id=? ORDER BY version DESC').all(id).map(row => this.decode(row)!);
    if (!rows.length) { const legacy = this.get(id, true); if (legacy) rows.push(legacy); }
    return rows.map(value => ({ revision: value.revision, version: value.version, updatedAt: value.updatedAt, name: value.definition.name, archived: !!value.archivedAt }));
  }
  archive(id: string, profileId: string, expectedRevision: string, archived: boolean) {
    return this.transaction(() => {
      const value = this.get(id, true);
      if (!value || value.profileId !== profileId) throw new BrowserError('WORKFLOW_NOT_FOUND', '此账号没有该流程。');
      if (value.revision !== expectedRevision) throw new BrowserError('WORKFLOW_CHANGED', '流程内容版本已变化，请刷新后操作。');
      if (!!value.archivedAt === archived) return value;
      const table = archived ? 'archived_workflows' : 'workflows';
      if (Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n) >= (archived ? 1000 : 100)) throw new BrowserError('WORKFLOW_CAPACITY', '目标流程列表已满，请先整理。');
      const next = { ...value, archivedAt: archived ? new Date().toISOString() : null, updatedAt: new Date().toISOString() };
      this.db.prepare('DELETE FROM workflows WHERE id=?').run(id); this.db.prepare('DELETE FROM archived_workflows WHERE id=?').run(id);
      this.db.prepare(`INSERT INTO ${table}(id,profile_id,data,created_at) VALUES(?,?,?,?)`).run(id, profileId, JSON.stringify(next), value.createdAt);
      return next; // 归档不产生新的内容版本，达到版本预算时仍然可以归档、恢复和整理。
    });
  }
  revision(id: string, revision: string) {
    const current = this.get(id, true);
    if (current?.revision === revision) return current;
    return this.decode(this.db.prepare('SELECT data FROM workflow_revisions WHERE workflow_id=? AND revision=?').get(id, revision));
  }
  remove(id: string, profileId: string, expectedRevision: string) {
    return this.transaction(() => {
      const value = this.get(id, true);
      if (!value || value.profileId !== profileId) throw new BrowserError('WORKFLOW_NOT_FOUND', '此账号没有该流程。');
      if (!value.archivedAt) throw new BrowserError('WORKFLOW_NOT_ARCHIVED', '仅允许永久删除已归档的流程。');
      if (value.revision !== expectedRevision) throw new BrowserError('WORKFLOW_CHANGED', '流程状态已变化，请刷新后再操作。');
      this.db.prepare('DELETE FROM archived_workflows WHERE id=?').run(id);
      this.db.prepare('DELETE FROM workflow_revisions WHERE workflow_id=?').run(id);
      return { removed: true, workflowId: id };
    });
  }
}
