import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixture, fakeProfile, freePort } from './helpers.js';
import { startGateway } from '../src/remote-gateway.js';

// 远程业务收据按 [服务器 origin, 电脑 deviceId, Agent id] 隔离：同一个 submissionId 在不同服务器、电脑或 Agent 下
// 是互不相干的提交，不能返回对方的任务，也不能被误报为遗留收据或冲突。

async function until(predicate: () => boolean, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const identity = (deviceId: string) => ({ id: randomUUID(), label: 'agent', token: randomBytes(32).toString('hex'), deviceId, profiles: '*' as const, readOnly: false });
const newDevice = () => ({ id: randomUUID(), label: '测试电脑', token: randomBytes(32).toString('hex') });
async function mcp(port: number, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const sdk = new Client({ name: 'receipt-isolation', version: '1' }); await sdk.connect(transport);
  return { sdk, async close() { await transport.terminateSession().catch(() => {}); await sdk.close(); } };
}
async function harness(t: { after: (callback: () => Promise<void>) => void }) {
  const f = await fixture(), cleanups: Array<() => Promise<void>> = [];
  let writes = 0;
  const profile = await fakeProfile(f.config, 'receipt', command => { if (command.operation === 'tabs.list') return [{ tabId: 7 }]; if (command.operation === 'page.evaluate') writes++; return {}; });
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); await f.cleanup(); });
  const gateway = async (config: { port: number; devices: ReturnType<typeof newDevice>[]; agents: ReturnType<typeof identity>[] }) => {
    const running = await startGateway({ host: '127.0.0.1', ...config }); let closed = false;
    const close = async () => { if (!closed) { closed = true; await running.close(); } };
    cleanups.push(close); return { close };
  };
  const connect = async (port: number, device: ReturnType<typeof newDevice>) => {
    const connectedAt = f.remote.status().connectedAt;
    await f.remote.configure({ enabled: true, url: `http://127.0.0.1:${port}`, token: device.token, profiles: '*', readOnly: false });
    await until(() => f.remote.status().state === 'connected' && f.remote.status().connectedAt !== connectedAt);
  };
  const args = (submissionId: string) => ({ profileId: profile.id, tabId: 7, name: 'one business intent', submissionId, captureOnFailure: false, steps: [{ operation: 'page.evaluate', args: { expression: 'fixture counter' } }] });
  const submit = async (port: number, agent: { token: string }, submissionId: string) => {
    const client = await mcp(port, agent.token); cleanups.push(() => client.close());
    const result = (await client.sdk.callTool({ name: 'chrome_task_submit', arguments: args(submissionId) })).structuredContent as any;
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.data.deduplicated) await until(() => f.service.tasks.get(profile.id, result.data.id).status === 'succeeded');
    return result.data as { id: string; deduplicated?: boolean };
  };
  return { f, gateway, connect, submit, writes: () => writes };
}

test('同一 submissionId 经不同 Agent 提交是各自独立的任务，同一 Agent 重复提交才返回原任务', async t => {
  const h = await harness(t), port = await freePort(), device = newDevice(), first = identity(device.id), second = identity(device.id), submission = randomUUID();
  await h.gateway({ port, devices: [device], agents: [first, second] }); await h.connect(port, device);
  const one = await h.submit(port, first, submission), other = await h.submit(port, second, submission);
  assert.notEqual(other.id, one.id); assert.ok(!other.deduplicated); assert.equal(h.writes(), 2);
  const again = await h.submit(port, first, submission);
  assert.equal(again.id, one.id); assert.equal(again.deduplicated, true); assert.equal(h.writes(), 2);
  assert.equal((await h.submit(port, second, submission)).id, other.id);
});

test('同一 submissionId 与同一 Agent id 经不同电脑提交是独立任务（同一服务器地址）', async t => {
  const h = await harness(t), port = await freePort(), submission = randomUUID(), agentId = randomUUID();
  const deviceOne = newDevice(), deviceTwo = newDevice();
  const agentOne = { ...identity(deviceOne.id), id: agentId }, agentTwo = { ...identity(deviceTwo.id), id: agentId };
  const gatewayOne = await h.gateway({ port, devices: [deviceOne], agents: [agentOne] }); await h.connect(port, deviceOne);
  const one = await h.submit(port, agentOne, submission);
  await gatewayOne.close();
  await h.gateway({ port, devices: [deviceTwo], agents: [agentTwo] }); await h.connect(port, deviceTwo);
  const two = await h.submit(port, agentTwo, submission);
  assert.notEqual(two.id, one.id); assert.ok(!two.deduplicated); assert.equal(h.writes(), 2);
});

test('同一 submissionId 与同一电脑、Agent id 经不同服务器提交是独立任务；回到原服务器仍返回原任务', async t => {
  const h = await harness(t), submission = randomUUID(), device = newDevice(), agent = identity(device.id);
  const portOne = await freePort(), portTwo = await freePort();
  await h.gateway({ port: portOne, devices: [device], agents: [agent] }); await h.gateway({ port: portTwo, devices: [device], agents: [agent] });
  await h.connect(portOne, device);
  const one = await h.submit(portOne, agent, submission);
  await h.connect(portTwo, device);
  const two = await h.submit(portTwo, agent, submission);
  assert.notEqual(two.id, one.id); assert.ok(!two.deduplicated); assert.equal(h.writes(), 2);
  // 回到原服务器（连接实例已变化）：收据按稳定身份匹配，而不是按连接代际，所以仍是原任务且不重复执行。
  await h.connect(portOne, device);
  const back = await h.submit(portOne, agent, submission);
  assert.equal(back.id, one.id); assert.equal(back.deduplicated, true); assert.equal(h.writes(), 2);
});

test('遗留远程收据只拦截同一 Agent、同一配置、同一 submissionId，其余提交照常受理', async () => {
  const f = await fixture();
  try {
    const profiles = [randomUUID(), randomUUID()] as const;
    for (const id of profiles) await fakeProfile(f.config, id, command => command.operation === 'tabs.list' ? [{ tabId: 1 }] : {}, id);
    const agentX = randomUUID(), agentY = randomUUID(), submission = randomUUID();
    // 旧版收据以连接实例命名：remote:<实例>:<agent>。
    f.service.state.saveNewTask({ id: randomUUID(), profileId: profiles[0], status: 'succeeded', updatedAt: new Date().toISOString() }, { principalId: `remote:${randomUUID()}:${agentX}`, id: submission, fingerprint: 'old' });
    // 任务每一步都会重新核对创建者授权，所以主体要像远程连接器那样登记。
    const principal = (agentId: string) => {
      const value = { id: `remote:${randomUUID()}:${agentId}`, submissionScope: `remote-submission:${agentId}`, remoteAgentId: agentId, label: 'test', profiles: '*' as const, admin: false, readOnly: false };
      f.service.state.remotePrincipals.set(value.id, value); return value;
    };
    const submit = (profile: string, agentId: string, id = submission) => f.service.tasks.submit(profile, 1, { name: 'legacy', steps: [{ operation: 'page.evaluate', args: { expression: 'one' } }] }, principal(agentId), undefined, id);
    assert.throws(() => submit(profiles[0], agentX), { code: 'TASK_SUBMISSION_LEGACY' });
    const accepted = [submit(profiles[0], agentY), submit(profiles[1], agentX), submit(profiles[0], agentX, randomUUID())];
    assert.equal(new Set(accepted.map(task => task.id)).size, 3); assert.ok(accepted.every(task => !(task as { deduplicated?: boolean }).deduplicated));
    await until(() => accepted.every(task => f.service.tasks.get(task.profileId, task.id).status === 'succeeded'));
  } finally { await f.cleanup(); }
});
