import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, fakeProfile, FAKE_CAPABILITIES } from './helpers.js';
import { CAPABILITY, type JsonObject, type WireCommand } from '../src/shared.js';

// 新版服务把带修饰键的鼠标动作、元素定位的 scroll、只给 deltaX 的 scroll 发给旧扩展，旧扩展会静默按旧语义执行
// （丢掉修饰键、在视口原点滚动、deltaY 仍默认 600）。服务必须在派发前要求 interaction-v6；其余动作不能被无谓地强制刷新。
// 门禁写在 src/service.ts 的 perform()，本用例永远严格：漏掉任何一类条件、或者误伤普通动作，都会让它失败，而不是悄悄跳过。
test('interaction-v6 门禁：只有真正用到新语义的动作才要求它，旧扩展在派发前被明确拒绝', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const seen: WireCommand[] = [];
  const profile = await fakeProfile(f.config, 'old-extension', command => { seen.push(command); return {}; }, undefined, { capabilities: FAKE_CAPABILITIES.filter(name => name !== CAPABILITY.interactionV6) });
  const action = (args: JsonObject) => f.service.invoke('chrome_action', { profileId: profile.id, tabId: 1, ...args }, 'owner');
  const batch = (args: JsonObject) => f.service.invoke('chrome_batch', { profileId: profile.id, tabId: 1, steps: [{ operation: 'page.action', args: { action: 'click', x: 1, y: 1 } }, { operation: 'page.action', args }] }, 'owner');
  const needs: JsonObject[] = [
    { action: 'click', x: 1, y: 1, modifiers: 8 }, { action: 'hover', selector: '#a', modifiers: 2 }, { action: 'scroll', x: 1, y: 1, deltaY: 10, modifiers: 4 },
    { action: 'scroll', selector: '#list', deltaY: 10 }, { action: 'scroll', ref: 'doc:1' }, { action: 'scroll', locator: { role: 'list' }, deltaY: 5 }, { action: 'scroll', x: 1, y: 1, deltaX: 30 },
  ];
  const free: JsonObject[] = [
    { action: 'click', x: 1, y: 1 }, { action: 'click', x: 1, y: 1, modifiers: 0 }, { action: 'hover', x: 1, y: 1 }, { action: 'press', key: 'a', selector: '#a', modifiers: 2 },
    { action: 'scroll', x: 1, y: 1 }, { action: 'scroll', x: 1, y: 1, deltaY: 40 }, { action: 'scroll', x: 1, y: 1, deltaX: 3, deltaY: 4 }, { action: 'fill', selector: '#a', text: 'x' },
  ];
  const firstPass = await Promise.all(needs.map(args => action(args)));
  const before = seen.length;
  for (const [index, args] of needs.entries()) {
    for (const result of [firstPass[index]!, await batch(args)]) {
      assert.equal(result.error?.code, 'EXTENSION_UPDATE_REQUIRED', JSON.stringify(args)); assert.equal(result.error?.outcome, 'not_dispatched', JSON.stringify(args));
    }
  }
  assert.equal(seen.length, before, '被拒绝的动作不会到达扩展');
  for (const args of free) assert.notEqual((await action(args)).error?.code, 'EXTENSION_UPDATE_REQUIRED', `${JSON.stringify(args)} 不应因 interaction-v6 被拒绝`);
  // 声明了 interaction-v6 的新扩展：全部放行
  const fresh = await fakeProfile(f.config, 'new-extension', command => { seen.push(command); return {}; });
  for (const args of needs) assert.notEqual((await f.service.invoke('chrome_action', { profileId: fresh.id, tabId: 1, ...args }, 'owner')).error?.code, 'EXTENSION_UPDATE_REQUIRED', JSON.stringify(args));
});
