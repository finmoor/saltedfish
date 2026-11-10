import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { BrowserError } from './shared.js';
import { tokenHash, type Principal } from './auth.js';
import type { ProfileInfo } from './shared.js';
import { WorkflowStore, type StoredWorkflow } from './workflow-store.js';
import { STATE_VERSION } from './version.js';

export type OperationState = 'running' | 'succeeded' | 'failed' | 'unknown';
const parsedDetail = (value: unknown) => { if (typeof value !== 'string') return {}; try { const detail = JSON.parse(value); return detail && typeof detail === 'object' ? { detail } : {}; } catch { return {}; } };
export interface OperationRecord {
  id: string; profileId: string; tabId: number | null; owner: string; tool: string;
  state: OperationState; startedAt: string; finishedAt: string | null;
  errorCode: string | null; acknowledgedAt: string | null;
  /** 不含正文的补充信息，目前只有上传：文件名、大小、SHA-256。 */
  detail?: Record<string, unknown>;
}

// 任务去重收据：通常保留 30 天；容量吃紧时只回收超过 24 小时保护期的最旧收据（远长于合理的断线重试窗口）。
// 非管理员主体各自有上限，并给管理员保留一部分容量，单个客户端不能把所有带 submissionId 的任务堵死。
const RECEIPT_RETENTION_MS = 30 * 24 * 3600 * 1000, RECEIPT_PROTECTED_MS = 24 * 3600 * 1000;
const RECEIPT_TOTAL = 10000, RECEIPT_ADMIN_RESERVE = 1000, RECEIPT_PER_PRINCIPAL = 2000;
// 稳定远程收据（remote-submission:）需要的最低库格式版本：旧运行时不理解这种去重键，落盘第一张此类收据时原子抬高到它。
// 只升不降（见 raiseStateVersion）；不能高于 STATE_VERSION（tests/state-version-guard.test.ts 守护）。
export const REMOTE_RECEIPT_STATE_VERSION = 2;

export class StateStore {
  // 远程权限只在当前已认证的连接期间有效，断线清除，不写入长期客户端凭据表。
  readonly remotePrincipals = new Map<string, Principal>();
  private submitter?: { id: string; admin: boolean };
  private db: DatabaseSync;
  private workflowStore: WorkflowStore;
  constructor(dataDir: string, minimumVersion = 1) {
    if(!Number.isInteger(minimumVersion)||minimumVersion<1||minimumVersion>STATE_VERSION)throw new Error('最低数据格式版本无效。');
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'state.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version as number;
    if (version > STATE_VERSION) { this.db.close(); throw new BrowserError('STATE_VERSION_TOO_NEW', '数据由更新版本创建，不能用旧版服务直接打开。请升级服务；不能回滚任务或授权数据库来绕过兼容保护。'); }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, tab_id INTEGER,
        owner TEXT NOT NULL, tool TEXT NOT NULL, state TEXT NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT, error_code TEXT,
        acknowledged_at TEXT
      );
      CREATE INDEX IF NOT EXISTS operations_target ON operations(profile_id,tab_id,state);
      CREATE INDEX IF NOT EXISTS operations_owner ON operations(profile_id,owner);
      CREATE INDEX IF NOT EXISTS operations_retention ON operations(started_at DESC) WHERE state IN ('succeeded','failed') OR acknowledged_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS operations_unacknowledged ON operations(profile_id,state,started_at DESC) WHERE acknowledged_at IS NULL AND state IN ('running','unknown');
      CREATE TABLE IF NOT EXISTS clients (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
        profiles TEXT NOT NULL, read_only INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY, profile_id TEXT, owner TEXT NOT NULL,
        extension TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_records (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_submissions (profile_id TEXT NOT NULL, principal_id TEXT NOT NULL, submission_id TEXT NOT NULL, fingerprint TEXT NOT NULL, task_id TEXT NOT NULL, PRIMARY KEY(profile_id,principal_id,submission_id));
      CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS known_profiles (id TEXT PRIMARY KEY, label TEXT NOT NULL, version TEXT NOT NULL, last_seen TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_usage (agent_id TEXT NOT NULL, profile_id TEXT NOT NULL, last_used_at TEXT NOT NULL, PRIMARY KEY(agent_id,profile_id));
      PRAGMA user_version=${Math.max(1, version)};
    `);
    this.raiseStateVersion(minimumVersion);
    // 任务列表摘要（去掉 steps、附带 totalSteps）由 SQLite 触发器维护，旧版回滚后写入也不会留下陈旧摘要：chrome_tasks 每次只读摘要，不再解析最多 600 条完整任务 JSON。
    // json_valid 守卫：一行损坏的记录不能让写入或启动失败。触发器里用 DELETE + INSERT 而不是 INSERT OR REPLACE：
    // 触发它的 saveTask 是带 ON CONFLICT 的 UPSERT，SQLite 会让外层语句的冲突策略覆盖触发器内部的 OR REPLACE，已有摘要行就会 UNIQUE 失败。
    const taskSummary = (data: string) => `json_set(json_remove(${data},'$.steps'),'$.totalSteps',coalesce(json_array_length(${data},'$.steps'),0))`;
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_summaries (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, updated_at TEXT NOT NULL, summary TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_summary_page ON task_summaries(profile_id,updated_at DESC,id DESC);`);
    for (const operation of ['INSERT', 'UPDATE'] as const) this.db.exec(`CREATE TRIGGER IF NOT EXISTS task_records_summary_${operation.toLowerCase()} AFTER ${operation} ON task_records WHEN json_valid(new.data)
      BEGIN DELETE FROM task_summaries WHERE id=new.id; INSERT INTO task_summaries(id,profile_id,updated_at,summary) VALUES(new.id,new.profile_id,new.updated_at,${taskSummary('new.data')}); END;`);
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS task_records_summary_delete AFTER DELETE ON task_records BEGIN DELETE FROM task_summaries WHERE id=old.id; END;
      INSERT OR IGNORE INTO task_summaries(id,profile_id,updated_at,summary) SELECT id,profile_id,updated_at,${taskSummary('data')} FROM task_records WHERE json_valid(data) AND id NOT IN (SELECT id FROM task_summaries);`);
    // 收据时间戳用于回收；旧库的收据补上当前时间（保守地从现在起算保留期），旧运行时写入的空值同样补齐。
    if (!this.db.prepare('PRAGMA table_info(task_submissions)').all().some(column => column.name === 'created_at')) this.db.exec('ALTER TABLE task_submissions ADD COLUMN created_at TEXT');
    this.db.prepare('UPDATE task_submissions SET created_at=? WHERE created_at IS NULL').run(new Date().toISOString());
    this.db.exec('CREATE INDEX IF NOT EXISTS task_submissions_age ON task_submissions(created_at)');
    // 旧版回滚后仍能写入：新列有默认值，插入时不用提到它，所以不抬高状态格式。
    if (!this.db.prepare('PRAGMA table_info(clients)').all().some(column => column.name === 'advanced_tools')) this.db.exec('ALTER TABLE clients ADD COLUMN advanced_tools INTEGER NOT NULL DEFAULT 0');
    // 同理：旧版写入时这一列留空，不影响它读写，所以也不抬高状态格式。
    if (!this.db.prepare('PRAGMA table_info(operations)').all().some(column => column.name === 'detail')) this.db.exec('ALTER TABLE operations ADD COLUMN detail TEXT');
    // 上次进程在发送前已落盘、但没有收到确定结果的操作，绝不当成未执行。
    this.db.prepare("UPDATE operations SET state='unknown',error_code='SERVICE_RESTARTED',finished_at=? WHERE state='running'").run(new Date().toISOString());
    this.workflowStore = new WorkflowStore(this.db);
  }

  // 只升不降：库版本由多个功能共同抬高，某个功能写入自己所需的最低版本时，不能把别的功能已经抬高的版本写回去（兼容闸门读的就是它）。
  // 在事务内调用时随回滚一起撤销。
  private raiseStateVersion(minimum: number): void {
    const current = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
    if (current < minimum) this.db.exec(`PRAGMA user_version=${Math.trunc(minimum)}`);
  }

  // 无标签页的未决操作影响范围不明，拦住这个配置的所有写入；标签页上的未决操作只暂停这个标签页，其他标签页和新开标签页不受影响。
  assertWritable(profileId: string, tabId?: number): void {
    const row = this.db.prepare(`SELECT id,state,tool,error_code,started_at FROM operations WHERE profile_id=? AND state IN ('running','unknown') AND acknowledged_at IS NULL
      AND (tab_id IS NULL OR tab_id=?) ORDER BY started_at LIMIT 1`).get(profileId, tabId ?? null);
    // 写明是哪一次、为什么：调用方不用先翻 chrome_operations 才知道该核对什么。
    if (row) throw new BrowserError(row.state === 'running' ? 'OPERATION_PENDING' : 'RESULT_UNKNOWN', `此前操作 ${row.id}（${row.tool}${row.error_code ? `，${row.error_code}` : ''}，开始于 ${row.started_at}）${row.state === 'running' ? '仍在执行' : '结果尚未确认'}。先检查页面，确认后用 chrome_recover_operation 解除，不要重复提交；若完成状态无法落盘，修复存储并重启服务后再确认恢复。`);
  }

  // 这个标签页（或整个配置）上是否还有未确认的运行中/未知操作；与 assertWritable 同一口径，但不抛错。
  hasOpenOperation(profileId: string, tabId: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM operations WHERE profile_id=? AND state IN ('running','unknown') AND acknowledged_at IS NULL AND (tab_id IS NULL OR tab_id=?) LIMIT 1").get(profileId, tabId);
  }

  begin(profileId: string, tabId: number | undefined, owner: string, tool: string): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO operations(id,profile_id,tab_id,owner,tool,state,started_at) VALUES(?,?,?,?,?,\'running\',?)')
      .run(id, profileId, tabId ?? null, owner, tool, new Date().toISOString());
    return id;
  }

  finish(id: string, state: Exclude<OperationState, 'running'>, errorCode?: string): void {
    this.db.prepare('UPDATE operations SET state=?,finished_at=?,error_code=? WHERE id=? AND state=\'running\'')
      .run(state, new Date().toISOString(), errorCode ?? null, id);
    // 只回收旧的已完成元数据，不删未知操作，也不删除用户结果文件。
    this.db.exec(`DELETE FROM operations WHERE id IN (SELECT id FROM operations
      WHERE (state IN ('succeeded','failed') OR acknowledged_at IS NOT NULL)
      ORDER BY started_at DESC LIMIT -1 OFFSET 10000)`);
  }

  setDetail(id: string, detail: Record<string, unknown>): void {
    this.db.prepare('UPDATE operations SET detail=? WHERE id=?').run(JSON.stringify(detail), id);
  }

  get(id: string): OperationRecord | undefined {
    return this.row(this.db.prepare('SELECT * FROM operations WHERE id=?').get(id));
  }
  /** 任务的操作记录：未确认的 running/unknown 一条不漏（上限 2000），已完成的历史只取最近 500 条；超出的用 truncated 说明。 */
  taskOperationPage(profileId: string, owner: string): { operations: OperationRecord[]; truncated: boolean } {
    const pending = this.db.prepare("SELECT * FROM operations WHERE profile_id=? AND owner=? AND state IN ('running','unknown') AND acknowledged_at IS NULL ORDER BY started_at DESC,id DESC LIMIT 2000").all(profileId, owner);
    const recent = this.db.prepare('SELECT * FROM operations WHERE profile_id=? AND owner=? ORDER BY started_at DESC,id DESC LIMIT 500').all(profileId, owner);
    const rows = new Map<string, Record<string, unknown>>();
    for (const row of [...recent, ...pending]) rows.set(String(row.id), row);
    const total = Number(this.db.prepare('SELECT COUNT(*) AS count FROM operations WHERE profile_id=? AND owner=?').get(profileId, owner)?.count);
    return { operations: [...rows.values()].map(row => this.row(row)!).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id)), truncated: total > rows.size };
  }
  taskOperations(profileId: string, owner: string): OperationRecord[] { return this.taskOperationPage(profileId, owner).operations; }

  list(profileId: string, state: string | undefined, offset: number, limit: number, acknowledged?: boolean) {
    const conditions = ['profile_id=?']; const parameters: Array<string | number> = [profileId];
    if (state !== undefined) { conditions.push('state=?'); parameters.push(state); }
    if (acknowledged !== undefined) conditions.push(acknowledged ? 'acknowledged_at IS NOT NULL' : 'acknowledged_at IS NULL');
    const where = conditions.join(' AND ');
    const count = this.db.prepare(`SELECT COUNT(*) AS count FROM operations WHERE ${where}`).get(...parameters)?.count as number;
    const rows = this.db.prepare(`SELECT * FROM operations WHERE ${where} ORDER BY started_at DESC,id DESC LIMIT ? OFFSET ?`)
      .all(...parameters, limit, offset);
    return { items: rows.map(row => this.row(row)!), total: count, nextOffset: offset + limit < count ? offset + limit : null };
  }

  protection() {
    const rows = this.db.prepare("SELECT profile_id,state,count(*) AS count FROM operations WHERE acknowledged_at IS NULL AND state IN ('running','unknown') GROUP BY profile_id,state").all();
    const profiles = new Map<string, { profileId: string; unknown: number; running: number }>();
    let unknown = 0, running = 0;
    for (const row of rows) {
      const id = String(row.profile_id), item = profiles.get(id) || { profileId: id, unknown: 0, running: 0 }, count = Number(row.count);
      if (row.state === 'unknown') { item.unknown += count; unknown += count; } else { item.running += count; running += count; }
      profiles.set(id, item);
    }
    return { unknown, running, profiles: [...profiles.values()] };
  }

  // 操作弹出的框已由同一调用方响应：动作确实发出了，不再算结果不明。错误码保留，记录里看得到经过了弹窗。
  settleDialog(id: string, state: 'succeeded' | 'failed') {
    return this.db.prepare("UPDATE operations SET state=? WHERE id=? AND state='unknown' AND acknowledged_at IS NULL AND error_code IN ('DIALOG_OPEN','DIALOG_MISMATCH')").run(state, id).changes > 0;
  }

  acknowledge(id: string): void {
    const record = this.get(id);
    if (!record) throw new BrowserError('OPERATION_NOT_FOUND', '操作记录不存在。');
    if (record.state === 'running') throw new BrowserError('OPERATION_RUNNING', '操作仍在运行，不能解除保护。');
    this.db.prepare('UPDATE operations SET acknowledged_at=? WHERE id=?').run(new Date().toISOString(), id);
  }

  acknowledgeTab(profileId: string, tabId: number): void {
    this.db.prepare("UPDATE operations SET acknowledged_at=? WHERE profile_id=? AND tab_id=? AND state='unknown'")
      .run(new Date().toISOString(), profileId, tabId);
  }

  // 某个配置当前未确认的运行中/未知操作：放弃离线配置时先给管理员看清楚要放弃什么。
  pendingOperations(profileId: string, limit = 50) {
    const where = "profile_id=? AND acknowledged_at IS NULL AND state IN ('running','unknown')";
    const counts = new Map(this.db.prepare(`SELECT state,count(*) AS count FROM operations WHERE ${where} GROUP BY state`).all(profileId).map(row => [String(row.state), Number(row.count)]));
    const items = this.db.prepare(`SELECT * FROM operations WHERE ${where} ORDER BY started_at DESC,id DESC LIMIT ?`).all(profileId, limit).map(row => this.row(row)!);
    return { unknown: counts.get('unknown') ?? 0, running: counts.get('running') ?? 0, items };
  }

  // 放弃一个不会再连接的配置：同一个事务里确认它全部未确认的 unknown 记录，并忘记配置本身（known_profiles；它再次连接时会重新登记）。
  // expectedUnknown 必须等于管理员预览时看到的数量，预览之后又出现新的待核查记录就拒绝；仍在运行的记录不能被放弃。只改数据库，不碰浏览器。
  abandonProfile(profileId: string, expectedUnknown: number) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { unknown, running } = this.pendingOperations(profileId, 0);
      if (running) throw new BrowserError('OPERATION_RUNNING', `该配置还有 ${running} 个操作仍在运行，不能放弃；等它们结束后再试。`, { phase: 'precondition', outcome: 'not_dispatched' });
      if (unknown !== expectedUnknown) throw new BrowserError('ABANDON_COUNT_CHANGED', `待核查记录从 ${expectedUnknown} 条变成了 ${unknown} 条；请重新预览，确认后再放弃。`, { phase: 'precondition', outcome: 'not_dispatched' });
      const acknowledged = Number(this.db.prepare("UPDATE operations SET acknowledged_at=? WHERE profile_id=? AND acknowledged_at IS NULL AND state='unknown'").run(new Date().toISOString(), profileId).changes);
      const forgotten = Number(this.db.prepare('DELETE FROM known_profiles WHERE id=?').run(profileId).changes) > 0;
      this.db.exec('COMMIT');
      return { acknowledged, forgotten };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  createClient(label: string, profiles: '*' | string[] = '*', readOnly = false, advancedTools = false) {
    const id = randomUUID(), token = randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO clients(id,label,token_hash,profiles,read_only,advanced_tools,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, label, tokenHash(token), JSON.stringify(profiles), readOnly ? 1 : 0, advancedTools ? 1 : 0, new Date().toISOString());
    return { id, token, label, profiles, readOnly, advancedTools };
  }

  setClientTools(id: string, advancedTools: boolean) {
    return this.db.prepare('UPDATE clients SET advanced_tools=? WHERE id=? AND revoked=0').run(advancedTools ? 1 : 0, id).changes > 0;
  }

  authenticate(token: string): Principal | undefined {
    const client = this.db.prepare('SELECT * FROM clients WHERE token_hash=? AND revoked=0').get(tokenHash(token));
    return client ? { id: String(client.id), label: String(client.label), admin: false,
      profiles: JSON.parse(String(client.profiles)) as '*' | string[], readOnly: client.read_only === 1, advancedTools: client.advanced_tools === 1 } : undefined;
  }


  listClients() {
    return this.db.prepare('SELECT id,label,profiles,read_only,advanced_tools,revoked,created_at FROM clients ORDER BY created_at').all()
      .map(row => ({ id: row.id, label: row.label, profiles: JSON.parse(String(row.profiles)), readOnly: row.read_only === 1, advancedTools: row.advanced_tools === 1, revoked: row.revoked === 1, createdAt: row.created_at }));
  }

  // 撤销后该客户端再也不能重试提交，它的去重收据同时释放，这是占满收据额度时的恢复路径。
  revokeClient(id: string) { const revoked = this.db.prepare('UPDATE clients SET revoked=1 WHERE id=?').run(id).changes > 0; if (revoked) this.db.prepare('DELETE FROM task_submissions WHERE principal_id=?').run(id); return revoked; }
  rememberProfile(profile: Pick<ProfileInfo, 'id' | 'label' | 'version'>) { this.db.prepare('INSERT INTO known_profiles(id,label,version,last_seen) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,version=excluded.version,last_seen=excluded.last_seen').run(profile.id, profile.label, profile.version, new Date().toISOString()); }
  // 配置断开时记下“最后在线时间”：last_seen 之前只在连接和改名时更新，长时间在线后断开会显得像很久以前就走了。
  touchProfile(id: string) { this.db.prepare('UPDATE known_profiles SET last_seen=? WHERE id=?').run(new Date().toISOString(), id); }
  agentUsage() { return this.db.prepare('SELECT agent_id,profile_id,last_used_at FROM agent_usage LIMIT 10000').all().map(row => ({ agentId: String(row.agent_id), profileId: String(row.profile_id), lastUsedAt: String(row.last_used_at) })); }
  recordAgentUsage(agentId: string, profileId: string, at: string) { this.db.prepare('INSERT INTO agent_usage (agent_id,profile_id,last_used_at) VALUES (?,?,?) ON CONFLICT(agent_id,profile_id) DO UPDATE SET last_used_at=excluded.last_used_at').run(agentId, profileId, at); }
  knownProfiles() { return this.db.prepare('SELECT id,label,version,last_seen AS lastSeen FROM known_profiles ORDER BY label LIMIT 1000').all().map(row => ({ id: String(row.id), label: String(row.label), version: String(row.version), lastSeen: String(row.lastSeen), online: false })); }
  principal(id: string): Principal | undefined {
    if (id.startsWith('remote:')) return this.remotePrincipals.get(id);
    const row = this.db.prepare('SELECT * FROM clients WHERE id=? AND revoked=0').get(id);
    return row ? { id, label: String(row.label), admin: false, profiles: JSON.parse(String(row.profiles)), readOnly: row.read_only === 1, advancedTools: row.advanced_tools === 1 } : undefined;
  }
  saveTask(task: { id: string; profileId: string; status: string; updatedAt: string }) {
    this.db.prepare('INSERT INTO task_records(id,profile_id,status,data,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data,updated_at=excluded.updated_at')
      .run(task.id, task.profileId, task.status, JSON.stringify(task), task.updatedAt);
    this.db.exec("DELETE FROM task_records WHERE id IN (SELECT id FROM task_records WHERE status IN ('succeeded','failed','cancelled','interrupted','needs_review') ORDER BY updated_at DESC LIMIT -1 OFFSET 500)");
  }
  taskSubmission(profileId:string,principalId:string,submissionId:string){return this.db.prepare('SELECT fingerprint,task_id FROM task_submissions WHERE profile_id=? AND principal_id=? AND submission_id=?').get(profileId,principalId,submissionId) as {fingerprint:string;task_id:string}|undefined;}
  hasLegacyRemoteSubmission(profileId: string, agentId: string, submissionId: string) {
    return !!this.db.prepare('SELECT 1 FROM task_submissions WHERE profile_id=? AND submission_id=? AND principal_id GLOB ? LIMIT 1')
      .get(profileId, submissionId, `remote:*:${agentId}`);
  }
  // TaskManager.submit 是同步的；它的调用点拿不到提交者身份，所以由服务层在同步调用期间设置上下文。
  asSubmitter<T>(principal: Pick<Principal, 'id' | 'admin' | 'submissionScope'>, work: () => T): T {
    const previous = this.submitter;
    this.submitter = { id: principal.submissionScope ?? principal.id, admin: principal.admin };
    try { return work(); } finally { this.submitter = previous; }
  }
  assertSubmissionCapacity() {
    const now = Date.now(), who = this.submitter && !this.submitter.admin ? this.submitter : undefined;
    const protectedBefore = new Date(now - RECEIPT_PROTECTED_MS).toISOString();
    this.db.prepare('DELETE FROM task_submissions WHERE created_at<?').run(new Date(now - RECEIPT_RETENTION_MS).toISOString());
    const count = (sql: string, ...parameters: string[]) => Number(this.db.prepare(sql).get(...parameters)!.count);
    const evict = (limit: number, principalId?: string) => this.db.prepare(`DELETE FROM task_submissions WHERE rowid IN (SELECT rowid FROM task_submissions WHERE created_at<? ${principalId ? 'AND principal_id=? ' : ''}ORDER BY created_at LIMIT ${limit})`).run(protectedBefore, ...(principalId ? [principalId] : []));
    const capacity = who ? RECEIPT_TOTAL - RECEIPT_ADMIN_RESERVE : RECEIPT_TOTAL;
    if (count('SELECT count(*) AS count FROM task_submissions') >= capacity) {
      evict(RECEIPT_TOTAL / 20);
      if (count('SELECT count(*) AS count FROM task_submissions') >= capacity) throw new BrowserError('SUBMISSION_CAPACITY', '任务去重凭据已满，且都还在 24 小时保护期内，暂时不能接受新的带 submissionId 的任务；未删除任何仍受保护的凭据。最早的凭据 24 小时后自动回收。期间可省略 submissionId 提交（失去断线重试去重），或由管理员撤销占用大量凭据的客户端。', { phase: 'precondition', outcome: 'not_dispatched' });
    }
    if (!who) return;
    const own = () => count('SELECT count(*) AS count FROM task_submissions WHERE principal_id=?', who.id);
    if (own() >= RECEIPT_PER_PRINCIPAL) {
      evict(RECEIPT_PER_PRINCIPAL / 20, who.id);
      if (own() >= RECEIPT_PER_PRINCIPAL) {
        const oldest = String(this.db.prepare('SELECT min(created_at) AS oldest FROM task_submissions WHERE principal_id=?').get(who.id)?.oldest ?? '');
        const free = oldest ? new Date(Date.parse(oldest) + RECEIPT_PROTECTED_MS).toISOString() : '24 小时后';
        throw new BrowserError('SUBMISSION_QUOTA', `此客户端已保留 ${RECEIPT_PER_PRINCIPAL} 个任务去重凭据（上限），都还在 24 小时保护期内；最早的一条在 ${free} 之后可回收。期间可省略 submissionId 提交（失去断线重试去重），或由管理员撤销该客户端以释放它的凭据。其他客户端不受影响。`, { phase: 'precondition', outcome: 'not_dispatched' });
      }
    }
  }
  saveNewTask(task:Parameters<StateStore['saveTask']>[0],submission:{principalId:string;id:string;fingerprint:string}){
    this.db.exec('BEGIN IMMEDIATE');
    try{
      // 旧运行时不理解稳定远程去重键；落盘首张此类收据时原子设置最低读取版本。
      if (submission.principalId.startsWith('remote-submission:')) this.raiseStateVersion(REMOTE_RECEIPT_STATE_VERSION);
      this.db.prepare('INSERT INTO task_submissions(profile_id,principal_id,submission_id,fingerprint,task_id,created_at) VALUES(?,?,?,?,?,?)').run(task.profileId,submission.principalId,submission.id,submission.fingerprint,task.id,new Date().toISOString());
      this.saveTask(task);this.db.exec('COMMIT');
    }
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  /** 启动时读到的损坏任务记录数：坏行只跳过，不阻止服务启动。 */
  skippedTaskRecords = 0;
  task(id: string): unknown { const row = this.db.prepare('SELECT data FROM task_records WHERE id=?').get(id); if (!row) return undefined; try { return JSON.parse(String(row.data)); } catch { return undefined; } }
  tasks(): unknown[] {
    const items: unknown[] = [];
    for (const row of this.db.prepare('SELECT data FROM task_records ORDER BY updated_at DESC LIMIT 600').all()) {
      try { const value = JSON.parse(String(row.data)); if (value && typeof value === 'object') items.push(value); else this.skippedTaskRecords++; } catch { this.skippedTaskRecords++; }
    }
    return items;
  }
  // 列表用：该配置最近的任务摘要（不含 steps，带 totalSteps），由触发器维护；详情和启动恢复仍读完整记录。
  taskSummaries(profileId: string): unknown[] { return this.db.prepare('SELECT summary FROM task_summaries WHERE profile_id=? ORDER BY updated_at DESC,id DESC LIMIT 600').all(profileId).map(row => JSON.parse(String(row.summary))); }
  saveWorkflow(value: StoredWorkflow, expectedRevision?: string) { return this.workflowStore.save(value, expectedRevision); }
  workflow(id: string, includeArchived = false) { return this.workflowStore.get(id, includeArchived); }
  workflows(profileId: string, archived = false) { return this.workflowStore.list(profileId, archived); }
  workflowPage(profileId: string, archived: boolean, offset: number, limit: number, summary: boolean) { return this.workflowStore.page(profileId, archived, offset, limit, summary); }
  workflowVersions(id: string) { return this.workflowStore.versions(id); }
  archiveWorkflow(id: string, profileId: string, expectedRevision: string, archived: boolean) { return this.workflowStore.archive(id, profileId, expectedRevision, archived); }
  workflowRevision(id: string, revision: string) { return this.workflowStore.revision(id, revision); }
  removeWorkflow(id: string, profileId: string, expectedRevision: string) { return this.workflowStore.remove(id, profileId, expectedRevision); }
  addArtifact(id: string, profileId: string | undefined, owner: string, extension: string, size: number) {
    this.db.prepare('INSERT INTO artifacts(id,profile_id,owner,extension,size,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, profileId ?? null, owner, extension, size, new Date().toISOString());
  }
  artifact(id: string) { return this.db.prepare('SELECT profile_id AS profileId,owner,extension,size FROM artifacts WHERE id=?').get(id); }
  resultBytes() { return Number(this.db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM artifacts').get()?.bytes); }
  // 结果的 owner 约定以“<主体 id>:”开头（HTTP、远程和任务调用都如此），按此前缀把结果归到提交者名下做配额。
  // 远程主体的直接调用以跨重连稳定的 submissionScope 作 owner 前缀，它的任务仍以当前连接的主体 id 为前缀；两个前缀互不相交，一起计入。
  principalResultBytes(principalId: string, stableScope?: string) {
    const prefixes = [principalId, ...(stableScope && stableScope !== principalId ? [stableScope] : [])].map(item => item + ':');
    return prefixes.reduce((sum, prefix) => sum + Number(this.db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM artifacts WHERE substr(owner,1,?)=?').get(prefix.length, prefix)?.bytes), 0);
  }
  listArtifacts() { return this.db.prepare('SELECT id,profile_id AS profileId,extension,size,created_at AS createdAt FROM artifacts ORDER BY created_at DESC LIMIT 1000').all(); }
  removeArtifact(id: string) { this.db.prepare('DELETE FROM artifacts WHERE id=?').run(id); }

  private row(row: Record<string, unknown> | undefined): OperationRecord | undefined {
    if (!row) return undefined;
    return { id: String(row.id), profileId: String(row.profile_id), tabId: row.tab_id as number | null,
      owner: String(row.owner), tool: String(row.tool), state: row.state as OperationState,
      startedAt: String(row.started_at), finishedAt: row.finished_at as string | null,
      errorCode: row.error_code as string | null, acknowledgedAt: row.acknowledged_at as string | null, ...(parsedDetail(row.detail)) };
  }

  close() { this.db.close(); }
}
