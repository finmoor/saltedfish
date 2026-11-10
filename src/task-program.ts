import { z } from 'zod';
import { BrowserError, NOT_DISPATCHED, type JsonObject } from './shared.js';

const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const scalar = z.union([z.string().max(100000), z.number().finite(), z.boolean(), z.null()]);
export const valueCondition = z.object({
  variable: z.string().min(1).max(256).describe('本任务内结果变量的路径，例如 response.status；只读取自有属性。'),
  operator: z.enum(['exists', 'truthy', 'equals', 'notEquals', 'contains', 'lt', 'lte', 'gt', 'gte']),
  value: scalar.optional(),
}).strict().superRefine((condition,context)=>{
  if(!['exists','truthy'].includes(condition.operator)&&condition.value===undefined)context.addIssue({code:'custom',message:'比较条件必须提供 value。'});
  if(['lt','lte','gt','gte'].includes(condition.operator)&&typeof condition.value!=='number')context.addIssue({code:'custom',message:'大小比较的 value 必须为数字。'});
});
export const resultFields = {
  saveAs: name.optional(),
  bindings: z.record(z.string(), z.string()).optional(),
};
export const flowSteps = [
  z.object({ operation: z.literal('flow.if'), args: valueCondition }).strict(),
  z.object({ operation: z.literal('flow.else'), args: z.object({}).strict() }).strict(),
  z.object({ operation: z.literal('flow.repeat'), args: z.object({ count: z.number().int().min(1).max(100), while: valueCondition.optional() }).strict() }).strict(),
  z.object({ operation: z.literal('flow.end'), args: z.object({}).strict() }).strict(),
  z.object({ operation: z.literal('flow.set'), args: z.object({ name, value: z.unknown() }).strict() }).strict(),
] as const;

export interface ProgramStep { operation: string; args: JsonObject; saveAs?: string; bindings?: Record<string, string> }
interface Block { start: number; end: number; otherwise?: number; kind: 'flow.if' | 'flow.repeat' }
export interface Program { blocks: Map<number, Block>; ends: Map<number, Block>; alternatives: Map<number, Block> }
function fail(code: string, message: string): never { throw new BrowserError(code, message, NOT_DISPATCHED); }
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
function parts(path: string) {
  const list = path.split('.');
  if (path.length>256 || list.length > 16 || list.some(p => !/^[A-Za-z0-9_]+$/.test(p) || forbidden.has(p))) fail('TASK_VARIABLE_PATH', '变量或字段路径无效；只允许点分隔的自有属性或数组下标。');
  return list;
}
export function compileProgram(steps: readonly ProgramStep[]): Program {
  const blocks = new Map<number, Block>(), ends = new Map<number, Block>(), alternatives = new Map<number, Block>(), stack: Block[] = [];
  steps.forEach((step, i) => {
    if(Object.keys(step.bindings??{}).length>40)fail('TASK_BINDING_CAPACITY','每步最多40个结果绑定。');
    if (step.saveAs && forbidden.has(step.saveAs)) fail('TASK_VARIABLE_PATH', '不能使用原型属性名作为变量。');
    if(step.operation==='flow.set'&&forbidden.has(String(step.args.name)))fail('TASK_VARIABLE_PATH','不能使用原型属性名作为变量。');
    if(step.operation==='flow.if'&&typeof step.args.variable==='string')parts(step.args.variable);
    if(step.operation==='flow.repeat'&&step.args.while)parts(String((step.args.while as JsonObject).variable));
    if (step.bindings) for (const [target, source] of Object.entries(step.bindings)) {
      const targetParts = parts(target); parts(source);
      if (step.operation === 'page.evaluate' || step.operation === 'page.cdp' || targetParts.some(p => ['expression', 'functionDeclaration', 'profileId', 'tabId', 'contextId', 'sessionId', 'method', 'operation', 'adminGuard'].includes(p))) fail('TASK_UNSAFE_BINDING', '结果绑定不能生成脚本、CDP调用或改变账号、标签及frame。');
    }
    if (step.operation === 'flow.if' || step.operation === 'flow.repeat') {
      if (stack.length >= 8) fail('TASK_CONTROL_DEPTH', '控制流最多嵌套 8 层。');
      const block: Block = { start: i, end: -1, kind: step.operation }; stack.push(block); blocks.set(i, block);
    } else if (step.operation === 'flow.else') {
      const block = stack.at(-1);
      if (!block || block.kind !== 'flow.if' || block.otherwise !== undefined) fail('TASK_CONTROL_INVALID', 'flow.else 必须属于尚无 else 的 flow.if。');
      block.otherwise = i; alternatives.set(i, block);
    } else if (step.operation === 'flow.end') {
      const block = stack.pop(); if (!block) fail('TASK_CONTROL_INVALID', 'flow.end 没有对应的 if/repeat。');
      block.end = i; ends.set(i, block);
    }
  });
  if (stack.length) fail('TASK_CONTROL_INVALID', '每个 flow.if/repeat 都必须由 flow.end 关闭。');
  return { blocks, ends, alternatives };
}

/** 运行值只存内存；不写 task_records。全局预算由 TaskManager 汇总。 */
export class TaskVariables {
  private values = new Map<string, unknown>();
  private sizes = new Map<string, number>();
  get bytes() { return [...this.sizes.values()].reduce((a, b) => a + b, 0); }
  read(path: string, optional = false): unknown {
    const [root, ...rest] = parts(path); let value = this.values.get(root!);
    let exists = this.values.has(root!);
    for (const key of rest) {
      if (!exists || !value || typeof value !== 'object' || !Object.hasOwn(value, key)) { exists = false; value = undefined; break; }
      value = (value as JsonObject)[key];
    }
    if (!exists && !optional) fail('TASK_VARIABLE_MISSING', `变量路径 ${path} 尚无结果；未派发下一步。`);
    return value;
  }
  set(key: string, value: unknown, globalRemaining = Infinity) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) || forbidden.has(key)) fail('TASK_VARIABLE_PATH', '变量名称无效。');
    let encoded:string;
    try { const json=JSON.stringify(value ?? null);if(json===undefined)fail('TASK_VARIABLE_INVALID','结果变量必须是可序列化的 JSON 值。');encoded=json; }
    catch(error){if(error instanceof BrowserError)throw error;fail('TASK_VARIABLE_INVALID','结果变量不能包含循环引用或不能序列化的值。');}
    const size = Buffer.byteLength(encoded);
    const delta = size - (this.sizes.get(key) ?? 0);
    if (size > 256 * 1024 || this.bytes + delta > 1024 * 1024 || delta > globalRemaining) fail('TASK_VARIABLE_CAPACITY', '结果变量超过容量（单值256 KiB、单任务1 MiB、全局16 MiB）；请只提取所需字段或使用artifact引用。');
    this.values.set(key, JSON.parse(encoded)); this.sizes.set(key, size);
  }
  condition(condition: z.infer<typeof valueCondition>) {
    const value = this.read(condition.variable, condition.operator === 'exists');
    switch (condition.operator) {
      case 'exists': return value !== undefined;
      case 'truthy': return !!value;
      case 'equals': return value === condition.value;
      case 'notEquals': return value !== condition.value;
      case 'contains': return typeof value === 'string' && typeof condition.value === 'string' ? value.includes(condition.value) : Array.isArray(value) && value.includes(condition.value);
      default: {
        if (typeof value !== 'number' || typeof condition.value !== 'number') fail('TASK_CONDITION_TYPE', '大小比较要求两侧均为数字。');
        return condition.operator === 'lt' ? value < condition.value : condition.operator === 'lte' ? value <= condition.value : condition.operator === 'gt' ? value > condition.value : value >= condition.value;
      }
    }
  }
  bind(step: ProgramStep): JsonObject {
    const args = structuredClone(step.args);
    for (const [target, source] of Object.entries(step.bindings ?? {})) {
      const list = parts(target), leaf = list.pop()!; let cursor: JsonObject = args;
      for (const key of list) {
        if (!Object.hasOwn(cursor, key) || !cursor[key] || typeof cursor[key] !== 'object') fail('TASK_BINDING_TARGET', `绑定字段 ${target} 的父节点不存在。`);
        cursor = cursor[key] as JsonObject;
      }
      if(Array.isArray(cursor)&&(!/^(0|[1-9][0-9]*)$/.test(leaf)||!Number.isSafeInteger(Number(leaf))||Number(leaf)>=cursor.length))fail('TASK_BINDING_TARGET','数组绑定只能替换已有下标，不能扩展为稀疏数组。');
      cursor[leaf] = structuredClone(this.read(source));
    }
    return args;
  }
}
