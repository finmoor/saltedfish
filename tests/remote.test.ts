import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixture, fakeProfile, freePort } from './helpers.js';
import { startGateway } from '../src/remote-gateway.js';
import { RemoteConnector } from '../src/remote-connector.js';
import { remoteUrl, pairingCredential } from '../src/remote-protocol.js';

export async function until(predicate: () => boolean | Promise<boolean>, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() >= deadline) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
export async function gatewayFixture() {
  const device = { id: randomUUID(), label: '测试电脑', token: randomBytes(32).toString('hex') };
  const agent = { id: randomUUID(), label: 'Claude', token: randomBytes(32).toString('hex'), deviceId: device.id, profiles: '*' as const, readOnly: false };
  const other = { ...agent, id: randomUUID(), label: 'OpenCode', token: randomBytes(32).toString('hex') };
  const config = { host: '127.0.0.1', port: await freePort(), devices: [device], agents: [agent, other] };
  const gateway = await startGateway(config);
  const url = `http://127.0.0.1:${config.port}`;
  return { gateway, config, device, agent, other, url };
}
async function client(url: string, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const sdk = new Client({ name: 'remote-regression', version: '1' }); await sdk.connect(transport);
  return { sdk, transport, async close() { await transport.terminateSession().catch(() => {}); await sdk.close(); } };
}
const call = async (sdk: Client, name: string, args: Record<string, unknown> = {}) => (await sdk.callTool({ name, arguments: args })).structuredContent as any;

test('业务提交身份跨自动远程重连保持，旧连接授权仍失效', async t => {
  const h = await harness(t); let writes = 0;
  const p = await fakeProfile(h.f.config, 'receipt', command => {
    if (command.operation === 'tabs.list') return [{ tabId: 7 }];
    if (command.operation === 'page.evaluate') writes++;
    return {};
  });
  await h.f.remote.configure({ ...h.settings, profiles: '*' });
  await until(() => h.f.remote.status().state === 'connected');
  const args = { profileId: p.id, tabId: 7, name: 'one business intent', submissionId: randomUUID(), captureOnFailure: false,
    steps: [{ operation: 'page.evaluate', args: { expression: 'fixture counter' } }] };
  const first = await call(h.sdk, 'chrome_task_submit', args);
  assert.equal(first.ok, true);
  await until(() => h.f.service.tasks.get(p.id, first.data.id).status === 'succeeded');
  const originalPrincipal = [...h.f.service.state.remotePrincipals.values()][0]!;
  const connectedAt = h.f.remote.status().connectedAt;
  (h.f.remote as any).socket.terminate();
  await until(() => h.f.remote.status().state === 'connected' && h.f.remote.status().connectedAt !== connectedAt);
  const again = await call(h.sdk, 'chrome_task_submit', args);
  assert.equal(again.ok, true); assert.equal(again.data.id, first.data.id); assert.equal(again.data.deduplicated, true);
  assert.equal(writes, 1);
  assert.equal((await h.f.service.invoke('chrome_profiles', {}, 'old', originalPrincipal)).error?.code, 'REMOTE_CONNECTION_CHANGED');
});
async function harness(t: any) {
  const f = await fixture(), g = await gatewayFixture();
  t.after(async () => { await g.gateway.close(); await f.cleanup(); });
  const hits: string[] = [];
  const a = await fakeProfile(f.config, '个人', command => { hits.push(`a:${command.operation}`); if (command.operation === 'tabs.list') return [{ tabId: 7, title: 'A', windowId: 1 }]; return { value: 'A' }; });
  const b = await fakeProfile(f.config, '工作', command => { hits.push(`b:${command.operation}`); if (command.operation === 'tabs.list') return [{ tabId: 7, title: 'B', windowId: 2 }]; return { value: 'B' }; });
  const settings = { enabled: true, url: g.url, token: g.device.token, profiles: [a.id, b.id], readOnly: false };
  await f.remote.configure(settings); await until(() => f.remote.status().state === 'connected');
  const c = await client(g.url, g.agent.token); t.after(() => c.close());
  return { f, g, a, b, hits, settings, ...c };
}
test('远程标准 HTTP 发现 64 工具、按名称列出两个 Chrome，同号标签按 profileId 隔离', async t => {
  const h = await harness(t);
  const catalog=(await h.sdk.listTools()).tools;
  assert.equal(catalog.length, 64);
  for(const [name,fields] of Object.entries({chrome_action:['autoWait'],chrome_inspect:['scopeSelector','valueLimit','sinceSnapshot'],chrome_accessibility:['offset','limit','mode','maxCharacters'],chrome_events:['mode','maxCharacters'],chrome_dialog:['dialogId','expectedType','expectedMessage']})){
    const properties=catalog.find(tool=>tool.name===name)!.inputSchema.properties!;
    for(const field of fields)assert.ok(Object.hasOwn(properties,field),`${name}.${field} 在 HTTP 链路缺失`);
  }
  assert.ok(JSON.stringify(catalog.find(tool=>tool.name==='chrome_batch')!.inputSchema).includes('page.dialog'));
  const result = await call(h.sdk, 'chrome_profiles'); assert.deepEqual(result.data.profiles.map((p: any) => p.label), ['个人', '工作']);
  assert.equal((await call(h.sdk, 'chrome_tabs', { profileId: h.a.id })).data.items[0].title, 'A');
  assert.equal((await call(h.sdk, 'chrome_tabs', { profileId: h.b.id })).data.items[0].title, 'B');
  assert.equal((await call(h.sdk, 'chrome_evaluate', { profileId: h.b.id, tabId: 7, expression: '1' })).ok, true);
  assert.ok(h.hits.includes('b:page.evaluate')); assert.ok(!h.hits.includes('a:page.evaluate'));
});

test('远程保留派发前失败与结果未知的类型，operation 与 MCP 响应一致',async t=>{
 const f=await fixture(),g=await gatewayFixture();t.after(async()=>{await g.gateway.close();await f.cleanup();});
 const p=await fakeProfile(f.config,'outcomes',command=>{if(['page.action','page.evaluate'].includes(command.operation))p.socket.send(JSON.stringify({type:'result',id:command.id,error:{code:command.operation==='page.action'?'ACTIONABILITY_TIMEOUT':'JAVASCRIPT_ERROR',message:'fixture',phase:command.operation==='page.action'?'precondition':'execution',outcome:command.operation==='page.action'?'not_dispatched':'unknown'}}));return {};});
 await f.remote.configure({enabled:true,url:g.url,token:g.device.token,profiles:[p.id],readOnly:false});await until(()=>f.remote.status().state==='connected');const c=await client(g.url,g.agent.token);t.after(()=>c.close());
 const known=await call(c.sdk,'chrome_action',{profileId:p.id,tabId:7,action:'click',selector:'#late'});assert.equal(known.error.outcome,'not_dispatched');assert.equal(known.error.phase,'precondition');assert.equal(f.service.state.get(known.operationId)!.state,'failed');
 const unknown=await call(c.sdk,'chrome_evaluate',{profileId:p.id,tabId:7,expression:'fixture'});assert.equal(unknown.error.outcome,'unknown');assert.equal(f.service.state.get(unknown.operationId)!.state,'unknown');assert.equal((await call(c.sdk,'chrome_action',{profileId:p.id,tabId:7,action:'click',selector:'#late'})).error.code,'RESULT_UNKNOWN');
});
test('设备 Token 不能调用 MCP；agent Token 不能接入设备；管理 API 不外露，拒绝非法 Origin/Host', async t => {
  const h = await harness(t);
  for (const credential of [h.g.device.token, randomBytes(32).toString('hex')]) assert.equal((await fetch(`${h.g.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${credential}` } })).status, 401);
  for (const route of ['/rpc', '/clients', '/remote', '/admin/shutdown', '/results']) assert.equal((await fetch(h.g.url + route, { headers: { authorization: `Bearer ${h.g.agent.token}` } })).status, 404);
  assert.equal((await fetch(h.g.url + '/mcp', { headers: { authorization: `Bearer ${h.g.agent.token}`, origin: 'https://evil.invalid' } })).status, 403);
  const hostStatus = await new Promise(resolve => { const req = httpRequest(h.g.url + '/health', { headers: { host: 'evil.invalid' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', () => resolve(0)); req.end(); });
  assert.equal(hostStatus, 403);
  const socket = new WebSocket(h.g.url.replace('http:', 'ws:') + '/connect', { headers: { authorization: `Bearer ${h.g.agent.token}` } });
  socket.on('error', () => {}); const rejected = new Promise<number | undefined>(resolve => socket.on('unexpected-response', (_r, res) => { res.resume(); resolve(res.statusCode); socket.terminate(); }));
  assert.equal(await rejected, 401);
});
test('不同 agent 的 HTTP session 不可互用，标签租约也不会共用', async t => {
  const h = await harness(t), second = await client(h.g.url, h.g.other.token); t.after(() => second.close());
  const response = await fetch(`${h.g.url}/mcp`, { headers: { authorization: `Bearer ${h.g.other.token}`, 'mcp-session-id': h.transport.sessionId! } }); assert.equal(response.status, 404);
  assert.equal((await call(h.sdk, 'chrome_claim_tab', { profileId: h.a.id, tabId: 7 })).ok, true);
  assert.equal((await call(second.sdk, 'chrome_claim_tab', { profileId: h.a.id, tabId: 7 })).ok, false);
});
test('本机账号范围及只读设置立即限制远程，状态 API 不回显 Token', async t => {
  const h = await harness(t);
  await h.f.remote.configure({ ...h.settings, profiles: [h.b.id], readOnly: true }); await until(() => h.f.remote.status().state === 'connected');
  assert.deepEqual((await call(h.sdk, 'chrome_profiles')).data.profiles.map((p: any) => p.id), [h.b.id]);
  assert.equal((await call(h.sdk, 'chrome_tabs', { profileId: h.a.id })).error.code, 'PROFILE_NOT_AUTHORIZED');
  assert.equal((await call(h.sdk, 'chrome_action', { profileId: h.b.id, tabId: 7, action: 'fill', selector: '#x', text: 'test' })).error.code, 'CLIENT_READ_ONLY');
  const status = JSON.stringify(h.f.remote.status()); assert.ok(!status.includes(h.g.device.token)); assert.ok(!status.includes('"token":'));
  const raw = await readFile(path.join(h.f.config.dataDir, 'remote.json'), 'utf8'); assert.equal(JSON.parse(raw).token, h.g.device.token);
});
test('连接断开时返回结果待核查；重连不重放，未连接时不切换其他设备', async t => {
  const h = await harness(t); let finish!: () => void, started = false, calls = 0;
  const slow = await fakeProfile(h.f.config, 'slow', async () => { started = true; calls++; await new Promise<void>(resolve => { finish = resolve; }); return { ok: true }; });
  await h.f.remote.configure({ ...h.settings, profiles: '*' }); await until(() => h.f.remote.status().state === 'connected');
  const pending = call(h.sdk, 'chrome_evaluate', { profileId: slow.id, tabId: 8, expression: '1' });
  await until(() => started); await h.f.remote.configure({ ...h.settings, enabled: false });
  assert.equal((await pending).error.code, 'REMOTE_RESULT_UNKNOWN');
  assert.equal((await call(h.sdk, 'chrome_profiles')).error.code, 'REMOTE_DEVICE_OFFLINE');
  finish(); await until(() => h.f.remote.status().activeCalls === 0);
  await h.f.remote.configure({ ...h.settings, profiles: '*' }); await until(() => h.f.remote.status().state === 'connected');
  await call(h.sdk, 'chrome_profiles'); assert.equal(calls, 1);
  assert.equal(h.f.service.state.list(slow.id, undefined, 0, 10).items[0]!.state, 'succeeded');
});
test('远程断线使任务后续步骤停止，新连接不能续跑旧任务', async t => {
  const h = await harness(t); let finish!: () => void, started = false, actions = 0;
  const slow = await fakeProfile(h.f.config, 'queue', async command => {
    if (command.operation === 'tabs.list') return [{ tabId: 9 }];
    if (command.operation === 'page.evaluate') { actions++; if (actions === 1) { started = true; await new Promise<void>(resolve => { finish = resolve; }); } }
    return {};
  });
  await h.f.remote.configure({ ...h.settings, profiles: '*' }); await until(() => h.f.remote.status().state === 'connected');
  const result = await call(h.sdk, 'chrome_task_submit', { profileId: slow.id, tabId: 9, name: 'remote sequence', visible: false, captureOnFailure: false, steps: [{ operation: 'page.evaluate', args: { expression: '1' } }, { operation: 'page.evaluate', args: { expression: '2' } }] });
  assert.equal(result.ok, true); await until(() => started);
  await h.f.remote.configure({ ...h.settings, enabled: false }); finish();
  await until(() => h.f.service.tasks.stats().activeTaskProfiles === 0); assert.equal(actions, 1);
  const task = h.f.service.tasks.get(slow.id, result.data.id); assert.notEqual(task.status, 'succeeded');
});
test('同一个设备 Token 的重复接入拒绝，不替换正在工作的电脑', async t => {
  const h = await harness(t), second = new RemoteConnector(h.f.service); t.after(() => second.close());
  // 独立 connector 用于模拟另一台机器；仅测试连接竞争，不改变原连接设置。
  await second.configure(h.settings); await until(() => second.status().state === 'reconnecting');
  assert.match(second.status().error!, /另一台电脑/); assert.equal(h.f.remote.status().state, 'connected');
  assert.equal((await call(h.sdk, 'chrome_profiles')).ok, true);
  h.f.remote.close(); await until(() => second.status().state === 'connected', 35000);
  assert.equal((await call(h.sdk, 'chrome_profiles')).ok, true);
});
test('拒绝明文远端、带凭据/查询的地址和坏 Token，关闭后重启不自动连接', async t => {
  for (const url of ['http://192.168.1.10:18443', 'ftp://localhost', 'https://user:secret@host', 'https://host/?token=x', 'https://host/mcp']) assert.throws(() => remoteUrl(url));
  assert.throws(() => pairingCredential('bad')); assert.throws(() => pairingCredential('fc1.' + Buffer.from('{"token":"secret"}').toString('base64url')));
  const h = await harness(t); await h.f.remote.configure({ ...h.settings, enabled: false });
  const restarted = new RemoteConnector(h.f.service); t.after(() => restarted.close()); await restarted.start(); assert.equal(restarted.status().state, 'disconnected');
});

test('远程请求在异步文件预检期间过期，上传不能迟到执行', async t => {
  const h = await harness(t); let release!: () => void, entered = false;
  const principal = { id: `remote:${randomUUID()}:${randomUUID()}`, label: 'deadline', admin: false, profiles: [h.a.id], readOnly: false };
  h.f.service.state.remotePrincipals.set(principal.id, principal);
  (h.f.service as any).checkFiles = async () => { entered = true; await new Promise<void>(resolve => { release = resolve; }); };
  const pending = h.f.service.invoke('chrome_upload', { profileId: h.a.id, tabId: 7, selector: '#upload', paths: ['C:/synthetic.txt'] }, 'deadline-test', principal, undefined, Date.now() + 50);
  await until(() => entered); await new Promise(resolve => setTimeout(resolve, 70)); release();
  assert.equal((await pending).error?.code, 'REMOTE_REQUEST_EXPIRED'); assert.ok(!h.hits.some(value => value.endsWith('page.upload')));
});
