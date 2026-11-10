import test from 'node:test';
import assert from 'node:assert/strict';
import type { JsonObject } from '../src/shared.js';
import { loadExtension } from './extension-harness.js';

// 离线夹具：真实执行器 + 假 Chrome。核对光标只多发 Overlay 命令，页面收到的输入一点不变，截图前先收起。
const h = await loadExtension();
const metrics = { layoutViewport: { clientWidth: 1500 }, cssLayoutViewport: { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 0 }, cssVisualViewport: { zoom: 1 } };
let overlayFails = false;
h.hooks.intercept = command => {
  if (command.method === 'Page.getLayoutMetrics') return metrics;
  if (overlayFails && /^(Overlay|DOM)\./.test(command.method)) return Promise.reject(new Error('Overlay must be enabled before a tool can be shown'));
  return undefined;
};
const run = (tabId: number, args: JsonObject) => h.executor.execute('page.action', { tabId, ...args }, h.deadline()) as Promise<JsonObject>;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function mouseEvents(shown: boolean) {
  h.executor.setCursorShown(shown);
  const { tabId, page } = h.openTab();
  page.element('go', { left: 100, top: 200, right: 140, bottom: 220 });
  await run(tabId, { action: 'click', selector: '#go' });
  await run(tabId, { action: 'doubleClick', selector: '#go' });
  await run(tabId, { action: 'hover', x: 5, y: 6 });
  await run(tabId, { action: 'scroll', selector: '#go', deltaY: 50 });
  await run(tabId, { action: 'click', x: 7, y: 8, modifiers: 2 });
  h.executor.setCursorShown(false);
  return { tabId, events: page.mouseEvents };
}

test('光标开着时，页面收到的鼠标事件和关着时完全一样；多出来的只有光标自己的命令', async () => {
  const off = await mouseEvents(false), on = await mouseEvents(true);
  assert.deepEqual(on.events, off.events);
  assert.equal(h.commandsFor(off.tabId).filter(command => /^(Overlay|DOM)\./.test(command.method)).length, 0, '关着时不发 Overlay、DOM 命令');
  assert.ok(h.commandsFor(on.tabId, 'Overlay.highlightQuad').length > 0, '开着时画了光标');
  const extra = new Set(h.commandsFor(on.tabId).map(command => command.method)), base = new Set(h.commandsFor(off.tabId).map(command => command.method));
  assert.deepEqual([...extra].filter(method => !base.has(method)).sort(), ['DOM.enable', 'Overlay.enable', 'Overlay.hideHighlight', 'Overlay.highlightQuad', 'Page.getLayoutMetrics']);
});

test('fill：光标关着时探针不读目标的框，开着时才读并框住目标', async () => {
  for (const shown of [false, true]) {
    h.executor.setCursorShown(shown);
    const { tabId, page } = h.openTab();
    page.input('name');
    await run(tabId, { action: 'fill', selector: '#name', text: 'x' });
    const probes = h.commandsFor(tabId, 'Runtime.evaluate').filter(command => String(command.params.expression).includes('NOT_TEXT_INPUT'));
    assert.ok(probes.length > 0);
    assert.equal(probes.some(command => String(command.params.expression).includes('box:')), shown);
    await sleep(30);
    const boxed = h.commandsFor(tabId, 'Overlay.highlightQuad').some(command => (command.params.color as JsonObject).a === .1);
    assert.equal(boxed, shown);
    h.executor.setCursorShown(false);
  }
});

test('截图前先收起光标，截完再画回去', async () => {
  h.executor.setCursorShown(true);
  const { tabId, page } = h.openTab();
  page.element('go', { left: 100, top: 200, right: 140, bottom: 220 });
  await run(tabId, { action: 'click', selector: '#go' });
  await sleep(30);
  await h.executor.execute('page.screenshot', { tabId }, h.deadline());
  const methods = h.commandsFor(tabId).map(command => command.method).filter(method => /^(Overlay\.(highlightQuad|hideHighlight)|Page\.captureScreenshot)$/.test(method));
  const shot = methods.lastIndexOf('Page.captureScreenshot');
  assert.equal(methods[shot - 1], 'Overlay.hideHighlight');
  await sleep(30);
  assert.equal(h.commandsFor(tabId).map(command => command.method).filter(method => method.startsWith('Overlay.')).at(-1), 'Overlay.highlightQuad');
  h.executor.setCursorShown(false);
});

test('Overlay 不可用时点击照常成功，输入不变', async () => {
  const off = await mouseEvents(false);
  overlayFails = true;
  try { const on = await mouseEvents(true); assert.deepEqual(on.events, off.events); }
  finally { overlayFails = false; }
});
