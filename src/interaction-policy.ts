// 服务端焦点模拟和扩展窗口队列使用同一分类；这里不依赖 Node 或 Chrome API。
const visualActions = ['click', 'doubleClick', 'drag', 'setChecked', 'choose', 'hover', 'fill', 'type', 'press', 'scroll'] as const;
export type VisualAction = typeof visualActions[number];
const visualActionNames = new Set<string>(visualActions);

export function isVisualAction(action: unknown): action is VisualAction {
  return typeof action === 'string' && visualActionNames.has(action);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 分类不代替 wire/schema 校验。未知或损坏的形状不抛异常，也不隐式取得焦点。
export function needsViewportOperation(operation: unknown, args: unknown): boolean {
  if (!object(args)) return false;
  if (operation === 'page.screenshot') return true;
  if (operation === 'page.action') return isVisualAction(args.action);
  if (operation !== 'page.batch' || !Array.isArray(args.steps)) return false;
  return args.steps.some(step => object(step) && step.operation === 'page.action' && object(step.args) && isVisualAction(step.args.action));
}
