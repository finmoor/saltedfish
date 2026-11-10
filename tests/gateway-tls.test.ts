import test from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate, randomBytes, randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectDir } from '../src/config.js';
import { fixture, freePort, testDirectory } from './helpers.js';
import { gatewayPairing, repairGatewayTls, validateGatewayTls } from '../src/gateway-tls.js';
import { startGateway } from '../src/remote-gateway.js';
import { RemoteSettings, pairingCredential } from '../src/remote-protocol.js';
import { VERSION } from '../src/version.js';
import { createTestCertificate, type TestCertificateOptions } from './fixtures/test-certificate.js';

// 证书和私钥都在测试里即时生成（见 fixtures/test-certificate.ts），干净检出不依赖任何被 .gitignore 排除的文件。
const day = 24 * 3600_000;
async function until(predicate: () => boolean, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
function run(script: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(projectDir, script), ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
}
async function certificatePair(directory: string, name: string, options?: TestCertificateOptions) {
  const pair = createTestCertificate(options), cert = path.join(directory, `${name}.crt`), key = path.join(directory, `${name}.key`);
  await writeFile(cert, pair.cert); await writeFile(key, pair.key);
  return { ...pair, certPath: cert, keyPath: key };
}
const fingerprint = (pem: string) => new X509Certificate(pem).fingerprint256;
async function withTemp<T>(work: (directory: string) => Promise<T>) {
  const temp = await testDirectory();
  try { return await work(temp.directory); } finally { await temp.cleanup(); }
}
const codeIs = (code: string) => (error: Error & { code?: string }) => error.code === code;

test('缺失私钥在网关提交前失败，同目录更正后带证书重试成功，配对只含证书', async () => withTemp(async root => {
  const directory = path.join(root, 'gateway'), pair = await certificatePair(root, 'server', { ipAddresses: ['127.0.0.1'] });
  const init = (...extra: string[]) => run('src/gateway-cli.ts', ['init', ...extra, '--data-dir', directory]);
  const failed = await init('--cert', pair.certPath, '--key', path.join(root, 'missing.key'));
  assert.equal(failed.code, 1); assert.match(failed.stderr, /无法读取 TLS 证书或私钥/);
  await assert.rejects(access(directory));
  const retried = await init('--cert', pair.certPath, '--key', pair.keyPath);
  assert.equal(retried.code, 0, retried.stderr);
  const config = JSON.parse(await readFile(path.join(directory, 'gateway.json'), 'utf8'));
  assert.deepEqual(config.tls, { cert: pair.certPath, key: pair.keyPath });
  const pairing = pairingCredential(await readFile(path.join(directory, 'device-pairing.token'), 'utf8'));
  assert.equal(pairing.token, config.devices[0].token);
  assert.equal(fingerprint(pairing.ca!), fingerprint(pair.cert));
  assert.ok(!pairing.ca!.includes('PRIVATE KEY'));
}));

test('init 生成的配对对真实 TLS 网关握手：钉扎 CA 的远程连接成功，缺少 CA 被拒绝且不发送操作', { timeout: 60000 }, async t => {
  const temp = await testDirectory(), f = await fixture();
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  t.after(async () => { await gateway?.close(); await f.cleanup(); await temp.cleanup(); });
  const directory = path.join(temp.directory, 'gateway'), port = await freePort(), localPort = await freePort();
  const pair = await certificatePair(temp.directory, 'server', { ipAddresses: ['127.0.0.1'] });
  const init = await run('src/gateway-cli.ts', ['init', '--host', '127.0.0.1', '--port', String(port), '--local-port', String(localPort), '--cert', pair.certPath, '--key', pair.keyPath, '--data-dir', directory]);
  assert.equal(init.code, 0, init.stderr);
  gateway = await startGateway(JSON.parse(await readFile(path.join(directory, 'gateway.json'), 'utf8')));
  const pairing = (await readFile(path.join(directory, 'device-pairing.token'), 'utf8')).trim(), credential = pairingCredential(pairing), url = `https://127.0.0.1:${port}`;
  const health = (ca?: string) => new Promise<string>(resolve => {
    const request = httpsRequest(`${url}/health`, { ca }, response => { response.resume(); resolve(`status ${response.statusCode}`); });
    request.on('error', error => resolve((error as NodeJS.ErrnoException).code ?? String(error))); request.end();
  });
  assert.equal(await health(credential.ca), 'status 200');
  assert.equal(await health(), 'DEPTH_ZERO_SELF_SIGNED_CERT');
  // 本机连接器：只有设备 Token、没有配对 CA 时证书校验失败并停止，不会静默降级。
  await f.remote.configure({ enabled: true, url, token: credential.token, profiles: '*', readOnly: false });
  await until(() => f.remote.status().state === 'error');
  assert.match(f.remote.status().error!, /服务器证书校验失败/);
  await f.remote.configure({ enabled: true, url, token: pairing, profiles: '*', readOnly: false });
  await until(() => f.remote.status().state === 'connected');
});

test('证书与私钥校验：有效配对返回规范化证书；过期、尚未生效、私钥不匹配或损坏、无法读取都在提交前被拒绝', async () => withTemp(async root => {
  const valid = await certificatePair(root, 'valid');
  const ca = await validateGatewayTls({ cert: valid.certPath, key: valid.keyPath });
  assert.match(ca!, /^-----BEGIN CERTIFICATE-----\n/); assert.equal(fingerprint(ca!), fingerprint(valid.cert));
  // 临近到期但仍有效的证书不能被误拒。
  const soon = await certificatePair(root, 'soon', { notAfter: new Date(Date.now() + 3600_000) });
  assert.ok(await validateGatewayTls({ cert: soon.certPath, key: soon.keyPath }));
  const expired = await certificatePair(root, 'expired', { notBefore: new Date(Date.now() - 10 * day), notAfter: new Date(Date.now() - day) });
  await assert.rejects(validateGatewayTls({ cert: expired.certPath, key: expired.keyPath }), codeIs('GATEWAY_TLS_INVALID'));
  const future = await certificatePair(root, 'future', { notBefore: new Date(Date.now() + day), notAfter: new Date(Date.now() + 10 * day) });
  await assert.rejects(validateGatewayTls({ cert: future.certPath, key: future.keyPath }), codeIs('GATEWAY_TLS_INVALID'));
  const other = await certificatePair(root, 'other');
  await assert.rejects(validateGatewayTls({ cert: valid.certPath, key: other.keyPath }), codeIs('GATEWAY_TLS_INVALID'));
  const garbage = path.join(root, 'garbage.key'); await writeFile(garbage, 'not-a-private-key');
  await assert.rejects(validateGatewayTls({ cert: valid.certPath, key: garbage }), codeIs('GATEWAY_TLS_INVALID'));
  await assert.rejects(validateGatewayTls({ cert: valid.certPath, key: path.join(root, 'absent.key') }), codeIs('GATEWAY_TLS_UNREADABLE'));
  assert.equal(await validateGatewayTls(undefined), undefined);
}));

test('--cert 夹带私钥被拒绝，配对只取规范化的证书块', async () => withTemp(async root => {
  const pair = await certificatePair(root, 'server');
  const combined = path.join(root, 'combined.pem'); await writeFile(combined, pair.cert + pair.key);
  await assert.rejects(validateGatewayTls({ cert: combined, key: pair.keyPath }), codeIs('GATEWAY_TLS_CERT_HAS_KEY'));
  for (const label of ['RSA PRIVATE KEY', 'EC PRIVATE KEY', 'ENCRYPTED PRIVATE KEY']) {
    const file = path.join(root, `${label.replaceAll(' ', '-')}.pem`);
    await writeFile(file, `${pair.cert}-----BEGIN ${label}-----\nAAAA\n-----END ${label}-----\n`);
    await assert.rejects(validateGatewayTls({ cert: file, key: pair.keyPath }), codeIs('GATEWAY_TLS_CERT_HAS_KEY'), label);
  }
  // 带说明文字、CRLF 和尾随内容的证书文件仍可用，写进配对的只有规范化的证书块。
  const noisy = path.join(root, 'noisy.pem');
  await writeFile(noisy, `# generated by a tool\r\n${pair.cert.replaceAll('\n', '\r\n')}\r\n# trailing note\r\n`);
  const ca = (await validateGatewayTls({ cert: noisy, key: pair.keyPath }))!;
  assert.equal(ca, pair.cert); assert.ok(!/[#\r]/.test(ca));
  // 证书链：顺序保持，每个块都规范化。
  const intermediate = createTestCertificate({ commonName: 'intermediate' }), chain = path.join(root, 'chain.pem');
  await writeFile(chain, pair.cert + intermediate.cert);
  assert.equal(await validateGatewayTls({ cert: chain, key: pair.keyPath }), pair.cert + intermediate.cert);
  const empty = path.join(root, 'empty.pem'); await writeFile(empty, 'no certificate here');
  await assert.rejects(validateGatewayTls({ cert: empty, key: pair.keyPath }), codeIs('GATEWAY_TLS_INVALID'));
  // 通过命令行：合并 PEM 不会生成任何网关文件，更不会把私钥写进配对。
  const directory = path.join(root, 'gateway'), result = await run('src/gateway-cli.ts', ['init', '--cert', combined, '--key', combined, '--data-dir', directory]);
  assert.equal(result.code, 1); assert.match(result.stderr, /包含私钥/); await assert.rejects(access(directory));
}));

test('证书必须覆盖 --url 主机，与远程连接器的主机名校验一致；不覆盖时提交前给出明确提示', async () => withTemp(async root => {
  const named = await certificatePair(root, 'named', { commonName: 'cn-only-name', dnsNames: ['gateway.example', '*.lan.example'], ipAddresses: ['192.168.1.10'] });
  const tls = { cert: named.certPath, key: named.keyPath };
  for (const host of ['gateway.example', 'node.lan.example', '192.168.1.10']) assert.ok(await validateGatewayTls(tls, host), host);
  for (const host of ['192.168.1.11', 'other.example', '127.0.0.1', '[::1]']) {
    await assert.rejects(validateGatewayTls(tls, host), (error: Error & { code?: string }) => error.code === 'GATEWAY_TLS_HOST_MISMATCH' && error.message.includes(host.replace(/^\[|\]$/g, '')) && error.message.includes('192.168.1.10'), host);
  }
  // 只有 CN、没有 SAN 的证书：DNS 名按 CN 通过，IP 地址必须有 SAN。
  const cnOnly = await certificatePair(root, 'cn-only', { commonName: 'localhost' });
  assert.ok(await validateGatewayTls({ cert: cnOnly.certPath, key: cnOnly.keyPath }, 'localhost'));
  await assert.rejects(validateGatewayTls({ cert: cnOnly.certPath, key: cnOnly.keyPath }, '127.0.0.1'), codeIs('GATEWAY_TLS_HOST_MISMATCH'));
  // 命令行：默认 --url 的主机不被证书覆盖时拒绝且不落盘；改成证书覆盖的地址后同一目录可以重试。
  const directory = path.join(root, 'gateway'), init = (...extra: string[]) => run('src/gateway-cli.ts', ['init', '--cert', cnOnly.certPath, '--key', cnOnly.keyPath, ...extra, '--data-dir', directory]);
  const rejected = await init('--host', '127.0.0.1');
  assert.equal(rejected.code, 1); assert.match(rejected.stderr, /不覆盖 --url 的主机 127\.0\.0\.1/); await assert.rejects(access(directory));
  const accepted = await init('--host', '127.0.0.1', '--url', 'https://localhost:18443');
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'gateway.json'), 'utf8')).allowedHosts, ['localhost:18443']);
}));

test('证书链过大给出专门错误，不再误报 Token 格式无效；上限与配对/设置的实际校验一致', async () => withTemp(async root => {
  const leaf = await certificatePair(root, 'leaf', { ipAddresses: ['127.0.0.1'] }), extras = Array.from({ length: 80 }, () => createTestCertificate().cert);
  const file = path.join(root, 'huge.pem'); await writeFile(file, leaf.cert + extras.join(''));
  const token = randomBytes(32).toString('hex'), ca = (await validateGatewayTls({ cert: file, key: leaf.keyPath }))!;
  assert.throws(() => gatewayPairing(token, ca), (error: Error & { code?: string }) => error.code === 'GATEWAY_TLS_CERT_TOO_LARGE' && /证书链过大/.test(error.message) && !/格式无效/.test(error.message));
  const directory = path.join(root, 'gateway'), result = await run('src/gateway-cli.ts', ['init', '--cert', file, '--key', leaf.keyPath, '--host', '127.0.0.1', '--data-dir', directory]);
  assert.equal(result.code, 1); assert.match(result.stderr, /证书链过大/); assert.doesNotMatch(result.stderr, /格式无效/); await assert.rejects(access(directory));
  // 逐个增加证书块：gatewayPairing 接受，当且仅当配对解析与本机设置都接受同一个 Token。
  let accepted = 0, rejected = 0;
  for (let count = 1; count <= 80; count++) {
    const text = leaf.cert + extras.slice(0, count - 1).join('');
    const pairing = `fc1.${Buffer.from(JSON.stringify({ token, ca: text })).toString('base64url')}`;
    let expected = RemoteSettings.shape.token.safeParse(pairing).success;
    if (expected) { try { pairingCredential(pairing); } catch { expected = false; } }
    let actual: boolean;
    try { assert.equal(gatewayPairing(token, text), pairing); actual = true; }
    catch (error) { if ((error as { code?: string }).code !== 'GATEWAY_TLS_CERT_TOO_LARGE') throw error; actual = false; }
    assert.equal(actual, expected, `${count} 个证书块`); if (actual) accepted++; else rejected++;
  }
  assert.ok(accepted > 10 && rejected > 10, `边界应落在测试范围内：接受 ${accepted}，拒绝 ${rejected}`);
  assert.equal(pairingCredential(gatewayPairing(token)).ca, undefined);
}));

async function repairFixture(root: string) {
  const pair = await certificatePair(root, 'server'), directory = path.join(root, 'gateway'); await mkdir(directory);
  const device = { id: randomUUID(), label: 'fixture', token: randomBytes(32).toString('hex') };
  const agent = { id: randomUUID(), label: 'codex', token: randomBytes(32).toString('hex'), deviceId: device.id, profiles: '*', readOnly: false };
  const broken = path.join(root, 'moved.key');
  const config = { host: '127.0.0.1', port: 18443, localPort: 18444, allowedHosts: [], tls: { cert: pair.certPath, key: broken }, devices: [device], agents: [agent] };
  const file = path.join(directory, 'gateway.json'), paired = path.join(directory, 'device-pairing.token');
  const pairing = (ca: string) => `fc1.${Buffer.from(JSON.stringify({ token: device.token, ca })).toString('base64url')}`;
  await writeFile(file, JSON.stringify(config)); await writeFile(paired, pairing(pair.cert));
  const snapshot = async () => ({ config: await readFile(file, 'utf8'), pairing: await readFile(paired, 'utf8'), files: (await readdir(directory)).sort() });
  return { pair, directory, config, file, paired, broken, pairing, snapshot };
}

test('修复只更正路径：损坏私钥拒绝，更正后保持配置、全部凭据和配对文件，并留备份', async () => withTemp(async root => {
  const f = await repairFixture(root), before = await f.snapshot();
  await writeFile(f.broken, 'not-a-private-key');
  await assert.rejects(repairGatewayTls(f.directory, { key: f.broken }), codeIs('GATEWAY_TLS_INVALID'));
  assert.deepEqual(await f.snapshot(), before);
  const repaired = await repairGatewayTls(f.directory, { key: f.pair.keyPath });
  assert.equal(repaired.credentialsPreserved, true); assert.ok(!('warning' in repaired));
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), { ...f.config, tls: { cert: f.pair.certPath, key: f.pair.keyPath } });
  assert.equal(await readFile(f.paired, 'utf8'), before.pairing);
  assert.deepEqual(JSON.parse(await readFile(repaired.backup, 'utf8')), f.config);
}));

test('修复不更换证书：换成另一张证书、证书已过期、缺少选项或未配置 TLS 都拒绝且不改任何文件', async () => withTemp(async root => {
  const f = await repairFixture(root), before = await f.snapshot();
  const other = await certificatePair(root, 'other');
  await assert.rejects(repairGatewayTls(f.directory, { cert: other.certPath, key: other.keyPath }), codeIs('GATEWAY_REPAIR_CERT_CHANGED'));
  assert.deepEqual(await f.snapshot(), before);
  await assert.rejects(repairGatewayTls(f.directory, {}), codeIs('GATEWAY_REPAIR_OPTIONS'));
  // 配对里的证书已经过期：即使路径正确，修复也不能把过期证书写回配置。
  const expired = await certificatePair(root, 'expired', { notBefore: new Date(Date.now() - 10 * day), notAfter: new Date(Date.now() - day) });
  await writeFile(f.paired, f.pairing(expired.cert)); await writeFile(f.file, JSON.stringify({ ...f.config, tls: { cert: expired.certPath, key: f.broken } }));
  const expiredBefore = await f.snapshot();
  await assert.rejects(repairGatewayTls(f.directory, { key: expired.keyPath }), codeIs('GATEWAY_TLS_INVALID'));
  assert.deepEqual(await f.snapshot(), expiredBefore);
  const { tls: _tls, ...plain } = f.config; await writeFile(f.file, JSON.stringify(plain));
  await assert.rejects(repairGatewayTls(f.directory, { key: f.pair.keyPath }), codeIs('GATEWAY_REPAIR_NO_TLS'));
}));

test('修复兼容旧版配对：整文件写入的 ca 带注释也按证书内容比对；旧配对含私钥时给出泄漏警告', async () => withTemp(async root => {
  const f = await repairFixture(root);
  await writeFile(f.paired, f.pairing(`# 旧版整文件原样写入\r\n${f.pair.cert.replaceAll('\n', '\r\n')}`));
  assert.ok(!('warning' in await repairGatewayTls(f.directory, { key: f.pair.keyPath })));
  const nested = path.join(root, 'leaked'); await mkdir(nested);
  const leaked = await repairFixture(nested);
  await writeFile(leaked.paired, leaked.pairing(leaked.pair.cert + leaked.pair.key));
  const warned = await repairGatewayTls(leaked.directory, { key: leaked.pair.keyPath });
  assert.match(String((warned as { warning?: string }).warning), /私钥/);
}));

async function homeFixture(root: string) {
  const f = await repairFixture(root), home = await realpath(root), target = path.join(home, 'data/gateway');
  await writeFile(path.join(home, 'installation.json'), JSON.stringify({ product: 'saltedfish-npm', createdAt: new Date().toISOString() }));
  for (const folder of ['run', 'versions', 'logs']) await mkdir(path.join(home, folder), { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'gateway.json'), await readFile(f.file)); await writeFile(path.join(target, 'device-pairing.token'), await readFile(f.paired));
  const snapshot = async () => ({ config: await readFile(path.join(target, 'gateway.json'), 'utf8'), files: (await readdir(target)).sort() });
  // 服务管理记录需要一个真实存活、身份与本安装相符的进程：按 startService 的方式运行 versions/<版本>/dist/npm-worker.js <角色> <home>，
  // 脚本只是空转，所以“运行中/不可达”的判断不依赖管理记录以外的任何启发式。
  async function worker(t: { after: (callback: () => void) => void }) {
    const script = path.join(home, 'versions', VERSION, 'dist/npm-worker.js');
    await mkdir(path.dirname(script), { recursive: true }); await writeFile(script, 'setInterval(() => {}, 1000);');
    const child = spawn(process.execPath, [script, 'gateway', home], { windowsHide: true, stdio: 'ignore' });
    t.after(() => { child.kill(); });
    await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject); });
    await new Promise(resolve => setTimeout(resolve, 500));
    return child.pid!;
  }
  const record = (pid: number, port: number, instanceId: string) => writeFile(path.join(home, 'run/gateway.json'), JSON.stringify({ role: 'gateway', port, token: randomBytes(32).toString('hex'), instanceId, pid, version: VERSION, startedAt: new Date().toISOString(), home }));
  return { ...f, home, target, snapshot, record, worker };
}

test('gateway repair 在网关运行或管理端口不可达时拒绝，停止后才修复', { timeout: 120000 }, async t => {
  const temp = await testDirectory(); let status: Server | undefined;
  const closeStatus = async () => { const server = status; status = undefined; if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
  t.after(async () => { await closeStatus(); await temp.cleanup(); });
  const f = await homeFixture(temp.directory), repair = () => run('src/npm-cli.ts', ['gateway', 'repair', '--key', f.pair.keyPath, '--home', f.home]);
  await writeFile(f.broken, 'not-a-private-key');
  const before = await f.snapshot(), instanceId = randomUUID(), port = await freePort(), pid = await f.worker(t);
  // 管理端口正常应答：运行中。
  status = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ role: 'gateway', home: f.home, instanceId, pid, version: VERSION })); });
  await new Promise<void>(resolve => status!.listen(port, '127.0.0.1', resolve)); await f.record(pid, port, instanceId);
  const running = await repair();
  assert.equal(running.code, 1); assert.match(running.stderr, /请先核查并停止 gateway/); assert.deepEqual(await f.snapshot(), before);
  // 记录里的进程还活着但管理端口无应答：不可达，同样拒绝。
  await closeStatus();
  const unreachable = await repair();
  assert.equal(unreachable.code, 1); assert.match(unreachable.stderr, /请先核查并停止 gateway/); assert.deepEqual(await f.snapshot(), before);
  // 已停止（没有运行记录）：修复成功，证书、配对与所有凭据保持。
  await rm(path.join(f.home, 'run/gateway.json'));
  const repaired = await repair();
  assert.equal(repaired.code, 0, repaired.stderr); assert.equal(JSON.parse(repaired.stdout).repaired, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.target, 'gateway.json'), 'utf8')).tls, { cert: f.pair.certPath, key: f.pair.keyPath });
  assert.equal(await readFile(path.join(f.target, 'device-pairing.token'), 'utf8'), f.pairing(f.pair.cert));
});
