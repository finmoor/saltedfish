import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, fakeProfile } from './helpers.js';

// chrome_workflow_run 的幂等重试：响应丢失期间流程被编辑或归档，同样的请求（同一 submissionId、同一版本、同样的参数）
// 必须拿回原任务收据，而不是一个看起来像“没运行”的 WORKFLOW_CHANGED / WORKFLOW_ARCHIVED，诱导调用方换身份再运行一次。
const definition = (name = '流程', value = '{{内容}}') => ({ name, captureOnFailure: false, parameters: [{ name: '内容' }], steps: [{ operation: 'page.action', args: { action: 'fill', selector: '#input', text: value } }] });
async function until(predicate: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function harness(t: { after: (callback: () => Promise<void>) => void }) {
  const f = await fixture(); t.after(() => f.cleanup());
  let fills = 0;
  const profile = await fakeProfile(f.config, 'A', command => { if (command.operation === 'tabs.list') return [{ tabId: 7 }, { tabId: 8 }]; if (command.operation === 'page.action') fills++; return {}; });
  const flow = f.service.tasks.saveWorkflow(profile.id, definition());
  const run = (overrides: Record<string, unknown> = {}, principal?: Parameters<typeof f.service.invoke>[3]) =>
    f.service.invoke('chrome_workflow_run', { profileId: profile.id, tabId: 7, workflowId: flow.id, revision: flow.revision, parameters: { 内容: 'hello' }, ...overrides }, 'caller', principal);
  const finished = (taskId: string) => until(() => f.service.tasks.get(profile.id, taskId).status === 'succeeded');
  return { f, profile, flow, run, finished, fills: () => fills };
}

test('流程在响应丢失期间被编辑：同样的重试返回原任务（deduplicated），不重复执行', async t => {
  const h = await harness(t), submissionId = randomUUID();
  const first = await h.run({ submissionId }); assert.equal(first.ok, true, JSON.stringify(first.error)); const taskId = (first.data as { id: string }).id;
  await h.finished(taskId); assert.equal(h.fills(), 1);
  h.f.service.tasks.saveWorkflow(h.profile.id, definition('新版本', 'changed {{内容}}'), h.flow.id, h.flow.revision);
  const retry = await h.run({ submissionId });
  assert.equal(retry.ok, true, JSON.stringify(retry.error)); assert.equal((retry.data as { id: string }).id, taskId); assert.equal((retry.data as { deduplicated?: boolean }).deduplicated, true);
  assert.equal(h.fills(), 1, '没有重复执行'); assert.equal(h.f.service.tasks.list(h.profile.id, 0, 10).total, 1);
});

test('流程在响应丢失期间被归档：同样的重试返回原任务；没有收据的新请求仍被归档状态拒绝', async t => {
  const h = await harness(t), submissionId = randomUUID();
  const first = await h.run({ submissionId }); const taskId = (first.data as { id: string }).id; await h.finished(taskId);
  h.f.service.tasks.archiveWorkflow(h.profile.id, h.flow.id, h.flow.revision, true);
  const retry = await h.run({ submissionId });
  assert.equal(retry.ok, true, JSON.stringify(retry.error)); assert.equal((retry.data as { id: string }).id, taskId); assert.equal((retry.data as { deduplicated?: boolean }).deduplicated, true);
  assert.equal((await h.run({ submissionId: randomUUID() })).error?.code, 'WORKFLOW_ARCHIVED', '没有原收据的请求仍然拒绝运行已归档的流程');
  assert.equal((await h.run()).error?.code, 'WORKFLOW_ARCHIVED'); assert.equal(h.fills(), 1);
});

test('常规校验不变：没有原收据时，流程被编辑后的旧版本请求仍然是 WORKFLOW_CHANGED，流程不存在仍然是 WORKFLOW_NOT_FOUND', async t => {
  const h = await harness(t);
  h.f.service.tasks.saveWorkflow(h.profile.id, definition('新版本'), h.flow.id, h.flow.revision);
  for (const overrides of [{}, { submissionId: randomUUID() }]) assert.equal((await h.run(overrides)).error?.code, 'WORKFLOW_CHANGED');
  assert.equal((await h.run({ workflowId: randomUUID(), submissionId: randomUUID() })).error?.code, 'WORKFLOW_NOT_FOUND');
  assert.equal(h.fills(), 0);
});

test('同一个 submissionId 的内容必须一致：参数、标签页或版本不同都是 TASK_SUBMISSION_CONFLICT，流程变更后也一样，不会被当成重试', async t => {
  const h = await harness(t), submissionId = randomUUID();
  const first = await h.run({ submissionId }); await h.finished((first.data as { id: string }).id);
  const next = h.f.service.tasks.saveWorkflow(h.profile.id, definition('新版本'), h.flow.id, h.flow.revision);
  for (const [what, overrides] of [['参数不同', { parameters: { 内容: 'other' } }], ['标签页不同', { tabId: 8 }], ['改用新版本重新运行', { revision: next.revision }]] as const) {
    const result = await h.run({ submissionId, ...overrides });
    assert.equal(result.error?.code, 'TASK_SUBMISSION_CONFLICT', what); assert.equal(result.error?.outcome, 'not_dispatched', what);
  }
  assert.equal(h.fills(), 1);
});

test('原版本已读不到（流程被永久删除）时无法验证内容，不冒充重试：回到常规校验', async t => {
  const h = await harness(t), submissionId = randomUUID();
  const first = await h.run({ submissionId }); await h.finished((first.data as { id: string }).id);
  const archived = h.f.service.tasks.archiveWorkflow(h.profile.id, h.flow.id, h.flow.revision, true);
  assert.equal(h.f.service.state.removeWorkflow(h.flow.id, h.profile.id, archived.revision).removed, true);
  assert.equal((await h.run({ submissionId })).error?.code, 'WORKFLOW_NOT_FOUND'); assert.equal(h.fills(), 1);
});

test('收据按提交者隔离：另一个客户端用同一个 submissionId 不会拿到别人的任务', async t => {
  const h = await harness(t), submissionId = randomUUID();
  const first = await h.run({ submissionId }); await h.finished((first.data as { id: string }).id);
  h.f.service.tasks.saveWorkflow(h.profile.id, definition('新版本'), h.flow.id, h.flow.revision);
  const other = h.f.service.state.authenticate(h.f.service.state.createClient('另一个客户端').token)!;
  assert.equal((await h.run({ submissionId }, other)).error?.code, 'WORKFLOW_CHANGED', '别人的收据不是你的收据');
});
