import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { fixture, fakeProfile, freePort } from './helpers.js';
import { bridgeToken, bridgeProof } from '../src/auth.js';
import { BRIDGE_PROTOCOL, type JsonObject } from '../src/shared.js';
import { BridgeHandshake, bridgeProof as extensionProof, newNonce, type BridgeStep } from '../extension/bridge-auth.js';
import type { Config } from '../src/config.js';

// 扩展桥接握手 v2：双向挑战应答，配对密钥从不在线上明文传输；鉴权前的连接数、帧大小和字段长度都有上限。
const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const url = (config: Config) => `ws://127.0.0.1:${config.port}/bridge`;
const profileOf = (extra: JsonObject = {}) => ({ id: randomUUID(), label: '握手测试', instanceId: randomUUID(), version: 'test', userAgent: 'test', capabilities: ['admin-origin-v1'], ...extra });
const next = (socket: WebSocket) => once(socket, 'message').then(([raw]) => JSON.parse(String(raw)) as JsonObject);
const closed = (socket: WebSocket) => socket.readyState === WebSocket.CLOSED ? Promise.resolve() : once(socket, 'close').then(() => undefined);

// 用扩展里真正的握手状态机连接真实服务，记录线上出现的每一帧。
async function extensionConnect(config: Config, token: string, profile = profileOf()) {
  const socket = new WebSocket(url(config), { origin: ORIGIN }); socket.on('error', () => {});
  await once(socket, 'open');
  const wire: { dir: 'out' | 'in'; text: string }[] = [], bridge = new BridgeHandshake(token, profile);
  const send = (text: string) => { wire.push({ dir: 'out', text }); socket.send(text); };
  send(bridge.hello());
  let step: BridgeStep;
  for (;;) {
    const raw = await once(socket, 'message').then(([data]) => String(data)); wire.push({ dir: 'in', text: raw });
    step = await bridge.receive(JSON.parse(raw) as JsonObject);
    if (step.kind !== 'send') break;
    send(step.frame);
  }
  return { socket, step, wire, bridge, profile };
}

test('v2 握手端到端：扩展的状态机与真实服务互相证明，线上没有配对密钥，服务登记浏览器并公布 admin-origin-v1', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const token = bridgeToken(f.config), run = await extensionConnect(f.config, token); t.after(() => run.socket.close());
  assert.equal(run.step.kind, 'ready'); assert.equal(run.bridge.ready, true);
  assert.ok((run.step as Extract<BridgeStep, { kind: 'ready' }>).capabilities.includes('admin-origin-v1'));
  assert.deepEqual(f.service.broker.listProfiles().map(profile => profile.id), [run.profile.id]);
  const out = run.wire.filter(frame => frame.dir === 'out').map(frame => JSON.parse(frame.text) as JsonObject);
  assert.deepEqual(out.map(frame => frame.type), ['hello', 'auth']);
  assert.equal(out[0]!.protocol, BRIDGE_PROTOCOL); assert.match(String(out[0]!.nonce), /^[a-f0-9]{32}$/);
  assert.equal(out[0]!.token, undefined); assert.equal(out[0]!.profile, undefined, '第一帧不带身份，也不带密钥');
  assert.match(String(out[1]!.proof), /^[a-f0-9]{64}$/);
  const everything = run.wire.map(frame => frame.text).join('\n');
  for (const secret of [token, f.config.token]) assert.ok(!everything.includes(secret), '配对密钥和管理员密钥都不在线上');
  // 扩展(WebCrypto)和服务(node:crypto)算出的证明一致
  assert.equal(await extensionProof(token, 'client', 'a'.repeat(32), 'b'.repeat(32), 'p', 'i'), bridgeProof(token, 'client', 'a'.repeat(32), 'b'.repeat(32), 'p', 'i'));
  assert.equal(await extensionProof(token, 'server', 'a'.repeat(32), 'b'.repeat(32)), bridgeProof(token, 'server', 'a'.repeat(32), 'b'.repeat(32)));
  assert.notEqual(bridgeProof(token, 'server', 'a'.repeat(32), 'b'.repeat(32)), bridgeProof(token, 'client', 'a'.repeat(32), 'b'.repeat(32)), '两个方向的证明不能互相替代');
});

test('扩展先核对服务的证明：密钥不符的服务（同端口的其他程序、被替换的配对文件）得不到身份，扩展不发送 auth', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const wrong = await extensionConnect(f.config, 'wrong'.repeat(13)); t.after(() => wrong.socket.close());
  assert.equal(wrong.step.kind, 'fail'); assert.match((wrong.step as { message: string }).message, /没有发送任何密钥/);
  assert.deepEqual(wrong.wire.filter(frame => frame.dir === 'out').map(frame => JSON.parse(frame.text).type), ['hello'], '只发出了 hello');
  assert.equal(f.service.broker.listProfiles().length, 0);
  // 伪造服务：随便回一个挑战
  const rogue = new WebSocketServer({ port: await freePort(), host: '127.0.0.1' }); t.after(() => rogue.close()); await once(rogue, 'listening');
  const received: JsonObject[] = [];
  rogue.on('connection', socket => socket.on('message', raw => { received.push(JSON.parse(String(raw))); socket.send(JSON.stringify({ type: 'challenge', nonce: randomBytes(16).toString('hex'), proof: randomBytes(32).toString('hex') })); }));
  const client = new WebSocket(`ws://127.0.0.1:${(rogue.address() as { port: number }).port}/bridge`); client.on('error', () => {}); await once(client, 'open');
  const bridge = new BridgeHandshake(bridgeToken(f.config), profileOf()); client.send(bridge.hello());
  const step = await bridge.receive(await next(client));
  assert.equal(step.kind, 'fail'); assert.deepEqual(received.map(frame => frame.type), ['hello']); client.close();
  // 重放别的连接里截获的有效证明也不行（证明绑定双方的随机数）
  const token = bridgeToken(f.config), captured = bridgeProof(token, 'server', 'c'.repeat(32), 'd'.repeat(32));
  const replay = new BridgeHandshake(token, profileOf());
  assert.equal((await replay.receive({ type: 'challenge', nonce: 'd'.repeat(32), proof: captured })).kind, 'fail');
  // 格式不对的挑战
  assert.equal((await new BridgeHandshake(token, profileOf()).receive({ type: 'challenge', nonce: 'short', proof: 'x' })).kind, 'fail');
  assert.equal((await new BridgeHandshake(token, profileOf()).receive({ type: 'ready', capabilities: [] })).kind, 'fail', '没有挑战就收到 ready');
});

test('服务端核对扩展的证明：错误密钥、管理员密钥、换身份复用证明都不能登记', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const attempt = async (token: string, mutate?: (frame: JsonObject) => void) => {
    const socket = new WebSocket(url(f.config), { origin: ORIGIN }); socket.on('error', () => {}); await once(socket, 'open');
    const nonce = newNonce(), instance = randomUUID(), profile = profileOf({ instanceId: instance });
    const challenge = next(socket); socket.send(JSON.stringify({ type: 'hello', protocol: BRIDGE_PROTOCOL, nonce }));
    const serverNonce = String((await challenge).nonce);
    const frame: JsonObject = { type: 'auth', proof: bridgeProof(token, 'client', nonce, serverNonce, String(profile.id), instance), profile };
    mutate?.(frame);
    const reply = next(socket); socket.send(JSON.stringify(frame)); const result = await reply; socket.close(); await closed(socket); return result;
  };
  assert.equal((await attempt(bridgeToken(f.config))).type, 'ready');
  assert.equal((await attempt('wrong'.repeat(13))).type, 'rejected');
  assert.equal((await attempt(f.config.token)).type, 'rejected', '管理员密钥不能用于扩展连接');
  assert.equal((await attempt(bridgeToken(f.config), frame => { (frame.profile as JsonObject).id = randomUUID(); })).type, 'rejected', '证明绑定了身份，换一个配置 ID 就不成立');
  assert.equal((await attempt(bridgeToken(f.config), frame => { (frame.profile as JsonObject).label = '改名'; })).type, 'ready', '标签不在证明范围内，改名不影响');
});

test('旧版明文 hello 被明确拒绝并提示刷新扩展，浏览器没有被登记；新扩展遇到旧服务也得到能指导恢复的说明', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const socket = new WebSocket(url(f.config), { origin: ORIGIN }); socket.on('error', () => {}); await once(socket, 'open');
  const reply = next(socket);
  socket.send(JSON.stringify({ type: 'hello', token: bridgeToken(f.config), profile: profileOf() }));
  const rejected = await reply;
  assert.equal(rejected.type, 'rejected'); assert.equal(rejected.code, 'EXTENSION_UPDATE_REQUIRED'); assert.match(String(rejected.message), /刷新/); assert.match(String(rejected.message), /chrome:\/\/extensions/);
  await closed(socket);
  assert.equal(f.service.broker.listProfiles().length, 0, '即使密钥正确，旧握手也不登记');
  // 新扩展 → 旧服务：服务没有 challenge 就直接拒绝
  const bridge = new BridgeHandshake(bridgeToken(f.config), profileOf());
  const step = await bridge.receive({ type: 'rejected', message: 'Invalid input: expected string, received undefined' });
  assert.equal(step.kind, 'rejected'); assert.match((step as { message: string }).message, /服务版本较旧|版本较旧/); assert.match((step as { message: string }).message, /Invalid input/);
  const known = await new BridgeHandshake(bridgeToken(f.config), profileOf()).receive({ type: 'rejected', code: 'EXTENSION_UPDATE_REQUIRED', message: '原样显示' });
  assert.deepEqual(known, { kind: 'rejected', message: '原样显示' });
});

test('鉴权前的限制：帧大小累计 16 KiB，鉴权后放宽；字段长度和阶段顺序都被校验', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  // 完全合法的握手；多余的 pad 字段会被 zod 忽略。这样“被断开”只可能来自鉴权前的字节上限，“被拒绝”只可能来自被测的字段校验。
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const token = bridgeToken(f.config);
  const session = async (pad: { hello?: number; auth?: number } = {}, profile = profileOf(), proofOverride?: string) => {
    const socket = new WebSocket(url(f.config), { origin: ORIGIN }); socket.on('error', () => {}); await once(socket, 'open');
    const frames: JsonObject[] = []; socket.on('message', raw => frames.push(JSON.parse(String(raw))));
    const nonce = newNonce();
    const outcome = async (type: string) => { for (let i = 0; i < 200 && socket.readyState !== WebSocket.CLOSED && !frames.some(frame => frame.type === type || frame.type === 'rejected'); i++) await sleep(10); return frames.find(frame => frame.type === type || frame.type === 'rejected')?.type as string | undefined; };
    socket.send(JSON.stringify({ type: 'hello', protocol: BRIDGE_PROTOCOL, nonce, ...(pad.hello ? { pad: 'x'.repeat(pad.hello) } : {}) }));
    if (await outcome('challenge') !== 'challenge') { const result = frames.find(frame => frame.type === 'rejected') ? 'rejected' : 'closed'; socket.close(); await closed(socket); return result; }
    const serverNonce = String(frames.find(frame => frame.type === 'challenge')!.nonce);
    socket.send(JSON.stringify({ type: 'auth', proof: proofOverride ?? bridgeProof(token, 'client', nonce, serverNonce, String(profile.id), String(profile.instanceId)), profile, ...(pad.auth ? { pad: 'x'.repeat(pad.auth) } : {}) }));
    const result = (await outcome('ready')) ?? 'closed'; socket.close(); await closed(socket); return result;
  };
  assert.equal(await session(), 'ready', '对照：合法握手成功');
  assert.equal(await session({ hello: 9000 }), 'ready', '单帧 9 KiB 在 16 KiB 以内');
  assert.equal(await session({ hello: 20 * 1024 }), 'closed', '鉴权前的单个大帧：连接被断开，服务不处理它');
  assert.equal(await session({ hello: 9000, auth: 9000 }), 'closed', '鉴权前累计超过 16 KiB（不必一帧）：连接被断开，不会 ready');
  // 字段长度：除被测字段外全部合法，所以“被拒绝”只可能来自该字段的校验
  for (const bad of [{ label: 'x'.repeat(101) }, { label: '' }, { version: 'v'.repeat(65) }, { version: '' }, { userAgent: 'u'.repeat(1001) }, { capabilities: Array.from({ length: 31 }, (_, i) => `c${i}`) }, { capabilities: ['c'.repeat(101)] }, { id: 'not-a-uuid' }, { instanceId: 'nope' }])
    assert.equal(await session({}, profileOf(bad)), 'rejected', JSON.stringify(bad).slice(0, 90));
  assert.equal(await session({}, profileOf({ label: 'x'.repeat(100), version: 'v'.repeat(64), userAgent: 'u'.repeat(1000), capabilities: Array.from({ length: 30 }, (_, i) => `c${i}`) })), 'ready', '恰好在上限上的字段被接受');
  assert.equal(await session({}, profileOf(), 'short'), 'rejected', '证明格式不对');
  assert.equal(await session({}, profileOf(), '0'.repeat(64)), 'rejected', '证明格式对但不正确');
  // 阶段顺序：每个阶段只接受该来的那种帧，其余一律拒绝，不登记浏览器
  const exchange = async (frames: JsonObject[]) => {
    const socket = new WebSocket(url(f.config), { origin: ORIGIN }); socket.on('error', () => {}); await once(socket, 'open');
    const answers: JsonObject[] = []; socket.on('message', raw => answers.push(JSON.parse(String(raw))));
    for (const frame of frames) {
      const before = answers.length; socket.send(JSON.stringify(frame));
      for (let i = 0; i < 200 && answers.length === before && socket.readyState === WebSocket.OPEN; i++) await sleep(10);
      if (answers.some(answer => answer.type === 'rejected')) break;
    }
    socket.close(); await closed(socket); return answers.map(answer => String(answer.type));
  };
  const hello = (): JsonObject => ({ type: 'hello', protocol: BRIDGE_PROTOCOL, nonce: newNonce() }), event: JsonObject = { type: 'event', method: 'Network.x', tabId: 1, params: {} };
  assert.deepEqual(await exchange([{ type: 'auth', proof: '0'.repeat(64), profile: profileOf() }]), ['rejected'], '没有 hello 就发 auth');
  assert.deepEqual(await exchange([event]), ['rejected'], '鉴权前的事件帧');
  assert.deepEqual(await exchange([{ type: 'result', id: randomUUID(), result: {} }]), ['rejected'], '鉴权前的结果帧');
  assert.deepEqual(await exchange([{ type: 'hello', protocol: 1, nonce: newNonce() }]), ['rejected'], '协议版本不对');
  assert.deepEqual(await exchange([{ type: 'hello', protocol: BRIDGE_PROTOCOL, nonce: 'short' }]), ['rejected'], 'nonce 格式不对');
  assert.deepEqual(await exchange([hello(), hello()]), ['challenge', 'rejected'], 'challenge 之后再发 hello');
  assert.deepEqual(await exchange([hello(), event]), ['challenge', 'rejected'], 'auth 之前发事件');
  // 鉴权成功以后不再受 16 KiB 限制：2 MiB 的事件帧被接收
  const profile = await fakeProfile(f.config, 'A', undefined, undefined, { verifyServer: true });
  assert.equal(profile.handshake.type, 'ready');
  profile.socket.send(JSON.stringify({ type: 'event', method: 'Network.big', tabId: 1, params: { data: 'x'.repeat(2 * 1024 * 1024) } }));
  for (let i = 0; i < 50 && !f.service.broker.events(profile.id, 1, 0).events.some(event => event.method === 'Network.big'); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(profile.socket.readyState, WebSocket.OPEN); assert.ok(f.service.broker.events(profile.id, 1, 0).events.some(event => event.method === 'Network.big'), '2 MiB 的事件帧在鉴权后被接收');
  profile.socket.close();
});

test('未鉴权连接最多 16 条：占满后第 17 条在升级阶段收到 503，有连接离开后恢复', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const held: WebSocket[] = [];
  for (let i = 0; i < 16; i++) { const socket = new WebSocket(url(f.config), { origin: ORIGIN }); socket.on('error', () => {}); await once(socket, 'open'); held.push(socket); }
  const extra = new WebSocket(url(f.config), { origin: ORIGIN }); extra.on('error', () => {});
  // 没有上限时第 17 条会直接 open；两种结果竞争，这样失败时立刻报错而不是等到测试超时
  const refused = await Promise.race([once(extra, 'unexpected-response').then(([, response]) => { (response as { resume(): void }).resume(); return (response as { statusCode?: number }).statusCode; }), once(extra, 'open').then(() => 'open')]);
  assert.equal(refused, 503, '第 17 条未鉴权连接被拒绝'); extra.close();
  held[0]!.close(); await closed(held[0]!);
  let recovered = false;
  for (let i = 0; i < 40 && !recovered; i++) {
    const probe = new WebSocket(url(f.config), { origin: ORIGIN }); probe.on('error', () => {});
    recovered = await Promise.race([once(probe, 'open').then(() => true), once(probe, 'unexpected-response').then(([, res]) => { (res as { resume(): void }).resume(); return false; })]);
    probe.close(); if (!recovered) await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(recovered, '连接数恢复后可以再握手');
  for (const socket of held.slice(1)) socket.close();
});
