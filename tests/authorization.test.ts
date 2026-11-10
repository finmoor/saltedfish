import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, fakeProfile } from './helpers.js';
import { bridgeToken } from '../src/auth.js';

test('扩展配对密钥不能调用控制 API，客户端密钥可单独撤销', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const base = `http://127.0.0.1:${f.config.port}`;
  const payload = JSON.stringify({ name: 'chrome_profiles', args: {}, owner: 'one' });
  assert.equal((await fetch(`${base}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${bridgeToken(f.config)}`, 'content-type': 'application/json' }, body: payload })).status, 401);
  const client = f.service.state.createClient('测试客户端');
  const request = () => fetch(`${base}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${client.token}`, 'content-type': 'application/json' }, body: payload });
  assert.equal((await request()).status, 200);
  f.service.state.revokeClient(client.id);
  assert.equal((await request()).status, 401);
});

test('客户端只能访问指定账号，只读授权拒绝任意 JS 与批量写入', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const a = await fakeProfile(f.config, 'A', () => []); const b = await fakeProfile(f.config, 'B', () => []);
  const key = f.service.state.createClient('只读 A', [a.id], true);
  const principal = f.service.state.authenticate(key.token)!;
  const profiles = await f.service.invoke('chrome_profiles', {}, 'reader', principal);
  assert.deepEqual((profiles.data as { profiles: { id: string }[] }).profiles.map(profile => profile.id), [a.id]);
  assert.equal((await f.service.invoke('chrome_tabs', { profileId: b.id }, 'reader', principal)).error?.code, 'PROFILE_NOT_AUTHORIZED');
  assert.equal((await f.service.invoke('chrome_evaluate', { profileId: a.id, tabId: 1, expression: '1' }, 'reader', principal)).error?.code, 'CLIENT_READ_ONLY');
  assert.equal((await f.service.invoke('chrome_tabs', { profileId: a.id }, 'reader', principal)).ok, true);
});

test('不同客户端使用相同 owner 字符串也不能释放对方占用', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const profile = await fakeProfile(f.config, 'A', () => [{ tabId: 1 }]);
  const a = f.service.state.createClient('A'), b = f.service.state.createClient('B');
  async function call(token: string, name: string) {
    const response = await fetch(`http://127.0.0.1:${f.config.port}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ owner: 'same-name', name, args: { profileId: profile.id, tabId: 1 } }) });
    return await response.json() as { ok: boolean; error?: { code: string } };
  }
  assert.equal((await call(a.token, 'chrome_claim_tab')).ok, true);
  assert.equal((await call(b.token, 'chrome_release_tab')).error?.code, 'TAB_CLAIMED');
});

test('大结果也保持账号授权，结果文件容量不足不把已完成业务标成失败', async t => {
  const f = await fixture(); t.after(() => f.cleanup()); f.config.outputLimit = 50;
  const a = await fakeProfile(f.config, 'A', () => 'secret-A'.repeat(100));
  const b = await fakeProfile(f.config, 'B', () => []);
  const saved = await f.service.invoke('chrome_evaluate', { profileId: a.id, tabId: 1, expression: '1' }, 'admin');
  const key = f.service.state.createClient('B', [b.id]);
  assert.equal((await f.service.invoke('chrome_read_result', { artifactId: (saved.data as { artifactId: string }).artifactId }, 'B', f.service.state.authenticate(key.token)!)).error?.code, 'RESULT_NOT_AUTHORIZED');
  f.config.resultByteLimit = 1;
  const result = await f.service.invoke('chrome_evaluate', { profileId: a.id, tabId: 1, expression: '1' }, 'admin');
  assert.equal(result.ok, true); assert.equal(result.warnings?.[0]?.code, 'RESULT_STORAGE_FAILED');
  assert.equal(f.service.state.get(result.operationId!)?.state, 'succeeded');
});

test('网络事件按字节预算有界，超大事件明确报告省略', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  for (let i = 0; i < 20; i++) f.service.broker.addEvent('A', 1, 'Network.data', { requestId: String(i), data: 'x'.repeat(1000000) });
  const events = f.service.broker.events('A', 1, 0);
  assert.ok(events.bufferedBytes <= 8 * 1024 * 1024);
  f.service.broker.addEvent('A', 1, 'Network.data', { requestId: 'big', data: 'x'.repeat(9000000) });
  const last = f.service.broker.events('A', 1, 0).events.at(-1)!;
  assert.equal(last.params.omitted, true); assert.equal(last.params.requestId, 'big');
});
