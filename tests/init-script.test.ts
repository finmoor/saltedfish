import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { unifiedFixture, fakeProfile } from './helpers.js';
import { CAPABILITY, EXTENSION_CAPABILITIES, BrowserError, errorInfo, type WireCommand } from '../src/shared.js';
import { toolMap } from '../src/tools.js';
import { initScriptRegistration, initScriptSource } from '../extension/init-script.js';
import type { Principal } from '../src/auth.js';

// 新文档加载前注入脚本（chrome_navigate、chrome_new_tab 的 initScript）的服务端和扩展纯逻辑部分；页面里的行为在 interaction-init-script.integration.ts。

// 在一个假的全局里跑包装后的脚本：self.origin 由测试给，脚本往 globalThis.out 里写。
function runWrapped(source: string, origin: string, protectedOrigins: string[] = []) {
  const scope: Record<string, unknown> = { origin, out: [] as unknown[] };
  new Function('self', 'globalThis', 'window', initScriptSource(source, protectedOrigins))(scope, scope, scope);
  return scope;
}

test('包装：按函数体执行，顶层声明不进全局；受保护的 origin 整段不执行；没有保护列表时照常执行', () => {
  const ran = runWrapped('const local = 1; globalThis.out.push("ran", typeof local); return; globalThis.out.push("after return");', 'https://video.example.com', ['http://127.0.0.1:17422']);
  assert.deepEqual(ran.out, ['ran', 'number'], '顶层 return 可用，后面的不跑');
  assert.equal('local' in ran, false);
  assert.deepEqual(runWrapped('globalThis.out.push("ran")', 'http://127.0.0.1:17422', ['http://127.0.0.1:17422', 'chrome-extension://abc']).out, [], '管理页上不执行');
  assert.deepEqual(runWrapped('globalThis.out.push("ran")', 'chrome-extension://abc', ['http://127.0.0.1:17422', 'chrome-extension://abc']).out, [], '扩展页面上不执行');
  assert.deepEqual(runWrapped('globalThis.out.push("ran")', 'http://127.0.0.1:17422').out, ['ran'], '管理员主体没有保护列表');
  // 函数声明在外层函数里，不会被提升成页面的全局函数（直接拼前缀的写法在管理页上也会把 function fetch(){} 装进全局）。
  const hoisted = runWrapped('function fetch() { return "hooked"; }', 'http://127.0.0.1:17422', ['http://127.0.0.1:17422']);
  assert.equal('fetch' in hoisted, false);
  assert.match(initScriptSource('x()', []), /^\(function\(\)\{\nx\(\)\n\}\)\(\);$/);
});

test('参数校验：initScript 必须单独就是合法的函数体，闭合不了外层函数；不能配 wait:false；timeoutMs 只和 initScript 一起用', () => {
  const navigate = toolMap.get('chrome_navigate')!.schema, newTab = toolMap.get('chrome_new_tab')!.schema;
  const target = { profileId: 'p', tabId: 1, url: 'https://video.example.com/user/x' };
  assert.equal(navigate.safeParse({ ...target, initScript: 'if (window !== top) return; window.__hook = [];' }).success, true);
  for (const escape of ['})();fetch=null;(function(){', '}); evil(); (function(){', '/*', 'await fetch("/x")']) {
    const parsed = navigate.safeParse({ ...target, initScript: escape });
    assert.equal(parsed.success, false, escape);
    assert.match(errorInfo(parsed.error).message, /initScript 不是合法的 JavaScript 函数体/);
  }
  assert.match(errorInfo(navigate.safeParse({ ...target, initScript: 'x()', wait: false }).error).message, /不能和 wait:false 一起用/);
  assert.equal(navigate.safeParse({ ...target, initScript: '' }).success, false);
  assert.equal(navigate.safeParse({ ...target, initScript: 'x'.repeat(200001) }).success, false, '最长 20 万字');
  assert.equal(newTab.safeParse({ profileId: 'p', url: target.url, initScript: 'x()', timeoutMs: 60000 }).success, true);
  assert.match(errorInfo(newTab.safeParse({ profileId: 'p', url: target.url, timeoutMs: 60000 }).error).message, /timeoutMs 只和 initScript 一起用/);
  assert.equal(toolMap.get('chrome_batch')!.schema.safeParse({ ...target, steps: [{ operation: 'page.navigate', args: { url: target.url, initScript: 'x()' } }] }).success, false, '批次里的导航没有 initScript');
  const schema = (name: string) => JSON.stringify(z.toJSONSchema(toolMap.get(name)!.schema, { target: 'draft-7', io: 'input' }));
  for (const name of ['chrome_navigate', 'chrome_new_tab']) { assert.match(schema(name), /只管这一次导航/); assert.match(schema(name), /跨进程 iframe/); }
});

test('扩展登记：派发前 add，失败是未派发；remove 只撤一次，调试连接已断开算撤掉了，其他失败如实报告', async () => {
  const sent: [string, unknown][] = [];
  let fail: string | undefined;
  const send = async (method: string, params: Record<string, unknown> = {}) => { sent.push([method, params]); if (fail) throw new Error(fail); return method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: '7' } : {}; };
  const script = initScriptRegistration(send as any);
  assert.equal(await script.remove(), true, '没登记就不发撤销');
  assert.equal(sent.length, 0);
  await script.add('x()');
  assert.equal(script.registered, true);
  assert.deepEqual(sent[0], ['Page.addScriptToEvaluateOnNewDocument', { source: 'x()' }], '主世界：不带 worldName，也不在当前文档立即执行');
  assert.equal(await script.remove(), true);
  assert.deepEqual(sent[1], ['Page.removeScriptToEvaluateOnNewDocument', { identifier: '7' }]);
  assert.equal(await script.remove(), true); assert.equal(sent.length, 2, '只撤一次');

  const detached = initScriptRegistration(send as any); await detached.add('x()');
  fail = 'Debugger is not attached to the tab with id: 3.'; assert.equal(await detached.remove(), true);
  fail = undefined; const stuck = initScriptRegistration(send as any); await stuck.add('x()');
  fail = 'Internal error'; assert.equal(await stuck.remove(), false);
  fail = 'Not allowed';
  const rejected = initScriptRegistration(send as any);
  await assert.rejects(rejected.add('x()'), (error: unknown) => error instanceof BrowserError && error.code === 'INIT_SCRIPT_REJECTED' && error.details.outcome === 'not_dispatched');
  assert.equal(rejected.registered, false);
});

test('服务：navigate 把 initScript 交给扩展（非管理员带管理页保护列表）；new_tab 先开空白页再带脚本导航；旧扩展报需要更新、什么都不发', async t => {
  const f = await unifiedFixture(); t.after(() => f.cleanup());
  const seen: WireCommand[] = [];
  let navigateReply: (command: WireCommand) => unknown = command => ({ tabId: command.args.tabId, url: command.args.url, status: 'complete', initScript: { removed: true } });
  const reply = (command: WireCommand) => {
    seen.push(command);
    if (command.operation === 'tabs.create') return { tabId: 42, url: command.args.url, status: 'complete' };
    if (command.operation === 'page.navigate') return navigateReply(command);
    return {};
  };
  const profile = await fakeProfile(f.service.config, 'A', reply);
  const agent: Principal = f.service.state.authenticate(f.service.state.createClient('受限客户端').token)!;
  const hook = 'if (window !== top) return; window.__posts = [];';
  const url = 'https://video.example.com/user/MS4wLjABAAAA';

  const navigated = await f.service.invoke('chrome_navigate', { profileId: profile.id, tabId: 7, url, initScript: hook }, `o-${agent.id}`, agent);
  assert.equal(navigated.ok, true, JSON.stringify(navigated.error));
  const sentNavigate = seen.filter(command => command.operation === 'page.navigate').at(-1)!;
  assert.equal(sentNavigate.args.initScript, hook, '脚本原样交给扩展，由扩展包装');
  assert.ok(Array.isArray(sentNavigate.args.adminGuard), '非管理员带管理页保护列表，扩展据此跳过管理页');
  assert.equal(navigated.warnings, undefined);
  assert.deepEqual((navigated.data as any).initScript, { removed: true });

  navigateReply = command => ({ tabId: command.args.tabId, url: command.args.url, status: 'complete', initScript: { removed: false } });
  const stuck = await f.service.invoke('chrome_navigate', { profileId: profile.id, tabId: 7, url, initScript: hook }, 'admin');
  assert.equal(stuck.ok, true); assert.equal(stuck.warnings?.[0]?.code, 'INIT_SCRIPT_NOT_REMOVED');
  navigateReply = command => ({ tabId: command.args.tabId, url: command.args.url, status: 'complete', initScript: { removed: true } });

  seen.length = 0;
  const opened = await f.service.invoke('chrome_new_tab', { profileId: profile.id, url, initScript: hook, timeoutMs: 45000 }, 'admin');
  assert.equal(opened.ok, true, JSON.stringify(opened.error));
  assert.deepEqual(seen.map(command => command.operation).filter(operation => operation !== 'page.cdp'), ['tabs.create', 'page.navigate']);
  const first = seen.find(command => command.operation === 'tabs.create')!;
  assert.equal(first.args.url, 'about:blank', '先开空白页，脚本登记好再打开目标网址');
  assert.equal(first.args.initScript, undefined);
  const second = seen.find(command => command.operation === 'page.navigate')!;
  assert.equal(second.args.tabId, 42); assert.equal(second.args.url, url); assert.equal(second.args.initScript, hook); assert.equal(second.args.wait, true);
  assert.equal((opened.data as any).tabId, 42); assert.equal((opened.data as any).url, url);
  assert.ok(opened.operationId, '结果带导航那一步的操作记录');

  // 导航失败：错误里写明标签页已经开好、tabId 是多少。
  navigateReply = () => { throw new BrowserError('NAVIGATION_FAILED', 'net::ERR_NAME_NOT_RESOLVED', { phase: 'precondition', outcome: 'not_dispatched' }); };
  const failed = await f.service.invoke('chrome_new_tab', { profileId: profile.id, url: 'https://nowhere.invalid/', initScript: hook }, 'admin');
  assert.equal(failed.ok, false); assert.equal(failed.error?.code, 'NAVIGATION_FAILED');
  assert.match(failed.error!.message, /新标签页已经开好，tabId 42，停在空白页/);
  assert.equal((failed.error as any).detail.tabId, 42); assert.equal(failed.error?.outcome, 'not_dispatched');

  navigateReply = command => ({ tabId: command.args.tabId, url: command.args.url, status: 'complete' });
  const old = await fakeProfile(f.service.config, 'B', reply, undefined, { capabilities: EXTENSION_CAPABILITIES.filter(capability => capability !== CAPABILITY.initScriptV1) });
  seen.length = 0;
  for (const [name, args] of [['chrome_navigate', { tabId: 7, url, initScript: hook }], ['chrome_new_tab', { url, initScript: hook }]] as [string, Record<string, unknown>][]) {
    const result = await f.service.invoke(name, { profileId: old.id, ...args }, 'admin');
    assert.equal(result.error?.code, 'EXTENSION_UPDATE_REQUIRED', name);
    assert.equal(result.error?.outcome, 'not_dispatched', name);
  }
  assert.deepEqual(seen.filter(command => command.operation !== 'page.cdp'), [], '旧扩展一条都没收到，也没开出空白页');
  const plain = await f.service.invoke('chrome_navigate', { profileId: old.id, tabId: 7, url }, 'admin');
  assert.equal(plain.ok, true, JSON.stringify(plain.error));
});

test('chrome_cdp 的新文档脚本：非管理员的 source 要单独就是合法的函数体，否则派发前拒绝；管理员不改', async t => {
  const f = await unifiedFixture(); t.after(() => f.cleanup());
  const seen: WireCommand[] = [];
  const profile = await fakeProfile(f.service.config, 'A', command => { seen.push(command); return { identifier: '1' }; });
  const agent: Principal = f.service.state.authenticate(f.service.state.createClient('受限客户端').token)!;
  const cdp = (source: string, principal?: Principal) => f.service.invoke('chrome_cdp', { profileId: profile.id, tabId: 7, method: 'Page.addScriptToEvaluateOnNewDocument', params: { source } }, principal ? `o-${principal.id}` : 'admin', principal);
  const sent = () => seen.filter(command => command.operation === 'page.cdp' && (command.args as any).method === 'Page.addScriptToEvaluateOnNewDocument');
  const ok = await cdp('if (window !== top) return; window.__hook = 1;', agent);
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
  assert.equal((sent().at(-1)!.args as any).params.source, 'if (window !== top) return; window.__hook = 1;', '服务原样交给扩展，由扩展套函数');
  for (const source of ['})();window.fetch=null;(function(){', 'await 1']) {
    const before = sent().length, refused = await cdp(source, agent);
    assert.equal(refused.error?.code, 'INVALID_ARGUMENT', source); assert.equal(refused.error?.outcome, 'not_dispatched');
    assert.match(refused.error!.message, /params\.source: .*按函数体执行.*initScript/);
    assert.equal(sent().length, before, '没有发给扩展');
  }
  const admin = await cdp('})();(function(){');
  assert.equal(admin.ok, true, '管理员不套函数，也不校验');
});
