import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { ClientSetup, type SetupOptions } from '../src/client-setup.js';
import { clientCredential, type CredentialStore } from '../src/client-credentials.js';
import { testDirectory } from './helpers.js';

// 2026-11-06 评审 U35–U38：预览不建凭据、OpenCode 1 迁移保留停用和 permission、双文件接入失败可重试可恢复。
const entry = { command: 'C:/Chrome MCP/program.exe', args: ['mcp'], env: { CHROME_MCP_TOKEN_FILE: 'private/client.token' } };
const verify = async () => ({ tools: 59, profiles: 0 });
async function fixture(run: (setup: ClientSetup, target: (name: string) => string) => Promise<void>, options: SetupOptions = {}) {
  const temp = await testDirectory();
  try { await run(new ClientSetup({ dataDir: temp.directory }, { home: temp.directory, entries: { opencode: entry, claude: entry }, verify, ...options }), name => path.join(temp.directory, name)); }
  finally { await temp.cleanup(); }
}

// 和 client-pi-agy.test.ts 一样：假的授权库 + 数据目录里的 launcher 入口，pi 第一次接入时才建凭据。
async function lazy(run: (context: { setup: ClientSetup; home: string; data: string; clients: { id: string; label: string; revoked: boolean }[] }) => Promise<void>, transport: 'http' | 'stdio') {
  const temp = await testDirectory(), home = path.join(temp.directory, 'home'), data = path.join(temp.directory, 'data');
  await mkdir(home); await mkdir(data);
  const token = path.join(data, 'claude.token');
  await writeFile(token, 'claude-secret\n');
  await writeFile(path.join(data, 'config.json'), JSON.stringify({ port: 18445, token: 'x'.repeat(64), network: { host: '192.168.1.10', publicUrl: 'http://192.168.1.10:18445', allowInsecureLan: true } }));
  await writeFile(path.join(data, 'mcp-config.json'), JSON.stringify({ mcpServers: { saltedfish: { command: '/usr/bin/node', args: ['/opt/saltedfish/launcher.mjs', 'mcp'], env: { CHROME_MCP_DATA_DIR: data, CHROME_MCP_TOKEN_FILE: token } } } }));
  const clients: { id: string; label: string; revoked: boolean }[] = [];
  const store: CredentialStore = { list: async () => clients, create: async (label: string) => { const id = `00000000-0000-4000-8000-${String(clients.length).padStart(12, '0')}`; clients.push({ id, label, revoked: false }); return { id, token: `${label}-secret` }; }, remove: async () => undefined };
  try { await run({ setup: new ClientSetup({ dataDir: data }, { home, verify, localTransport: transport, credential: async client => (await clientCredential(data, store, client, '*', false, true)).tokenFile }), home, data, clients }); }
  finally { await temp.cleanup(); }
}

for (const transport of ['http', 'stdio'] as const) {
  test(`U35：预览（${transport}）不建授权也不写令牌文件，确认后才创建并写进配置`, () => lazy(async ({ setup, home, data, clients }) => {
    const plan = await setup.preview('pi');
    assert.equal(clients.length, 0, '预览阶段不能新增授权'); assert.ok(!(await readdir(data)).includes('clients'), '预览阶段不写令牌文件');
    assert.ok(plan.notices.some(note => note.includes('新建一份独立授权')), '预览说明确认后才新建');
    assert.ok(!JSON.stringify(plan).includes('pi-secret'));
    const again = await setup.preview('pi', { trust: 'preserve' });
    assert.equal(clients.length, 0, '重复预览、取消都不留授权'); void again;
    const done = await setup.apply(plan.planId);
    assert.deepEqual(clients.map(client => client.label), ['pi']);
    const saved = parse(await readFile(path.join(home, '.pi/agent/mcp.json'), 'utf8')).mcpServers.saltedfish;
    if (transport === 'http') assert.equal(saved.headers.Authorization, 'Bearer pi-secret');
    else assert.match(saved.env.CHROME_MCP_TOKEN_FILE, /clients[\\/]00000000-0000-4000-8000-000000000000\.token$/);
    assert.ok((done as { changeId?: string }).changeId);
    // 再次接入沿用，不重复建。
    await setup.apply((await setup.preview('pi', { trust: 'service' })).planId);
    assert.equal(clients.length, 1);
  }, transport));
}

test('U35：预览后放弃（不 apply），已有授权数量不变；apply 时配置已被改动则拒绝，且不影响已建授权的一致性', () => lazy(async ({ setup, home, clients }) => {
  const plan = await setup.preview('pi');
  await mkdir(path.join(home, '.pi/agent'), { recursive: true });
  await writeFile(path.join(home, '.pi/agent/mcp.json'), '{"mcpServers":{"other":{"command":"x"}}}');
  await assert.rejects(setup.apply(plan.planId), /预览后配置发生变化/);
  assert.equal(clients.length, 0, '配置变化在建凭据之前被拦下');
}, 'http'));

test('U36：OpenCode 1 迁移旧名称和同名重新接入都保留 enabled:false', () => fixture(async (setup, target) => {
  const file = target('opencode.json');
  await writeFile(file, '{"mcp":{"feng-chrome":{"type":"local","command":["old"],"enabled":false}}}');
  await setup.apply((await setup.preview('opencode', { configPath: file })).planId);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).mcp.saltedfish.enabled, false);
  await setup.apply((await setup.preview('opencode', { configPath: file, trust: 'preserve' })).planId);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).mcp.saltedfish.enabled, false, '同名重新接入也不启用');
  await writeFile(file, '{"mcp":{"saltedfish":{"type":"local","command":["old"]}}}');
  await setup.apply((await setup.preview('opencode', { configPath: file })).planId);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).mcp.saltedfish.enabled, true, '没设过的仍用默认启用');
}));

test('U37：OpenCode 1 的单数 permission 对象里旧名称的键跟着改名，其他键和值不动', () => fixture(async (setup, target) => {
  const file = target('opencode.json');
  await writeFile(file, '{"mcp":{"feng-chrome":{"type":"local","command":["old"]}},"permission":{"bash":"ask","feng-chrome_*":"allow","feng-chrome_chrome_evaluate":"deny","feng-chrome-other_run":"ask"}}');
  const plan = await setup.preview('opencode', { configPath: file });
  await setup.apply(plan.planId);
  const data = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(data.permission, { bash: 'ask', 'saltedfish_*': 'allow', 'saltedfish_chrome_evaluate': 'deny', 'feng-chrome-other_run': 'ask' });
  assert.deepEqual(Object.keys(data.permission), ['bash', 'saltedfish_*', 'saltedfish_chrome_evaluate', 'feng-chrome-other_run'], '键的顺序保持');
}));

test('U37：新名称的键已存在时不覆盖，保留旧键并提示手动检查', () => fixture(async (setup, target) => {
  const file = target('opencode.json');
  await writeFile(file, '{"mcp":{"feng-chrome":{"type":"local","command":["old"]}},"permission":{"feng-chrome_*":"allow","saltedfish_*":"deny"}}');
  const plan = await setup.preview('opencode', { configPath: file });
  assert.ok(plan.notices.some(note => note.includes('手动检查')));
  await setup.apply(plan.planId);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).permission, { 'feng-chrome_*': 'allow', 'saltedfish_*': 'deny' });
}));

// 让连接配置先写成功、审批文件在写入前被改动：verify 在两份文件的写入之前执行。
async function twoFiles(run: (context: { setup: ClientSetup; mcp: string; settings: string; breakSecond: () => void; original: { mcp: string; settings: string } }) => Promise<void>) {
  const temp = await testDirectory(), mcp = path.join(temp.directory, '.claude.json'), settings = path.join(temp.directory, '.claude/settings.json');
  await mkdir(path.dirname(settings), { recursive: true });
  const original = { mcp: JSON.stringify({ keep: 'user', mcpServers: { other: { command: 'keep' } } }), settings: JSON.stringify({ model: 'keep', permissions: { allow: ['Bash(ls:*)'] } }) };
  await writeFile(mcp, original.mcp); await writeFile(settings, original.settings);
  let broken = false;
  const setup = new ClientSetup({ dataDir: temp.directory }, { home: temp.directory, entries: { claude: entry }, verify: async () => { if (broken) await writeFile(settings, JSON.stringify({ model: 'someone-else' })); return { tools: 59, profiles: 0 }; } });
  try { await run({ setup, mcp, settings, breakSecond: () => { broken = true; }, original }); } finally { await temp.cleanup(); }
}

test('U38：第二份文件写入失败时撤回第一份，原文件字节不变，且修好后可以重新预览接入', () => twoFiles(async ({ setup, mcp, settings, breakSecond, original }) => {
  const plan = await setup.preview('claude', { trust: 'service' });
  breakSecond();
  await assert.rejects(setup.apply(plan.planId), /配置已被其他程序修改/);
  assert.equal(await readFile(mcp, 'utf8'), original.mcp, '已写入的连接配置被撤回');
  assert.equal(await readFile(settings, 'utf8'), JSON.stringify({ model: 'someone-else' }), '别人改过的审批文件不动');
  const retry = await setup.preview('claude', { trust: 'service' });
  const done = await setup.apply(retry.planId);
  assert.ok((done as { changeId?: string }).changeId);
  assert.ok(JSON.parse(await readFile(mcp, 'utf8')).mcpServers.saltedfish);
}));

test('U38：双文件接入只落了一份时（中途失败遗留），restore 能恢复已写入的那份，也能在全部未改动时安全返回', () => twoFiles(async ({ setup, mcp, settings, original }) => {
  const plan = await setup.preview('claude', { trust: 'service' });
  const done = await setup.apply(plan.planId) as { changeId: string };
  assert.ok(JSON.parse(await readFile(mcp, 'utf8')).mcpServers.saltedfish);
  await writeFile(settings, original.settings); // 模拟第二份没写进去的遗留状态
  const history = await setup.history();
  assert.equal(history.find(item => item.changeId === done.changeId)?.canRestore, true, '部分落盘的接入仍可恢复');
  assert.equal((await setup.restore(done.changeId)).restored, true);
  assert.equal(await readFile(mcp, 'utf8'), original.mcp); assert.equal(await readFile(settings, 'utf8'), original.settings);
  assert.equal((await setup.restore(done.changeId)).restored, true, '全部已是接入前的状态，重复恢复不报错');
}));

test('U38：任一份文件被改成既不是接入前也不是接入后，restore 一份都不动', () => twoFiles(async ({ setup, mcp, settings }) => {
  const done = await setup.apply((await setup.preview('claude', { trust: 'service' })).planId) as { changeId: string };
  const written = await readFile(mcp, 'utf8');
  await writeFile(settings, '{"changed":"by user"}');
  await assert.rejects(setup.restore(done.changeId), /其他改动/);
  assert.equal(await readFile(mcp, 'utf8'), written);
}));
