import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { claudeExceptions, claudePermission, claudeTrusted, mergeClaudeSettings } from '../src/client-permissions.js';
import { ClientSetup } from '../src/client-setup.js';
import { testDirectory } from './helpers.js';

const entry = { command: 'C:/Chrome MCP/program.exe', args: ['mcp'], env: { CHROME_MCP_TOKEN_FILE: 'private/client.token' } };
const verify = async () => ({ tools: 59, profiles: 0 });
const allow = (text: string) => JSON.parse(text).permissions?.allow;
async function fixture(run: (setup: ClientSetup, file: (name: string) => string) => Promise<void>) {
  const temp = await testDirectory();
  try { await run(new ClientSetup({ dataDir: temp.directory }, { home: temp.directory, entries: { claude: entry }, verify }), name => path.join(temp.directory, name)); }
  finally { await temp.cleanup(); }
}

test('信任只加整服务的允许规则，重复执行不再改动', () => {
  const source = '{\n  "model": "keep",\n  "permissions": {\n    "allow": ["Bash(ls:*)"],\n    "defaultMode": "plan"\n  }\n}\n';
  const trusted = mergeClaudeSettings(source, 'service'), data = JSON.parse(trusted);
  assert.deepEqual(data.permissions.allow, ['Bash(ls:*)', claudePermission]); assert.equal(data.permissions.defaultMode, 'plan'); assert.equal(data.model, 'keep');
  assert.equal(mergeClaudeSettings(trusted, 'service'), trusted); assert.equal(claudeTrusted(trusted), true);
  assert.equal(mergeClaudeSettings('{"permissions":{"allow":["mcp__saltedfish"]}}', 'service'), '{"permissions":{"allow":["mcp__saltedfish"]}}', '用户已有的整服务写法也算信任');
});

test('没有设置内容时也能生成规则，保留 BOM 和 CRLF', () => {
  assert.deepEqual(allow(mergeClaudeSettings('{}\n', 'service')), [claudePermission]);
  const text = mergeClaudeSettings('\ufeff{\r\n  "model": "keep"\r\n}\r\n', 'service');
  assert.ok(text.startsWith('\ufeff')); assert.ok(!text.replaceAll('\r\n', '').includes('\n')); assert.deepEqual(allow(text.slice(1)), [claudePermission]);
});

test('撤销移除两种整服务写法，其他规则保持', () => {
  const text = mergeClaudeSettings(JSON.stringify({ permissions: { allow: ['Bash(ls:*)', 'mcp__saltedfish', claudePermission, 'mcp__saltedfish__chrome_tabs', 'mcp__other__*'] } }), 'prompt');
  assert.deepEqual(allow(text), ['Bash(ls:*)', 'mcp__saltedfish__chrome_tabs', 'mcp__other__*']); assert.equal(claudeTrusted(text), false);
});

test('旧连接名的规则跟着改名，名字相近的服务不受影响，重复规则合并', () => {
  const text = mergeClaudeSettings(JSON.stringify({ permissions: { allow: ['mcp__feng-chrome__*', 'mcp__saltedfish__*', 'mcp__feng-chrome-two__*'], ask: ['mcp__feng-chrome__chrome_evaluate'], deny: ['mcp__feng-chrome'] } }), 'preserve');
  assert.deepEqual(JSON.parse(text).permissions, { allow: ['mcp__saltedfish__*', 'mcp__feng-chrome-two__*'], ask: ['mcp__saltedfish__chrome_evaluate'], deny: ['mcp__saltedfish'] });
});

test('没有要改的规则时原样返回', () => {
  for (const source of ['{}\n', '{"permissions":{"allow":["Bash(ls:*)"]}}']) assert.equal(mergeClaudeSettings(source, 'preserve'), source);
  assert.equal(mergeClaudeSettings('{"permissions":{"allow":["Bash(ls:*)"]}}', 'prompt'), '{"permissions":{"allow":["Bash(ls:*)"]}}');
});

test('规则不是字符串数组时拒绝，不覆盖原配置', () => {
  for (const source of ['{"permissions":[]}', '{"permissions":{"allow":"x"}}', '{"permissions":{"deny":[1]}}', 'not json']) assert.throws(() => mergeClaudeSettings(source, 'service'), (error: any) => error.code === 'CLIENT_CONFIG_INVALID');
});

test('逐工具的询问或拒绝规则会被识别，整服务规则也算', () => {
  assert.equal(claudeExceptions('{"permissions":{"ask":["mcp__saltedfish__chrome_evaluate"]}}'), true);
  assert.equal(claudeExceptions('{"permissions":{"deny":["mcp__saltedfish"]}}'), true);
  assert.equal(claudeExceptions('{"permissions":{"ask":["mcp__other__x"],"allow":["mcp__saltedfish__*"]}}'), false);
});

test('一次信任同时写连接和审批规则，备份和恢复算一次改动', () => fixture(async (setup, file) => {
  const config = file('.claude.json'), settings = file('.claude/settings.json');
  await mkdir(path.dirname(settings));
  await writeFile(config, '{"keep":"user"}'); await writeFile(settings, '{"model":"keep"}');
  const plan = await setup.preview('claude', { trust: 'service' });
  assert.equal(plan.trust, 'service'); assert.equal(plan.unchanged, false); assert.ok(plan.notices.some(note => note.includes(path.resolve(settings))));
  const result = await setup.apply(plan.planId) as { changeId: string; trust: string };
  assert.equal(result.trust, 'service'); assert.deepEqual(allow(await readFile(settings, 'utf8')), [claudePermission]); assert.equal(JSON.parse(await readFile(settings, 'utf8')).model, 'keep');
  assert.equal(JSON.parse(await readFile(config, 'utf8')).keep, 'user'); assert.equal(((await setup.inspect('claude')) as { trusted: boolean }).trusted, true);
  const history = await setup.history(); assert.equal(history.length, 1); assert.equal(history[0]!.canRestore, true);
  assert.equal((await setup.preview('claude', { trust: 'service' })).unchanged, true);
  await setup.restore(result.changeId);
  assert.equal(await readFile(config, 'utf8'), '{"keep":"user"}'); assert.equal(await readFile(settings, 'utf8'), '{"model":"keep"}');
}));

test('设置文件原本不存在时，恢复会删除新建的文件', () => fixture(async (setup, file) => {
  const result = await setup.apply((await setup.preview('claude', { trust: 'service' })).planId) as { changeId: string };
  await setup.restore(result.changeId);
  await assert.rejects(readFile(file('.claude/settings.json')), { code: 'ENOENT' }); await assert.rejects(readFile(file('.claude.json')), { code: 'ENOENT' });
}));

test('接入后审批文件被改动时不恢复，备份保留', () => fixture(async (setup, file) => {
  const result = await setup.apply((await setup.preview('claude', { trust: 'service' })).planId) as { changeId: string };
  await writeFile(file('.claude/settings.json'), '{"changed":true}');
  assert.equal((await setup.history())[0]!.canRestore, false);
  await assert.rejects(setup.restore(result.changeId), (error: any) => error.code === 'CLIENT_CONFIG_CHANGED');
  assert.equal(await readFile(file('.claude/settings.json'), 'utf8'), '{"changed":true}');
}));

test('已经接入时只改审批文件，连接配置不算改动；撤销同样', () => fixture(async (setup, file) => {
  await setup.apply((await setup.preview('claude', { trust: 'preserve' })).planId);
  const config = await readFile(file('.claude.json'), 'utf8');
  await assert.rejects(readFile(file('.claude/settings.json')), { code: 'ENOENT' });
  const plan = await setup.preview('claude', { trust: 'service' });
  assert.equal(plan.target, path.resolve(file('.claude/settings.json'))); assert.equal(plan.unchanged, false);
  const result = await setup.apply(plan.planId) as { changeId: string };
  assert.equal(await readFile(file('.claude.json'), 'utf8'), config); assert.deepEqual(allow(await readFile(file('.claude/settings.json'), 'utf8')), [claudePermission]);
  await writeFile(file('.claude.json'), config + '\n'); // Claude Code 自己也会改这个文件，不能挡住只动审批文件的恢复。
  await setup.restore(result.changeId); await assert.rejects(readFile(file('.claude/settings.json')), { code: 'ENOENT' });
  await writeFile(file('.claude.json'), config);
  await setup.apply((await setup.preview('claude', { trust: 'service' })).planId);
  await setup.apply((await setup.preview('claude', { trust: 'prompt' })).planId);
  assert.deepEqual(allow(await readFile(file('.claude/settings.json'), 'utf8')), []);
  assert.equal(((await setup.inspect('claude')) as { trusted: boolean }).trusted, false);
}));

test('项目范围的信任写个人的 settings.local.json，不写共享设置', () => fixture(async (setup, file) => {
  const project = file('project'); await mkdir(project);
  await setup.apply((await setup.preview('claude', { projectDirectory: project, trust: 'service' })).planId);
  assert.deepEqual(allow(await readFile(path.join(project, '.claude/settings.local.json'), 'utf8')), [claudePermission]);
  assert.ok(JSON.parse(await readFile(path.join(project, '.mcp.json'), 'utf8')).mcpServers.saltedfish);
  assert.deepEqual(await readdir(path.join(project, '.claude')), ['settings.local.json']);
}));

test('已有逐工具例外时在终端提示，其他信任说明不进终端', () => fixture(async (setup, file) => {
  await mkdir(file('.claude'));
  await writeFile(file('.claude/settings.json'), '{"permissions":{"deny":["mcp__saltedfish__chrome_evaluate"]}}');
  const plan = await setup.preview('claude', { trust: 'service' });
  assert.deepEqual(plan.highlights, ['保留已有的逐工具例外规则；这些工具仍按你原来的选择审批。']);
}));

test('保留审批且没有旧规则时不碰设置文件', () => fixture(async (setup, file) => {
  await mkdir(file('.claude'));
  await writeFile(file('.claude/settings.json'), '{"permissions":{"allow":["Bash(ls:*)"]}}');
  const plan = await setup.preview('claude', { trust: 'preserve' });
  assert.ok(plan.notices.some(note => note.includes('审批保持不变'))); assert.ok(!plan.notices.some(note => note.includes('审批规则写入')));
  await setup.apply(plan.planId);
  assert.equal(await readFile(file('.claude/settings.json'), 'utf8'), '{"permissions":{"allow":["Bash(ls:*)"]}}');
}));
