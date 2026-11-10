import test from 'node:test';
import assert from 'node:assert/strict';
import { keyboardKey, modifierFlag } from '../extension/keyboard.js';
import { BrowserError, errorInfo, unknownResult } from '../src/shared.js';

// 键名来自模型生成的任意字符串。Object.prototype 上的名字不是键，必须和不存在的键名一样被明确拒绝，而不是在解构时抛 TypeError。
const prototypeNames = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__'];

test('原型属性名与不存在的键名一样得到 UNSUPPORTED_KEY，明确未派发（不是 TypeError / unknown）', () => {
  for (const key of ['DefinitelyNotAKey', 'é', '', 'enter', 'Enter ', ...prototypeNames]) {
    assert.throws(() => keyboardKey(key), (error: unknown) => {
      assert.ok(error instanceof BrowserError, `${JSON.stringify(key)} 抛出的是 ${String(error)}`);
      const info = errorInfo(error);
      assert.equal(info.code, 'UNSUPPORTED_KEY'); assert.equal(info.phase, 'precondition'); assert.equal(info.outcome, 'not_dispatched');
      assert.equal(unknownResult(info), false);
      return true;
    }, JSON.stringify(key));
  }
});

test('modifierFlag 对原型属性名返回 0，不把函数当成修饰键', () => {
  for (const key of prototypeNames) assert.equal(modifierFlag(key), 0, key);
  assert.deepEqual(['Alt', 'Control', 'Meta', 'Shift', 'a'].map(modifierFlag), [1, 2, 4, 8, 0]);
});

test('合法键名的映射保持不变：命名键、功能键、可打印 ASCII、Ctrl+A 不被升级为 Ctrl+Shift+A', () => {
  assert.deepEqual(keyboardKey('Enter'), { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0, text: '\r' });
  assert.deepEqual(keyboardKey('Tab'), { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 0 });
  assert.deepEqual(keyboardKey('ArrowLeft'), { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, modifiers: 0 });
  assert.deepEqual(keyboardKey('F12'), { key: 'F12', code: 'F12', windowsVirtualKeyCode: 123, modifiers: 0 });
  assert.deepEqual(keyboardKey('Shift'), { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8, location: 1 });
  assert.deepEqual(keyboardKey('Space'), { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, modifiers: 0, text: ' ' });
  assert.deepEqual(keyboardKey('!'), { key: '!', code: 'Digit1', windowsVirtualKeyCode: 49, modifiers: 8, text: '!' });
  assert.deepEqual(keyboardKey('A', 2), { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  assert.deepEqual(keyboardKey('a', 8), { key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 8, text: 'A' });
});
