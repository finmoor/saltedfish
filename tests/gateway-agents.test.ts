import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, access, chmod, chown, stat } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { addGatewayAgent, gatewayAgentsCommand, listGatewayAgents } from '../src/gateway-agents.js';
import { startGateway, GatewayConfig } from '../src/remote-gateway.js';
import { gatewayClientSetup } from '../src/gateway-setup.js';
import { parseCodex } from '../src/codex-config.js';
import { testDirectory, fixture, fakeProfile, freePort } from './helpers.js';
import { projectDir } from '../src/config.js';
import { createTestCertificate } from './fixtures/test-certificate.js';
import { pathToFileURL } from 'node:url';
import { ensureHome, saveActive, startService, stopService } from '../src/npm-runtime.js';
import { VERSION, STATE_VERSION } from '../src/version.js';
import { REMOTE_PROTOCOL } from '../src/remote-protocol.js';

const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const credentials = () => randomBytes(32).toString('hex');
async function setup(directory: string) {
  const device = { id: randomUUID(), label: '浏览器电脑', token: credentials() }, other = { id: randomUUID(), label: '另一台电脑', token: credentials() };
  const config = GatewayConfig.parse({ host: '127.0.0.1', port: await freePort(), localPort: await freePort(), devices: [device, other],
    agents: ['codex', 'opencode'].map(label => ({ id: randomUUID(), label, token: credentials(), deviceId: device.id, profiles: '*', readOnly: false })) });
  await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'gateway.json'), JSON.stringify(config, null, 2));
  return { config, device, other };
}
async function cli(directory: string, args: string[], npmEntry = false) {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(projectDir, npmEntry ? 'src/npm-cli.ts' : 'src/gateway-cli.ts'), ...args, npmEntry ? '--home' : '--data-dir', directory], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  const timer = setTimeout(() => child.kill(), 20000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timer));
  return { code, stdout, stderr };
}
async function suggestedCommand(command: string, configPath: string) {
  const windows = process.platform === 'win32';
  const quotedPath = windows ? "'" + configPath.replaceAll("'", "''") + "'" : "'" + configPath.replaceAll("'", "'\\''") + "'";
  const script = `${command} --config ${quotedPath}`;
  const child = spawn(windows ? 'powershell.exe' : '/bin/sh', windows ? ['-NoProfile', '-NonInteractive', '-Command', script] : ['-c', script], { cwd: projectDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  const timer = setTimeout(() => child.kill(), 25000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timer));
  return { code, stdout, stderr };
}
async function gatewayTestEntries(home: string) {
  const directory = path.join(home, 'versions', VERSION, 'dist'); await mkdir(directory, { recursive: true });
  for (const name of ['gateway-cli', 'npm-cli', 'npm-worker']) {
    const loader = pathToFileURL(path.join(projectDir, 'node_modules/tsx/dist/esm/api/index.mjs')).href;
    const source = pathToFileURL(path.join(projectDir, `src/${name}.ts`)).href;
    await writeFile(path.join(directory, `${name}.js`), `import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(source)});\n`);
  }
}
async function until(predicate: () => boolean, timeout = 6000) { const end = Date.now() + timeout; while (!predicate()) { if (Date.now() > end) throw Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 30)); } }
async function connect(port: number, token: string) {
  const client = new Client({ name: 'gateway-agent-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return { client, close: async () => { await transport.terminateSession().catch(() => {}); await client.close(); } };
}

test('新增远程 Agent 生成独立私有配置，list 与 stdout 不泄露凭据，原身份不变', async () => {
  const temp = await testDirectory();
  try {
    const { config, device } = await setup(temp.directory), profileId = randomUUID();
    const result = await cli(temp.directory, ['agents', 'add', '--name', '远程 Codex A', '--device', device.id, '--profiles', profileId, '--read-only']);
    assert.equal(result.code, 0, result.stderr); const created = JSON.parse(result.stdout);
    const after = await json(path.join(temp.directory, 'gateway.json'));
    assert.deepEqual(after.devices, config.devices); assert.deepEqual(after.agents.slice(0, 2), config.agents);
    const agent = after.agents[2]; assert.equal(agent.id, created.agentId); assert.equal(agent.label, '远程 Codex A'); assert.deepEqual(agent.profiles, [profileId]); assert.equal(agent.readOnly, true);
    const token = (await readFile(created.tokenFile, 'utf8')).trim(); assert.equal(token, agent.token); assert.ok(!result.stdout.includes(token));
    const codex = parseCodex(await readFile(created.clientFiles.codex, 'utf8')).mcp_servers['saltedfish'];
    assert.equal(codex.http_headers.Authorization, `Bearer ${token}`); assert.equal(codex.tool_input_schema_max_bytes, 32768);
    assert.equal((await json(created.clientFiles.claude)).mcpServers['saltedfish'].headers.Authorization, `Bearer ${token}`);
    assert.equal((await json(created.clientFiles.opencode)).mcp.servers['saltedfish'].headers.Authorization, `Bearer ${token}`);
    assert.equal(created.endpointScope, 'gateway-machine-only'); assert.match(await readFile(path.join(created.credentialDirectory, 'README.txt'), 'utf8'), /只能用于网关所在电脑/);
    const list = await cli(temp.directory, ['agents', 'list']); assert.equal(list.code, 0); const listing = JSON.parse(list.stdout);
    assert.equal(listing.agents.length, 3); for (const secret of [...after.agents, ...after.devices].map(item => item.token)) assert.ok(!list.stdout.includes(secret));
  } finally { await temp.cleanup(); }
});

test('原子新增保留 gateway.json 的权限和所有者，新凭据仍归执行用户私有', async () => {
  const temp = await testDirectory();
  try {
    const { device } = await setup(temp.directory), file = path.join(temp.directory, 'gateway.json');
    await chmod(file, 0o640);
    const before = await stat(file);
    const result = await cli(temp.directory, ['agents', 'add', '--name', 'metadata-preserved', '--device', device.id, '--profiles', randomUUID()]);
    assert.equal(result.code, 0, result.stderr); const created = JSON.parse(result.stdout), after = await stat(file);
    assert.deepEqual({ uid: after.uid, gid: after.gid, mode: after.mode }, { uid: before.uid, gid: before.gid, mode: before.mode });
    assert.equal((await json(file)).agents.at(-1).id, created.agentId);
    if (process.platform !== 'win32') {
      const token = await stat(created.tokenFile);
      assert.equal(token.uid, process.getuid!()); assert.equal(token.mode & 0o7777, 0o600);
    }
  } finally { await temp.cleanup(); }
});

test('Linux root 新增时保留服务用户 uid/gid，凭据不转交服务用户', { skip: process.platform !== 'linux' || process.getuid?.() !== 0 }, async () => {
  const temp = await testDirectory();
  try {
    const { device } = await setup(temp.directory), file = path.join(temp.directory, 'gateway.json');
    await chown(file, 65534, 65534); await chmod(file, 0o640);
    const result = await cli(temp.directory, ['agents', 'add', '--name', 'service-owner-preserved', '--device', device.id, '--profiles', randomUUID()]);
    assert.equal(result.code, 0, result.stderr); const created = JSON.parse(result.stdout), after = await stat(file), token = await stat(created.tokenFile);
    assert.deepEqual({ uid: after.uid, gid: after.gid, mode: after.mode & 0o7777 }, { uid: 65534, gid: 65534, mode: 0o640 });
    assert.equal(token.uid, 0); assert.equal(token.mode & 0o7777, 0o600);
  } finally { await temp.cleanup(); }
});

test('设备与配置范围必须显式；参数、重复名称和不安全端点在授权落盘前拒绝', async () => {
  const temp = await testDirectory();
  try {
    const { device } = await setup(temp.directory), file = path.join(temp.directory, 'gateway.json'), before = await readFile(file, 'utf8');
    const base = ['add', '--name', 'new', '--device', device.id];
    for (const args of [base, [...base, '--profiles', '*'], [...base, '--profiles', randomUUID(), '--all-profiles'], [...base, '--all-profiles', '--read-only', '--read-only'], [...base, '--all-profiles', '--device', device.id]]) {
      await assert.rejects(gatewayAgentsCommand(temp.directory, args), { code: 'GATEWAY_AGENT_ARGUMENT' });
      assert.equal(await readFile(file, 'utf8'), before);
    }
    await assert.rejects(addGatewayAgent(temp.directory, { name: 'x', deviceId: randomUUID(), profiles: [randomUUID()] }), { code: 'GATEWAY_DEVICE_NOT_FOUND' });
    await assert.rejects(addGatewayAgent(temp.directory, { name: ' CODEX ', deviceId: device.id, profiles: '*' }), { code: 'GATEWAY_AGENT_NAME_EXISTS' });
    await assert.rejects(addGatewayAgent(temp.directory, { name: 'x', deviceId: device.id, profiles: '*', url: 'http://remote.example:18443' }), { code: 'REMOTE_TLS_REQUIRED' });
    await assert.rejects(addGatewayAgent(temp.directory, { name: 'x', deviceId: device.id, profiles: '*', url: 'https://unknown.example:18443' }), { code: 'GATEWAY_AGENT_URL' });
    assert.equal(await readFile(file, 'utf8'), before); await assert.rejects(access(path.join(temp.directory, 'agents')));
    const all = await gatewayAgentsCommand(temp.directory, [...base, '--all-profiles']); assert.ok('profiles' in all); assert.equal(all.profiles, '*');
  } finally { await temp.cleanup(); }
});

test('两个 CLI 同时新增不会丢失授权，锁冲突可明确重试，不覆盖原凭据', async () => {
  const temp = await testDirectory();
  try {
    const { config, device } = await setup(temp.directory), profileId = randomUUID();
    const args = (name: string) => ['agents', 'add', '--name', name, '--device', device.id, '--profiles', profileId];
    const results = await Promise.all(['first', 'second'].map(name => cli(temp.directory, args(name))));
    for (const [index, result] of results.entries()) if (result.code !== 0) {
      assert.match(result.stderr, /另一个网关授权修改/); const retry = await cli(temp.directory, args(index === 0 ? 'first' : 'second')); assert.equal(retry.code, 0, retry.stderr);
    }
    const updated = await json(path.join(temp.directory, 'gateway.json')); assert.deepEqual(updated.agents.slice(0, 2), config.agents);
    assert.deepEqual(updated.agents.slice(2).map((agent: any) => agent.label).sort(), ['first', 'second']);
    assert.equal(new Set(updated.agents.map((agent: any) => agent.token)).size, 4);
    const folders = await readdir(path.join(temp.directory, 'agents')); assert.equal(folders.length, 2); assert.ok(folders.every(name => !name.startsWith('.')));
  } finally { await temp.cleanup(); }
});

test('外部地址生成标准 HTTPS 配置和公开 CA，不复制私钥或关闭 TLS 校验', async () => {
  const temp = await testDirectory();
  try {
    const { config, device } = await setup(temp.directory), pair = createTestCertificate({ ipAddresses: ['127.0.0.1'] });
    const cert = path.join(temp.directory, 'server.crt'), key = path.join(temp.directory, 'server.key');
    await writeFile(cert, pair.cert); await writeFile(key, pair.key);
    const next = { ...config, tls: { cert, key } }; await writeFile(path.join(temp.directory, 'gateway.json'), JSON.stringify(next));
    const created = await addGatewayAgent(temp.directory, { name: 'external', deviceId: device.id, profiles: '*', readOnly: false, url: `https://127.0.0.1:${config.port}` });
    assert.equal(created.mcpUrl, `https://127.0.0.1:${config.port}/mcp`); assert.equal(created.endpointScope, 'explicit-gateway-url'); assert.ok(created.caFile);
    assert.equal(await readFile(created.caFile!, 'utf8'), pair.cert);
    for (const filename of await readdir(created.credentialDirectory)) {
      const bytes = await readFile(path.join(created.credentialDirectory, filename), 'utf8');
      assert.ok(!bytes.includes('PRIVATE KEY')); assert.ok(!bytes.includes('NODE_TLS_REJECT_UNAUTHORIZED')); assert.ok(!bytes.includes('rejectUnauthorized'));
    }
  } finally { await temp.cleanup(); }
});

test('运行中网关热载新 Agent，SDK按独立设备/配置/只读范围执行，默认凭据仍可用', async () => {
  const temp = await testDirectory(), f = await fixture(); let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  const clients: Awaited<ReturnType<typeof connect>>[] = [];
  try {
    const a = await fakeProfile(f.config, 'A', c => c.operation === 'tabs.list' ? [{ tabId: 1 }] : {});
    const b = await fakeProfile(f.config, 'B', c => c.operation === 'tabs.list' ? [{ tabId: 1 }] : {});
    const { config, device, other } = await setup(temp.directory), file = path.join(temp.directory, 'gateway.json');
    gateway = await startGateway(config, { agentConfigFile: file });
    await f.remote.configure({ enabled: true, url: `http://127.0.0.1:${config.port}`, token: device.token, profiles: '*', readOnly: false });
    await until(() => f.remote.status().state === 'connected');
    const reader = await addGatewayAgent(temp.directory, { name: 'reader', deviceId: device.id, profiles: [a.id], readOnly: true });
    const separate = await addGatewayAgent(temp.directory, { name: 'other device', deviceId: other.id, profiles: [a.id], readOnly: false });
    await until(() => gateway!.config.agents.length === 4);
    const r = await connect(config.localPort!, (await readFile(reader.tokenFile, 'utf8')).trim()); clients.push(r);
    assert.equal((await r.client.listTools()).tools.length, 64);
    const visible = await r.client.callTool({ name: 'chrome_profiles', arguments: {} }); assert.deepEqual((visible.structuredContent as any).data.profiles.map((p: any) => p.id), [a.id]);
    const wrong = await r.client.callTool({ name: 'chrome_tabs', arguments: { profileId: b.id } }); assert.equal((wrong.structuredContent as any).error.code, 'PROFILE_NOT_AUTHORIZED');
    const write = await r.client.callTool({ name: 'chrome_action', arguments: { profileId: a.id, tabId: 1, action: 'fill', selector: '#x', text: 'x' } }); assert.equal((write.structuredContent as any).error.code, 'CLIENT_READ_ONLY');
    const otherClient = await connect(config.localPort!, (await readFile(separate.tokenFile, 'utf8')).trim()); clients.push(otherClient);
    const offline = await otherClient.client.callTool({ name: 'chrome_profiles', arguments: {} }); assert.equal((offline.structuredContent as any).error.code, 'REMOTE_DEVICE_OFFLINE');
    const original = await connect(config.localPort!, config.agents[0]!.token); clients.push(original);
    const originalProfiles = await original.client.callTool({ name: 'chrome_profiles', arguments: {} }); assert.equal((originalProfiles.structuredContent as any).data.profiles.length, 2);
  } finally { await Promise.all(clients.map(client => client.close())); await gateway?.close(); await f.cleanup(); await temp.cleanup(); }
});

test('实际执行 core next 保留带引号的 data-dir、指定身份与默认接入兼容，不输出秘密', async () => {
  const temp = await testDirectory(); let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  try {
    const directory = path.join(temp.directory, "data ' $(literal)"), { config, device } = await setup(directory), file = path.join(directory, 'gateway.json');
    gateway = await startGateway(config, { agentConfigFile: file });
    const added = await cli(directory, ['agents', 'add', '--name', '独立 Codex', '--device', device.id, '--profiles', randomUUID()]);
    assert.equal(added.code, 0, added.stderr); const created = JSON.parse(added.stdout);
    assert.ok(created.next.includes('--data-dir')); assert.ok(!created.next.includes('saltedfish gateway connect'));
    assert.ok((await readFile(path.join(created.credentialDirectory, 'README.txt'), 'utf8')).includes(created.next));
    await until(() => gateway!.config.agents.length === 3);
    const target = path.join(temp.directory, 'custom.toml'); await writeFile(target, 'model = "preserved"\n');
    const result = await suggestedCommand(created.next, target);
    assert.equal(result.code, 0, result.stderr);
    const token = (await readFile(created.tokenFile, 'utf8')).trim(), parsed = parseCodex(await readFile(target, 'utf8'));
    assert.equal(parsed.model, 'preserved'); assert.equal(parsed.mcp_servers['saltedfish'].http_headers.Authorization, `Bearer ${token}`); assert.ok(!result.stdout.includes(token));
    const legacy = await gatewayClientSetup(directory), defaultTarget = path.join(temp.directory, 'default.toml');
    const preview = await legacy.preview('codex', { configPath: defaultTarget, trust: 'preserve' }); await legacy.apply(preview.planId);
    assert.equal(parseCodex(await readFile(defaultTarget, 'utf8')).mcp_servers['saltedfish'].http_headers.Authorization, `Bearer ${config.agents[0]!.token}`);
    await assert.rejects(gatewayClientSetup(directory, undefined, randomUUID()), { code: 'GATEWAY_AGENT_NOT_FOUND' });
    await assert.rejects(gatewayClientSetup(directory, undefined, '../bad'), { code: 'GATEWAY_AGENT_NOT_FOUND' });
  } finally { await gateway?.close(); await temp.cleanup(); }
});

test('npm gateway agents 路由使用该home的网关配置，不启动服务或接触本机浏览器数据', async () => {
  const temp = await testDirectory();
  try {
    const home = await ensureHome(path.join(temp.directory, 'npm home')), directory = path.join(home, 'data', 'gateway');
    const { device } = await setup(directory);
    await saveActive(home, { product: 'saltedfish-npm', version: VERSION, stateVersion: STATE_VERSION });
    await gatewayTestEntries(home);
    const add = await cli(home, ['gateway', 'agents', 'add', '--name', 'npm-route', '--device', device.id, '--profiles', randomUUID()], true);
    assert.equal(add.code, 0, add.stderr); const created = JSON.parse(add.stdout); assert.equal(created.name, 'npm-route');
    const list = await cli(home, ['gateway', 'agents', 'list'], true); assert.equal(list.code, 0, list.stderr); assert.equal(JSON.parse(list.stdout).agents.length, 3);
    assert.deepEqual(await readdir(path.join(home, 'run')), []); await assert.rejects(access(path.join(home, 'data', 'local', 'config.json')));
    assert.ok(created.credentialDirectory.startsWith(directory + path.sep));
  } finally { await temp.cleanup(); }
});

test('实际执行 npm next 保留自定义 home，安全引用路径并接入该 Agent', async () => {
  const temp = await testDirectory(); let home: string | undefined;
  try {
    home = await ensureHome(path.join(temp.directory, "npm home ' $(literal)"));
    const directory = path.join(home, 'data', 'gateway'), { config, device } = await setup(directory);
    await saveActive(home, { product: 'saltedfish-npm', version: VERSION, stateVersion: STATE_VERSION }); await gatewayTestEntries(home);
    const added = await cli(home, ['gateway', 'agents', 'add', '--name', 'npm-next', '--device', device.id, '--profiles', randomUUID()], true);
    assert.equal(added.code, 0, added.stderr); const created = JSON.parse(added.stdout);
    assert.ok(created.next.includes('npm-cli.js')); assert.ok(created.next.includes('--home')); assert.ok(!created.next.includes('--data-dir'));
    assert.ok((await readFile(path.join(created.credentialDirectory, 'README.txt'), 'utf8')).includes(created.next));
    const target = path.join(temp.directory, 'npm-target.toml'); await writeFile(target, 'model = "kept"\n');
    // Windows PowerShell 会等待本次命令启动的后台子进程；夹具先启动服务，再验证可复制命令的接入路由。
    await startService(home, 'gateway');
    const result = await suggestedCommand(created.next, target); assert.equal(result.code, 0, result.stderr);
    const token = (await readFile(created.tokenFile, 'utf8')).trim(), updated = parseCodex(await readFile(target, 'utf8'));
    assert.equal(updated.model, 'kept'); assert.equal(updated.mcp_servers['saltedfish'].http_headers.Authorization, `Bearer ${token}`);
    assert.equal(updated.mcp_servers['saltedfish'].url, `http://127.0.0.1:${config.localPort}/mcp`);
    assert.ok(!added.stdout.includes(token)); assert.ok(!result.stdout.includes(token)); assert.deepEqual((await json(path.join(directory, 'gateway.json'))).agents.slice(0, 2), config.agents);
    await assert.rejects(access(path.join(home, 'data', 'local', 'config.json')));
  } finally { if (home) await stopService(home, 'gateway', true); await temp.cleanup(); }
});

test('实际 serve 子进程在设备握手公布真实可执行入口和原data-dir，不假定npm home', async () => {
  const temp = await testDirectory(); let child: ReturnType<typeof spawn> | undefined, socket: WebSocket | undefined;
  let exit: Promise<unknown> | undefined;
  try {
    const { config, device } = await setup(temp.directory), entry = path.join(projectDir, 'src/gateway-cli.ts');
    child = spawn(process.execPath, ['--import', 'tsx', entry, 'serve', '--data-dir', temp.directory], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    exit = once(child, 'close'); let stderr = '';
    child.stderr!.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.stdout!.on('data', () => {});
    const limit = Date.now() + 10000;
    while (true) {
      if (child.exitCode !== null || child.signalCode) throw new Error(`Gateway exited before handshake: ${stderr}`);
      const ready = await fetch(`http://127.0.0.1:${config.port}/health`).then(response => response.ok, () => false);
      if (ready) break;
      if (Date.now() > limit) throw new Error('Gateway serve did not listen');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    socket = new WebSocket(`ws://127.0.0.1:${config.port}/connect`, { headers: { authorization: `Bearer ${device.token}` } });
    const response = once(socket, 'message'); await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'hello', protocol: REMOTE_PROTOCOL, version: VERSION, instanceId: randomUUID() }));
    const ready = JSON.parse(String((await response)[0])); assert.equal(ready.type, 'ready');
    assert.deepEqual(ready.onboarding, { platform: process.platform, command: [process.execPath, entry], suffix: ['--data-dir', temp.directory] });
    assert.ok(!stderr.includes(device.token));
  } finally {
    socket?.terminate();
    if (child?.exitCode === null && !child.signalCode) child.kill();
    await exit; await temp.cleanup();
  }
});
