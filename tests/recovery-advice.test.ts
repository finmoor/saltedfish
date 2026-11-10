import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryAdvice } from '../src/recovery.js';

// FOCUS_CHANGED 只在两种情况下出现：派发前焦点丢失（没有任何字符送出），以及逐键/组合输入的中途丢失（已送出的部分可能已生效）。
// 整段 fill/type 成功之后页面自行跳格不再报这个错误，而是成功结果里带 focusVerified:false（见 tests/executor-actions.test.ts）。建议文案必须如实说明这三种情况，不能再声称“后续输入已经停止”就是全部。
test('FOCUS_CHANGED 的恢复建议区分派发前丢失、输入途中丢失，并指向成功结果里的 focusVerified', () => {
  const advice = recoveryAdvice('FOCUS_CHANGED');
  assert.equal(advice.automaticReplay, false);
  assert.match(advice.next, /派发前/); assert.match(advice.next, /逐键|组合/); assert.match(advice.next, /已送出的字符可能已写进页面/);
  assert.match(advice.next, /focusVerified/);
  assert.doesNotMatch(advice.title, /^聚焦后/, '标题不再只描述“聚焦之后”');
  assert.doesNotMatch(advice.next, /^后续输入已经停止。核对/, '旧文案把所有情况都说成“后续输入已经停止”');
});

test('未登记的错误码仍是通用建议，且永远不自动重放', () => {
  assert.deepEqual(recoveryAdvice('NO_SUCH_CODE'), recoveryAdvice(undefined));
  assert.equal(recoveryAdvice('NO_SUCH_CODE').automaticReplay, false);
});
