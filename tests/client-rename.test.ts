import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { ClientSetup } from '../src/client-setup.js';
import { codexConfig } from '../src/client-config.js';
import { parseCodex, removeCodexServer } from '../src/codex-config.js';
import { testDirectory } from './helpers.js';

const entry = { command: 'C:/Chrome MCP/program.exe', args: ['mcp'], env: { CHROME_MCP_TOKEN_FILE: 'private/client.token' } };
const verify = async () => ({ tools: 59, profiles: 0 });
async function fixture(run: (setup: ClientSetup, target: (name: string) => string) => Promise<void>) {
  const temp = await testDirectory();
  try { await run(new ClientSetup({ dataDir: temp.directory }, { home: temp.directory, entries: { codex: entry, opencode: entry, claude: entry }, verify }), name => path.join(temp.directory, name)); }
  finally { await temp.cleanup(); }
}

test('Codex 迁移旧条目：沿用审批、逐工具规则和 schema 上限，其他配置的字节不变', () => fixture(async (setup, target) => {
  const file = target('config.toml'), before = '# 用户注释\r\nmodel = "keep"\r\n\r\n', after = '[mcp_servers.other]\r\ncommand = "untouched" # keep\r\n';
  const source = before + '[mcp_servers.feng-chrome]\r\ncommand = "old"\r\ndefault_tools_approval_mode = "approve"\r\ntool_input_schema_max_bytes = 65536\r\nenabled = false\r\n\r\n[mcp_servers.feng-chrome.tools.chrome_evaluate]\r\napproval_mode = "prompt"\r\n\r\n' + after;
  await writeFile(file, source);
  const plan = await setup.preview('codex', { configPath: file });
  assert.equal(plan.mode, 'migrate-server'); assert.ok(plan.notices.some(note => note.includes('feng-chrome') && note.includes('审批设置沿用')));
  assert.ok(!plan.highlights.some(note => note.includes('feng-chrome')), '改名不在终端里解释'); assert.ok(plan.highlights.some(note => note.includes('禁用状态')));
  await setup.apply(plan.planId);
  const text = await readFile(file, 'utf8'), data = parseCodex(text);
  assert.ok(text.startsWith(before + after)); assert.ok(!text.includes('feng-chrome')); assert.equal(data.mcp_servers.other.command, 'untouched');
  const server = data.mcp_servers.saltedfish;
  assert.equal(server.command, entry.command); assert.equal(server.default_tools_approval_mode, 'approve'); assert.equal(server.tool_input_schema_max_bytes, 65536);
  assert.equal(server.enabled, false); assert.equal(server.tools.chrome_evaluate.approval_mode, 'prompt');
  const again = await setup.preview('codex', { configPath: file });
  assert.equal(again.unchanged, true); assert.equal(again.mode, 'replace-server');
}));

test('Codex 入口文件的 env 子表和主表同名，只有一个服务', () => {
  const { mcp_servers } = parseCodex(codexConfig(entry));
  assert.deepEqual(Object.keys(mcp_servers), ['saltedfish']); assert.deepEqual(mcp_servers.saltedfish.env, entry.env);
});

test('beta.5 生成的入口文件把 env 留在旧名称下，接入时仍带上独立凭据', async () => {
  const temp = await testDirectory();
  try {
    await writeFile(path.join(temp.directory, 'codex-config.toml'), '[mcp_servers.saltedfish]\ncommand = "node"\nargs = ["launcher.mjs", "mcp"]\n\n[mcp_servers.feng-chrome.env]\nCHROME_MCP_DATA_DIR = "data"\nCHROME_MCP_TOKEN_FILE = "private/codex.token"\n');
    const setup = new ClientSetup({ dataDir: temp.directory }, { home: temp.directory, verify, localTransport: 'stdio' }), file = path.join(temp.directory, 'config.toml');
    await setup.apply((await setup.preview('codex', { configPath: file })).planId);
    const server = parseCodex(await readFile(file, 'utf8')).mcp_servers.saltedfish;
    assert.equal(server.env.CHROME_MCP_TOKEN_FILE, 'private/codex.token'); assert.equal(server.env.CHROME_MCP_DATA_DIR, 'data');
  } finally { await temp.cleanup(); }
});

test('入口文件没有独立凭据时拒绝接入，不写配置', async () => {
  const temp = await testDirectory();
  try {
    await writeFile(path.join(temp.directory, 'codex-config.toml'), '[mcp_servers.saltedfish]\ncommand = "node"\nargs = ["launcher.mjs", "mcp"]\n');
    const setup = new ClientSetup({ dataDir: temp.directory }, { home: temp.directory, verify }), file = path.join(temp.directory, 'config.toml');
    await assert.rejects(setup.preview('codex', { configPath: file }), (error: any) => error.code === 'CLIENT_CREDENTIAL_MISSING');
    await assert.rejects(readFile(file), { code: 'ENOENT' });
  } finally { await temp.cleanup(); }
});

test('Codex 迁移后可以恢复原配置', () => fixture(async (setup, target) => {
  const file = target('config.toml'), source = '[mcp_servers.feng-chrome]\ncommand = "old"\n';
  await writeFile(file, source);
  const applied = await setup.apply((await setup.preview('codex', { configPath: file })).planId) as { changeId: string };
  assert.notEqual(await readFile(file, 'utf8'), source);
  await setup.restore(applied.changeId); assert.equal(await readFile(file, 'utf8'), source);
}));

test('Codex 内联写法和已有新名称都能移除旧条目', () => fixture(async (setup, target) => {
  assert.deepEqual(Object.keys(parseCodex(removeCodexServer('mcp_servers = { feng-chrome = { command = "old" }, other = { command = "keep" } }\n', 'feng-chrome')).mcp_servers), ['other']);
  assert.equal(removeCodexServer('model = "keep"\n', 'feng-chrome'), 'model = "keep"\n');
  assert.equal(removeCodexServer('model = "keep"\n\n[mcp_servers.feng-chrome]\ncommand = "old"\n', 'feng-chrome'), 'model = "keep"\n');
  const file = target('config.toml');
  await writeFile(file, '[mcp_servers.feng-chrome]\ncommand = "old"\ndefault_tools_approval_mode = "approve"\n\n[mcp_servers.saltedfish]\ncommand = "new"\ndefault_tools_approval_mode = "prompt"\n');
  const plan = await setup.preview('codex', { configPath: file });
  assert.ok(plan.notices.some(note => note.includes('以 saltedfish 为准')));
  await setup.apply(plan.planId);
  const servers = parseCodex(await readFile(file, 'utf8')).mcp_servers;
  assert.deepEqual(Object.keys(servers), ['saltedfish']); assert.equal(servers.saltedfish.default_tools_approval_mode, 'prompt');
}));

test('OpenCode 2 迁移时权限规则跟着改名，其他规则和注释保留', () => fixture(async (setup, target) => {
  const file = target('opencode.jsonc');
  await writeFile(file, `{
  // 用户注释
  "mcp": { "servers": { "feng-chrome": { "type": "local", "command": ["old"], "codemode": false }, "other": { "type": "local", "command": ["keep"] } } },
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "deny" },
    { "action": "feng-chrome_*", "resource": "*", "effect": "allow" },
    { "action": "feng-chrome_chrome_evaluate", "resource": "*", "effect": "ask" }
  ]
}
`);
  await setup.apply((await setup.preview('opencode', { configPath: file })).planId);
  const text = await readFile(file, 'utf8'), data = parse(text);
  assert.ok(text.includes('// 用户注释')); assert.ok(!text.includes('feng-chrome'));
  assert.deepEqual(Object.keys(data.mcp.servers).sort(), ['other', 'saltedfish']); assert.equal(data.mcp.servers.saltedfish.codemode, false); assert.deepEqual(data.mcp.servers.saltedfish.command, [entry.command, 'mcp']);
  assert.deepEqual(data.permissions, [{ action: 'shell', resource: '*', effect: 'deny' }, { action: 'saltedfish_*', resource: '*', effect: 'allow' }, { action: 'saltedfish_chrome_evaluate', resource: '*', effect: 'ask' }]);
}));

test('OpenCode 2 迁移时明确选择的信任只保留一条，改名后的旧规则不重复', () => fixture(async (setup, target) => {
  const file = target('opencode.json');
  await writeFile(file, '{"mcp":{"servers":{"feng-chrome":{"type":"local","command":["old"]}}},"permissions":[{"action":"feng-chrome_*","resource":"*","effect":"ask"}]}');
  await setup.apply((await setup.preview('opencode', { configPath: file, trust: 'service' })).planId);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).permissions, [{ action: 'saltedfish_*', resource: '*', effect: 'allow' }]);
}));

test('OpenCode 迁移不碰别的服务，保留原有不规范的 permissions，并提示剩下的旧名称', () => fixture(async (setup, target) => {
  const file = target('opencode.json');
  await writeFile(file, '{"mcp":{"servers":{"feng-chrome":{"type":"local","command":["old"]},"feng-chrome_other":{"type":"local","command":["keep"]}}},"permissions":[{"action":"feng-chrome_other_run","resource":"*","effect":"deny"},"手写内容"]}');
  const plan = await setup.preview('opencode', { configPath: file });
  assert.ok(plan.notices.some(note => note.includes('手动检查')));
  await setup.apply(plan.planId);
  const data = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(data.mcp.servers).sort(), ['feng-chrome_other', 'saltedfish']); assert.deepEqual(data.permissions, [{ action: 'feng-chrome_other_run', resource: '*', effect: 'deny' }, '手写内容']);
}));

test('OpenCode 1 迁移保留禁用状态', () => fixture(async (setup, target) => {
  const file = target('opencode.json');
  await writeFile(file, '{"mcp":{"feng-chrome":{"type":"local","command":["old"],"enabled":false,"custom":1}}}');
  await setup.apply((await setup.preview('opencode', { configPath: file })).planId);
  const { mcp } = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(mcp['feng-chrome'], undefined); assert.equal(mcp.saltedfish.custom, 1); assert.equal(mcp.saltedfish.type, 'local');
}));

test('Claude Code 迁移替换旧条目，旧前缀的审批规则跟着改名', () => fixture(async (setup, target) => {
  const file = target('.claude.json'), settings = target('.claude/settings.json');
  await mkdir(path.dirname(settings));
  await writeFile(file, JSON.stringify({ keep: 'user', mcpServers: { 'feng-chrome': { command: 'old', args: [] }, other: { command: 'keep' } } }));
  await writeFile(settings, JSON.stringify({ model: 'keep', permissions: { allow: ['Bash(ls:*)', 'mcp__feng-chrome__*'], deny: ['mcp__feng-chrome__chrome_evaluate', 'mcp__feng-chrome-other__run'] } }));
  const plan = await setup.preview('claude');
  assert.equal(plan.mode, 'migrate-server'); assert.ok(!plan.highlights.length);
  await setup.apply(plan.planId);
  const data = JSON.parse(await readFile(file, 'utf8')), rules = JSON.parse(await readFile(settings, 'utf8'));
  assert.equal(data.keep, 'user'); assert.deepEqual(Object.keys(data.mcpServers).sort(), ['other', 'saltedfish']); assert.equal(data.mcpServers.saltedfish.command, entry.command);
  assert.equal(rules.model, 'keep'); assert.deepEqual(rules.permissions, { allow: ['Bash(ls:*)', 'mcp__saltedfish__*'], deny: ['mcp__saltedfish__chrome_evaluate', 'mcp__feng-chrome-other__run'] });
}));

test('只有旧名称时 inspect 仍识别为已接入，并提示下次接入会改名', () => fixture(async (setup, target) => {
  const codex = target('.codex/config.toml'), opencode = target('.config/opencode/opencode.json');
  await setup.apply((await setup.preview('codex', { trust: 'service' })).planId);
  await setup.apply((await setup.preview('opencode', { trust: 'service' })).planId);
  await writeFile(codex, (await readFile(codex, 'utf8')).replaceAll('saltedfish', 'feng-chrome'));
  await writeFile(opencode, (await readFile(opencode, 'utf8')).replaceAll('saltedfish', 'feng-chrome'));
  for (const client of ['codex', 'opencode'] as const) {
    const state = await setup.inspect(client) as { connection: string; trusted?: boolean; note: string };
    assert.equal(state.connection, 'configured'); assert.equal(state.trusted, true); assert.match(state.note, /改为 saltedfish/);
  }
}));
