import test from 'node:test';
import assert from 'node:assert/strict';
import { unifiedFixture, fakeProfile } from './helpers.js';
import { CAPABILITY, EXTENSION_CAPABILITIES, type WireCommand } from '../src/shared.js';
import { z } from 'zod';
import { toolMap } from '../src/tools.js';

// 11-05 那批使用反馈的服务端部分：参数校验、旧扩展的能力判断、说明文字。页面里的行为在 interaction-feedback-1105.integration.ts。
test('textMatches 和 chrome_action 的 postcondition：参数校验，用到时要 interaction-v9，旧扩展报需要更新、不派发', async t => {
  const f = await unifiedFixture(); t.after(() => f.cleanup());
  const seen: WireCommand[] = [];
  const reply = (command: WireCommand) => { seen.push(command); return command.operation === 'page.wait' ? { matched: true, value: true } : command.operation === 'page.batch' ? { completed: true, results: [] } : { clicked: true, postcondition: { matched: true, url: 'https://creator.example/manage', title: '作品管理' } }; };
  const profile = await fakeProfile(f.service.config, 'A', reply);
  const invoke = (name: string, args: Record<string, unknown>, profileId = profile.id) => f.service.invoke(name, { profileId, tabId: 7, ...args }, 'admin');

  const waited = await invoke('chrome_wait', { textMatches: '热度\\s*[\\d.]+万', timeoutMs: 1000 });
  assert.equal(waited.ok, true, JSON.stringify(waited.error));
  assert.equal(seen.at(-1)!.args.textMatches, '热度\\s*[\\d.]+万', '只给 textMatches 也是有效条件，原样交给扩展');
  const bad = await invoke('chrome_wait', { textMatches: '热度(' });
  assert.equal(bad.error?.code, 'INVALID_ARGUMENT'); assert.match(bad.error!.message, /textMatches 不是有效的 JavaScript 正则/);

  const clicked = await invoke('chrome_action', { action: 'click', selector: '#publish', postcondition: { urlContains: '/manage', timeoutMs: 5000 } });
  assert.equal(clicked.ok, true, JSON.stringify(clicked.error));
  assert.deepEqual(seen.filter(command => command.operation === 'page.action').at(-1)!.args.postcondition, { urlContains: '/manage', timeoutMs: 5000, state: 'visible' }, '后置条件随动作一起交给扩展');
  assert.equal((clicked.data as any).postcondition.url, 'https://creator.example/manage');
  assert.equal((await invoke('chrome_action', { action: 'click', selector: '#publish', postcondition: { state: 'visible' } })).error?.code, 'INVALID_ARGUMENT', '后置条件要有元素、文字或网址');
  assert.equal((await invoke('chrome_action', { action: 'click', selector: '#publish', postcondition: { expression: 'true' } })).error?.code, 'INVALID_ARGUMENT', '后置条件不执行任意 JS');

  const old = await fakeProfile(f.service.config, 'B', reply, undefined, { capabilities: EXTENSION_CAPABILITIES.filter(capability => capability !== CAPABILITY.interactionV9) });
  const before = seen.filter(command => command.operation !== 'page.cdp').length;
  for (const [name, args] of [
    ['chrome_wait', { textMatches: '\\d+' }],
    ['chrome_action', { action: 'click', selector: '#publish', postcondition: { urlContains: '/manage' } }],
    ['chrome_batch', { steps: [{ operation: 'page.wait', args: { textMatches: '\\d+' } }] }],
    ['chrome_batch', { steps: [{ operation: 'page.action', args: { action: 'click', selector: '#a' }, postcondition: { textMatches: '\\d+' } }] }],
  ] as [string, Record<string, unknown>][]) assert.equal((await invoke(name, args, old.id)).error?.code, 'EXTENSION_UPDATE_REQUIRED', `${name} ${JSON.stringify(args)}`);
  assert.equal(seen.filter(command => command.operation !== 'page.cdp').length, before, '旧扩展一条都没收到');
  assert.equal((await invoke('chrome_wait', { textContains: '作品管理' }, old.id)).ok, true, '不用新字段的等待旧扩展照常');
  assert.equal((await invoke('chrome_batch', { steps: [{ operation: 'page.action', args: { action: 'click', selector: '#a' }, postcondition: { urlContains: '/manage' } }] }, old.id)).ok, true, '批次步骤的后置条件旧扩展本来就支持');
});

test('说明文字：evaluate 提示直接返回对象、不用 JSON.stringify；savePath 说清只拦数据目录；chrome_action 的 postcondition 有说明', () => {
  const schema = (name: string) => JSON.stringify(z.toJSONSchema(toolMap.get(name)!.schema, { target: 'draft-7', io: 'input' }));
  assert.match(schema('chrome_evaluate'), /不用 JSON\.stringify/);
  assert.match(schema('chrome_screenshot'), /数据目录不能写/);
  assert.doesNotMatch(schema('chrome_screenshot'), /save-roots/);
  assert.match(schema('chrome_action'), /POSTCONDITION_TIMEOUT/);
  assert.match(schema('chrome_wait'), /textMatches/);
});
