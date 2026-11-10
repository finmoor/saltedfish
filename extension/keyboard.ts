import { BrowserError, type JsonObject } from '../src/shared';

export interface KeyboardKey extends JsonObject {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  modifiers: number;
  text?: string;
  location?: number;
}

// CDP 使用 Windows 虚拟键码；字符的 Unicode 编码不能作为 VK 使用。
// press 和 keySequence 共用 US 键位定义，非 US 文本交给 insertText / composition。
const punctuation: readonly [string, string, string, number][] = [
  ['`', '~', 'Backquote', 192], ['-', '_', 'Minus', 189], ['=', '+', 'Equal', 187],
  ['[', '{', 'BracketLeft', 219], [']', '}', 'BracketRight', 221], ['\\', '|', 'Backslash', 220],
  [';', ':', 'Semicolon', 186], ["'", '"', 'Quote', 222], [',', '<', 'Comma', 188],
  ['.', '>', 'Period', 190], ['/', '?', 'Slash', 191],
];
const named: Record<string, [string, number]> = {
  Enter: ['Enter', 13], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8],
  Delete: ['Delete', 46], Insert: ['Insert', 45], Home: ['Home', 36], End: ['End', 35],
  PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], ArrowDown: ['ArrowDown', 40],
  ArrowUp: ['ArrowUp', 38], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39],
  Shift: ['ShiftLeft', 16], Control: ['ControlLeft', 17], Alt: ['AltLeft', 18], Meta: ['MetaLeft', 91],
  CapsLock: ['CapsLock', 20], NumLock: ['NumLock', 144], ScrollLock: ['ScrollLock', 145],
  Pause: ['Pause', 19], PrintScreen: ['PrintScreen', 44], ContextMenu: ['ContextMenu', 93],
};

export function keyboardKey(requested: string, explicitModifiers = 0): KeyboardKey {
  let key = requested === 'Space' ? ' ' : requested;
  let code: string, virtualKey: number, modifiers = explicitModifiers;
  if (/^[a-z]$/i.test(key)) {
    // Ctrl+A 等历史调用不因大写键名而被升级为 Ctrl+Shift+A。
    if (modifiers & 8 || key === key.toUpperCase() && !(modifiers & 7)) { key = key.toUpperCase(); modifiers |= 8; }
    else key = key.toLowerCase();
    code = `Key${key.toUpperCase()}`; virtualKey = key.toUpperCase().charCodeAt(0);
  } else if (/^[0-9!@#$%^&*()]$/.test(key)) {
    const shifted = '!@#$%^&*()'.indexOf(key);
    const digit = shifted >= 0 ? (shifted + 1) % 10 : Number(key);
    if (shifted >= 0 || modifiers & 8) { modifiers |= 8; key = ')!@#$%^&*('[digit]!; }
    code = `Digit${digit}`; virtualKey = 48 + digit;
  } else if (key === ' ') { code = 'Space'; virtualKey = 32; }
  else {
    const pair = punctuation.find(([plain, shifted]) => key === plain || key === shifted);
    // 键名是任意字符串：只认自有属性，否则 'constructor'、'toString' 等会取到原型上的函数，解构时抛 TypeError。
    const special = Object.hasOwn(named, key) ? named[key] : undefined;
    if (pair) {
      if (key === pair[1] || modifiers & 8) { modifiers |= 8; key = pair[1]; }
      code = pair[2]; virtualKey = pair[3];
    } else if (special) { [code, virtualKey] = special; }
    else if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key)) { code = key; virtualKey = 111 + Number(key.slice(1)); }
    else throw new BrowserError('UNSUPPORTED_KEY', '不支持此键名；press 使用常用命名键或可打印 ASCII，Unicode 文本请使用 type。', { phase: 'precondition', outcome: 'not_dispatched' });
  }
  const modifierKey = modifierFlag(key);
  modifiers |= modifierKey;
  const text = modifiers & 7 ? undefined : key === 'Enter' ? '\r' : key.length === 1 ? key : undefined;
  return { key, code, windowsVirtualKeyCode: virtualKey, modifiers, ...(modifierKey ? { location: 1 } : {}), ...(text === undefined ? {} : { text }) };
}

const modifierFlags: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
// 组合键里的修饰键：真键盘先按下修饰键、再按主键，主键松开后再松修饰键，页面能看到修饰键自己的 keydown/keyup。
// 按按下的顺序返回，每个带上按到它时已经按住的修饰位；主键自己是修饰键时不重复。
export function modifierKeys(flags: number, own = ''): KeyboardKey[] {
  const keys: KeyboardKey[] = []; let held = 0;
  for (const name of ['Control', 'Alt', 'Shift', 'Meta']) { const flag = modifierFlags[name]!; if (flags & flag && name !== own) { held |= flag; keys.push({ ...keyboardKey(name), modifiers: held }); } }
  return keys;
}
export function modifierFlag(key: string): number {
  return Object.hasOwn(modifierFlags, key) ? modifierFlags[key] ?? 0 : 0;
}
