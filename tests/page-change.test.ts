import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_SETTLE_MS, INPUT_SETTLE_MS, PageChanges } from '../extension/page-change.js';
import type { JsonObject } from '../src/shared.js';

const frame = {} as JsonObject;
function harness(respond: (expression: string) => unknown, tab: JsonObject | Error = { url: 'http://a/', status: 'complete' }) {
  const waits: number[] = [], calls: string[] = [];
  const changes = new PageChanges({
    evaluate: async (_tabId, expression) => { calls.push(expression); return respond(expression); },
    tab: async () => { if (tab instanceof Error) throw tab; return tab; },
    sleep: ms => { if (ms === 1000) return new Promise(() => {}); waits.push(ms); return Promise.resolve(); }, // 1000 是读取上限的定时器，测试里不到期。
  });
  return { changes, waits, calls };
}
const reading = (quiet: unknown, result: unknown) => (expression: string) => expression.includes('watchPage') ? true : expression.includes('pageQuietFor') ? quiet : result;
const far = () => Date.now() + 30000;

test('没开始观察时什么都不读，也不等待', async () => {
  const { changes, waits, calls } = harness(() => { throw new Error('不该调用'); });
  assert.deepEqual(await changes.read(7, ACTION_SETTLE_MS, far()), {});
  assert.deepEqual(waits, []); assert.deepEqual(calls, []);
});

test('点击多等一会儿，输入几乎不等；只读一次，读过就清掉', async () => {
  for (const [settle, expected] of [[ACTION_SETTLE_MS, 300], [INPUT_SETTLE_MS, 50]] as const) {
    const { changes, waits } = harness(reading(5000, { changed: true, added: ['保存成功'] }));
    await changes.start(7, frame, far());
    assert.deepEqual(await changes.read(7, settle, far()), { pageChange: { changed: true, added: ['保存成功'] } });
    assert.deepEqual(waits, [expected]);
    assert.deepEqual(await changes.read(7, settle, far()), {}, '第二次没有可读的');
  }
});

test('页面还在变时继续等到安静，但有上限', async () => {
  let quiet = 0;
  const { changes, waits } = harness(expression => expression.includes('pageQuietFor') ? quiet++ * 40 : expression.includes('pageChanges') ? { changed: true } : true);
  await changes.start(7, frame, far());
  await changes.read(7, INPUT_SETTLE_MS, far());
  assert.deepEqual(waits, [50, 100, 60, 20], '每次只补足到安静窗口');
  const busy = harness(reading(0, { changed: true }));
  await busy.changes.start(7, frame, far());
  let now = Date.now(); const real = Date.now;
  Date.now = () => (now += 300);
  try { await busy.changes.read(7, INPUT_SETTLE_MS, Number.MAX_SAFE_INTEGER); } finally { Date.now = real; }
  assert.ok(busy.waits.length <= 4, `不能一直等：${busy.waits}`);
});

test('点击后完全没动静时继续看到上限，一有变化就按安静收尾；输入类动作不多等', async () => {
  const replies = [-1, -1, 30, 200];
  const clicked = harness(expression => expression.includes('pageQuietFor') ? replies.shift() : expression.includes('pageChanges') ? { changed: true, added: ['已保存'] } : true);
  await clicked.changes.start(7, frame, far());
  assert.deepEqual((await clicked.changes.read(7, ACTION_SETTLE_MS, far())).pageChange, { changed: true, added: ['已保存'] });
  assert.deepEqual(clicked.waits, [300, 150, 150, 70], '等到变化之后再等安静');
  const typed = harness(reading(-1, { changed: false }));
  await typed.changes.start(7, frame, far());
  await typed.changes.read(7, INPUT_SETTLE_MS, far());
  assert.deepEqual(typed.waits, [50]);
});

test('没有变化时说清看了多久，文档换了或正在跳转时说实话', async () => {
  const same = harness(reading(5000, { changed: false }));
  await same.changes.start(7, frame, far());
  const quiet = (await same.changes.read(7, ACTION_SETTLE_MS, far())).pageChange!;
  assert.equal(quiet.changed, false); assert.equal(typeof quiet.waitedMs, 'number');

  const swapped = harness(reading(null, null), { url: 'http://a/next', title: 'Next', status: 'complete' });
  await swapped.changes.start(7, frame, far());
  assert.deepEqual(await swapped.changes.read(7, ACTION_SETTLE_MS, far()), { pageChange: { changed: true, navigated: true, url: 'http://a/next', title: 'Next' } });

  const leaving = harness(reading(5000, { changed: false }), { url: 'http://a/', pendingUrl: 'http://a/next', status: 'loading' });
  await leaving.changes.start(7, frame, far());
  assert.deepEqual(await leaving.changes.read(7, ACTION_SETTLE_MS, far()), { pageChange: { changed: false, loading: true, url: 'http://a/next' } }, '旧文档没变不代表动作没用');
});

test('读取失败只少一段信息，绝不抛错', async () => {
  const lost = harness(expression => { if (expression.includes('watchPage')) return true; throw new Error('Cannot find context'); }, { url: 'http://a/', pendingUrl: 'http://a/next', status: 'loading' });
  await lost.changes.start(7, frame, far());
  assert.deepEqual(await lost.changes.read(7, ACTION_SETTLE_MS, far()), { pageChange: { changed: true, loading: true, url: 'http://a/next' } });

  const dead = harness(expression => { if (expression.includes('watchPage')) return true; throw new Error('gone'); }, new Error('tab closed'));
  await dead.changes.start(7, frame, far());
  assert.deepEqual(await dead.changes.read(7, ACTION_SETTLE_MS, far()), {});

  const refused = harness(() => { throw new Error('page hung'); });
  await refused.changes.start(7, frame, far());
  assert.deepEqual(await refused.changes.read(7, ACTION_SETTLE_MS, far()), {}, '开始就失败时不读');
});

test('标签页看不到地址时（管理页）不补 URL', async () => {
  const hidden = harness(reading(null, null), { status: 'complete' });
  await hidden.changes.start(7, frame, far());
  assert.deepEqual(await hidden.changes.read(7, ACTION_SETTLE_MS, far()), { pageChange: { changed: true, navigated: true } });
});

test('动作失败时收掉观察，不等待', async () => {
  const { changes, waits, calls } = harness(reading(5000, { changed: false }));
  await changes.start(7, frame, far());
  changes.drop(7); await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(waits, []);
  assert.ok(calls.at(-1)!.includes('pageChanges'));
  assert.deepEqual(await changes.read(7, ACTION_SETTLE_MS, far()), {});
});
