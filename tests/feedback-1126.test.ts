import test from 'node:test';
import assert from 'node:assert/strict';
import { unifiedFixture, fakeProfile } from './helpers.js';
import { BrowserError, CAPABILITY, EXTENSION_CAPABILITIES, type WireCommand } from '../src/shared.js';
import { dialogNotOpen } from '../src/service.js';

// 11-26 那批使用反馈的服务端部分。页面里的行为在 interaction-feedback-1126.integration.ts。
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('长等待分段发给扩展：每段最多 5 秒，中间段超时接着等，只有最后一段的超时带回现场', async t => {
  const f = await unifiedFixture(); t.after(() => f.cleanup());
  const waits: number[] = [];
  const reply = async (command: WireCommand) => {
    if (command.operation !== 'page.wait') return {};
    const ms = Number(command.args.timeoutMs); waits.push(ms);
    // 扩展照自己的期限等满再报超时；stableMs 那次只看段长，不用真等。
    if (!command.args.stableMs) await sleep(ms);
    throw new BrowserError('WAIT_TIMEOUT', `等待条件在 ${ms}ms 内未满足。现在在「表单」`, { phase: 'execution', outcome: 'not_dispatched' });
  };
  const profile = await fakeProfile(f.service.config, 'A', reply);
  const result = await f.service.invoke('chrome_wait', { profileId: profile.id, tabId: 7, textContains: '保存成功', timeoutMs: 10500 }, 'admin');
  assert.equal(result.error?.code, 'WAIT_TIMEOUT'); assert.match(result.error!.message, /现在在「表单」/);
  assert.equal(waits.length, 3, `分段：${waits}`); assert.deepEqual(waits.slice(0, 2), [5000, 5000]); assert.ok(waits[2]! <= 600, `最后一段是剩下的：${waits}`);
  // stableMs 长的段也跟着放长，不然一段里永远等不到“稳定”。
  waits.length = 0;
  const cancel = new AbortController();
  const stable = f.service.invoke('chrome_wait', { profileId: profile.id, tabId: 7, selector: '#a', stableMs: 6000, timeoutMs: 20000 }, 'admin', undefined, undefined, Infinity, cancel.signal);
  await sleep(200); cancel.abort(); await stable;
  assert.equal(waits[0], 9000, `stableMs 6000 的段：${waits}`);
});

test('客户端取消了等待：很快返回 CANCELLED（未派发），标签页让出来，紧接着的截图不再 TAB_BUSY', async t => {
  const f = await unifiedFixture(); t.after(() => f.cleanup());
  const reply = async (command: WireCommand) => {
    if (command.operation === 'page.wait') { await sleep(Number(command.args.timeoutMs)); throw new BrowserError('WAIT_TIMEOUT', '超时', { phase: 'execution', outcome: 'not_dispatched' }); }
    if (command.operation === 'page.screenshot') return { data: 'iVBORw0KGgo=', format: 'png' };
    return {};
  };
  const profile = await fakeProfile(f.service.config, 'A', reply);
  const cancel = new AbortController(), started = Date.now();
  const waiting = f.service.invoke('chrome_wait', { profileId: profile.id, tabId: 7, textContains: '保存成功', timeoutMs: 60000 }, 'admin', undefined, undefined, Infinity, cancel.signal);
  await sleep(300);
  // 等待占着标签页时，截图报 TAB_BUSY，写明在跑什么、还要多久。
  const blocked = await f.service.invoke('chrome_screenshot', { profileId: profile.id, tabId: 7 }, 'admin');
  assert.equal(blocked.error?.code, 'TAB_BUSY'); assert.equal(blocked.error?.outcome, 'not_dispatched');
  assert.match(blocked.error!.message, /chrome_wait 还在执行，最多再要约 \d+ 秒/);
  cancel.abort();
  const cancelled = await waiting;
  assert.equal(cancelled.error?.code, 'CANCELLED'); assert.equal(cancelled.error?.outcome, 'not_dispatched');
  assert.ok(Date.now() - started < 3000, `取消后立刻返回：${Date.now() - started}ms`);
  const shot = await f.service.invoke('chrome_screenshot', { profileId: profile.id, tabId: 7 }, 'admin');
  assert.notEqual(shot.error?.code, 'TAB_BUSY', JSON.stringify(shot.error));
});

test('chrome_action 带 beforeUnload 要 interaction-v11；旧扩展一条都收不到', async t => {
  const f = await unifiedFixture(); t.after(() => f.cleanup());
  const seen: WireCommand[] = [];
  const old = await fakeProfile(f.service.config, 'B', command => { seen.push(command); return {}; }, undefined, { capabilities: EXTENSION_CAPABILITIES.filter(capability => capability !== CAPABILITY.interactionV11) });
  const result = await f.service.invoke('chrome_action', { profileId: old.id, tabId: 7, action: 'click', selector: '#close', beforeUnload: 'accept' }, 'admin');
  assert.equal(result.error?.code, 'EXTENSION_UPDATE_REQUIRED'); assert.equal(result.error?.outcome, 'not_dispatched');
  assert.equal(seen.filter(command => command.operation === 'page.action').length, 0);
});

test('DIALOG_NOT_OPEN 按事件说清：还没弹过、已经关了（答的是什么）、标签页关了、调试连接断了', () => {
  const at = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
  const event = (sequence: number, method: string, params: Record<string, unknown> = {}, seconds = 5) => ({ sequence, profileId: 'p', tabId: 7, method, params, time: at(seconds) });
  assert.match(dialogNotOpen([], undefined).message, /还没弹过框/);
  const opened = event(1, 'Page.javascriptDialogOpening', { dialogId: 'd1', type: 'beforeunload' });
  assert.match(dialogNotOpen([opened, event(2, 'Page.javascriptDialogClosed', { result: true })], 'd1').message, /beforeunload 弹窗 5 秒前已经关了（离开）/);
  assert.match(dialogNotOpen([opened, event(2, 'tabs.removed')], undefined).message, /标签页 5 秒前已经关了/);
  assert.match(dialogNotOpen([opened, event(2, 'debugger.detached')], undefined).message, /调试连接 5 秒前断开了/);
  assert.match(dialogNotOpen([opened], 'other').message, /没见过 dialogId=other/);
  assert.equal(dialogNotOpen([], undefined).details.outcome, 'not_dispatched');
});

test('MCP 客户端自己超时会发取消：工具调用收到 signal，等待类工具据此收手', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createBrowserMcp } = await import('../src/mcp.js');
  let aborted: Promise<boolean> | undefined;
  const server = createBrowserMcp(async (_name, _args, signal) => {
    aborted = new Promise(resolve => { if (!signal) return resolve(false); signal.addEventListener('abort', () => resolve(true), { once: true }); setTimeout(() => resolve(false), 3000); });
    await aborted; return { ok: false, error: { code: 'CANCELLED', message: '取消' } };
  });
  const client = new Client({ name: 'test', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try {
    await assert.rejects(client.callTool({ name: 'chrome_wait', arguments: { profileId: 'p', tabId: 1, textContains: 'x', timeoutMs: 60000 } }, undefined, { timeout: 300 }), /timed out/i);
    assert.equal(await aborted, true, '客户端超时后服务端收到了取消');
  } finally { await client.close(); await server.close(); }
});

test('batch 步骤写错结构（参数平铺在步骤上、写成 type）：报错附上正确写法', async t => {
  const f = await unifiedFixture(); t.after(() => f.cleanup());
  const profile = await fakeProfile(f.service.config, 'A', () => ({ completed: true, results: [] }));
  for (const steps of [[{ operation: 'page.navigate', url: 'https://example.com/' }], [{ type: 'navigate', url: 'https://example.com/' }]]) {
    const result = await f.service.invoke('chrome_batch', { profileId: profile.id, tabId: 7, steps }, 'admin');
    assert.equal(result.error?.code, 'INVALID_ARGUMENT', JSON.stringify(result.error));
    assert.match(result.error!.message, /每一步写成 \{operation, args:\{…\}\}/);
  }
  // 参数内容本身错了（不是结构）不附这句。
  const inner = await f.service.invoke('chrome_batch', { profileId: profile.id, tabId: 7, steps: [{ operation: 'page.action', args: { action: 'fly' } }] }, 'admin');
  assert.doesNotMatch(inner.error!.message, /每一步写成/);
});
