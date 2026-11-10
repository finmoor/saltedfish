import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, fakeProfile } from './helpers.js';
import { adminPrincipal } from '../src/auth.js';
import { workflowDefinition } from '../src/tools.js';

const definition = (name = '流程', value = '{{内容}}') => ({ name, captureOnFailure: false, parameters: [{ name: '内容' }], steps: [{ operation: 'page.action', args: { action: 'fill', selector: '#input', text: value } }] });
test('流程编辑有版本冲突保护，历史恢复追加版本，归档可恢复并限定永久删除', async () => {
  const f = await fixture(), profileId = randomUUID();
  try {
    const first = f.service.tasks.saveWorkflow(profileId, definition()); assert.equal(first.version, 1);
    const second = f.service.tasks.saveWorkflow(profileId, definition('更新'), first.id, first.revision); assert.equal(second.version, 2);
    const summary = f.service.tasks.workflows(profileId, 0, 10, false, true).items[0]!;
    assert.equal((summary as any).stepCount, 1); assert.equal((summary.definition as any).steps, undefined);
    assert.throws(() => f.service.tasks.saveWorkflow(profileId, definition('过期编辑'), first.id, first.revision), { code: 'WORKFLOW_CHANGED' });
    assert.equal(f.service.tasks.getWorkflow(profileId, first.id, first.revision).definition.name, '流程');
    const restored = f.service.tasks.restoreWorkflow(profileId, first.id, first.revision, second.revision); assert.equal(restored.version, 3); assert.equal(restored.definition.name, '流程'); assert.notEqual(restored.revision, first.revision);
    const archived = f.service.tasks.archiveWorkflow(profileId, first.id, restored.revision, true);
    assert.equal(f.service.tasks.workflows(profileId, 0, 50).total, 0); assert.equal(f.service.tasks.workflows(profileId, 0, 50, true).total, 1);
    assert.equal(f.service.state.workflow(first.id), undefined, '旧版可见的活动集合不应包含归档流程');
    assert.throws(() => f.service.tasks.runWorkflow(profileId, 1, first.id, archived.revision, { 内容: 'value' }, adminPrincipal), { code: 'WORKFLOW_ARCHIVED' });
    const active = f.service.tasks.archiveWorkflow(profileId, first.id, archived.revision, false); assert.equal(active.version, 3);
    assert.throws(() => f.service.state.removeWorkflow(first.id, profileId, active.revision), { code: 'WORKFLOW_NOT_ARCHIVED' });
    const final = f.service.tasks.archiveWorkflow(profileId, first.id, active.revision, true);
    assert.equal(f.service.tasks.workflowHistory(profileId, first.id).versions.length, 3);
    assert.equal(f.service.state.removeWorkflow(first.id, profileId, final.revision).removed, true);
    assert.throws(() => f.service.tasks.getWorkflow(profileId, first.id), { code: 'WORKFLOW_NOT_FOUND' }); assert.equal(f.service.state.workflowVersions(first.id).length, 0);
  } finally { await f.cleanup(); }
});

test('beta.3 旧流程按第一版读取，首次编辑保存原版本且不破坏内容', async () => {
  const f = await fixture(), profileId = randomUUID();
  try {
    const legacy = { id: randomUUID(), profileId, createdAt: '2026-10-01T00:00:00Z', revision: 'legacy-hash', definition: workflowDefinition.parse(definition('旧流程')) };
    (f.service.state as any).db.prepare('INSERT INTO workflows(id,profile_id,data,created_at) VALUES(?,?,?,?)').run(legacy.id, profileId, JSON.stringify(legacy), legacy.createdAt);
    assert.equal(f.service.tasks.workflowHistory(profileId, legacy.id).versions[0]!.version, 1);
    const next = f.service.tasks.saveWorkflow(profileId, definition('新版'), legacy.id, legacy.revision); assert.equal(next.version, 2);
    assert.deepEqual(f.service.tasks.getWorkflow(profileId, legacy.id, legacy.revision).definition, legacy.definition);
    assert.equal(f.service.tasks.workflowHistory(profileId, legacy.id).versions.length, 2);
  } finally { await f.cleanup(); }
});

test('复制和历史读取严格限制两个账号的授权，只读客户端不能修改', async () => {
  const f = await fixture(), a = randomUUID(), b = randomUUID();
  try {
    const flow = f.service.tasks.saveWorkflow(a, definition());
    const grant = f.service.state.createClient('a-only', [a]), principal = f.service.state.authenticate(grant.token)!;
    const copied = await f.service.invoke('chrome_workflow_copy', { profileId: a, workflowId: flow.id, toProfileId: b, name: '副本' }, 'one', principal);
    assert.equal(copied.error?.code, 'PROFILE_NOT_AUTHORIZED'); assert.equal(f.service.state.workflows(b).length, 0);
    const both = f.service.state.createClient('both', [a, b]), writer = f.service.state.authenticate(both.token)!;
    const result = await f.service.invoke('chrome_workflow_copy', { profileId: a, workflowId: flow.id, toProfileId: b, name: '副本' }, 'one', writer);
    assert.equal(result.ok, true); assert.equal((result.data as any).profileId, b); assert.notEqual((result.data as any).id, flow.id);
    assert.equal((await f.service.invoke('chrome_workflow_get', { profileId: a, workflowId: (result.data as any).id }, 'one', principal)).error?.code, 'WORKFLOW_NOT_FOUND');
    assert.equal((await f.service.invoke('chrome_workflow_archive', { profileId: a, workflowId: flow.id, expectedRevision: flow.revision, archived: true }, 'one', { ...principal, readOnly: true })).error?.code, 'CLIENT_READ_ONLY');
  } finally { await f.cleanup(); }
});

test('活动流程容量可通过归档腾出，版本历史满额时拒绝修改而保留原值', async () => {
  const f = await fixture(), id = randomUUID();
  try {
    const first = f.service.tasks.saveWorkflow(id, definition('first'));
    for (let i = 1; i < 100; i++) f.service.tasks.saveWorkflow(id, definition(`流程 ${i}`));
    assert.throws(() => f.service.tasks.saveWorkflow(id, definition('overflow')), { code: 'WORKFLOW_CAPACITY' });
    f.service.tasks.archiveWorkflow(id, first.id, first.revision, true); const editing = f.service.tasks.saveWorkflow(id, definition('replacement'));
    let current = editing;
    for (let i = 2; i <= 50; i++) current = f.service.tasks.saveWorkflow(id, definition(`版本 ${i}`), editing.id, current.revision);
    assert.throws(() => f.service.tasks.saveWorkflow(id, definition('over'), editing.id, current.revision), { code: 'WORKFLOW_VERSION_CAPACITY' });
    assert.equal(f.service.tasks.getWorkflow(id, editing.id).version, 50); assert.equal(f.service.tasks.getWorkflow(id, editing.id).definition.name, '版本 50');
    const archived = f.service.tasks.archiveWorkflow(id, editing.id, current.revision, true); assert.ok(archived.archivedAt);
    assert.equal(f.service.tasks.archiveWorkflow(id, editing.id, archived.revision, false).version, 50);
  } finally { await f.cleanup(); }
});

test('诊断与恢复草稿保留原版本引用，排除运行参数，不自动解除未知保护', async () => {
  const f = await fixture();
  try {
    const p = await fakeProfile(f.config, 'recovery', command => {
      if (command.operation === 'tabs.list') return [{ tabId: 1 }];
      if (command.operation === 'page.wait') { p.socket.send(JSON.stringify({ type: 'result', id: command.id, error: { code: 'WAIT_TIMEOUT', message: 'fixture stopped' } })); return new Promise(() => {}); }
      return {};
    });
    const def = { ...definition(), steps: [...definition().steps, { operation: 'page.wait', args: { expression: 'window.finish' } }] };
    const flow = f.service.tasks.saveWorkflow(p.id, def);
    const job = f.service.tasks.runWorkflow(p.id, 1, flow.id, flow.revision, { 内容: 'PRIVATE-RUNTIME-VALUE' }, adminPrincipal);
    for (let i = 0; i < 100 && f.service.tasks.get(p.id, job.id).status !== 'needs_review'; i++) await new Promise(resolve => setTimeout(resolve, 20));
    const report = f.service.tasks.diagnostics(p.id, job.id); assert.equal(report.task.status, 'needs_review'); assert.ok(!JSON.stringify(report).includes('PRIVATE-RUNTIME-VALUE'));
    const draft = f.service.tasks.recoveryDraft(p.id, job.id, 1); assert.equal(draft.steps.length, 1); assert.equal(draft.source?.revision, flow.revision); assert.equal(draft.operationsToCheck.length, 1);
    f.service.tasks.saveWorkflow(p.id, definition('后来修改'), flow.id, flow.revision);
    assert.equal(f.service.tasks.getWorkflow(p.id, flow.id, draft.source!.revision).definition.steps.length, 2);
    assert.equal(f.service.state.get(draft.operationsToCheck[0]!.id)?.acknowledgedAt, null);
    assert.throws(() => f.service.tasks.diagnostics('other', job.id), { code: 'TASK_NOT_FOUND' });
    assert.throws(() => f.service.tasks.recoveryDraft(p.id, job.id, 2), { code: 'NO_REMAINING_STEPS' });
  } finally { await f.cleanup(); }
});
