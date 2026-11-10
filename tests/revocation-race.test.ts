import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { fixture, fakeProfile } from './helpers.js';

test('撤销完成后未接收完正文的旧请求不再派发，新请求也被拒绝', async () => {
  const f = await fixture(); const hits: string[] = [];
  try {
    const p = await fakeProfile(f.config, 'isolated', command => { hits.push(command.operation); return {}; });
    const grant = f.service.state.createClient('writer', [p.id]);
    const base = `http://127.0.0.1:${f.config.port}`;
    const payload = JSON.stringify({ name: 'chrome_evaluate', args: { profileId: p.id, tabId: 7, expression: 'fixture' }, owner: 'held-body' });
    let signal!: () => void;
    const authenticated = new Promise<void>(resolve => { signal = resolve; });
    const authenticate = f.service.state.authenticate.bind(f.service.state);
    f.service.state.authenticate = token => { const principal = authenticate(token); if (token === grant.token && principal) signal(); return principal; };
    let pending!: ReturnType<typeof request>;
    const response = new Promise<any>((resolve, reject) => {
      pending = request(base + '/rpc', { method: 'POST', headers: { authorization: `Bearer ${grant.token}`, 'content-length': Buffer.byteLength(payload) } }, res => {
        let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve(JSON.parse(body)));
      }); pending.on('error', reject); pending.flushHeaders();
    });
    await authenticated;
    assert.equal((await fetch(base + '/clients/' + grant.id, { method: 'DELETE', headers: { authorization: `Bearer ${f.config.token}` } })).status, 200);
    pending.end(payload);
    const result = await response;
    assert.equal(result.ok, false); assert.equal(result.error.code, 'CLIENT_AUTHORIZATION_FAILED'); assert.deepEqual(hits, []);
    assert.equal((await fetch(base + '/rpc', { method: 'POST', headers: { authorization: `Bearer ${grant.token}` }, body: payload })).status, 401);
  } finally { await f.cleanup(); }
});
