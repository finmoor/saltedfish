import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:net';
import { randomBytes, randomUUID, randomInt } from 'node:crypto';
import { once } from 'node:events';
import {pathToFileURL} from 'node:url';
import { WebSocket } from 'ws';
import { projectDir, type Config } from '../src/config.js';
import { startServer } from '../src/http-server.js';
import { BRIDGE_PROTOCOL, CAPABILITY, EXTENSION_CAPABILITIES, errorInfo, type JsonObject, type WireCommand } from '../src/shared.js';
import { bridgeToken, bridgeProof } from '../src/auth.js';
import {serviceInternalUrl,servicePublicUrl} from '../src/service-network.js';
import {bridgeAddress} from '../src/service-address.js';

export async function freePort(): Promise<number> {
  // 本机 port=0 曾分配 1723，Chrome 拒绝访问；夹具使用高位端口，不改浏览器安全策略。
  for (let attempt = 0; attempt < 50; attempt++) {
    const server = createServer(), port = randomInt(49152, 65536);
    try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
    // Windows 上 49664 起的若干端口被系统服务独占，bind 返回 EACCES 而不是 EADDRINUSE；两者都只是“换一个端口”。
    catch (error) { if (['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) continue; throw error; }
    await new Promise<void>(resolve => server.close(() => resolve())); return port;
  }
  throw new Error('No available high test port');
}
export async function testDirectory() {
  const root = path.join(projectDir, '.local', 'tests'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'run-'));
  return { directory, async cleanup() {
    if (!path.resolve(directory).startsWith(path.resolve(root) + path.sep)) throw new Error('Unsafe cleanup target');
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } };
}
export async function fixture(options: Parameters<typeof startServer>[1] = {},start:typeof startServer=startServer) {
  const temp = await testDirectory();
  const config: Config = { port: await freePort(), token: randomBytes(32).toString('hex'), dataDir: temp.directory, outputLimit: 24000, eventLimit: 100 };
  const app = await start(config, options);
  return { ...app, config, async cleanup() { await app.close(); await temp.cleanup(); } };
}
// 发行门禁中的新直连UI场景也运行候选包的实际服务代码。
export async function unifiedFixture(){
  const start=process.env.PRODUCT_SERVICE_ROOT?(await import(pathToFileURL(path.join(process.env.PRODUCT_SERVICE_ROOT,'dist/http-server.js')).href)).startServer as typeof startServer:startServer;
  return fixture({},(config,options)=>start({...config,directConnections:true},options));
}
// 假扩展：按桥接握手 v2（互相挑战应答）连接。默认不核对服务端证明，这样错误配对密钥的用例仍能走到服务端的拒绝分支；
// 需要验证服务端也持有密钥时传 verifyServer。
// 假扩展声明真扩展的全部能力（src/shared.ts），只去掉三项有意缺省的：dialog-control 会让每条写命令登记弹窗控制者（需要的用例自己加）；activity 只是声明、没有消费方；tab-groups 要真的 Chrome 才有意义。
export const FAKE_CAPABILITIES: string[] = EXTENSION_CAPABILITIES.filter(name => name !== CAPABILITY.dialogControl && name !== CAPABILITY.activity && name !== CAPABILITY.tabGroupsV1);
export async function fakeProfile(config: Config, label: string, handler?: (command: WireCommand) => Promise<unknown> | unknown, id = randomUUID(), options: { verifyServer?: boolean; capabilities?: string[];pairing?:{pairingId:string;token:string};userAgent?:string;version?:string;codeVersion?:string } = {}) {
  let pairing=options.pairing;
  if(!pairing&&(config.directConnections===true||config.network)){
    const response=await fetch(serviceInternalUrl(config)+'/browser-pairings',{method:'POST',headers:{authorization:'Bearer '+config.token,'content-type':'application/json'},body:JSON.stringify({label,profileId:id})});
    if(!response.ok)throw new Error('测试浏览器配对创建失败（HTTP '+response.status+'）。');
    pairing=await response.json() as {pairingId:string;token:string};
  }
  const socket = new WebSocket(bridgeAddress(servicePublicUrl(config)), { origin: `chrome-extension://${'a'.repeat(32)}` });
  await once(socket, 'open');
  const token = pairing?.token??bridgeToken(config), clientNonce = randomBytes(16).toString('hex'), instanceId = randomUUID();
  const challenged = once(socket, 'message');
  socket.send(JSON.stringify({ type: 'hello', protocol: BRIDGE_PROTOCOL, nonce: clientNonce,...(pairing?{pairingId:pairing.pairingId}:{}) }));
  const challenge = JSON.parse(String((await challenged)[0])) as JsonObject;
  if (challenge.type !== 'challenge') return { id, socket, handshake: challenge };
  const serverNonce = String(challenge.nonce);
  if (options.verifyServer && challenge.proof !== bridgeProof(token, 'server', clientNonce, serverNonce)) { socket.close(); return { id, socket, handshake: { type: 'rejected', message: '服务端证明与本地密钥不符。' } as JsonObject }; }
  const ready = once(socket, 'message');
  socket.send(JSON.stringify({ type: 'auth', proof: bridgeProof(token, 'client', clientNonce, serverNonce, id, instanceId), profile: { id, label, instanceId, version: options.version ?? 'test', ...(options.codeVersion ? { codeVersion: options.codeVersion } : {}), userAgent: options.userAgent ?? 'test', capabilities: options.capabilities ?? FAKE_CAPABILITIES } }));
  const [message] = await ready;
  const handshake = JSON.parse(String(message)) as JsonObject;
  if (handshake.type !== 'ready') return { id, socket, handshake };
  socket.on('message', async raw => {
    const command = JSON.parse(raw.toString()) as WireCommand;
    if (command.type !== 'command') return;
    // 处理函数抛出的错误按扩展的方式回给服务（含 phase/outcome），便于测试扩展拒绝命令的分支。
    let reply: { result?: unknown; error?: unknown };
    try { reply = { result: handler ? await handler(command) : { label } }; } catch (error) { reply = { error: errorInfo(error) }; }
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'result', id: command.id, ...reply }));
  });
  return { id, socket, handshake };
}
