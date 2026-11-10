import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { fixture, fakeProfile } from './helpers.js';
import { bridgeToken } from '../src/auth.js';

test('扩展只能读取自己的远程连接摘要，配对密钥仍不能管理或取得全机凭据', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const a = await fakeProfile(f.config, '个人'), b = await fakeProfile(f.config, '工作');
  const secret = randomBytes(32).toString('hex');
  await f.remote.configure({ enabled: false, url: 'https://server.example:18443', token: secret, profiles: [a.id], readOnly: true });
  const origin = `chrome-extension://${'a'.repeat(32)}`;
  const get = (id: string, instanceId: string, auth = bridgeToken(f.config), source = origin, method = 'GET') => fetch(`http://127.0.0.1:${f.config.port}/extension/remote-status?profileId=${id}&instanceId=${instanceId}`, { method, headers: { authorization: `Bearer ${auth}`, origin: source } });
  const instance = f.service.broker.profiles.get(a.id)!.info.instanceId;
  const r = await get(a.id, instance); assert.equal(r.status, 200); assert.equal(r.headers.get('access-control-allow-origin'), origin);
  const value = await r.json(); assert.equal(value.allowed, true); assert.equal(value.readOnly, true); assert.equal(value.url, 'https://server.example:18443');
  const serialized = JSON.stringify(value); for (const credential of [secret, f.config.token, bridgeToken(f.config)]) assert.ok(!serialized.includes(credential));
  assert.ok(!('profiles' in value)); assert.ok(!('token' in value));
  assert.equal((await get(a.id, randomUUID())).status, 403); assert.equal((await get(b.id, instance)).status, 403);
  assert.equal((await get(a.id, instance, 'wrong')).status, 401); assert.equal((await get(a.id, instance, f.config.token)).status, 401);
  assert.equal((await get(a.id, instance, bridgeToken(f.config), 'https://evil.invalid')).status, 403);
  assert.equal((await get(a.id, instance, bridgeToken(f.config), origin, 'POST')).status, 405);
  for (const route of ['/remote', '/clients', '/diagnostics']) assert.equal((await fetch(`http://127.0.0.1:${f.config.port}${route}`, { headers: { authorization: `Bearer ${bridgeToken(f.config)}` } })).status, 401);
  const preflight = await fetch(`http://127.0.0.1:${f.config.port}/extension/remote-status`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
});
