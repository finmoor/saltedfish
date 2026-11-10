import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundPopups, POPUP_ACTIVATION_MS } from '../extension/background-popups.js';

// 窗口 1：用户在看 1，Agent 的标签页 2 在后台；窗口 9 里有 Agent 的标签页 5。
function setup() {
  let clock = 1000;
  const tabs = new Map<number, { id: number; windowId: number; active: boolean }>();
  const activated: number[] = [];
  const popups = new BackgroundPopups({
    activate: async tabId => { activated.push(tabId); },
    get: async tabId => tabs.get(tabId),
    now: () => clock,
  });
  tabs.set(1, { id: 1, windowId: 1, active: true }); tabs.set(2, { id: 2, windowId: 1, active: false });
  tabs.set(5, { id: 5, windowId: 9, active: true });
  popups.seed([...tabs.values()]);
  // Chrome 开新标签页：放到前台，同窗口其他的变成后台。
  const open = (id: number, windowId = 1) => {
    for (const tab of tabs.values()) if (tab.windowId === windowId) tab.active = false;
    const tab = { id, windowId, active: true }; tabs.set(id, tab); return tab;
  };
  return { popups, tabs, activated, open, tick: (ms: number) => { clock += ms; } };
}

test('Agent 后台标签页报了 windowOpen，随后新标签页被放到前台：切回用户原来的标签页', async () => {
  const s = setup();
  await s.popups.windowOpen(2);
  const tab = s.open(3);
  await s.popups.onCreated(tab);
  await s.popups.onActivated({ tabId: 3, windowId: 1 });
  assert.deepEqual(s.activated, [1]);
});

test('三个事件谁先到都一样', async () => {
  for (const order of [['activated', 'created', 'open'], ['created', 'open', 'activated'], ['activated', 'open', 'created']]) {
    const s = setup();
    const tab = s.open(3);
    for (const step of order) {
      if (step === 'open') await s.popups.windowOpen(2);
      if (step === 'created') await s.popups.onCreated(tab);
      if (step === 'activated') await s.popups.onActivated({ tabId: 3, windowId: 1 });
    }
    assert.deepEqual(s.activated, [1], order.join('→'));
  }
});

test('不动的情况', async () => {
  const none = setup();
  await none.popups.onCreated(none.open(3)); await none.popups.onActivated({ tabId: 3, windowId: 1 });
  assert.deepEqual(none.activated, [], '没有 Agent 的 windowOpen（用户自己的标签页打开的）');

  const own = setup();
  await own.popups.windowOpen(1);
  await own.popups.onCreated(own.open(3)); await own.popups.onActivated({ tabId: 3, windowId: 1 });
  assert.deepEqual(own.activated, [], '报 windowOpen 的就是用户正看着的标签页');

  const watching = setup();
  watching.tabs.get(1)!.active = false; watching.tabs.get(2)!.active = true;
  await watching.popups.onActivated({ tabId: 2, windowId: 1 });
  await watching.popups.windowOpen(2);
  await watching.popups.onCreated(watching.open(3)); await watching.popups.onActivated({ tabId: 3, windowId: 1 });
  assert.deepEqual(watching.activated, [], '用户切到 Agent 的标签页上看着');

  const background = setup();
  await background.popups.windowOpen(2);
  background.tabs.set(3, { id: 3, windowId: 1, active: false });
  await background.popups.onCreated({ id: 3, windowId: 1, active: false });
  assert.deepEqual(background.activated, [], '在后台打开的');

  const otherWindow = setup();
  await otherWindow.popups.windowOpen(5);
  await otherWindow.popups.onCreated(otherWindow.open(3)); await otherWindow.popups.onActivated({ tabId: 3, windowId: 1 });
  assert.deepEqual(otherWindow.activated, [], '发起方在别的窗口');

  const windowed = setup();
  await windowed.popups.windowOpen(2);
  await windowed.popups.onCreated(windowed.open(3, 12)); await windowed.popups.onActivated({ tabId: 3, windowId: 12 });
  assert.deepEqual(windowed.activated, [], '开成了弹出窗口');

  const stale = setup();
  await stale.popups.windowOpen(2);
  stale.tick(POPUP_ACTIVATION_MS + 1);
  await stale.popups.onCreated(stale.open(3)); await stale.popups.onActivated({ tabId: 3, windowId: 1 });
  assert.deepEqual(stale.activated, [], 'windowOpen 是很久以前的');

  const later = setup();
  await later.popups.windowOpen(2);
  later.tabs.set(3, { id: 3, windowId: 1, active: false });
  await later.popups.onCreated({ id: 3, windowId: 1, active: false });
  later.tick(POPUP_ACTIVATION_MS + 1);
  later.open(3); await later.popups.onActivated({ tabId: 3, windowId: 1 });
  assert.deepEqual(later.activated, [], '后台打开、用户过一会儿自己点过去的');

  const moved = setup();
  await moved.popups.windowOpen(2);
  const tab = moved.open(3);
  await moved.popups.onCreated(tab);
  moved.tabs.get(3)!.active = false;
  await moved.popups.onActivated({ tabId: 3, windowId: 1 });
  assert.deepEqual(moved.activated, [], '实时查到已经不是当前标签页');
});

test('一次 windowOpen 只抵一个新标签页', async () => {
  const s = setup();
  await s.popups.windowOpen(2);
  await s.popups.onCreated(s.open(3)); await s.popups.onActivated({ tabId: 3, windowId: 1 });
  s.tabs.get(1)!.active = true; s.tabs.get(3)!.active = false; await s.popups.onActivated({ tabId: 1, windowId: 1 });
  await s.popups.onCreated(s.open(4)); await s.popups.onActivated({ tabId: 4, windowId: 1 });
  assert.deepEqual(s.activated, [1]);
});
