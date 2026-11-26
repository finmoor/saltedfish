import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenedTabs, OPEN_PAIR_MS } from '../extension/opened-tabs.js';

// 页面自己打开的新标签页按发起方的 Page.windowOpen 认是谁打开的（11-26 反馈：Chrome 的 openerTabId 指错或被清掉）。只认唯一、时间和网址对得上的一对。
function setup() {
  let now = 1000;
  const paired: [number, number][] = [];
  const opened = new OpenedTabs((tabId, opener) => paired.push([tabId, opener]), () => now);
  return { opened, paired, tick: (ms: number) => { now += ms; } };
}

test('Page.windowOpen 先到、新标签页后到，或者反过来，都配得上；openedBy 按时间列出', () => {
  const a = setup();
  a.opened.windowOpen(7, 'http://erp/form?byPageId=1');
  a.tick(20); a.opened.onCreated({ id: 70, pendingUrl: 'http://erp/form?byPageId=1' });
  assert.deepEqual(a.paired, [[70, 7]]); assert.equal(a.opened.openerOf(70), 7);
  assert.deepEqual(a.opened.openedBy(7, 900), [{ tabId: 70, url: 'http://erp/form?byPageId=1' }]); assert.deepEqual(a.opened.openedBy(7, 1100), [], '早于这次动作开始的不算');
  // 新标签页刚建出来还是空白页：不比网址。
  const b = setup();
  b.opened.onCreated({ id: 80, url: 'about:blank' }); b.tick(30); b.opened.windowOpen(8, 'http://erp/popup');
  assert.deepEqual(b.paired, [[80, 8]]);
});

test('对不上就不认：网址不同（用户自己开的）、超过 1.5 秒、两个标签页同时打开同一个网址', () => {
  const user = setup();
  user.opened.windowOpen(7, 'http://erp/form'); user.opened.onCreated({ id: 70, pendingUrl: 'chrome://newtab/' });
  assert.deepEqual(user.paired, []);
  const late = setup();
  late.opened.windowOpen(7, 'http://erp/form'); late.tick(OPEN_PAIR_MS + 1); late.opened.onCreated({ id: 70, pendingUrl: 'http://erp/form' });
  assert.deepEqual(late.paired, []);
  const twin = setup();
  twin.opened.windowOpen(7, 'http://erp/form'); twin.opened.windowOpen(8, 'http://erp/form'); twin.opened.onCreated({ id: 70, pendingUrl: 'http://erp/form' });
  assert.deepEqual(twin.paired, [], '分不清是哪个打开的');
  const two = setup();
  two.opened.windowOpen(7, 'http://erp/form'); two.opened.onCreated({ id: 70, pendingUrl: 'http://erp/form' }); two.opened.onCreated({ id: 71, pendingUrl: 'http://erp/form' });
  assert.deepEqual(two.paired, [[70, 7]], '一个 Page.windowOpen 只配一个新标签页');
  // 用户一秒前刚开的空白标签页不算：新标签页要在 Page.windowOpen 之后建出来（最多早 100ms）。
  const earlier = setup();
  earlier.opened.onCreated({ id: 60, url: 'about:blank' }); earlier.tick(1000);
  earlier.opened.windowOpen(7, 'http://erp/popup'); earlier.tick(12); earlier.opened.onCreated({ id: 70, url: '' });
  assert.deepEqual(earlier.paired, [[70, 7]]);
});

test('标签页关掉后忘掉', () => {
  const a = setup();
  a.opened.windowOpen(7, ''); a.opened.onCreated({ id: 70 });
  assert.equal(a.opened.openerOf(70), 7);
  a.opened.onRemoved(70); assert.equal(a.opened.openerOf(70), undefined);
});
