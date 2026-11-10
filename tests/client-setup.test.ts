import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, access, symlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { ClientSetup, verifyClientEntry } from '../src/client-setup.js';
import { fixture, testDirectory } from './helpers.js';
import { projectDir } from '../src/config.js';
import { isAdvancedTool, toolDefinitions } from '../src/tools.js';

const entry = { command: 'C:/program/FengChromeMCP.exe', args: ['mcp'], env: { CHROME_MCP_TOKEN_FILE: 'C:/private/client.token', CHROME_MCP_DATA_DIR: 'C:/private/data' } };
test('项目与自定义配置明确定位、提示优先级、支持 OpenCode 1 且能恢复原目标', async () => {
  const f = await fixture(), temp = await testDirectory();
  try {
    const project = path.join(temp.directory, '中文项目'); await mkdir(project);
    const user = { projects: { [project]: { mcpServers: { 'saltedfish': { command: 'unchanged' } } } } };
    await writeFile(path.join(temp.directory, '.claude.json'), JSON.stringify(user));
    const setup = new ClientSetup(f.config, { home: temp.directory, entries: { claude: entry, opencode: entry }, verify: async () => ({ tools: toolDefinitions.length, profiles: 0 }) });
    const plan = await setup.preview('claude', { projectDirectory: project }); assert.equal(plan.target, path.join(project, '.mcp.json')); assert.ok(plan.notices.some(note => note.includes('本地同名')));
    const result = await setup.apply(plan.planId); assert.equal(JSON.parse(await readFile(plan.target, 'utf8')).mcpServers['saltedfish'].command, entry.command);
    assert.deepEqual(JSON.parse(await readFile(path.join(temp.directory, '.claude.json'), 'utf8')), user); assert.ok(result.changeId); await setup.restore(result.changeId); await assert.rejects(access(plan.target));
    const custom = path.join(project, 'custom.jsonc'), original = '{ // 自定义\n "mcp":{"other":{"type":"local","command":["keep"]}},\n}'; await writeFile(custom, original);
    await assert.rejects(setup.preview('opencode', { configPath: custom, format: 'v2' }), { code: 'LEGACY_OPENCODE_CONFIG' });
    const old = await setup.apply((await setup.preview('opencode', { configPath: custom, format: 'v1' })).planId);
    const parsed = parse(await readFile(custom, 'utf8')); assert.equal(parsed.mcp.servers, undefined); assert.equal(parsed.mcp.other.command[0], 'keep'); assert.equal(parsed.mcp['saltedfish'].command[0], entry.command);
    assert.ok(old.changeId); await new ClientSetup(f.config, { home: project }).restore(old.changeId); assert.equal(await readFile(custom, 'utf8'), original);
    await writeFile(path.join(project, 'opencode.json'), '{}'); await writeFile(path.join(project, 'opencode.jsonc'), '{}');
    await assert.rejects(setup.preview('opencode', { projectDirectory: project }), { code: 'AMBIGUOUS_CONFIG' });
    await setup.preview('opencode', { configPath: path.join(project, 'opencode.jsonc') });
    for (const configPath of ['relative.json', '\\\\server\\config.json', path.join(project, 'file.txt')]) await assert.rejects(setup.preview('claude', { configPath }), { code: 'INVALID_CONFIG_PATH' });
    await assert.rejects(setup.preview('claude', { configPath: custom, projectDirectory: project }), { code: 'AMBIGUOUS_CONFIG' });
  } finally { await f.cleanup(); await temp.cleanup(); }
});

test('自定义配置经目录联接接入与恢复，不替换链接或写入不同文件', async () => {
  const f = await fixture(), temp = await testDirectory();
  try {
    const actual = path.join(temp.directory, 'actual'), alias = path.join(temp.directory, 'alias'); await mkdir(actual); await symlink(actual, alias, 'junction');
    const target = path.join(actual, 'custom.json'); await writeFile(target, '{"keep":true}');
    const setup = new ClientSetup(f.config, { home: temp.directory, entries: { claude: entry }, verify: async () => ({ tools: toolDefinitions.length, profiles: 0 }) });
    const plan = await setup.preview('claude', { configPath: path.join(alias, 'custom.json') }); assert.equal(plan.target, target);
    const applied = await setup.apply(plan.planId); assert.ok((await lstat(alias)).isSymbolicLink()); assert.ok(applied.changeId); await setup.restore(applied.changeId); assert.equal(await readFile(target, 'utf8'), '{"keep":true}');
  } finally { await f.cleanup(); await temp.cleanup(); }
});
test('接入向导保留 JSONC 注释、其他 MCP、模型和权限，恢复原文件字节', async () => {
  const f = await fixture(), temp = await testDirectory();
  try {
    const target = path.join(temp.directory, '.config/opencode/opencode.jsonc'); await mkdir(path.dirname(target), { recursive: true });
    const original = '{\n // 用户注释\n "model":"keep-model", "permissions":{"*":"ask"}, "mcp":{"servers":{"other":{"type":"local","command":["other"]}}},\n}\n'; await writeFile(target, original);
    let verified = 0; const setup = new ClientSetup(f.config, { home: temp.directory, entries: { opencode: entry }, verify: async () => { verified++; return { tools: 43, profiles: 2 }; } });
    const preview = await setup.preview('opencode'); assert.equal(await readFile(target, 'utf8'), original);
    assert.ok(!JSON.stringify(preview).includes('keep-model') && !JSON.stringify(preview).includes('private'));
    const applied = await setup.apply(preview.planId); assert.equal(verified, 1);
    const result = await readFile(target, 'utf8'); assert.ok(result.includes('// 用户注释'));
    const data = parse(result); assert.equal(data.model, 'keep-model'); assert.equal(data.permissions['*'], 'ask'); assert.equal(data.mcp.servers.other.command[0], 'other'); assert.equal(data.mcp.servers['saltedfish'].timeout.execution, 320000);
    assert.ok(applied.changeId); await setup.restore(applied.changeId); assert.equal(await readFile(target, 'utf8'), original);
    assert.equal((await setup.history())[0]!.canRestore, false);
  } finally { await f.cleanup(); await temp.cleanup(); }
});

test('配置在预览或接入后发生变化时拒绝覆盖；坏配置与重复键不写入', async () => {
  const f = await fixture(), temp = await testDirectory();
  try {
    const target = path.join(temp.directory, '.claude.json'); await writeFile(target, '{"existing":true}');
    const setup = new ClientSetup(f.config, { home: temp.directory, entries: { claude: entry }, verify: async () => ({ tools: 43, profiles: 0 }) });
    const preview = await setup.preview('claude'); await writeFile(target, '{"newer":true}');
    await assert.rejects(setup.apply(preview.planId), /配置发生变化/); assert.equal(await readFile(target, 'utf8'), '{"newer":true}');
    const next = await setup.apply((await setup.preview('claude')).planId);
    await writeFile(target, '{"keepMyEdit":true}'); assert.ok(next.changeId); await assert.rejects(setup.restore(next.changeId), /其他改动/);
    for (const invalid of ['{"x":', '{"mcpServers":{},"mcpServers":{}}', '{"mcpServers":null}']) { await writeFile(target, invalid); await assert.rejects(setup.preview('claude')); assert.equal(await readFile(target, 'utf8'), invalid); }
  } finally { await f.cleanup(); await temp.cleanup(); }
});

test('stdio 验证失败不修改配置；新建配置能恢复到原先不存在', async () => {
  const f = await fixture(), temp = await testDirectory();
  try {
    const target = path.join(temp.directory, '.claude.json');
    const fail = new ClientSetup(f.config, { home: temp.directory, entries: { claude: entry }, verify: async () => { throw new Error('fixture verify failure'); } });
    await assert.rejects(fail.apply((await fail.preview('claude')).planId), /fixture verify failure/); await assert.rejects(access(target));
    const ok = new ClientSetup(f.config, { home: temp.directory, entries: { claude: entry }, verify: async () => ({ tools: 43, profiles: 0 }) });
    const result = await ok.apply((await ok.preview('claude')).planId); assert.equal(JSON.parse(await readFile(target, 'utf8')).mcpServers['saltedfish'].command, entry.command);
    assert.ok(result.changeId); await ok.restore(result.changeId); await assert.rejects(access(target));
  } finally { await f.cleanup(); await temp.cleanup(); }
});

test('真实 stdio 接入预检使用独立凭据，撤销后拒绝', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.config.dataDir, 'config.json'), JSON.stringify(f.config));
    const grant = f.service.state.createClient('setup-client'); const tokenFile = path.join(f.config.dataDir, 'setup.token'); await writeFile(tokenFile, grant.token);
    const actual = { command: process.execPath, args: [path.join(projectDir, 'dist/cli.js'), 'mcp'], env: { CHROME_MCP_DATA_DIR: f.config.dataDir, CHROME_MCP_TOKEN_FILE: tokenFile } };
    const result = await verifyClientEntry(actual); assert.equal(result.tools, toolDefinitions.filter(tool => !isAdvancedTool(tool.name)).length); assert.equal(result.profiles, 0);
    f.service.state.revokeClient(grant.id); await assert.rejects(verifyClientEntry(actual), /凭据/);
    const response = await fetch(`http://127.0.0.1:${f.config.port}/setup/clients`, { headers: { authorization: `Bearer ${grant.token}` } }); assert.equal(response.status, 401);
    const other = f.service.state.createClient('non-admin'); const forbidden = await fetch(`http://127.0.0.1:${f.config.port}/setup/clients`, { headers: { authorization: `Bearer ${other.token}` } }); assert.equal(forbidden.status, 404);
  } finally { await f.cleanup(); }
});
