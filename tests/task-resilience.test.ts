import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, fakeProfile } from './helpers.js';
import { adminPrincipal } from '../src/auth.js';
import { randomUUID } from 'node:crypto';
import { startServer } from '../src/http-server.js';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const plan = { name: 'resilience', captureOnFailure: false, steps: [{ operation: 'page.action', args: { action: 'fill', selector: '#field', text: 'once' } }] };
async function ended(f: Awaited<ReturnType<typeof fixture>>, profileId: string, id: string) {
  for (let i = 0; i < 100; i++) { const task = f.service.tasks.get(profileId, id); if (['succeeded','failed','needs_review','interrupted'].includes(task.status)) return task; await pause(20); }
  throw new Error('Task did not finish');
}
test('步骤成功后任务日志暂时写入失败，不自动推进后续任务或重复点击', async () => {
  const f = await fixture(); let actions = 0, failed = false;
  const save = f.service.state.saveTask.bind(f.service.state);
  try {
    const p = await fakeProfile(f.config, 'disk', command => { if (command.operation === 'tabs.list') return [{ tabId: 1 }]; if (command.operation === 'page.action') actions++; return {}; });
    const first = f.service.tasks.submit(p.id, 1, plan, adminPrincipal), second = f.service.tasks.submit(p.id, 1, plan, adminPrincipal);
    f.service.state.saveTask = task => { if (task.id === first.id && (task as any).nextStep === 1 && !failed) { failed = true; throw new Error('fixture SQLITE_FULL'); } save(task); };
    await ended(f, p.id, first.id); await pause(300);
    assert.equal(actions, 1); assert.equal(f.service.tasks.get(p.id, first.id).nextStep, 1);
    assert.equal(f.service.tasks.get(p.id, first.id).reason, 'TASK_JOURNAL_FAILED'); assert.equal(f.service.tasks.get(p.id, second.id).status, 'paused');
    assert.throws(() => f.service.tasks.control(p.id, second.id, 'resume', adminPrincipal), { code: 'TASK_JOURNAL_FAILED' });
    assert.throws(() => f.service.tasks.submit(p.id, 1, plan, adminPrincipal), { code: 'TASK_JOURNAL_FAILED' });
  } finally { f.service.state.saveTask = save; await f.cleanup(); }
});
test('离线队列写入失败不会从调度定时器抛出，内存详情明确提示存储故障', async () => {
  const f = await fixture(), save = f.service.state.saveTask.bind(f.service.state);
  try {
    const job = f.service.tasks.submit('offline', 1, plan, adminPrincipal);
    f.service.state.saveTask = () => { throw new Error('fixture SQLITE_IOERR'); };
    assert.doesNotThrow(() => (f.service.tasks as any).pump());
    assert.equal(f.service.tasks.get('offline', job.id).reason, 'TASK_JOURNAL_FAILED');
    assert.equal((f.service.tasks.stats() as any).taskStorageFault, 'TASK_JOURNAL_FAILED');
    await pause(250);
    assert.equal((f.service.tasks.list('offline', 0, 10).items[0] as any).reason, 'TASK_JOURNAL_FAILED');
  } finally { f.service.state.saveTask = save; await f.cleanup(); }
});
test('持续任务日志故障保留已完成步骤，仍允许用户暂停原 Chrome', async () => {
  const f = await fixture(), save = f.service.state.saveTask.bind(f.service.state); let actions = 0, paused = 0;
  try {
    const p = await fakeProfile(f.config, 'permanent', command => {
      if (command.operation === 'tabs.list') return [{ tabId: 1 }];
      if (command.operation === 'page.action') { actions++; f.service.state.saveTask = () => { throw new Error('fixture disk unavailable'); }; }
      if (command.operation === 'profile.pause') paused++;
      return {};
    });
    const first = f.service.tasks.submit(p.id, 1, plan, adminPrincipal), second = f.service.tasks.submit(p.id, 1, plan, adminPrincipal);
    const task = await ended(f, p.id, first.id); await pause(250);
    assert.equal(task.status, 'needs_review'); assert.equal(task.nextStep, 1); assert.equal(task.steps[0]?.state, 'succeeded'); assert.equal(actions, 1);
    assert.equal(f.service.tasks.get(p.id, second.id).status, 'paused'); assert.equal(f.service.tasks.stats().activeTaskProfiles, 0);
    const stop = await f.service.invoke('chrome_pause_profile', { profileId: p.id }, 'user'); assert.equal(stop.ok, true); assert.equal(paused, 1);
  } finally { f.service.state.saveTask = save; await f.cleanup(); }
});
test('暂停账号时任务日志失败也必须把停止指令发送到原 Chrome', async () => {
  const f = await fixture(), save = f.service.state.saveTask.bind(f.service.state); let paused = 0, actions = 0;
  try {
    const p = await fakeProfile(f.config, 'pause', command => { if (command.operation === 'profile.pause') paused++; if (command.operation === 'page.action') actions++; return {}; });
    f.service.tasks.submit(p.id, 1, plan, adminPrincipal); f.service.state.saveTask = () => { throw new Error('fixture IOERR'); };
    const stopped = await f.service.invoke('chrome_pause_profile', { profileId: p.id }, 'user');
    assert.equal(stopped.ok, true); assert.equal(stopped.warnings?.[0]?.code, 'TASK_JOURNAL_FAILED'); assert.equal(paused, 1); assert.equal(actions, 0);
  } finally { f.service.state.saveTask = save; await f.cleanup(); }
});
test('重启后按任务 owner 找回尚未写入步骤的 operationId，恢复草稿保留未知保护', async () => {
  const f = await fixture(); let restarted: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const id = randomUUID(), profileId = randomUUID(), now = new Date().toISOString();
    f.service.state.saveTask({ id, profileId, principalId: adminPrincipal.id, name: 'crash', status: 'running', tabId: 1, initialTabId: 1, nextStep: 0, createdAt: now, updatedAt: now, visible: false, steps: [{ operation: 'page.action', state: 'running', startedAt: now }] } as any);
    const operationId = f.service.state.begin(profileId, 1, `${adminPrincipal.id}:task:${id}`, 'chrome_action');
    const foreign = f.service.state.begin('other-profile', 1, `${adminPrincipal.id}:task:${id}`, 'chrome_action');
    await f.close(); restarted = await startServer(f.config);
    const report = restarted.service.tasks.diagnostics(profileId, id); assert.equal(report.task.status, 'interrupted'); assert.equal(report.task.steps[0]?.operationId, undefined);
    assert.deepEqual(report.operations.map(item => item.id), [operationId]); assert.ok(!report.operations.some(item => item.id === foreign));
    const draft = restarted.service.tasks.recoveryDraft(profileId, id, 0); assert.equal(draft.operationsToCheck[0]?.id, operationId); assert.equal(restarted.service.state.get(operationId)?.acknowledgedAt, null);
  } finally { await restarted?.close(); await f.cleanup(); }
});
test('大量长标题标签不会阻塞普通任务；弹窗基线覆盖第 1000 个以后的旧标签', async () => {
  const f = await fixture(); let actions = 0;
  try {
    const tabs = Array.from({ length: 1100 }, (_, index) => ({ tabId: index + 1, title: '长标题'.repeat(50), url: 'https://example.test/' }));
    const p = await fakeProfile(f.config, 'many-tabs', command => {
      if (command.operation === 'tabs.list') return tabs;
      if (command.operation === 'tabs.wait') { assert.equal((command.args.excludeTabIds as number[]).length, 1100); assert.ok((command.args.excludeTabIds as number[]).includes(1100)); return { tabId: 1100 }; }
      if (command.operation === 'page.action') actions++;
      return {};
    });
    const first = f.service.tasks.submit(p.id, 1, plan, adminPrincipal);
    assert.equal((await ended(f, p.id, first.id)).status, 'succeeded');
    const second = f.service.tasks.submit(p.id, 1, { ...plan, steps: [...plan.steps, { operation: 'tabs.wait', args: {} }] }, adminPrincipal);
    assert.equal((await ended(f, p.id, second.id)).status, 'succeeded'); assert.equal(actions, 2);
  } finally { await f.cleanup(); }
});
test('流程参数展开在构造大字符串前检查预算，预览与运行均拒绝超额', async () => {
  const f = await fixture();
  try {
    const flow = f.service.tasks.saveWorkflow('profile', { ...plan, steps: [{ operation: 'page.action', args: { action: 'fill', selector: '#field', text: '{{内容}}'.repeat(80) } }], parameters: [{ name: '内容' }] });
    const parameters = { 内容: 'x'.repeat(100000) };
    assert.throws(() => f.service.tasks.preview('profile', flow.id, parameters), { code: 'WORKFLOW_EXPANSION_TOO_LARGE' });
    assert.throws(() => f.service.tasks.runWorkflow('profile', 1, flow.id, flow.revision, parameters, adminPrincipal), { code: 'WORKFLOW_EXPANSION_TOO_LARGE' });
    assert.equal(f.service.state.tasks().length, 0);
    assert.equal((f.service.tasks.preview('profile', flow.id, { 内容: '$&\\\"中' }).plan.steps[0]!.args as any).text, '$&\\\"中'.repeat(80));
  } finally { await f.cleanup(); }
});
