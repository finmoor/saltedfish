import test from 'node:test';
import assert from 'node:assert/strict';
import { connectClients, connectResult, connectSummary, switchResult } from '../src/client-connect.js';
import type { ClientSetup, SetupSelection } from '../src/client-setup.js';

function fakeSetup(detected: { client: string; cliDetected?: boolean; configExists?: boolean }[] = []) {
  const previews: { client: string; selection: SetupSelection }[] = [], applied: string[] = [];
  const setup = {
    detect: async () => detected,
    preview: async (client: string, selection: SetupSelection) => { previews.push({ client, selection }); return { planId: client, client, trust: selection.trust }; },
    apply: async (id: string) => { applied.push(id); return { client: id }; },
  } as unknown as ClientSetup;
  return { setup, previews, applied };
}
const quiet = (t: any) => t.mock.method(console, 'log', () => {});

test('--trust-browser 对三个客户端都生效', async t => {
  quiet(t);
  const { setup, previews, applied } = fakeSetup();
  await connectClients(setup, ['--clients', 'codex,opencode,claude', '--trust-browser']);
  assert.deepEqual(previews.map(item => [item.client, item.selection.trust]), [['codex', 'service'], ['opencode', 'service'], ['claude', 'service']]);
  assert.deepEqual(applied, ['codex', 'opencode', 'claude']);
});

test('不指定 --clients 时只接入检测到的客户端', async t => {
  quiet(t);
  const { setup, previews } = fakeSetup([{ client: 'codex', cliDetected: true }, { client: 'opencode', cliDetected: false, configExists: false }, { client: 'claude', cliDetected: false, configExists: true }]);
  await connectClients(setup, ['--keep-approvals']);
  assert.deepEqual(previews.map(item => item.client), ['codex', 'claude']);
});

test('没有检测到客户端时明确报错，不写配置', async t => {
  quiet(t);
  const { setup, previews } = fakeSetup([{ client: 'codex' }, { client: 'opencode' }, { client: 'claude' }]);
  await assert.rejects(connectClients(setup, ['--keep-approvals']), (error: any) => error.code === 'NO_CLIENT_DETECTED');
  assert.equal(previews.length, 0);
});

test('未知客户端和多客户端自定义文件都被拒绝', async t => {
  quiet(t);
  const { setup, previews } = fakeSetup();
  await assert.rejects(connectClients(setup, ['--clients', 'codex,cursor', '--keep-approvals']), (error: any) => error.code === 'UNKNOWN_CLIENT');
  await assert.rejects(connectClients(setup, ['--clients', 'codex,claude', '--config', 'a.json', '--keep-approvals']), (error: any) => error.code === 'AMBIGUOUS_CONFIG');
  assert.equal(previews.length, 0);
});

test('pi 和 agy 也能用 --clients 指定，pi 默认不确认，不算进信任那一行', async t => {
  quiet(t);
  const { setup, previews } = fakeSetup();
  await connectClients(setup, ['--clients', 'pi,agy', '--trust-browser']);
  assert.deepEqual(previews.map(item => [item.client, item.selection.trust]), [['pi', 'service'], ['agy', 'service']]);
  const summary = connectSummary([{ client: 'pi', trust: 'preserve', highlights: ['pi 默认不逐次确认工具调用，接入后就能用已登录的身份操作网站。'] }, { client: 'agy', trust: 'service' }]);
  assert.match(summary, /^将接入 pi、agy，/); assert.match(summary, /信任后 agy 调用浏览器工具不再逐次确认/); assert.match(summary, /pi 默认不逐次确认/);
});

test('终端里只说接入谁和信任的含义，特别情况单独列出', () => {
  const summary = connectSummary([{ client: 'codex', trust: 'service', highlights: ['保留已有的逐工具例外规则'] }, { client: 'opencode', trust: 'service' }, { client: 'claude', trust: 'service' }]);
  assert.match(summary, /将接入 Codex、OpenCode、Claude Code，写入前自动备份配置/); assert.match(summary, /信任后 Codex、OpenCode、Claude Code 调用浏览器工具不再逐次确认，可以用已登录的身份操作网站/);
  assert.match(summary, /保留已有的逐工具例外规则/); assert.match(summary, /saltedfish connect --preview/);
  assert.ok(summary.split('\n').length <= 4);
  assert.doesNotMatch(connectSummary([{ client: 'claude', trust: 'preserve' }]), /信任/);
  assert.match(connectSummary([{ client: 'codex', trust: 'prompt' }]), /Codex 恢复逐次确认/);
  assert.match(connectSummary([{ client: 'codex', trust: 'service', unchanged: true }, { client: 'claude', trust: 'preserve' }]), /^将接入 Claude Code，/);
});

test('终端里的结果只报接入了谁、工具数和是否要重连', () => {
  assert.equal(connectResult([{ client: 'codex', verification: { tools: 59 } }, { client: 'claude', unchanged: true, verification: { tools: 59 } }]), '已接入：Codex（59 个工具）。已打开的会话要重连才生效。\n已是最新：Claude Code。');
  assert.equal(connectResult([]), '');
});

test('终端里不输出 JSON，明确选项时不询问', async t => {
  const output = quiet(t), { setup, applied } = fakeSetup();
  await connectClients(setup, ['--clients', 'codex,claude', '--trust-browser'], true);
  const text = output.mock.calls.map((call: any) => call.arguments[0]).join('\n');
  assert.doesNotMatch(text, /planId/); assert.match(text, /将接入 Codex、Claude Code/); assert.match(text, /已接入：Codex、Claude Code/); assert.deepEqual(applied, ['codex', 'claude']);
});

test('终端里 --preview 仍给完整 JSON，不写配置', async t => {
  const output = quiet(t), { setup, applied } = fakeSetup();
  await connectClients(setup, ['--clients', 'codex', '--preview', '--keep-approvals'], true);
  assert.ok(JSON.parse(output.mock.calls[0].arguments[0]).plans); assert.deepEqual(applied, []);
});

test('终端里没有检测到客户端时只提示，不让 install 失败', async t => {
  const output = quiet(t), { setup } = fakeSetup([{ client: 'codex' }]);
  await connectClients(setup, [], true);
  assert.match(output.mock.calls[0].arguments[0], /saltedfish connect/);
});

test('--preview 只预览，不写配置', async t => {
  quiet(t);
  const { setup, previews, applied } = fakeSetup();
  await connectClients(setup, ['--clients', 'claude', '--preview', '--keep-approvals']);
  assert.equal(previews.length, 1); assert.deepEqual(applied, []);
});

test('升级和回滚在终端只说结果和下一步', () => {
  const state = { version: '0.3.0-beta.13', previous: '0.3.0-beta.12' };
  assert.equal(switchResult('upgrade', state, [{ role: 'local', completed: [], skipped: [] }]), 'SaltedFish 已升级到 0.3.0-beta.13（原来是 0.3.0-beta.12）\n已打开的 Agent 会话要重连才生效。\n扩展图标显示 NEW 时，点开它更新。');
  assert.equal(switchResult('rollback', state, [{ role: 'local', skipped: [] }]), 'SaltedFish 已回滚到 0.3.0-beta.13\n已打开的 Agent 会话要重连才生效。');
  assert.match(switchResult('upgrade', state, []), /服务没有运行，运行 saltedfish start 启动/);
  assert.equal(switchResult('upgrade', state, undefined), 'SaltedFish 已经是 0.3.0-beta.13，不用升级。');
  const problems = switchResult('upgrade', state, [{ warning: '维护标记没清掉' }, { role: 'local', skipped: [{ client: 'codex', reason: '配置已变化' }] }, { role: 'gateway', warning: '目录未更新' }], 'kept');
  for (const text of ['维护标记没清掉', '没有更新 Codex：配置已变化', '目录未更新', 'launcher.mjs 被改过']) assert.ok(problems.includes(text), text);
});
