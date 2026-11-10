import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { ClientSetup, type SetupOptions, type SetupClient } from '../src/client-setup.js';
import { clientCredential } from '../src/client-credentials.js';
import { desktopConfigPath } from '../src/client-paths.js';
import { httpAgentConfigurations } from '../src/client-config.js';
import { clientDocument } from '../src/client-document.js';
import { testDirectory, fixture } from './helpers.js';

const added = ['claude-desktop', 'codebuddy', 'workbuddy'] as const;
const write = async (file: string, text: string) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); };
async function harness(run: (c: { setup: ClientSetup; home: string; data: string; clients: { id: string; label: string; revoked: boolean }[]; options: SetupOptions }) => Promise<void>) {
  const temp = await testDirectory(), home = path.join(temp.directory, 'home'), data = path.join(temp.directory, 'data');
  await mkdir(home); await mkdir(data);
  const token = path.join(data, 'claude.token'); await writeFile(token, 'claude-secret');
  await writeFile(path.join(data, 'mcp-config.json'), JSON.stringify({ mcpServers: { saltedfish: { command: 'node', args: ['/test/launcher.mjs', 'mcp'], env: { CHROME_MCP_DATA_DIR: data, CHROME_MCP_TOKEN_FILE: token } } } }));
  await writeFile(path.join(data, 'config.json'), JSON.stringify({ port: 18445, token: 'x'.repeat(64) }));
  const clients: { id: string; label: string; revoked: boolean }[] = [];
  const store = { list: async () => clients, create: async (label: string) => { const id = `00000000-0000-4000-8000-${String(clients.length).padStart(12, '0')}`; clients.push({ id, label, revoked: false }); return { id, token: label + '-secret' }; }, remove: async (id: string) => { clients.find(c => c.id === id)!.revoked = true; } };
  const options: SetupOptions = { home, platform: 'win32', localTransport: 'http', verify: async () => ({ tools: 46, profiles: 0 }), credential: async client => (await clientCredential(data, store, client, '*', false, true)).tokenFile };
  try { await run({ setup: new ClientSetup({ dataDir: data }, options), home, data, clients, options }); }
  finally { await temp.cleanup(); }
}
const connect = async (setup: ClientSetup, client: SetupClient, selection = {}) => setup.apply((await setup.preview(client, selection)).planId);
const entry = async (file: string) => parse(await readFile(file, 'utf8')).mcpServers.saltedfish;

test('三种新客户端仅首次接入建立独立凭据，Desktop 即使 HTTP 模式也写 stdio，可检查和恢复', () => harness(async ({ setup, clients }) => {
  await setup.detect(); assert.equal(clients.length, 0);
  for (const client of added) {
    const plan = await setup.preview(client, { trust: 'service' });
    assert.equal(plan.trust, client === 'codebuddy' ? 'service' : 'preserve');
    assert.ok(!JSON.stringify(plan).includes('-secret'));
    const applied = await setup.apply(plan.planId), saved = await entry(plan.target);
    if (client === 'claude-desktop') { assert.equal(saved.command, 'node'); assert.equal(saved.url, undefined); assert.equal(await readFile(saved.env.CHROME_MCP_TOKEN_FILE, 'utf8'), client + '-secret'); }
    else { assert.equal(saved.type, 'http'); assert.equal(saved.headers.Authorization, `Bearer ${client}-secret`); }
    assert.equal((await setup.check(client)).verification.tools, 46);
    await connect(setup, client, { trust: 'service' });
    assert.ok(applied.changeId); await setup.restore(applied.changeId); await assert.rejects(access(plan.target));
  }
  assert.deepEqual(clients.map(c => c.label), [...added]);
}));

test('Desktop 定位 Windows 常规/商店版、macOS 和 Linux，多目录时拒绝猜测', () => harness(async ({ home }) => {
  const ordinary = path.join(home, 'AppData/Roaming/Claude/claude_desktop_config.json');
  assert.equal(await desktopConfigPath(home, 'win32', {}), ordinary);
  const store = path.join(home, 'AppData/Local/Packages/Claude_test123/LocalCache/Roaming/Claude/claude_desktop_config.json');
  await mkdir(path.dirname(store), { recursive: true });
  assert.equal(await desktopConfigPath(home, 'win32', {}), store);
  await mkdir(path.dirname(ordinary), { recursive: true });
  await assert.rejects(desktopConfigPath(home, 'win32', {}), { code: 'AMBIGUOUS_CONFIG' });
  // 新版商店 Desktop 把资料搬到 Claude-Data：旧目录没留标记时照旧不猜，两个旧目录都留了 .user-data-left 标记才用新位置（2026-11-07 本机 4.23118）。
  const migrated = path.join(home, 'AppData/Local/Claude-Data/claude_test123/claude_desktop_config.json');
  await mkdir(path.dirname(migrated), { recursive: true }); await write(path.join(home, 'AppData/Local/Claude-Data/README.txt'), 'not a profile');
  await assert.rejects(desktopConfigPath(home, 'win32', {}), { code: 'AMBIGUOUS_CONFIG' });
  await write(path.join(path.dirname(store), '.user-data-left.claude_test123'), '');
  await assert.rejects(desktopConfigPath(home, 'win32', {}), { code: 'AMBIGUOUS_CONFIG' }, '常规目录没留标记，仍有两个候选');
  await write(path.join(path.dirname(ordinary), '.user-data-left.claude_test123'), '');
  assert.equal(await desktopConfigPath(home, 'win32', {}), migrated);
  assert.equal(await desktopConfigPath(home, 'darwin', {}), path.join(home, 'Library/Application Support/Claude/claude_desktop_config.json'));
  assert.equal(await desktopConfigPath(home, 'linux', { XDG_CONFIG_HOME: home }), path.join(home, 'Claude/claude_desktop_config.json'));
}));

test('Desktop 资料搬到 Claude-Data 后：升级提示重新接入，重新接入后不再报旧位置', () => harness(async ({ setup, home }) => {
  const legacy = path.join(home, 'AppData/Local/Packages/Claude_test123/LocalCache/Roaming/Claude');
  await mkdir(legacy, { recursive: true });
  const first = await setup.preview('claude-desktop'); assert.equal(first.target, path.join(legacy, 'claude_desktop_config.json')); await setup.apply(first.planId);
  await mkdir(path.join(home, 'AppData/Local/Claude-Data/claude_test123'), { recursive: true }); await write(path.join(legacy, '.user-data-left.claude_test123'), '');
  let result = await setup.refreshCatalogs();
  assert.equal(result.completed.length, 0); assert.match(result.skipped.find(item => item.client === 'claude-desktop')!.reason, /位置已变化/);
  const moved = await setup.preview('claude-desktop'); assert.equal(moved.target, path.join(home, 'AppData/Local/Claude-Data/claude_test123/claude_desktop_config.json')); await setup.apply(moved.planId);
  result = await setup.refreshCatalogs();
  assert.equal(result.completed.length, 1); assert.deepEqual(result.skipped.filter(item => item.client === 'claude-desktop'), []);
}));

test('CodeBuddy 沿用首个存在文件，WorkBuddy 只读顶层 mcp.json，用户配置优先级变化拒绝旧预览', () => harness(async ({ setup, home }) => {
  const low = path.join(home, '.codebuddy.json'), middle = path.join(home, '.codebuddy/mcp.json'), high = path.join(home, '.codebuddy/.mcp.json');
  await write(low, '{}'); assert.equal((await setup.preview('codebuddy')).target, low);
  await write(middle, '{}'); const plan = await setup.preview('codebuddy'); assert.equal(plan.target, middle);
  await write(high, '{}'); await assert.rejects(setup.apply(plan.planId), { code: 'SETUP_TARGET_CHANGED' });
  assert.equal(await readFile(middle, 'utf8'), '{}');
  assert.equal((await setup.preview('codebuddy')).target, high);
  await write(path.join(home, '.workbuddy/.mcp.json'), '{broken');
  assert.equal((await setup.preview('workbuddy')).target, path.join(home, '.workbuddy/mcp.json'));
}));

test('CodeBuddy 项目配置沿用 mcp.json，不内嵌令牌；Desktop、WorkBuddy 不支持项目配置', () => harness(async ({ setup, home }) => {
  const project = path.join(home, 'repo'); await mkdir(project);
  const file = path.join(project, 'mcp.json'); await writeFile(file, '{}');
  const plan = await setup.preview('codebuddy', { projectDirectory: project, trust: 'service' });
  assert.equal(plan.target, file); await setup.apply(plan.planId);
  const text = await readFile(file, 'utf8'); assert.ok(!text.includes('-secret')); assert.equal((await entry(file)).type, 'stdio');
  assert.ok(parse(await readFile(path.join(project, '.codebuddy/settings.local.json'), 'utf8')).permissions.allow.includes('mcp__saltedfish__*'));
  for (const client of ['claude-desktop', 'workbuddy'] as const) await assert.rejects(setup.preview(client, { projectDirectory: project }), { code: 'PROJECT_UNSUPPORTED' });
}));

test('新增客户端使用各自严格 JSON/JSONC 规则；重复键与错误禁用数组被拒绝', () => {
  assert.equal(clientDocument('codebuddy', '{/* keep */ "mcpServers":{},}').data.mcpServers instanceof Object, true);
  for (const client of ['claude-desktop', 'workbuddy'] as const) assert.throws(() => clientDocument(client, '{/* no */ "mcpServers":{},}'), { code: 'CLIENT_CONFIG_INVALID' });
  for (const client of added) assert.throws(() => clientDocument(client, '{"mcpServers":{},"mcpServers":{}}'), { code: 'DUPLICATE_CONFIG_KEY' });
  assert.throws(() => clientDocument('codebuddy', '{"disabledMcpServers":"saltedfish"}'), { code: 'CLIENT_CONFIG_INVALID' });
});

test('CodeBuddy 迁移旧名、禁用和权限，保留注释与逐工具例外，恢复两个原文件', () => harness(async ({ setup, home }) => {
  const file = path.join(home, '.codebuddy/.mcp.json'), settings = path.join(home, '.codebuddy/settings.json');
  const original = '{\n// keep\n"mcpServers":{"other":{"command":"keep"},"feng-chrome":{"command":"old","enabled":false,"timeout":600,"oauth":{"old":true}}},"disabledMcpServers":["feng-chrome","other"]\n}';
  const rules = '{// settings\n"model":"keep","permissions":{"allow":["Read","mcp__feng-chrome__chrome_tabs"],"deny":["mcp__feng-chrome__chrome_evaluate"]}}';
  await write(file, original); await write(settings, rules);
  const plan = await setup.preview('codebuddy', { trust: 'service' }); assert.ok(plan.highlights.some(h => h.includes('禁用'))); assert.ok(plan.highlights.some(h => h.includes('例外')));
  const result = await setup.apply(plan.planId), saved = parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved.disabledMcpServers, ['saltedfish', 'other']); assert.equal(saved.mcpServers['feng-chrome'], undefined);
  assert.deepEqual([saved.mcpServers.saltedfish.enabled, saved.mcpServers.saltedfish.timeout, saved.mcpServers.saltedfish.oauth], [false, 600, undefined]);
  assert.equal(saved.mcpServers.other.command, 'keep'); assert.equal((await setup.inspect('codebuddy')).connection, 'disabled');
  const permission = parse(await readFile(settings, 'utf8')); assert.ok(permission.permissions.allow.includes('mcp__saltedfish__*')); assert.deepEqual(permission.permissions.deny, ['mcp__saltedfish__chrome_evaluate']);
  assert.ok(result.changeId); await setup.restore(result.changeId); assert.equal(await readFile(file, 'utf8'), original); assert.equal(await readFile(settings, 'utf8'), rules);
}));

test('Desktop、WorkBuddy 保留外部设置和禁用，只替换连接，恢复原文件', () => harness(async ({ setup }) => {
  for (const client of ['claude-desktop', 'workbuddy'] as const) {
    const file = (await setup.preview(client)).target, before = JSON.stringify({ preferences: { keep: 1 }, mcpServers: { other: { command: 'keep' }, saltedfish: { command: 'old', disabled: true, env: { OLD_TOKEN: 'old' }, headers: { Authorization: 'old' }, url: 'http://old', env_http_headers: { old: 'old' } } } });
    await write(file, before); const result = await connect(setup, client, { trust: 'prompt' });
    const saved = parse(await readFile(file, 'utf8')); assert.equal(saved.preferences.keep, 1); assert.equal(saved.mcpServers.saltedfish.disabled, true);
    assert.equal(saved.mcpServers.saltedfish.env?.OLD_TOKEN, undefined); assert.equal(saved.mcpServers.saltedfish.env_http_headers, undefined);
    assert.ok(result.changeId); await setup.restore(result.changeId); assert.equal(await readFile(file, 'utf8'), before);
  }
}));

test('仅修改 CodeBuddy 审批后仍能刷新目录，保留其他设置并沿用明确指定的配置', () => harness(async ({ setup, data, home, options }) => {
  const first = await connect(setup, 'codebuddy'); await connect(setup, 'codebuddy', { trust: 'service' });
  const saved = parse(await readFile(first.target, 'utf8')); saved.model = 'changed-by-app'; await writeFile(first.target, JSON.stringify(saved));
  const refreshed = new ClientSetup({ dataDir: data }, { ...options, catalogRevision: 'next' });
  assert.deepEqual((await refreshed.refreshCatalogs()).skipped, []);
  assert.equal((await entry(first.target)).headers['X-SaltedFish-Catalog-Version'], 'next'); assert.equal(parse(await readFile(first.target, 'utf8')).model, 'changed-by-app');
  await connect(setup, 'codebuddy', { trust: 'prompt' }); assert.equal((await setup.inspect('codebuddy')).trusted, false);
  const low = path.join(home, '.codebuddy.json'); await write(low, '{}');
  // 自定义文件即使另有高优先级配置也只按明确选择刷新。
  await connect(setup, 'codebuddy', { configPath: low }); assert.equal((await refreshed.refreshCatalogs()).skipped.length, 0);
}));

test('CodeBuddy 默认配置刷新后仍按优先级定位，高优先级文件出现则保留两个文件', () => harness(async ({ setup, data, home, options }) => {
  const low = path.join(home, '.codebuddy/mcp.json'), high = path.join(home, '.codebuddy/.mcp.json');
  await write(low, '{}'); await connect(setup, 'codebuddy');
  const refresh = (catalogRevision: string) => new ClientSetup({ dataDir: data }, { ...options, catalogRevision }).refreshCatalogs();
  assert.equal((await refresh('next')).completed.length, 1);
  const before = await readFile(low, 'utf8');
  await write(high, '{"mcpServers":{"other":{"command":"keep"}}}');
  const highBefore = await readFile(high, 'utf8'), result = await refresh('later');
  assert.equal(result.completed.length, 0); assert.equal(result.skipped.length, 1); assert.match(result.skipped[0]!.reason, /配置位置已变化/);
  assert.equal(await readFile(low, 'utf8'), before); assert.equal(await readFile(high, 'utf8'), highBefore);
}));

test('配置并发变动、无效文件和失败握手不覆盖新客户端配置', () => harness(async ({ setup, data, options }) => {
  for (const client of added) {
    const plan = await setup.preview(client); await write(plan.target, '{"userEdit":1}');
    await assert.rejects(setup.apply(plan.planId), { code: 'CLIENT_CONFIG_CHANGED' });
    const failing = new ClientSetup({ dataDir: data }, { ...options, verify: async () => { throw new Error('offline'); } });
    await assert.rejects(connect(failing, client), /offline/); assert.equal(await readFile(plan.target, 'utf8'), '{"userEdit":1}');
  }
}));

test('API 暴露八种配置，Desktop 是桥接命令，CodeBuddy 和 WorkBuddy 是显式 HTTP', async () => {
  const configurations = httpAgentConfigurations('http://127.0.0.1:18445/mcp', 'test-secret'); assert.equal(Object.keys(configurations).length, 8);
  for (const client of ['codebuddy', 'workbuddy'] as const) { const saved = JSON.parse(configurations[client]).mcpServers.saltedfish; assert.equal(saved.type, 'http'); assert.equal(saved.headers.Authorization, 'Bearer test-secret'); }
  const desktop = JSON.parse(configurations['claude-desktop']).mcpServers.saltedfish; assert.equal(desktop.url, undefined); assert.deepEqual(desktop.args, ['mcp-bridge']);
  const temp = await testDirectory(), e = { command: 'fixture', args: [], env: {} }, f = await fixture({ setup: { home: temp.directory, entries: { 'claude-desktop': e, codebuddy: e, workbuddy: e }, verify: async () => ({ tools: 46, profiles: 0 }) } });
  try {
    const post = async (route: string, value: object) => { const response = await fetch(`http://127.0.0.1:${f.config.port}${route}`, { method: 'POST', headers: { authorization: `Bearer ${f.config.token}`, 'content-type': 'application/json' }, body: JSON.stringify(value) }); assert.ok(response.ok); return response.json() as Promise<any>; };
    for (const client of added) { const plan = await post('/setup/preview', { client, trust: 'service' }); await post('/setup/apply', { planId: plan.planId }); assert.equal((await post('/setup/check', { client })).verification.tools, 46); }
    assert.equal(Object.keys((await post('/clients', { label: 'test' })).configurations).length, 8);
  } finally { await f.cleanup(); await temp.cleanup(); }
});
