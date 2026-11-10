import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixture, fakeProfile, freePort, testDirectory } from './helpers.js';
import { createTestCertificate } from './fixtures/test-certificate.js';
import { startGateway } from '../src/remote-gateway.js';
import { FILE_CHUNK_BYTES } from '../src/file-transfer-tools.js';
import type { WireCommand } from '../src/shared.js';

async function until(predicate: () => boolean, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const call = async (sdk: Client, name: string, args: Record<string, unknown>) => (await sdk.callTool({ name, arguments: args })).structuredContent as any;
async function harness(t: { after: (callback: () => Promise<void>) => void }) {
  const f = await fixture(), temp = await testDirectory(), clients: Array<{ sdk: Client; transport: StreamableHTTPClientTransport }> = [];
  const certificate = createTestCertificate({ ipAddresses: ['127.0.0.1'] }), cert = path.join(temp.directory, 'cert.pem'), key = path.join(temp.directory, 'key.pem');
  await writeFile(cert, certificate.cert); await writeFile(key, certificate.key, { mode: 0o600 });
  const device = { id: randomUUID(), label: 'isolated-test-device', token: randomBytes(32).toString('hex') };
  const identity = () => ({ id: randomUUID(), label: 'isolated-agent', token: randomBytes(32).toString('hex'), deviceId: device.id, profiles: '*' as const, readOnly: false });
  const agent = identity(), other = identity(), gateway = await startGateway({ host: '127.0.0.1', port: await freePort(), localPort: await freePort(), tls: { cert, key }, devices: [device], agents: [agent, other] });
  t.after(async () => { for (const client of clients.reverse()) { await client.transport.terminateSession().catch(() => {}); await client.sdk.close(); } await gateway.close(); await f.cleanup(); await temp.cleanup(); });
  const hits: WireCommand[] = [], uploads: Array<{ filename: string; bytes: Buffer }> = [];
  const profile = await fakeProfile(f.config, 'transfer-isolated', async command => {
    hits.push(command);
    if (command.operation === 'tabs.list') return [{ tabId: 7 }, { tabId: 9 }, { tabId: 11 }];
    if (command.operation === 'page.upload') for (const file of command.args.paths as string[]) uploads.push({ filename: path.basename(file), bytes: await readFile(file) });
    return { received: command.operation, tabId: command.args.tabId };
  });
  // Agent 走服务器回环 Streamable HTTP；设备端走带独立测试 CA 的真正 WSS，模拟正式拓扑。
  await f.remote.configure({ enabled: true, url: `https://127.0.0.1:${gateway.config.port}`, token: 'fc1.' + Buffer.from(JSON.stringify({ token: device.token, ca: certificate.cert })).toString('base64url'), profiles: [profile.id], readOnly: false });
  await until(() => f.remote.status().state === 'connected');
  const connect = async (token: string) => {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gateway.config.localPort}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
    const sdk = new Client({ name: 'file-transfer-remote-regression', version: '1' }); await sdk.connect(transport); clients.push({ sdk, transport }); return sdk;
  };
  const reconnect = async () => {
    const connectedAt = f.remote.status().connectedAt;
    (f.remote as unknown as { socket: WebSocket }).socket.terminate();
    await until(() => f.remote.status().state === 'connected' && f.remote.status().connectedAt !== connectedAt);
  };
  return { f, profile, hits, uploads, agentIdentity: agent, agent: await connect(agent.token), other: await connect(other.token), reconnect };
}

test('真实HTTP/WSS链路发现64工具与新增参数，文件块跨重连续传、校验、读取和上传；Agent身份隔离', async t => {
  const h = await harness(t), profileId = h.profile.id, catalog = (await h.agent.listTools()).tools;
  assert.equal(catalog.length, 64);
  for (const name of ['chrome_file_begin', 'chrome_file_write', 'chrome_file_commit', 'chrome_file_read', 'chrome_file_export', 'chrome_file_status', 'chrome_wait_response', 'chrome_wait_download']) assert.ok(catalog.some(item => item.name === name), name);
  const uploadSchema = catalog.find(item => item.name === 'chrome_upload')!.inputSchema;
  assert.ok(Object.hasOwn(uploadSchema.properties!, 'transferIds'));
  const actionSchema = JSON.stringify(catalog.find(item => item.name === 'chrome_action')!.inputSchema); for (const action of ['drag', 'doubleClick', 'setChecked']) assert.ok(actionSchema.includes(action));
  const bytes = Buffer.alloc(FILE_CHUNK_BYTES + 17, 0x41), declaration = { profileId, filename: '跨端文件.csv', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), submissionId: randomUUID() };
  const begun = await call(h.agent, 'chrome_file_begin', declaration); assert.equal(begun.ok, true, JSON.stringify(begun)); const transferId = begun.data.transferId;
  const first = { profileId, transferId, offset: 0, base64: bytes.subarray(0, FILE_CHUNK_BYTES).toString('base64') };
  assert.equal((await call(h.agent, 'chrome_file_write', first)).ok, true);
  assert.equal((await call(h.other, 'chrome_file_status', { profileId, transferId })).error.code, 'FILE_TRANSFER_NOT_FOUND');
  const originalPrincipal = [...h.f.service.state.remotePrincipals.values()].find(p => p.remoteAgentId === h.agentIdentity.id)!;
  await h.reconnect();
  const again = await call(h.agent, 'chrome_file_begin', declaration); assert.equal(again.ok, true); assert.equal(again.data.transferId, transferId); assert.equal(again.data.receivedBytes, FILE_CHUNK_BYTES); assert.equal(again.data.deduplicated, true);
  assert.equal((await h.f.service.invoke('chrome_file_write', first, 'old-connection', originalPrincipal)).error?.code, 'REMOTE_CONNECTION_CHANGED');
  assert.equal((await call(h.agent, 'chrome_file_write', first)).data.deduplicated, true, '重连后的相同块不重复追加');
  assert.equal((await call(h.agent, 'chrome_file_write', { profileId, transferId, offset: FILE_CHUNK_BYTES, base64: bytes.subarray(FILE_CHUNK_BYTES).toString('base64') })).ok, true);
  assert.equal((await call(h.agent, 'chrome_file_commit', { profileId, transferId })).data.state, 'ready');
  const chunks = [];
  for (let offset = 0; offset < bytes.length;) { const result = await call(h.agent, 'chrome_file_read', { profileId, transferId, offset, length: FILE_CHUNK_BYTES }); assert.equal(result.ok, true); assert.equal(result.data.artifactId, undefined); chunks.push(Buffer.from(result.data.base64, 'base64')); offset = result.data.nextOffset; }
  assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.equal((await call(h.other, 'chrome_upload', { profileId, tabId: 7, selector: '#file', transferIds: [transferId] })).error.code, 'FILE_TRANSFER_NOT_FOUND');
  assert.equal((await call(h.agent, 'chrome_upload', { profileId, tabId: 7, selector: '#file', transferIds: [transferId] })).ok, true);
  assert.equal(h.uploads.length, 1); assert.equal(h.uploads[0]!.filename, declaration.filename); assert.deepEqual(h.uploads[0]!.bytes, bytes);
});

test('同配置不同标签的本机RPC和远程SDK可同时写；同标签claim隔离客户端', async t => {
  const h = await harness(t), profileId = h.profile.id, grant = h.f.service.state.createClient('isolated-local', [profileId]), owner = randomUUID();
  const local = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${h.f.config.port}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${grant.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name, args: { profileId, ...args }, owner }) });
    assert.equal(response.status, 200); return response.json() as Promise<any>;
  };
  const target = { profileId, tabId: 7 };
  assert.equal((await call(h.agent, 'chrome_claim_tab', target)).ok, true);
  assert.equal((await local('chrome_evaluate', { tabId: 7, expression: 'local collision' })).error.code, 'TAB_CLAIMED');
  assert.equal((await call(h.other, 'chrome_claim_tab', target)).error.code, 'TAB_CLAIMED');
  const results = await Promise.all([local('chrome_evaluate', { tabId: 9, expression: 'local different tab' }), call(h.agent, 'chrome_evaluate', { ...target, expression: 'remote owner' }), call(h.other, 'chrome_evaluate', { profileId, tabId: 11, expression: 'other remote tab' })]);
  assert.equal(results.every(result => result.ok), true, JSON.stringify(results));
  assert.deepEqual(h.hits.filter(command => command.operation === 'page.evaluate').map(command => Number(command.args.tabId)).sort((a, b) => a - b), [7, 9, 11]);
  assert.equal((await call(h.agent, 'chrome_release_tab', target)).ok, true);
  assert.equal((await local('chrome_claim_tab', { tabId: 7 })).ok, true);
  assert.equal((await call(h.agent, 'chrome_evaluate', { ...target, expression: 'local owns it now' })).error.code, 'TAB_CLAIMED');
  assert.equal((await local('chrome_release_tab', { tabId: 7 })).ok, true);
});
