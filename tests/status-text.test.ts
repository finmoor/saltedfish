import test from 'node:test';
import assert from 'node:assert/strict';
import { controlText, desktopText, statusText } from '../src/status-text.js';

const now = Date.parse('2026-11-24T10:00:00.000Z');
const running = (extra: object = {}) => ({ role: 'local', state: 'running', version: '0.3.31', pid: 4242, startedAt: '2026-11-24T09:48:00.000Z', busy: false, resources: { profiles: 1, agentSessions: 2 }, ...extra });
const report = (services: object[], extra: object = {}) => ({ packageVersion: '0.3.31', active: { version: '0.3.31' }, services, hints: [], ...extra }) as any;

test('status 在终端里先说服务和地址，再说连着什么，最后告诉人怎么拿 JSON', () => {
  const text = statusText(report([running({ busy: true })]), { address: 'http://127.0.0.1:17422', now });
  assert.equal(text.split('\n')[0], 'SaltedFish 服务 0.3.31 运行中（PID 4242，12 分钟前启动）');
  assert.match(text, /地址：http:\/\/127\.0\.0\.1:17422/); assert.match(text, /浏览器：1 个连着 · Agent：2 个会话 · 有操作正在进行/);
  assert.doesNotMatch(text, /要处理的|提示：/); assert.match(text, /saltedfish status > saltedfish-status\.json$/);
  assert.doesNotMatch(text, /[{}]/, '终端里不出现 JSON');
});

test('停着的服务说明是不是手动停的；旧网关停着就不提', () => {
  const text = statusText(report([{ role: 'local', state: 'stopped', stoppedExplicitly: true }, { role: 'gateway', state: 'stopped' }], { active: null }), { now });
  assert.match(text, /^SaltedFish 服务没在运行（上次是手动停的）。要用时运行 saltedfish start。/); assert.doesNotMatch(text, /网关/);
  assert.match(statusText(report([{ role: 'local', state: 'crashed' }]), { now }), /意外退出了.*saltedfish logs/);
  assert.match(statusText(report([running(), { role: 'gateway', state: 'running', pid: 7, version: '0.3.31' }]), { now }), /旧网关服务 0\.3\.31 运行中/);
});

test('命令行和服务版本不同时给出换版本的命令；服务端提示原样列出', () => {
  const text = statusText(report([running({ version: '0.3.30' })], { active: { version: '0.3.30' }, hints: ['扩展需要更新'] }), { now });
  assert.match(text, /命令行是 0\.3\.31，服务运行的是 0\.3\.30。要换成 0\.3\.31，运行 saltedfish upgrade --no-fetch。/);
  assert.match(text, /提示：\n· 扩展需要更新/);
});

test('doctor 多查浏览器和 Agent 有没有连上，每条都给下一步', () => {
  const empty = statusText(report([running({ resources: { profiles: 0, agentSessions: 0 } })]), { doctor: true, now });
  assert.match(empty, /要处理的：/); assert.match(empty, /没有浏览器连着：.*继续连接.*saltedfish dashboard/); assert.match(empty, /现在没有 Agent 连着：.*saltedfish connect/);
  assert.match(empty, /saltedfish doctor > saltedfish-status\.json$/);
  assert.match(statusText(report([running()]), { doctor: true, now }), /没发现问题。/);
  assert.match(statusText(report([{ role: 'local', state: 'crashed' }]), { doctor: true, now }), /服务没在运行：运行 saltedfish start/);
  assert.match(statusText(report([{ role: 'local', state: 'stopped', stoppedExplicitly: true }], { active: null }), { doctor: true, now }), /没发现问题。/, '手动停的不算问题');
});

test('start、stop、restart 只说结果和下一步', () => {
  assert.equal(controlText('stop', { role: 'local', state: 'stopped' }), 'SaltedFish 已停止。Agent 不会自动把它拉起来，要用时运行 saltedfish start。');
  assert.equal(controlText('start', running(), 'http://127.0.0.1:17422'), 'SaltedFish 0.3.31 已启动（PID 4242）。\n地址：http://127.0.0.1:17422');
  assert.match(controlText('restart', running()), /已重启（PID 4242）。\n管理页的登录随重启失效/);
  assert.match(controlText('start', { role: 'local', state: 'crashed' }, undefined, now), /意外退出了/, '没起来时照实说');
});

test('desktop register / unregister 的结果', () => {
  assert.match(desktopText('register', { supported: false }), /只有 Windows 有/);
  assert.match(desktopText('register', { supported: true, registered: true }, 2), /已登记.*包括你指定的 2 个扩展目录/);
  assert.match(desktopText('unregister', { supported: true, removed: false, nativeSettings: { removed: true } }), /已移除/);
  assert.match(desktopText('unregister', { supported: true, removed: false, nativeSettings: { removed: false } }), /没有登记过/);
});
