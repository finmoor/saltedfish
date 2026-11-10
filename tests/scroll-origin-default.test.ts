import test from 'node:test';
import assert from 'node:assert/strict';
import { toolMap } from '../src/tools.js';
import { loadExtension } from './extension-harness.js';

// chrome_action 的说明写着 scroll 的“x,y（缺省 0,0）”。这条事实只存在于 extension/executor.ts 的 scroll 分支里，
// executor-actions.test.ts 的滚轮用例都显式给了坐标或元素，没有人守着缺省值：说明和实现必须一起改，所以放在同一个用例里。
const h = await loadExtension();
const scroll = (tabId: number, args: Record<string, unknown>) => h.executor.execute('page.action', { tabId, action: 'scroll', ...args }, h.deadline()) as Promise<Record<string, unknown>>;

test('scroll 没有元素定位、没给 x,y：滚轮发在视口原点 (0,0)；只给一个坐标时另一个取 0；返回值如实回显', async () => {
  assert.ok(toolMap.get('chrome_action')!.description.includes('x,y（缺省 0,0）'), '工具说明必须写明这个缺省值');
  for (const [args, x, y] of [[{ deltaY: 120 }, 0, 0], [{ x: 40, deltaY: 120 }, 40, 0], [{ y: 25, deltaY: 120 }, 0, 25]] as const) {
    const { tabId, page } = h.openTab();
    const result = await scroll(tabId, args);
    const wheel = page.mouseEvents.at(-1)!;
    assert.deepEqual([wheel.type, wheel.x, wheel.y, wheel.deltaX, wheel.deltaY], ['mouseWheel', x, y, 0, 120], JSON.stringify(args));
    assert.deepEqual(result, { scrolled: true, x, y, deltaX: 0, deltaY: 120 }, JSON.stringify(args));
  }
});
