import type { JsonObject } from '../src/shared';
import { elementExpression } from './page-functions';

export interface InputTarget { ref: string; documentId: string }

// 文档仍是派发时的那一个，再按 ref 解析回同一个元素；body 在解析出的 element/state 上继续检查。
function resolvedTarget(args: JsonObject, target: InputTarget, body: string): string {
  return `(() => {
    if(FengPage.documentId()!==${JSON.stringify(target.documentId)})FengPage.fail('DOCUMENT_CHANGED','目标文档已变化，未继续输入。');
    return ${elementExpression({ ...args, selector: undefined, locator: undefined, ref: target.ref }, body)};
  })()`;
}

// 派发之前的复查：聚焦可能触发页面微任务。每次派发前在另一次 CDP 读取中复核焦点和可编辑状态，绝不抢回焦点。
// 这不能将读取与 CDP 输入变成原子操作；派发后的异常仍由 action 保留 unknown。
export function inputTargetExpression(args: JsonObject, target: InputTarget, body = 'return true;'): string {
  return resolvedTarget(args, target, `
      FengPage.assertFocused(element);
      if(state.disabled||state.readOnly||!state.visible)FengPage.fail('NOT_EDITABLE');
      ${body}`);
}

// 派发之后的核验：只要求文档与 ref 仍指向同一个目标，其余由 body 判断（fill 比较值）。
// 焦点与可编辑状态不再是条件：验证码、分段卡号等页面会在 input 事件里把焦点移到下一格，提交时字段也可能被禁用，
// 此时值已经正确写入。把这类合法的页面行为判成失败，只会隔离标签页、逼人逐个 recover，还会误导调用方重复输入。
export function inputSettledExpression(args: JsonObject, target: InputTarget, body: string): string {
  return resolvedTarget(args, target, body);
}
