import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, access, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { collectMachineIdentity, machineIdentityHeaders, MACHINE_IDENTITY_HEADER } from '../src/machine-identity.js';
import { parseRemoteMachineReport } from '../src/remote-protocol.js';
import { ClientSetup } from '../src/client-setup.js';
import { parseCodex, mergeCodexHeaders } from '../src/codex-config.js';
import { parseClientJson } from '../src/client-document.js';
import { gatewayClientSetup } from '../src/gateway-setup.js';
import { startGateway } from '../src/remote-gateway.js';
import { addGatewayAgent } from '../src/gateway-agents.js';
import { testDirectory, freePort } from './helpers.js';
import { projectDir } from '../src/config.js';

const withoutMachine = (headers: Record<string, unknown>) => Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== MACHINE_IDENTITY_HEADER.toLowerCase()));
const stripCodex = (source: string) => { const data = parseCodex(source); data.mcp_servers['saltedfish'].http_headers = withoutMachine(data.mcp_servers['saltedfish'].http_headers); return data; };
const codexSource = (token: string) => `# user's formatting\nmodel = "preserved"\n[mcp_servers.saltedfish]\nurl = "https://gateway.invalid/mcp"\ntool_timeout_sec = 19\ntool_input_schema_max_bytes = 45678\ndefault_tools_approval_mode = "prompt"\nhttp_headers = { Authorization = "Bearer ${token}", "X-SaltedFish-Catalog-Version" = "unchanged", "x-saltedfish-client-machine" = "old", "X-Custom" = "keep" }\n[mcp_servers.saltedfish.tools.chrome_click]\napproval_mode = "prompt"\n[mcp_servers.other]\ncommand = "keep-this"\n`;

test('采集本机登记信息，去重并限制非loopback地址，空机名不猜测', () => {
  const item = (address: string, internal = false) => ({ address, internal, family: address.includes(':') ? 'IPv6' : 'IPv4', netmask: '', mac: '', cidr: null }) as os.NetworkInterfaceInfo;
  const report = collectMachineIdentity({ hostname: '  machine\n-name  ', interfaces: { one: [item('127.0.0.2'), item('::1'), item('10.0.0.1', true), item('10.0.0.2'), item('10.0.0.2'), item('not-an-ip'), ...Array.from({ length: 10 }, (_, i) => item(`10.2.0.${i + 1}`))] }, now: new Date('2026-01-01T00:00:00Z') });
  assert.equal(report.hostname, 'machine-name'); assert.equal(report.reportSource, 'setup_report'); assert.equal(report.reportedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(report.reportedAddresses.length, 8); assert.equal(new Set(report.reportedAddresses).size, 8); assert.ok(report.reportedAddresses.includes('10.0.0.2'));
  assert.ok(!report.reportedAddresses.includes('127.0.0.2')); assert.ok(!report.reportedAddresses.includes('::1')); assert.ok(!report.reportedAddresses.includes('10.0.0.1'));
  assert.deepEqual(parseRemoteMachineReport(machineIdentityHeaders(report)[MACHINE_IDENTITY_HEADER]), report);
  assert.equal(collectMachineIdentity({ hostname: '', interfaces: {} }).hostname, undefined);
  assert.equal(collectMachineIdentity().hostname, os.hostname().trim().slice(0, 128));
});

test('登记已导入 Codex HTTP 配置仅改机器头，保留凭据/地址/审批/timeout/schema并可备份恢复', async () => {
  const temp = await testDirectory();
  try {
    const token = randomBytes(32).toString('hex'), file = path.join(temp.directory, 'config.toml'), before = codexSource(token), backup = path.join(temp.directory, 'registration');
    await writeFile(file, before); const setup = new ClientSetup({ dataDir: backup }, { verify: async () => { throw new Error('Machine registration must not connect'); } });
    const plan = await setup.previewMachineRegistration('codex', file); assert.equal(await readFile(file, 'utf8'), before); assert.ok(!JSON.stringify(plan).includes(token));
    const applied = await setup.apply(plan.planId), after = await readFile(file, 'utf8'); assert.ok(!JSON.stringify(applied).includes(token));
    assert.deepEqual(stripCodex(after), stripCodex(before)); assert.ok(after.includes('tool_timeout_sec = 19')); assert.ok(after.startsWith("# user's formatting"));
    const headers = parseCodex(after).mcp_servers['saltedfish'].http_headers;
    assert.deepEqual(parseRemoteMachineReport(headers[MACHINE_IDENTITY_HEADER]), plan.report); assert.equal(headers['x-saltedfish-client-machine'], undefined);
    const files = await readdir(path.join(backup, 'setup-backups')); assert.ok(files.some(name => name.endsWith('.config')));
    assert.ok('changeId' in applied); await setup.restore(applied.changeId!); assert.equal(await readFile(file, 'utf8'), before);
  } finally { await temp.cleanup(); }
});

test('机器头合并兼容 Codex 普通表、子表、点号和内联表且不改变其他字段', () => {
  for (const source of [
    '[mcp_servers.saltedfish]\nurl="https://gateway.invalid/mcp"\n[ mcp_servers.saltedfish.http_headers ]\nAuthorization="keep-token"\n',
    '[mcp_servers.saltedfish]\nurl="https://gateway.invalid/mcp"\nhttp_headers.Authorization="keep-token"\n',
    'mcp_servers.saltedfish = { url="https://gateway.invalid/mcp", http_headers={Authorization="keep-token"}, tool_timeout_sec=17 }\n',
    'mcp_servers = { saltedfish = { url="https://gateway.invalid/mcp", http_headers={Authorization="keep-token"}, tools={chrome_click={approval_mode="prompt"}} }, other={command="keep"} }\n',
    '[mcp_servers.saltedfish]\nurl="https://gateway.invalid/mcp"\n',
  ]) {
    const before = parseCodex(source), headers = before.mcp_servers['saltedfish'].http_headers ?? {};
    const after = parseCodex(mergeCodexHeaders(source, { ...headers, [MACHINE_IDENTITY_HEADER]: 'report-value' }));
    after.mcp_servers['saltedfish'].http_headers = withoutMachine(after.mcp_servers['saltedfish'].http_headers);
    before.mcp_servers['saltedfish'].http_headers ??= {};
    assert.deepEqual(after, before);
  }
});

test('源码普通connect同机登记保持字节和单份历史，换机名或IP才更新；显式登记可刷新', async () => {
  const temp = await testDirectory();
  try {
    for (const client of ['codex', 'opencode', 'claude'] as const) {
      const target = path.join(temp.directory, `${client}.${client === 'codex' ? 'toml' : 'json'}`), directory = path.join(temp.directory, client);
      const report = () => ({ hostname: 'client-a', reportedAddresses: ['10.2.3.4', '10.2.3.5'], reportSource: 'setup_report' as const, reportId: randomUUID(), reportedAt: new Date().toISOString() });
      const firstReport = report();
      const setup = (machine = report()) => new ClientSetup({ dataDir: directory }, { entries: { [client]: { url: 'https://gateway.invalid/mcp', headers: { Authorization: 'Bearer unchanged-token', ...machineIdentityHeaders(machine) } } }, verify: async () => ({ tools: 59, profiles: 0 }) });
      const selection = { configPath: target, trust: client === 'claude' ? 'preserve' as const : 'service' as const };
      const first = setup(firstReport); await first.apply((await first.preview(client, selection)).planId); const initial = await readFile(target, 'utf8');
      const same = setup({ ...report(), reportedAddresses: ['10.2.3.5', '10.2.3.4'] }); const unchanged = await same.preview(client, selection);
      assert.equal(unchanged.unchanged, true, client); assert.equal((await same.apply(unchanged.planId)).unchanged, true, client);
      assert.equal(await readFile(target, 'utf8'), initial); assert.equal((await same.history()).length, 1);
      for (const [index, machine] of [{ ...report(), hostname: 'client-b' }, { ...report(), hostname: 'client-b', reportedAddresses: ['10.2.4.6'] }].entries()) {
        const changed = setup(machine), plan = await changed.preview(client, selection); assert.equal(plan.unchanged, false); await changed.apply(plan.planId);
        const source = await readFile(target, 'utf8'), data = client === 'codex' ? parseCodex(source).mcp_servers['saltedfish'] : client === 'opencode' ? JSON.parse(source).mcp.servers['saltedfish'] : JSON.parse(source).mcpServers['saltedfish'];
        const headers = data[client === 'codex' ? 'http_headers' : 'headers']; assert.deepEqual(parseRemoteMachineReport(headers[MACHINE_IDENTITY_HEADER]), machine);
        assert.equal(headers.Authorization, 'Bearer unchanged-token'); assert.equal((await changed.history()).length, index + 2);
      }
      const explicit = setup(); const a = await explicit.previewMachineRegistration(client, target); await explicit.apply(a.planId);
      const b = await explicit.previewMachineRegistration(client, target); assert.notEqual(a.report.reportId, b.report.reportId); assert.ok('changeId' in await explicit.apply(b.planId));
    }
  } finally { await temp.cleanup(); }
});

test('OpenCode 1/2 与 Claude HTTP 登记保留所有非机器元数据，旧信息不冒充当前上报', async () => {
  const temp = await testDirectory();
  try {
    for (const [client, shape] of [['opencode', 'v1'], ['opencode', 'v2'], ['claude', 'claude']] as const) {
      const current = { type: client === 'claude' ? 'http' : 'remote', url: 'https://gateway.invalid/mcp', enabled: false, timeout: 121, headers: { Authorization: 'Bearer keep-secret', 'x-saltedfish-client-machine': 'copied-old-report', Extra: 'kept' } };
      const original = shape === 'v1' ? { mcp: { 'saltedfish': current }, permission: { '*': 'ask' } } : shape === 'v2' ? { mcp: { servers: { 'saltedfish': current } }, permissions: [{ action: 'saltedfish_*', resource: '*', effect: 'ask' }] } : { mcpServers: { 'saltedfish': current }, projects: { keep: {} } };
      const file = path.join(temp.directory, `${shape}.${client === 'opencode' ? 'jsonc' : 'json'}`); await writeFile(file, (client === 'opencode' ? '// preserve this comment\n' : '') + JSON.stringify(original, null, 2));
      const setup = new ClientSetup({ dataDir: path.join(temp.directory, 'backups') }); const plan = await setup.previewMachineRegistration(client, file); await setup.apply(plan.planId);
      const after = parseClientJson(await readFile(file, 'utf8'), client === 'opencode'), entry = shape === 'v1' ? after.mcp['saltedfish'] : shape === 'v2' ? after.mcp.servers['saltedfish'] : after.mcpServers['saltedfish'];
      assert.equal(parseRemoteMachineReport(entry.headers[MACHINE_IDENTITY_HEADER])?.hostname, os.hostname());
      if (client === 'opencode') assert.ok((await readFile(file, 'utf8')).startsWith('// preserve this comment\n'));
      entry.headers = withoutMachine(entry.headers); current.headers = withoutMachine(current.headers) as typeof current.headers;
      assert.deepEqual(after, original);
    }
  } finally { await temp.cleanup(); }
});

test('登记拒绝缺失和stdio条目，预览后文件变化则保留用户更改', async () => {
  const temp = await testDirectory();
  try {
    const file = path.join(temp.directory, 'config.toml'), setup = new ClientSetup({ dataDir: temp.directory });
    await writeFile(file, '[mcp_servers.saltedfish]\ncommand="keep"\n'); await assert.rejects(setup.previewMachineRegistration('codex', file), { code: 'CLIENT_NOT_CONFIGURED' });
    await assert.rejects(setup.previewMachineRegistration('codex', path.join(temp.directory, 'missing.toml')), { code: 'CLIENT_NOT_CONFIGURED' });
    for (const bad of ['url="file:///private"', 'url="https://gateway.invalid/mcp"\nhttp_headers=1']) { await writeFile(file, `[mcp_servers.saltedfish]\n${bad}\n`); await assert.rejects(setup.previewMachineRegistration('codex', file), { code: 'MACHINE_REGISTRATION_INVALID' }); }
    await writeFile(file, codexSource('safe-test-token')); const plan = await setup.previewMachineRegistration('codex', file);
    const changed = (await readFile(file, 'utf8')) + '\n# user edit\n'; await writeFile(file, changed); await assert.rejects(setup.apply(plan.planId), { code: 'CLIENT_CONFIG_CHANGED' }); assert.equal(await readFile(file, 'utf8'), changed);
  } finally { await temp.cleanup(); }
});

test('npm 独立登记入口无需安装网关或启动服务，preview不写配置，输出无token', async () => {
  const temp = await testDirectory();
  try {
    const file = path.join(temp.directory, 'config.toml'), home = path.join(temp.directory, 'uninstalled home'), token = randomBytes(32).toString('hex'), before = codexSource(token); await writeFile(file, before);
    const cli = async (preview: boolean) => {
      const child = spawn(process.execPath, ['--import', 'tsx', path.join(projectDir, 'src/npm-cli.ts'), 'gateway', 'register-machine', '--client', 'codex', '--config', file, '--home', home, ...(preview ? ['--preview'] : [])], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
      const code = await new Promise(resolve => child.once('close', resolve)); assert.equal(code, 0, stderr); assert.ok(!stdout.includes(token)); return JSON.parse(stdout);
    };
    assert.equal((await cli(true)).preview, true); assert.equal(await readFile(file, 'utf8'), before); await assert.rejects(access(home));
    assert.equal((await cli(false)).report.hostname, os.hostname()); assert.deepEqual(stripCodex(await readFile(file, 'utf8')), stripCodex(before));
    await assert.rejects(access(path.join(home, 'active.json'))); await assert.rejects(access(path.join(home, 'run'))); await assert.rejects(access(path.join(home, 'data', 'gateway', 'gateway.json')));
  } finally { await temp.cleanup(); }
});

test('gateway connect 自动登记执行机器，portable新增配置始终不携带网关机器身份', async () => {
  const temp = await testDirectory(); let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  try {
    const device = { id: randomUUID(), label: 'device', token: randomBytes(32).toString('hex') };
    const agents = ['codex', 'opencode'].map(label => ({ id: randomUUID(), label, token: randomBytes(32).toString('hex'), deviceId: device.id, profiles: '*' as const, readOnly: false }));
    const config = { host: '127.0.0.1', port: await freePort(), localPort: await freePort(), devices: [device], agents };
    await writeFile(path.join(temp.directory, 'gateway.json'), JSON.stringify(config)); gateway = await startGateway(config);
    const setup = await gatewayClientSetup(temp.directory), target = path.join(temp.directory, 'connected.toml'); const plan = await setup.preview('codex', { configPath: target, trust: 'preserve' }); await setup.apply(plan.planId);
    const headers = parseCodex(await readFile(target, 'utf8')).mcp_servers['saltedfish'].http_headers; assert.equal(headers.Authorization, `Bearer ${agents[0]!.token}`); assert.equal(parseRemoteMachineReport(headers[MACHINE_IDENTITY_HEADER])?.hostname, os.hostname());
    const again = await gatewayClientSetup(temp.directory), repeated = await again.preview('codex', { configPath: target, trust: 'preserve' });
    assert.equal(repeated.unchanged, true); assert.equal((await again.apply(repeated.planId)).unchanged, true); assert.equal((await again.history()).length, 1);
    assert.equal((await (await gatewayClientSetup(temp.directory)).inspect('codex', { configPath: target })).connection, 'configured');
    const portable = await addGatewayAgent(temp.directory, { name: 'other-machine', deviceId: device.id, profiles: [randomUUID()] });
    for (const file of Object.values(portable.clientFiles)) assert.ok(!(await readFile(file, 'utf8')).toLowerCase().includes(MACHINE_IDENTITY_HEADER.toLowerCase()));
  } finally { await gateway?.close(); await temp.cleanup(); }
});
