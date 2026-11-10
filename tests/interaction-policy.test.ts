import test from 'node:test';
import assert from 'node:assert/strict';
import { isVisualAction, needsViewportOperation } from '../src/interaction-policy.js';

test('焦点与窗口分类覆盖可见输入、截图和混合批次，读取与select不抢焦点', () => {
  for (const action of ['click', 'hover', 'fill', 'type', 'press', 'scroll']) {
    assert.equal(isVisualAction(action), true);
    assert.equal(needsViewportOperation('page.action', { action }), true);
    assert.equal(needsViewportOperation('page.batch', { steps: [{ operation: 'page.wait', args: {} }, { operation: 'page.action', args: { action } }] }), true);
  }
  assert.equal(needsViewportOperation('page.screenshot', {}), true);
  for (const operation of ['page.inspect', 'page.find', 'page.wait', 'page.evaluate', 'tabs.list', 'unknown']) assert.equal(needsViewportOperation(operation, { action: 'click' }), false);
  assert.equal(needsViewportOperation('page.action', { action: 'select' }), false, 'select continues to use its DOM path without a visual window queue');
  assert.equal(needsViewportOperation('page.batch', { steps: [{ operation: 'page.wait', args: {} }] }), false);
});

test('未知wire形状不会因分类而抛异常或触发焦点', () => {
  for (const args of [null, undefined, 4, 'click', [], {}, { steps: null }, { steps: 'click' }, { steps: [null, 2, {}, { operation: 'page.action', args: null }, { operation: 'page.action', args: { action: {} } }] }]) {
    assert.equal(needsViewportOperation('page.batch', args), false);
    assert.equal(needsViewportOperation('page.action', args), false);
  }
  for (const action of [null, undefined, {}, ['click'], 'select', 'CLICK']) assert.equal(isVisualAction(action), false);
  assert.equal(needsViewportOperation('page.screenshot', null), false);
});
