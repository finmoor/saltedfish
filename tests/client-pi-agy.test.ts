import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { ClientSetup, type SetupOptions } from '../src/client-setup.js';
import { clientCredential, type CredentialStore } from '../src/client-credentials.js';
import { agyPermission } from '../src/client-permissions.js';
import { testDirectory } from './helpers.js';

const verify = async () => ({ tools: 43, profiles: 0 });
const url = 'http://192.168.1.10:18445/mcp';
interface Context { setup: ClientSetup; stdio: ClientSetup; home: string; data: string; store: CredentialStore & { clients: { id: string; label: string; revoked: boolean }[] } }
async function installed(run: (context: Context) => Promise<void>, options: SetupOptions = {}) {
  const temp = await testDirectory(), home = path.join(temp.directory, 'home'), data = path.join(temp.directory, 'data');
  await mkdir(home); await mkdir(data);
  const token = path.join(data, 'claude.token'), entry = { command: '/usr/bin/node', args: ['/opt/saltedfish/launcher.mjs', 'mcp'], env: { CHROME_MCP_DATA_DIR: data, CHROME_MCP_TOKEN_FILE: token } };
  await writeFile(token, 'claude-secret\n');
  await writeFile(path.join(data, 'config.json'), JSON.stringify({ port: 18445, token: 'x'.repeat(64), network: { host: '192.168.1.10', publicUrl: 'http://192.168.1.10:18445', allowInsecureLan: true } }));
  await writeFile(path.join(data, 'mcp-config.json'), JSON.stringify({ mcpServers: { saltedfish: entry } }));
  const clients: { id: string; label: string; revoked: boolean }[] = [];
  const store = { clients, list: async () => clients, create: async (label: string) => { const id = `00000000-0000-4000-8000-${String(clients.length).padStart(12, '0')}`; clients.push({ id, label, revoked: false }); return { id, token: `${label}-secret` }; }, remove: async (id: string) => { const client = clients.find(item => item.id === id); if (client) client.revoked = true; } };
  const common: SetupOptions = { home, verify, credential: async client => (await clientCredential(data, store, client, '*', false, true)).tokenFile, ...options };
  try { await run({ setup: new ClientSetup({ dataDir: data }, { localTransport: 'http', ...common }), stdio: new ClientSetup({ dataDir: data }, { localTransport: 'stdio', ...common }), home, data, store }); }
  finally { await temp.cleanup(); }
}
const connect = async (setup: ClientSetup, client: 'pi' | 'agy', selection = {}) => setup.apply((await setup.preview(client, selection)).planId);
const files = (home: string) => ({ pi: path.join(home, '.pi/agent/mcp.json'), agy: path.join(home, '.gemini/config/mcp_config.json'), agySettings: path.join(home, '.gemini/antigravity-cli/settings.json') });
const server = async (file: string) => parse(await readFile(file, 'utf8')).mcpServers.saltedfish;

test('pi、agy 第一次接入才建凭据，检测和查看不建，再次接入沿用', () => installed(async ({ setup, data, store }) => {
  const detected = await setup.detect() as { client: string; label: string; connection?: string }[];
  assert.deepEqual(detected.map(item => item.client), ['codex', 'opencode', 'claude', 'pi', 'agy', 'claude-desktop', 'codebuddy', 'workbuddy']);
  assert.deepEqual(detected.filter(item => ['pi', 'agy'].includes(item.client)).map(item => [item.label, item.connection]), [['pi', 'not_configured'], ['agy', 'not_configured']]);
  assert.equal(store.clients.length, 0); assert.ok(!(await readdir(data)).includes('clients'));
  await connect(setup, 'pi'); await connect(setup, 'agy');
  assert.deepEqual(store.clients.map(client => client.label), ['pi', 'agy']);
  await connect(setup, 'pi', { trust: 'service' });
  assert.equal(store.clients.length, 2, '再次接入沿用原凭据');
  assert.equal((await setup.inspect('pi')).connection, 'configured'); assert.equal((await setup.inspect('agy')).connection, 'configured');
}));

test('pi 写地址和自己的令牌，超时 330 秒、工具按需加载', () => installed(async ({ setup, home }) => {
  await mkdir(path.dirname(files(home).pi), { recursive: true });
  await writeFile(files(home).pi, '{\n  "mcpServers": {\n    "other": { "command": "keep" }\n  }\n}\n');
  const plan = await setup.preview('pi', { trust: 'service' });
  assert.equal(plan.trust, 'preserve', 'pi 没有审批规则可写');
  assert.ok(plan.highlights.some(note => note.includes('pi 默认不逐次确认')));
  await setup.apply(plan.planId);
  const saved = parse(await readFile(files(home).pi, 'utf8')).mcpServers;
  assert.deepEqual(saved.other, { command: 'keep' });
  assert.equal(saved.saltedfish.url, url); assert.equal(saved.saltedfish.headers.Authorization, 'Bearer pi-secret'); assert.equal(saved.saltedfish.timeout, 330); assert.equal(saved.saltedfish.exposure, 'deferred');
  assert.equal(saved.saltedfish.command, undefined); assert.equal(saved.saltedfish.type, undefined);
  assert.equal((await setup.inspect('pi')).trusted, true);
}));

test('pi 原有条目改成本安装的连接，用户的 exposure、enabled 和更长的超时保留', () => installed(async ({ setup, home }) => {
  await mkdir(path.dirname(files(home).pi), { recursive: true });
  await writeFile(files(home).pi, JSON.stringify({ mcpServers: { saltedfish: { type: 'stdio', command: 'old', args: ['x'], cwd: '/tmp', enabled: false, exposure: 'direct', timeout: 600, description: 'mine' } } }));
  assert.equal((await setup.inspect('pi')).connection, 'disabled');
  const plan = await setup.preview('pi');
  assert.ok(plan.highlights.some(note => note.includes('禁用状态')));
  await setup.apply(plan.planId);
  const saved = await server(files(home).pi);
  assert.deepEqual([saved.enabled, saved.exposure, saved.timeout, saved.description], [false, 'direct', 600, 'mine']);
  assert.deepEqual([saved.type, saved.command, saved.args, saved.cwd], [undefined, undefined, undefined, undefined]);
}));

test('pi 撤销信任不报错，只说明去管理页撤销授权', () => installed(async ({ setup, home }) => {
  const plan = await setup.preview('pi', { trust: 'prompt' });
  assert.equal(plan.trust, 'preserve');
  assert.ok(plan.highlights.some(note => note.includes('在管理页撤销')));
  await setup.apply(plan.planId);
  assert.equal((await server(files(home).pi)).url, url);
}));

test('pi 的项目配置不放令牌，继续走 launcher', () => installed(async ({ setup, home }) => {
  const project = path.join(home, 'repo'); await mkdir(project);
  const plan = await setup.preview('pi', { projectDirectory: project });
  assert.ok(plan.notices.some(note => note.includes('受信任的项目')));
  await setup.apply(plan.planId);
  const text = await readFile(path.join(project, '.pi/mcp.json'), 'utf8'), saved = parse(text).mcpServers.saltedfish;
  assert.ok(!text.includes('pi-secret')); assert.deepEqual(saved.args, ['/opt/saltedfish/launcher.mjs', 'mcp']); assert.equal(saved.url, undefined);
  assert.equal(path.dirname(saved.env.CHROME_MCP_TOKEN_FILE), path.join(saved.env.CHROME_MCP_DATA_DIR, 'clients'), '用 pi 自己的令牌文件');
  assert.equal((await setup.inspect('pi', { projectDirectory: project })).connection, 'configured');
}));

test('agy 写进空的 mcp_config.json，信任写 mcp(saltedfish/*)，其他规则和注释保留，恢复回到原样', () => installed(async ({ setup, home }) => {
  await mkdir(path.dirname(files(home).agy), { recursive: true }); await mkdir(path.dirname(files(home).agySettings), { recursive: true });
  await writeFile(files(home).agy, '');
  const settings = '{\n  // 用户的注释\n  "model": "keep",\n  "permissions": {\n    "allow": ["read_url(example.com)"],\n  },\n}\n';
  await writeFile(files(home).agySettings, settings);
  const plan = await setup.preview('agy', { trust: 'service' });
  assert.equal(plan.trust, 'service'); assert.ok(plan.notices.some(note => note.includes(files(home).agySettings)));
  const applied = await setup.apply(plan.planId) as { changeId: string };
  const saved = await server(files(home).agy);
  assert.equal(saved.serverUrl, url); assert.equal(saved.url, undefined); assert.equal(saved.headers.Authorization, 'Bearer agy-secret');
  const after = await readFile(files(home).agySettings, 'utf8');
  assert.ok(after.includes('// 用户的注释')); assert.deepEqual(parse(after).permissions.allow, ['read_url(example.com)', agyPermission]); assert.equal(parse(after).model, 'keep');
  assert.deepEqual([(await setup.inspect('agy')).connection, (await setup.inspect('agy')).trusted], ['configured', true]);
  await setup.restore(applied.changeId);
  assert.equal(await readFile(files(home).agy, 'utf8'), ''); assert.equal(await readFile(files(home).agySettings, 'utf8'), settings);
}));

test('agy 撤销信任只删整服务的允许规则，单个工具的规则保留', () => installed(async ({ setup, home }) => {
  await mkdir(path.dirname(files(home).agySettings), { recursive: true });
  await writeFile(files(home).agySettings, JSON.stringify({ permissions: { allow: [agyPermission, 'mcp(saltedfish/chrome_tabs)'], deny: ['mcp(saltedfish/chrome_evaluate)'] } }));
  const trusted = await setup.preview('agy', { trust: 'service' });
  assert.ok(trusted.highlights.some(note => note.includes('逐工具例外')));
  await connect(setup, 'agy', { trust: 'prompt' });
  assert.deepEqual(JSON.parse(await readFile(files(home).agySettings, 'utf8')).permissions, { allow: ['mcp(saltedfish/chrome_tabs)'], deny: ['mcp(saltedfish/chrome_evaluate)'] });
  assert.equal((await setup.inspect('agy')).trusted, false);
}));

test('agy 两种地址键名都认；不支持项目配置', () => installed(async ({ setup, home }) => {
  await connect(setup, 'agy');
  const saved = await server(files(home).agy);
  await writeFile(files(home).agy, JSON.stringify({ mcpServers: { saltedfish: { url: saved.serverUrl, headers: saved.headers } } }));
  assert.equal((await setup.inspect('agy')).connection, 'configured');
  const project = path.join(home, 'repo'); await mkdir(project);
  await assert.rejects(setup.preview('agy', { projectDirectory: project }), { code: 'PROJECT_UNSUPPORTED' });
}));

test('还没建凭据时，配置里已有的 saltedfish 算别的连接', () => installed(async ({ setup, home }) => {
  await mkdir(path.dirname(files(home).agy), { recursive: true });
  await writeFile(files(home).agy, JSON.stringify({ mcpServers: { saltedfish: { serverUrl: url, headers: { Authorization: 'Bearer claude-secret' } } } }));
  assert.equal((await setup.inspect('agy')).connection, 'other_config');
}));

test('升级把 pi、agy 的 launcher 条目换成 HTTP，pi 里改过的 exposure 和 agy 自己改的设置不挡', () => installed(async ({ setup, stdio, home }) => {
  await mkdir(path.dirname(files(home).agySettings), { recursive: true }); await writeFile(files(home).agySettings, '{}\n');
  await connect(stdio, 'pi'); await connect(stdio, 'agy', { trust: 'service' });
  assert.equal((await server(files(home).pi)).command, '/usr/bin/node');
  const pi = parse(await readFile(files(home).pi, 'utf8')); pi.mcpServers.saltedfish.exposure = 'codemode';
  await writeFile(files(home).pi, JSON.stringify(pi, null, 2));
  const settings = JSON.parse(await readFile(files(home).agySettings, 'utf8')); settings.model = 'changed-by-agy';
  await writeFile(files(home).agySettings, JSON.stringify(settings, null, 2));
  const result = await setup.refreshCatalogs();
  assert.deepEqual(result.skipped, []);
  const piEntry = await server(files(home).pi), agyEntry = await server(files(home).agy);
  assert.deepEqual([piEntry.url, piEntry.exposure, piEntry.command], [url, 'codemode', undefined]);
  assert.deepEqual([agyEntry.serverUrl, agyEntry.command, agyEntry.env], [url, undefined, undefined]);
  assert.equal(JSON.parse(await readFile(files(home).agySettings, 'utf8')).model, 'changed-by-agy');
  assert.equal((await setup.inspect('agy')).trusted, true);
}));

test('检测 agy 的安装位置', () => installed(async ({ setup, home }) => {
  const bin = path.join(home, 'AppData/Local/agy/bin/agy.exe');
  await mkdir(path.dirname(bin), { recursive: true }); await writeFile(bin, '');
  const agy = (await setup.detect()).find(item => item.client === 'agy') as { cliDetected: boolean; cliPaths: string[] };
  assert.equal(agy.cliDetected, true); assert.deepEqual(agy.cliPaths, [path.resolve(bin)]);
}));

test('凭据：撤销过的不复活，令牌文件丢了作废重建', async () => {
  const temp = await testDirectory();
  try {
    const clients: { id: string; revoked: boolean }[] = [];
    const store: CredentialStore = { list: async () => clients, create: async () => { const id = `id-${clients.length}`; clients.push({ id, revoked: false }); return { id, token: `token-${id}` }; }, remove: async id => { clients.find(item => item.id === id)!.revoked = true; } };
    const first = await clientCredential(temp.directory, store, 'pi', '*', false, true);
    assert.deepEqual(await clientCredential(temp.directory, store, 'pi', '*', false, true), first);
    await rm(first.tokenFile);
    const second = await clientCredential(temp.directory, store, 'pi', '*', false, true);
    assert.notEqual(second.id, first.id); assert.equal(clients[0]!.revoked, true); assert.equal(await readFile(second.tokenFile, 'utf8'), `token-${second.id}`);
    clients[1]!.revoked = true;
    assert.deepEqual(await clientCredential(temp.directory, store, 'pi', '*', false, true), second, '撤销过的不复活');
    assert.equal(clients.length, 2);
  } finally { await temp.cleanup(); }
});
