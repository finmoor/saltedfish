import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowLocks } from '../extension/window-lock.js';
import { errorInfo, unknownResult } from '../src/shared.js';

// 窗口队列的拒绝发生在 action 运行之前：文案写着“尚未执行”，错误元数据必须与之一致，
// 否则服务端把它当成 unknown，白白隔离标签页、要求人工 recover。
const refusal = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return errorInfo(error); } return assert.fail('预期被拒绝'); };

test('同窗口排队等待超时：WINDOW_BUSY 是明确的未派发，action 没有运行', async () => {
  const locks = new WindowLocks(); let ran = 0, release!: () => void;
  const holder = locks.run(1, Date.now() + 2000, () => new Promise<void>(resolve => { release = resolve; }));
  await new Promise(resolve => setTimeout(resolve, 0));
  const info = await refusal(locks.run(1, Date.now() + 30, async () => { ran++; }));
  assert.equal(info.code, 'WINDOW_BUSY'); assert.equal(info.phase, 'precondition'); assert.equal(info.outcome, 'not_dispatched'); assert.equal(unknownResult(info), false);
  assert.equal(ran, 0);
  release(); await holder;
});

test('窗口已空闲但截止时间已到：同样是明确的未派发', async () => {
  const locks = new WindowLocks(); let ran = 0;
  const info = await refusal(locks.run(2, Date.now() - 1, async () => { ran++; }));
  assert.equal(info.code, 'WINDOW_BUSY'); assert.equal(info.phase, 'precondition'); assert.equal(info.outcome, 'not_dispatched');
  assert.equal(ran, 0);
});
