import { BrowserError } from './shared.js';

export const TASK_PLAN_BYTES = 2 * 1024 * 1024;
export const TOTAL_PLAN_BYTES = 32 * 1024 * 1024;
const parameterPattern = /\{\{([\p{L}_][\p{L}\p{N}_]*)\}\}/gu;

// 先计算替换后的 JSON 字节数，避免先构造巨大字符串再拒绝。
export function expandWorkflow<T extends { steps: unknown }>(plan: T, parameters: Record<string, string>): T {
  let bytes = Buffer.byteLength(JSON.stringify(plan));
  const costs = new Map(Object.entries(parameters).map(([name, value]) => [name, Buffer.byteLength(JSON.stringify(value)) - 2]));
  function measure(value: unknown): void {
    if (typeof value === 'string') {
      for (const match of value.matchAll(parameterPattern)) bytes += (costs.get(match[1]!) ?? 0) - Buffer.byteLength(match[0]);
    } else if (Array.isArray(value)) value.forEach(measure);
    else if (value && typeof value === 'object') Object.values(value).forEach(measure);
  }
  measure(plan.steps);
  if (bytes > TASK_PLAN_BYTES) throw new BrowserError('WORKFLOW_EXPANSION_TOO_LARGE', '参数展开后的任务超过 2 MiB，尚未创建任务。请减少重复参数或拆分流程。');
  const expand = (value: unknown): any => typeof value === 'string' ? value.replace(parameterPattern, (_, key: string) => parameters[key]!)
    : Array.isArray(value) ? value.map(expand) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expand(child)])) : value;
  return { ...plan, steps: expand(plan.steps) };
}
