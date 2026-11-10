import test from 'node:test';
import assert from 'node:assert/strict';
import { Dialogs } from '../extension/dialogs.js';
import { DownloadTabs, type CreatedDownload } from '../extension/download-tabs.js';
import { WHEEL_MAX_NOTCHES, wheelSteps } from '../extension/human-input.js';
import { downloadPackage, UpdateError } from '../extension/self-update.js';

test('U08 respond 成功后立刻清掉 open，紧随的命令不再看到旧弹窗，也不误删新开的弹窗', async () => {
  const dialogs = new Dialogs(async () => {});
  const first = dialogs.opening(3, { type: 'alert', message: 'a' });
  await dialogs.respond(3, { accept: true, dialogId: first.dialogId });
  assert.equal(dialogs.has(3), false);
  await assert.rejects(dialogs.respond(3, { accept: true, dialogId: first.dialogId }), (error: { code?: string }) => error.code === 'DIALOG_NOT_OPEN');
  // closed 事件迟到仍是幂等的。
  dialogs.closed(3);
  // handle 期间事件先到、新弹窗已开：不能删掉新的。
  let second: ReturnType<Dialogs['opening']> | undefined;
  const racing = new Dialogs(async () => { racing.closed(4); second = racing.opening(4, { type: 'confirm', message: 'b' }); });
  const old = racing.opening(4, { type: 'alert', message: 'a' });
  await racing.respond(4, { accept: true, dialogId: old.dialogId });
  assert.equal(racing.has(4), true);
  assert.equal(second?.type, 'confirm');
});

test('U09 同 URL 并发下载：来源分不清就保持未知，唯一候选才附 tabId，两种到达顺序都不配错', () => {
  const url = 'https://example.test/a.zip';
  const make = () => { const out: { id: number; tabId?: number }[] = []; const tabs = new DownloadTabs((item: CreatedDownload, tabId) => out.push({ id: item.id, tabId })); return { out, tabs }; };
  // 先收到 A、B 的开始事件，再收到创建事件。
  let { out, tabs } = make();
  tabs.willBegin(1, url); tabs.willBegin(2, url);
  tabs.created({ id: 10, url }); tabs.created({ id: 11, url });
  assert.deepEqual(out.filter(item => item.tabId !== undefined), []);
  // 先收到两个创建事件，再收到开始事件。
  ({ out, tabs } = make());
  tabs.created({ id: 10, url }); tabs.created({ id: 11, url });
  tabs.willBegin(1, url); tabs.willBegin(2, url);
  assert.deepEqual(out.filter(item => item.tabId !== undefined), []);
  assert.equal(out.length, 2);
  // 唯一候选照常配对；同一标签页的多次同 URL 下载按先后配。
  ({ out, tabs } = make());
  tabs.willBegin(5, url); tabs.created({ id: 20, url });
  assert.deepEqual(out, [{ id: 20, tabId: 5 }]);
  ({ out, tabs } = make());
  tabs.willBegin(6, url); tabs.willBegin(6, url); tabs.created({ id: 21, url }); tabs.created({ id: 22, url });
  assert.deepEqual(out.map(item => item.tabId), [6, 6]);
});

test('U17 滚轮分格有格数上限，超大有限数值不会死循环，总量保持', () => {
  const huge = wheelSteps(0, 1e20);
  assert.equal(huge.length, WHEEL_MAX_NOTCHES);
  assert.ok(Math.abs(huge.reduce((sum, step) => sum + step.deltaY, 0) - 1e20) / 1e20 < 1e-9);
  assert.equal(wheelSteps(1e9, 0).length, WHEEL_MAX_NOTCHES);
  assert.deepEqual(wheelSteps(Number.POSITIVE_INFINITY, Number.NaN), []);
  assert.deepEqual(wheelSteps(0, 250).map(step => step.deltaY), [100, 100, 50]);
  assert.deepEqual(wheelSteps(0, -0.5), [{ deltaX: 0, deltaY: -0.5 }]);
});

const streamOf = (chunks: () => Uint8Array | undefined, headers: Record<string, string> = {}) => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { const chunk = chunks(); if (chunk) controller.enqueue(chunk); else controller.close(); }, cancel() { cancelled = true; } });
  return { response: new Response(body, { headers }), cancelled: () => cancelled };
};

test('U24 更新包下载按块计数，超过上限立即取消；Content-Length 提前拒绝；总超时中止', async () => {
  const MiB = new Uint8Array(1024 * 1024);
  let pulled = 0;
  const endless = streamOf(() => { pulled++; return MiB; });
  await assert.rejects(downloadPackage('http://x/a.zip', (async () => endless.response) as unknown as typeof fetch), (error: unknown) => error instanceof UpdateError);
  assert.ok(pulled <= 70, `读了 ${pulled} 块`);
  assert.equal(endless.cancelled(), true);
  const declared = streamOf(() => MiB, { 'content-length': String(65 * 1024 * 1024) });
  await assert.rejects(downloadPackage('http://x/a.zip', (async () => declared.response) as unknown as typeof fetch), UpdateError);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(declared.cancelled(), true);
  // 小包原样读回。
  let left = 3;
  const small = streamOf(() => left-- > 0 ? new Uint8Array([1, 2]) : undefined);
  assert.deepEqual([...await downloadPackage('http://x/a.zip', (async () => small.response) as unknown as typeof fetch)], [1, 2, 1, 2, 1, 2]);
  // 永不结束的流：总超时到了就中止。
  const hang = (async (_url: unknown, init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({ start(controller) { init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted'))); } }))) as unknown as typeof fetch;
  await assert.rejects(downloadPackage('http://x/a.zip', hang, 50), UpdateError);
});
