import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { ClientSetup, type SetupOptions } from '../src/client-setup.js';
import { codexConfig, type ClientEntry } from '../src/client-config.js';
import { parseCodex } from '../src/codex-config.js';
import { testDirectory } from './helpers.js';

const verify = async () => ({ tools: 43, profiles: 0 });
const url = 'http://192.168.1.10:18445/mcp';
async function installed(run: (context: { setup: ClientSetup; stdio: ClientSetup; home: string; data: string; entry: ClientEntry }) => Promise<void>, options: SetupOptions = {}) {
  const temp = await testDirectory(), home = path.join(temp.directory, 'home'), data = path.join(temp.directory, 'data');
  await mkdir(home); await mkdir(data);
  const token = path.join(data, 'client.token'), entry = { command: '/usr/bin/node', args: ['/opt/saltedfish/launcher.mjs', 'mcp'], env: { CHROME_MCP_DATA_DIR: data, CHROME_MCP_TOKEN_FILE: token } };
  await writeFile(token, 'agent-secret\n');
  await writeFile(path.join(data, 'config.json'), JSON.stringify({ port: 18445, token: 'x'.repeat(64), network: { host: '192.168.1.10', publicUrl: 'http://192.168.1.10:18445', allowInsecureLan: true } }));
  await writeFile(path.join(data, 'mcp-config.json'), JSON.stringify({ mcpServers: { saltedfish: entry } }));
  await writeFile(path.join(data, 'opencode-config.json'), JSON.stringify({ mcp: { servers: { saltedfish: { type: 'local', command: [entry.command, ...entry.args], environment: entry.env } } } }));
  await writeFile(path.join(data, 'codex-config.toml'), codexConfig(entry));
  const common = { home, verify, ...options };
  try { await run({ setup: new ClientSetup({ dataDir: data }, { localTransport: 'http', ...common }), stdio: new ClientSetup({ dataDir: data }, { localTransport: 'stdio', ...common }), home, data, entry }); }
  finally { await temp.cleanup(); }
}
const connect = async (setup: ClientSetup, client: 'codex' | 'opencode' | 'claude', selection = {}) => setup.apply((await setup.preview(client, selection)).planId);
const files = (home: string) => ({ codex: path.join(home, '.codex/config.toml'), opencode: path.join(home, '.config/opencode/opencode.json'), claude: path.join(home, '.claude.json') });
const claudeEntry = async (home: string) => parse(await readFile(files(home).claude, 'utf8')).mcpServers.saltedfish;

test('同机接入写地址和令牌，三个客户端都不再经 launcher', () => installed(async ({ setup, home }) => {
  for (const client of ['codex', 'opencode', 'claude'] as const) { await connect(setup, client); assert.equal((await setup.inspect(client)).connection, 'configured'); }
  const claude = await claudeEntry(home);
  assert.equal(claude.type, 'http'); assert.equal(claude.url, url); assert.equal(claude.headers.Authorization, 'Bearer agent-secret'); assert.equal(claude.command, undefined);
  const codex = parseCodex(await readFile(files(home).codex, 'utf8')).mcp_servers.saltedfish;
  assert.equal(codex.url, url); assert.equal(codex.http_headers.Authorization, 'Bearer agent-secret'); assert.equal(codex.command, undefined); assert.equal(codex.env, undefined);
  const opencode = parse(await readFile(files(home).opencode, 'utf8')).mcp.servers.saltedfish;
  assert.equal(opencode.type, 'remote'); assert.equal(opencode.url, url); assert.equal(opencode.command, undefined); assert.equal(opencode.environment, undefined);
}));

test('已有服务地址的本机端口优先，同机不绕到内网 IP', () => installed(async ({ setup, data, home }) => {
  const config = JSON.parse(await readFile(path.join(data, 'config.json'), 'utf8'));
  await writeFile(path.join(data, 'config.json'), JSON.stringify({ ...config, network: { ...config.network, localPort: 18446 } }));
  await connect(setup, 'claude');
  assert.equal((await claudeEntry(home)).url, 'http://127.0.0.1:18446/mcp');
}));

test('写进项目的配置不放令牌，继续走 launcher', () => installed(async ({ setup, home, entry }) => {
  const project = path.join(home, 'repo'); await mkdir(project);
  await connect(setup, 'claude', { projectDirectory: project });
  const text = await readFile(path.join(project, '.mcp.json'), 'utf8'), saved = parse(text).mcpServers.saltedfish;
  assert.ok(!text.includes('agent-secret')); assert.deepEqual(saved.args, entry.args); assert.equal(saved.url, undefined);
  assert.equal((await setup.inspect('claude', { projectDirectory: project })).connection, 'configured');
  await setup.refreshCatalogs();
  assert.ok(!(await readFile(path.join(project, '.mcp.json'), 'utf8')).includes('agent-secret'), '升级也不把令牌写进项目');
}));

test('升级把这次安装写的 launcher 入口换成 HTTP，审批和别的配置保持', () => installed(async ({ setup, stdio, home }) => {
  await writeFile(path.join(home, '.claude.json'), '{"numStartups":3,"mcpServers":{"other":{"command":"keep"}}}\n');
  await stdio.apply((await stdio.preview('codex', { trust: 'service' })).planId);
  await stdio.apply((await stdio.preview('opencode', { trust: 'service' })).planId);
  await connect(stdio, 'claude');
  assert.deepEqual((await claudeEntry(home)).args, ['/opt/saltedfish/launcher.mjs', 'mcp']);
  assert.equal((await setup.inspect('claude')).connection, 'configured', '旧入口算这次安装的，不提示已有别的连接');
  // Claude Code 自己一直在改这个文件，不能因此跳过。
  const changed = JSON.parse(await readFile(files(home).claude, 'utf8')); changed.numStartups = 4; await writeFile(files(home).claude, JSON.stringify(changed));
  const result = await setup.refreshCatalogs();
  assert.deepEqual(result.skipped, []); assert.equal(result.completed.length, 3);
  const claude = parse(await readFile(files(home).claude, 'utf8'));
  assert.equal(claude.mcpServers.saltedfish.url, url); assert.equal(claude.mcpServers.saltedfish.type, 'http'); assert.equal(claude.mcpServers.saltedfish.args, undefined);
  assert.equal(claude.numStartups, 4); assert.equal(claude.mcpServers.other.command, 'keep');
  const codex = parseCodex(await readFile(files(home).codex, 'utf8')).mcp_servers.saltedfish;
  assert.equal(codex.url, url); assert.equal(codex.default_tools_approval_mode, 'approve'); assert.equal(codex.env, undefined); assert.equal(codex.args, undefined);
  const opencode = parse(await readFile(files(home).opencode, 'utf8'));
  assert.equal(opencode.mcp.servers.saltedfish.url, url); assert.equal(opencode.mcp.servers.saltedfish.environment, undefined); assert.equal(opencode.mcp.servers.saltedfish.codemode, false);
  assert.ok(opencode.permissions.some((rule: any) => rule.action === 'saltedfish_*' && rule.effect === 'allow'));
  assert.equal((await setup.inspect('claude')).connection, 'configured');
  const before = await readFile(files(home).claude, 'utf8');
  assert.equal((await setup.refreshCatalogs()).completed.length, 3); assert.equal(await readFile(files(home).claude, 'utf8'), before, '再升级一次不用改');
}));

test('Claude Code 的连接被用户改过或删了就不动它', () => installed(async ({ stdio, setup, home }) => {
  await connect(stdio, 'claude');
  const config = JSON.parse(await readFile(files(home).claude, 'utf8'));
  config.mcpServers.saltedfish.command = '/mine/node'; await writeFile(files(home).claude, JSON.stringify(config));
  const edited = await setup.refreshCatalogs();
  assert.equal(edited.completed.length, 0); assert.equal(edited.skipped.length, 1); assert.equal((await claudeEntry(home)).command, '/mine/node');
  delete config.mcpServers.saltedfish; await writeFile(files(home).claude, JSON.stringify(config));
  assert.equal((await setup.refreshCatalogs()).completed.length, 0); assert.equal(await claudeEntry(home), undefined, '删掉的不重新接入');
}));

test('升级时 Claude Code 正好写文件：重新预览一次，不跳过', async () => {
  let writes = 0, target = '';
  const race = async () => { if (writes++ === 1) await writeFile(target, JSON.stringify({ ...JSON.parse(await readFile(target, 'utf8')), numStartups: 4 })); return verify(); };
  await installed(async ({ stdio, setup, home }) => {
    target = files(home).claude; await writeFile(target, '{"numStartups":3}');
    await connect(stdio, 'claude');
    assert.deepEqual((await setup.refreshCatalogs()).skipped, []);
    const saved = parse(await readFile(target, 'utf8')); assert.equal(saved.numStartups, 4); assert.equal(saved.mcpServers.saltedfish.url, url);
  }, { verify: race });
});

test('手动改过的令牌或地址算别的连接；令牌文件没了不写配置', () => installed(async ({ setup, home, data }) => {
  await connect(setup, 'claude');
  const config = JSON.parse(await readFile(files(home).claude, 'utf8'));
  config.mcpServers.saltedfish.url = 'http://10.0.0.1:18445/mcp'; await writeFile(files(home).claude, JSON.stringify(config));
  assert.equal((await setup.inspect('claude')).connection, 'other_config');
  await rm(path.join(data, 'client.token'));
  await assert.rejects(setup.preview('codex'), (error: any) => error.code === 'CLIENT_CREDENTIAL_MISSING');
  await assert.rejects(readFile(files(home).codex), { code: 'ENOENT' });
}));

test('Windows 和开发入口保持 stdio', () => installed(async ({ stdio, setup, home, data, entry }) => {
  await connect(stdio, 'claude');
  assert.deepEqual((await claudeEntry(home)).args, entry.args);
  await writeFile(path.join(data, 'mcp-config.json'), JSON.stringify({ mcpServers: { saltedfish: { ...entry, args: ['/repo/dist/cli.js', 'mcp'] } } }));
  await connect(setup, 'claude');
  assert.deepEqual((await claudeEntry(home)).args, ['/repo/dist/cli.js', 'mcp']);
}));
