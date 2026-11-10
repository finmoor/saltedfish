import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, fakeProfile } from './helpers.js';
import { adminPrincipal } from '../src/auth.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function finished(f: Awaited<ReturnType<typeof fixture>>, profileId: string, id: string) {
  for (let i = 0; i < 200; i++) { const job = f.service.tasks.get(profileId, id); if (['succeeded','failed','needs_review','interrupted','cancelled'].includes(job.status)) return job; await wait(20); }
  throw new Error('Task did not terminate');
}
const plan = { name: '连接切换验证', captureOnFailure: false, steps: [
  { operation: 'page.action', args: { action: 'fill', selector: '#x', text: 'first' } },
  { operation: 'page.action', args: { action: 'fill', selector: '#x', text: 'must-not-reach-new-connection' } },
] };
test('任务在排队时绑定连接，尚未执行第一步也不能迁移到重连连接', async () => {
  const f = await fixture(); let dispatched = 0;
  try {
    const old = await fakeProfile(f.config, 'old', command => command.operation === 'tabs.list' ? [{ tabId: 1 }] : {});
    const job = f.service.tasks.submit(old.id, 1, plan, adminPrincipal);
    f.service.tasks.control(old.id, job.id, 'pause', adminPrincipal);
    old.socket.terminate(); await wait(20);
    await fakeProfile(f.config, 'new', command => { dispatched++; return command.operation === 'tabs.list' ? [{ tabId: 1 }] : {}; }, old.id);
    assert.throws(() => f.service.tasks.control(old.id, job.id, 'resume', adminPrincipal), { code: 'CONNECTION_CHANGED' });
    assert.equal(dispatched, 0); assert.equal(f.service.tasks.get(old.id, job.id).nextStep, 0); assert.equal(f.service.tasks.stats().queuedPlanBytes, 0);
  } finally { await f.cleanup(); }
});

test('暂停期间重连不能继续旧任务，已完成步骤不会重复执行', async () => {
  const f = await fixture(); let release!: () => void; let seen = false; let newActions = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const old = await fakeProfile(f.config, 'old', async command => { if (command.operation === 'tabs.list') return [{ tabId: 1 }]; if (command.operation === 'page.action') { seen = true; await held; } return {}; });
    const job = f.service.tasks.submit(old.id, 1, plan, adminPrincipal);
    for (let i = 0; i < 100 && !seen; i++) await wait(10); assert.ok(seen);
    f.service.tasks.control(old.id, job.id, 'pause', adminPrincipal); release();
    for (let i = 0; i < 100 && f.service.tasks.get(old.id, job.id).status !== 'paused'; i++) await wait(10);
    old.socket.terminate(); await wait(20);
    await fakeProfile(f.config, 'new', command => { if (command.operation === 'tabs.list') return [{ tabId: 1 }]; if (command.operation === 'page.action') newActions++; return {}; }, old.id);
    assert.throws(() => f.service.tasks.control(old.id, job.id, 'resume', adminPrincipal), { code: 'CONNECTION_CHANGED' });
    assert.equal(f.service.tasks.get(old.id, job.id).status, 'interrupted'); assert.equal(newActions, 0);
    assert.equal(f.service.tasks.get(old.id, job.id).nextStep, 1);
  } finally { release(); await f.cleanup(); }
});

test('文件预检的异步间隙重连，上传仍绑定原连接且不会发送', async () => {
  const f = await fixture(); let uploads = 0;
  try {
    const old = await fakeProfile(f.config, 'old', command => command.operation === 'tabs.list' ? [{ tabId: 1 }] : {});
    const file = path.join(f.config.dataDir, 'test.txt'); await writeFile(file, 'fixture');
    const check = (f.service as any).checkFiles.bind(f.service);
    (f.service as any).checkFiles = async (files: string[], principal: unknown) => {
      await check(files, principal); old.socket.terminate(); await wait(20);
      await fakeProfile(f.config, 'new', command => { if (command.operation === 'page.upload') uploads++; return {}; }, old.id);
    };
    const job = f.service.tasks.submit(old.id, 1, { name: 'upload', captureOnFailure: false, steps: [{ operation: 'page.upload', args: { selector: '#file', paths: [file] } }] }, adminPrincipal);
    assert.equal((await finished(f, old.id, job.id)).reason, 'CONNECTION_CHANGED'); assert.equal(uploads, 0);
  } finally { await f.cleanup(); }
});

test('队列计划有字节上限，拒绝超大输入且不留下任务', async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.service.tasks.submit('offline', 1, { name: 'oversize', steps: [{ operation: 'page.action', args: { action: 'fill', selector: '#x', text: 'x'.repeat(2 * 1024 * 1024) } }] }, adminPrincipal), { code: 'TASK_PLAN_TOO_LARGE' });
    assert.equal(f.service.tasks.stats().queuedPlanBytes, 0); assert.equal(f.service.state.tasks().length, 0);
  } finally { await f.cleanup(); }
});

test('队列步骤之间更换同号配置连接，剩余动作不得派发到新连接', async () => {
  const f = await fixture(); const oldCalls: string[] = [], newCalls: string[] = []; let claims = 0;
  try {
    const old = await fakeProfile(f.config, 'old', command => { if (command.operation === 'tabs.list') return [{ tabId: 1 }]; if (command.operation === 'page.action') oldCalls.push(String(command.args.text)); return {}; });
    const invoke = f.service.invoke.bind(f.service);
    f.service.invoke = async (...args: Parameters<typeof f.service.invoke>) => {
      if (args[0] === 'chrome_claim_tab' && ++claims === 2) {
        old.socket.terminate(); await wait(20);
        await fakeProfile(f.config, 'new', command => { if (command.operation === 'tabs.list') return [{ tabId: 1 }]; if (command.operation === 'page.action') newCalls.push(String(command.args.text)); return {}; }, old.id);
      }
      return invoke(...args);
    };
    const job = f.service.tasks.submit(old.id, 1, plan, adminPrincipal);
    const record = await finished(f, old.id, job.id);
    assert.deepEqual(oldCalls, ['first']); assert.deepEqual(newCalls, [], '旧任务尾部不能发送给重连后的同号标签页');
    assert.equal(record.reason, 'CONNECTION_CHANGED'); assert.equal(record.nextStep, 1);
  } finally { await f.cleanup(); }
});
