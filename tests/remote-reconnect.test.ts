import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixture, fakeProfile, freePort, FAKE_CAPABILITIES } from './helpers.js';
import { startGateway } from '../src/remote-gateway.js';
import { CAPABILITY, type WireCommand } from '../src/shared.js';

// 远程连接自动重连后，网关里的 MCP 会话还在：同一个 Agent 的租约、标签页互斥和弹窗归属必须跟着“Agent + 会话”走，而不是跟着本次连接的 instanceId。
// 不同 Agent（以及同一 Agent 的不同会话）之间仍然互斥；旧连接的任务尾部仍不能派给新连接；本机管理员总能越过远程 Agent 的租约。
async function until(predicate: () => boolean | Promise<boolean>, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() >= deadline) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const call = async (sdk: Client, name: string, args: Record<string, unknown> = {}) => (await sdk.callTool({ name, arguments: args })).structuredContent as any;

async function harness(t: { after: (callback: () => Promise<void>) => void }) {
  const f = await fixture(), cleanups: Array<() => Promise<void>> = [];
  const device = { id: randomUUID(), label: '测试电脑', token: randomBytes(32).toString('hex') };
  const identity = (label: string) => ({ id: randomUUID(), label, token: randomBytes(32).toString('hex'), deviceId: device.id, profiles: '*' as const, readOnly: false });
  const agentIdentity = identity('Claude'), otherIdentity = identity('OpenCode');
  const gateway = await startGateway({ host: '127.0.0.1', port: await freePort(), devices: [device], agents: [agentIdentity, otherIdentity] });
  const url = `http://127.0.0.1:${gateway.config.port}`;
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); await gateway.close(); await f.cleanup(); });
  const behaviour = { evaluate: (_command: WireCommand): unknown => ({}), dialog: (_command: WireCommand): unknown => ({}) };
  const profile = await fakeProfile(f.config, '个人', command => {
    if (command.operation === 'tabs.list') return [{ tabId: 7 }, { tabId: 9 }];
    if (command.operation === 'page.evaluate') return behaviour.evaluate(command);
    if (command.operation === 'page.dialog') return behaviour.dialog(command);
    return {};
  }, undefined, { capabilities: [...FAKE_CAPABILITIES, CAPABILITY.dialogControl] });
  await f.remote.configure({ enabled: true, url, token: device.token, profiles: '*', readOnly: false });
  await until(() => f.remote.status().state === 'connected');
  const connect = async (token: string) => {
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
    const sdk = new Client({ name: 'remote-reconnect', version: '1' }); await sdk.connect(transport);
    cleanups.push(async () => { await transport.terminateSession().catch(() => {}); await sdk.close(); });
    return sdk;
  };
  const reconnect = async () => {
    const connectedAt = f.remote.status().connectedAt;
    (f.remote as unknown as { socket: WebSocket }).socket.terminate();
    await until(() => f.remote.status().state === 'connected' && f.remote.status().connectedAt !== connectedAt);
  };
  return { f, profile, behaviour, connect, reconnect, target: { profileId: profile.id, tabId: 7 }, agentToken: agentIdentity.token, agent: await connect(agentIdentity.token), other: await connect(otherIdentity.token) };
}

test('自动重连后，同一个 Agent 会话仍能写入、释放、重新占用自己占用的标签页；其他 Agent 和同一 Agent 的其他会话始终被互斥', async t => {
  const h = await harness(t), sibling = await h.connect(h.agentToken);
  assert.equal((await call(h.agent, 'chrome_claim_tab', { ...h.target, seconds: 600 })).ok, true);
  const excluded = async (when: string) => {
    for (const [who, sdk] of [['其他 Agent', h.other], ['同一 Agent 的另一个会话', sibling]] as const) {
      assert.equal((await call(sdk, 'chrome_claim_tab', h.target)).error?.code, 'TAB_CLAIMED', `${when}：${who}不能抢占`);
      assert.equal((await call(sdk, 'chrome_evaluate', { ...h.target, expression: '1' })).error?.code, 'TAB_CLAIMED', `${when}：${who}不能写`);
      assert.equal((await call(sdk, 'chrome_release_tab', h.target)).error?.code, 'TAB_CLAIMED', `${when}：${who}不能替别人释放`);
    }
  };
  await excluded('重连前');
  await h.reconnect();
  const write = await call(h.agent, 'chrome_evaluate', { ...h.target, expression: '1' });
  assert.equal(write.ok, true, `重连后原会话必须还能写自己占用的标签页：${JSON.stringify(write.error)}`);
  await excluded('重连后');
  assert.equal((await call(h.agent, 'chrome_claim_tab', { ...h.target, seconds: 600 })).ok, true, '可以续租');
  assert.equal((await call(h.agent, 'chrome_release_tab', h.target)).ok, true, '可以释放');
  assert.equal((await call(sibling, 'chrome_evaluate', { ...h.target, expression: '1' })).ok, true, '释放后其他会话可以写');
});

test('Agent 触发的弹窗在重连后仍归这个 Agent：它自己能响应，其他 Agent 仍然不能代答', async t => {
  const h = await harness(t); const dialogId = randomUUID(); let release!: () => void, answered = 0;
  h.behaviour.evaluate = command => {
    h.profile.socket.send(JSON.stringify({ type: 'event', tabId: 7, method: 'Page.javascriptDialogOpening', params: { dialogId, commandId: command.id, type: 'alert', message: 'fixture' } }));
    return new Promise<void>(resolve => { release = resolve; });
  };
  h.behaviour.dialog = () => { answered++; h.profile.socket.send(JSON.stringify({ type: 'event', tabId: 7, method: 'Page.javascriptDialogClosed', params: {} })); release(); return { handled: true }; };
  const triggered = call(h.agent, 'chrome_evaluate', { ...h.target, expression: 'alert()' });
  await until(() => h.f.service.broker.stats().openDialogs === 1);
  await h.reconnect();
  assert.equal((await triggered).error?.code, 'REMOTE_RESULT_UNKNOWN', '重连时在途请求按未知结果返回，不会重放');
  assert.equal((await call(h.other, 'chrome_dialog', { ...h.target, accept: false })).error?.code, 'DIALOG_NOT_AUTHORIZED');
  assert.equal(answered, 0);
  const own = await call(h.agent, 'chrome_dialog', { ...h.target, accept: false });
  assert.equal(own.ok, true, `重连后触发弹窗的 Agent 仍能响应：${JSON.stringify(own.error)}`); assert.equal(answered, 1);
});

test('本机管理员可以越过远程 Agent 的租约（释放、解除标签页保护、确认标签页上的未知操作）；本机普通客户端仍然不行', async t => {
  const h = await harness(t);
  assert.equal((await call(h.agent, 'chrome_claim_tab', { ...h.target, seconds: 600 })).ok, true);
  const stranger = h.f.service.state.authenticate(h.f.service.state.createClient('本机客户端').token)!;
  const asClient = (name: string, args: Record<string, unknown>) => h.f.service.invoke(name, args, `${stranger.id}:x`, stranger);
  assert.equal((await asClient('chrome_release_tab', h.target)).error?.code, 'TAB_CLAIMED', '本机普通客户端不能替远程 Agent 释放');
  assert.equal((await asClient('chrome_recover_tab', h.target)).error?.code, 'TAB_CLAIMED');
  // 标签页上有一条未知操作：管理员的“解除保护”不应被远程 Agent 的租约挡住
  const lost = h.f.service.state.begin(h.profile.id, 7, 'remote-owner', 'chrome_evaluate'); h.f.service.state.finish(lost, 'unknown', 'COMMAND_TIMEOUT');
  const confirmed = await h.f.service.invoke('chrome_recover_operation', { operationId: lost, acknowledged: true }, 'dashboard:test');
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed.error)); assert.equal(h.f.service.state.protection().unknown, 0);
  assert.equal((await h.f.service.invoke('chrome_recover_tab', h.target, 'dashboard:test')).ok, true);
  // 管理员强制释放；被释放的 Agent 随后看到的是普通的“没有租约”
  const released = await h.f.service.invoke('chrome_release_tab', h.target, 'dashboard:test');
  assert.equal(released.ok, true); assert.deepEqual(released.data, { released: true, takenOver: true });
  assert.equal((await call(h.other, 'chrome_claim_tab', h.target)).ok, true, '释放后其他 Agent 可以占用');
});

test('任务收尾时的释放只释放任务自己的租约：即使以管理员身份调用，也不会删掉别人占用的远程租约', async t => {
  const h = await harness(t);
  assert.equal((await call(h.agent, 'chrome_claim_tab', { ...h.target, seconds: 600 })).ok, true);
  const taskOwner = `admin:task:${randomUUID()}`;
  assert.equal((await h.f.service.invoke('chrome_release_tab', h.target, taskOwner)).error?.code, 'TAB_CLAIMED', '任务收尾不能接管远程租约');
  assert.equal((await call(h.other, 'chrome_claim_tab', h.target)).error?.code, 'TAB_CLAIMED', '远程 Agent 的租约还在');
  assert.equal((await h.f.service.invoke('chrome_release_tab', h.target, 'dashboard:operator')).ok, true, '管理员本人的显式释放才可以接管');
});

test('本机调用方之间的租约仍然互斥：管理员也不能替另一个本机会话释放（只有远程 Agent 的租约可以被管理员接管）', async t => {
  const h = await harness(t);
  assert.equal((await h.f.service.invoke('chrome_claim_tab', h.target, 'local-one')).ok, true);
  assert.equal((await h.f.service.invoke('chrome_release_tab', h.target, 'local-two')).error?.code, 'TAB_CLAIMED');
  assert.equal((await h.f.service.invoke('chrome_recover_tab', h.target, 'local-two')).error?.code, 'TAB_CLAIMED');
  assert.equal((await h.f.service.invoke('chrome_release_tab', h.target, 'local-one')).ok, true);
});

test('自动重连后旧连接提交的任务尾部仍不会继续派发（授权跟着连接走，只有租约身份是稳定的）', async t => {
  const h = await harness(t); let finish!: () => void, started = false, evaluations = 0;
  h.behaviour.evaluate = async () => { evaluations++; if (evaluations === 1) { started = true; await new Promise<void>(resolve => { finish = resolve; }); } return {}; };
  const submitted = await call(h.agent, 'chrome_task_submit', { profileId: h.profile.id, tabId: 9, name: 'remote sequence', visible: false, captureOnFailure: false, steps: [{ operation: 'page.evaluate', args: { expression: '1' } }, { operation: 'page.evaluate', args: { expression: '2' } }] });
  assert.equal(submitted.ok, true, JSON.stringify(submitted.error)); await until(() => started);
  await h.reconnect(); finish();
  await until(() => h.f.service.tasks.stats().activeTaskProfiles === 0);
  assert.equal(evaluations, 1, '第二步没有派发'); assert.notEqual(h.f.service.tasks.get(h.profile.id, submitted.data.id).status, 'succeeded');
  assert.equal(h.f.service.broker.stats().leases, 0, '任务释放了自己的租约');
});

test('远程结果配额按稳定身份计：同一连接内、以及重连之后，同一个 Agent 保存的结果合计受单主体上限约束', async t => {
  const h = await harness(t);
  h.f.config.resultByteLimit = 1_000_000; h.f.config.outputLimit = 50; // 单个主体 250000；每个结果约 100002 字节，第三个会超
  h.behaviour.evaluate = () => 'x'.repeat(100000);
  const save = async () => { const result = await call(h.agent, 'chrome_evaluate', { ...h.target, expression: '1' }); assert.equal(result.ok, true, '业务动作本身成功'); return result; };
  const stored = (result: any) => result.data?.saved === true;
  assert.ok(stored(await save())); assert.ok(stored(await save()));
  const over = await save();
  assert.ok(!stored(over), '同一连接内第三个结果超出单主体上限'); assert.equal(over.warnings?.[0]?.code, 'RESULT_STORAGE_FAILED');
  await h.reconnect();
  const again = await save();
  assert.ok(!stored(again), '重连不能让配额归零'); assert.equal(again.warnings?.[0]?.code, 'RESULT_STORAGE_FAILED');
  assert.ok(stored(await call(h.other, 'chrome_evaluate', { ...h.target, expression: '1' })), '其他 Agent 不受影响');
});
