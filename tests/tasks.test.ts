import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, fakeProfile, testDirectory } from './helpers.js';
import { adminPrincipal } from '../src/auth.js';
import { StateStore } from '../src/state-store.js';
import { TaskManager, type TaskRecord } from '../src/tasks.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const plan = (text: string) => ({ name: '测试流程', captureOnFailure: false, steps: [{ operation: 'page.action', args: { action: 'fill', selector: '#field', text } }] });
async function until<T>(read: () => T, accept: (value: T) => boolean): Promise<T> { for (let i = 0; i < 150; i++) { const value = read(); if (accept(value)) return value; await sleep(20); } throw new Error('Test condition timeout'); }
const ended = (task: TaskRecord) => ['succeeded', 'failed', 'needs_review', 'cancelled', 'interrupted'].includes(task.status);

test('同账号 FIFO 串行，另一账号独立推进，任务历史不保存运行输入', async () => {
  const f = await fixture(); let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; }), calls: string[] = [];
  try {
    const a = await fakeProfile(f.config, 'A', async command => {
      if (command.operation === 'tabs.list') return [{ tabId: 1 }];
      if (command.operation === 'page.action') { calls.push(String(command.args.text)); if (command.args.text === 'secret-first') await gate; }
      return {};
    });
    const b = await fakeProfile(f.config, 'B', command => command.operation === 'tabs.list' ? [{ tabId: 1 }] : {});
    const first = f.service.tasks.submit(a.id, 1, plan('secret-first'), adminPrincipal);
    const second = f.service.tasks.submit(a.id, 1, plan('secret-second'), adminPrincipal);
    const other = f.service.tasks.submit(b.id, 1, plan('other'), adminPrincipal);
    await until(() => f.service.tasks.get(b.id, other.id), task => task.status === 'succeeded');
    assert.equal(f.service.tasks.get(a.id, second.id).status, 'queued');
    unblock(); await until(() => f.service.tasks.get(a.id, second.id), ended);
    assert.deepEqual(calls, ['secret-first', 'secret-second']);
    assert.equal(f.service.tasks.get(a.id, first.id).status, 'succeeded');
    const persisted = JSON.stringify(f.service.state.tasks()); assert.ok(!persisted.includes('secret-first') && !persisted.includes('#field'));
  } finally { unblock(); await f.cleanup(); }
});

test('暂停在当前步骤结束后生效，继续不重复已完成步骤；取消排队任务不执行', async () => {
  const f = await fixture(); let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; }); let clicks = 0;
  try {
    const profile = await fakeProfile(f.config, 'A', async command => { if (command.operation === 'tabs.list') return [{ tabId: 1 }]; if (command.operation === 'page.action') { clicks++; if (clicks === 1) await gate; } return {}; });
    const p = plan('not-stored'); p.steps.push(...plan('next').steps);
    const job = f.service.tasks.submit(profile.id, 1, p, adminPrincipal);
    await until(() => clicks, value => value === 1);
    f.service.tasks.control(profile.id, job.id, 'pause', adminPrincipal); unblock();
    await until(() => f.service.tasks.get(profile.id, job.id), value => value.status === 'paused');
    assert.equal(clicks, 1);
    f.service.tasks.control(profile.id, job.id, 'resume', adminPrincipal);
    await until(() => f.service.tasks.get(profile.id, job.id), ended); assert.equal(clicks, 2);
    const cancel = f.service.tasks.submit(profile.id, 1, plan('cancel'), adminPrincipal);
    f.service.tasks.control(profile.id, cancel.id, 'cancel', adminPrincipal);
    await sleep(250); assert.equal(clicks, 2); assert.equal(f.service.tasks.get(profile.id, cancel.id).status, 'cancelled');
  } finally { unblock(); await f.cleanup(); }
});

test('任务按授权和创建者隔离，撤销授权阻止下一步', async () => {
  const f = await fixture(); let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; }); let actions = 0;
  try {
    const p = await fakeProfile(f.config, 'scope', async command => { if (command.operation === 'tabs.list') return [{ tabId: 1 }]; if (command.operation === 'page.action') { actions++; await gate; } return {}; });
    const grant = f.service.state.createClient('writer', [p.id]), principal = f.service.state.authenticate(grant.token)!;
    const reader = f.service.state.createClient('reader', [p.id], true), readPrincipal = f.service.state.authenticate(reader.token)!;
    assert.equal((await f.service.invoke('chrome_task_submit', { profileId: p.id, tabId: 1, ...plan('x') }, 'r', readPrincipal)).error?.code, 'CLIENT_READ_ONLY');
    assert.equal((await f.service.invoke('chrome_tasks', { profileId: 'not-allowed' }, 'r', principal)).error?.code, 'PROFILE_NOT_AUTHORIZED');
    const two = plan('one'); two.steps.push(...plan('two').steps);
    const result = await f.service.invoke('chrome_task_submit', { profileId: p.id, tabId: 1, ...two }, 'r', principal); const id = (result.data as TaskRecord).id;
    await until(() => actions, value => value === 1);
    const otherGrant = f.service.state.createClient('other-writer', [p.id]);
    const stranger = f.service.state.authenticate(otherGrant.token)!;
    assert.equal((await f.service.invoke('chrome_task_control', { profileId: p.id, taskId: id, action: 'cancel' }, 'r', stranger)).error?.code, 'TASK_NOT_OWNED');
    f.service.state.revokeClient(grant.id); unblock();
    const task = await until(() => f.service.tasks.get(p.id, id), ended); assert.equal(task.reason, 'CLIENT_AUTHORIZATION_FAILED'); assert.equal(actions, 1);
    assert.equal(f.service.broker.stats().leases, 0);
  } finally { unblock(); await f.cleanup(); }
});

test('流程参数逐字段替换，拒绝 JS 插值、临时引用、跨账号和错误版本', async () => {
  const f = await fixture();
  try {
    const p = await fakeProfile(f.config, 'scope', command => command.operation === 'tabs.list' ? [{ tabId: 1 }] : {});
    const flow = f.service.tasks.saveWorkflow(p.id, { ...plan('{{query}}'), parameters: [{ name: 'query' }] });
    const payload = '\");window.sideEffect=true;//';
    const preview = f.service.tasks.preview(p.id, flow.id, { query: payload });
    assert.equal((preview.plan.steps[0]!.args as any).text, payload);
    assert.throws(() => f.service.tasks.preview('other', flow.id, { query: 'x' }), /此账号/);
    assert.throws(() => f.service.tasks.runWorkflow(p.id, 1, flow.id, 'wrong', { query: 'x' }, adminPrincipal), /版本/);
    assert.throws(() => f.service.tasks.saveWorkflow(p.id, { name: 'unsafe', steps: [{ operation: 'page.evaluate', args: { expression: '{{query}}' } }], parameters: [{ name: 'query' }] }), /JavaScript/);
    assert.throws(() => f.service.tasks.saveWorkflow(p.id, { name: 'ref', steps: [{ operation: 'page.action', args: { action: 'click', ref: 'stale' } }] }), /临时|ref/);
    const job = f.service.tasks.runWorkflow(p.id, 1, flow.id, flow.revision, { query: payload }, adminPrincipal);
    assert.equal((await until(() => f.service.tasks.get(p.id, job.id), ended)).status, 'succeeded');
    assert.ok(!JSON.stringify(f.service.state.tasks()).includes('sideEffect'));
  } finally { await f.cleanup(); }
});

test('重启遗留的任务仅标记中断，不保存运行计划或自动重放', async () => {
  const temp = await testDirectory(); let state = new StateStore(temp.directory); let manager: TaskManager | undefined; let calls = 0;
  try {
    state.saveTask({ id: 'interrupted-test', profileId: 'profile', status: 'running', updatedAt: new Date().toISOString(), steps: [{ state: 'running', operation: 'page.action' }] } as any);
    state.close(); state = new StateStore(temp.directory);
    manager = new TaskManager(state, async () => { calls++; return { ok: true }; }, () => undefined, async () => []);
    await sleep(300); assert.equal(calls, 0);
    const task = manager.get('profile', 'interrupted-test'); assert.equal(task.status, 'interrupted'); assert.equal(task.steps[0]!.state, 'unknown');
    assert.throws(() => manager!.control('profile', task.id, 'resume', adminPrincipal), /不能自动重跑/);
  } finally { manager?.stopScheduling(); await manager?.drain(); state.close(); await temp.cleanup(); }
});

test('离线配置只暂停自己的队列，显式继续后仍使用原配置', async () => {
  const f = await fixture();
  try {
    const p = await fakeProfile(f.config, 'A', command => command.operation === 'tabs.list' ? [{ tabId: 1 }] : {});
    const waiting = f.service.tasks.submit('offline', 1, plan('pending'), adminPrincipal);
    const active = f.service.tasks.submit(p.id, 1, plan('online'), adminPrincipal);
    await until(() => f.service.tasks.get(p.id, active.id), ended);
    assert.equal(f.service.tasks.get('offline', waiting.id).status, 'paused');
    await fakeProfile(f.config, 'offline', command => command.operation === 'tabs.list' ? [{ tabId: 1 }] : {}, '00000000-0000-4000-8000-000000000001');
    assert.throws(() => f.service.tasks.control('offline', waiting.id, 'resume', adminPrincipal), { code: 'PROFILE_OFFLINE' });
  } finally { await f.cleanup(); }
});

test('明确跟随新标签页，失败记录截图并暂停同账号后续任务', async () => {
  const f = await fixture(); let opened = false; const actions: number[] = [];
  try {
    const p = await fakeProfile(f.config, 'popup', command => {
      if (command.operation === 'tabs.list') return opened ? [{ tabId: 1 }, { tabId: 2, openerTabId: 1 }] : [{ tabId: 1 }];
      if (command.operation === 'page.action') { actions.push(Number(command.args.tabId)); opened = true; }
      if (command.operation === 'tabs.wait') { assert.equal(command.args.openerTabId, 1); assert.deepEqual(command.args.excludeTabIds, [1]); return { tabId: 2 }; }
      return {};
    });
    const job = f.service.tasks.submit(p.id, 1, { name: 'popup', steps: [plan('open').steps[0], { operation: 'tabs.wait', args: {} }, plan('next').steps[0]] }, adminPrincipal);
    assert.equal((await until(() => f.service.tasks.get(p.id, job.id), ended)).status, 'succeeded'); assert.deepEqual(actions, [1, 2]);
    const bad = await fakeProfile(f.config, 'bad', command => {
      if (command.operation === 'tabs.list') return [{ tabId: 1 }];
      if (command.operation === 'page.screenshot') return { mimeType: 'image/png', data: 'dGVzdA==' };
      return { completed: true };
    });
    const failed = f.service.tasks.submit(bad.id, 1, { name: 'missing file', steps: [{ operation: 'page.upload', args: { selector: '#upload', paths: [path.join(f.config.dataDir, 'absent.txt')] } }] }, adminPrincipal);
    const later = f.service.tasks.submit(bad.id, 1, plan('must-not-run'), adminPrincipal);
    const result = await until(() => f.service.tasks.get(bad.id, failed.id), task => !!task.screenshotArtifactId);
    assert.equal(result.status, 'failed'); assert.equal(result.steps[0]!.outcome,'not_dispatched'); assert.equal(result.steps[0]!.operationId,undefined); assert.equal(f.service.tasks.get(bad.id, later.id).status, 'paused');
    assert.ok((await readFile(path.join(f.config.dataDir, 'results', `${result.screenshotArtifactId}.png`))).length);
  } finally { await f.cleanup(); }
});
