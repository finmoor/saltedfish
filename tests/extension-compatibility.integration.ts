import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { type Browser } from 'puppeteer-core';
import { launchTestChrome } from './chrome-launch.js';
import { projectDir } from '../src/config.js';
import { bridgeProof } from '../src/auth.js';
import { freePort, testDirectory } from './helpers.js';
import type { JsonObject, WireReply } from '../src/shared.js';
import { VERSION } from '../src/version.js';

test('新扩展遇到缺少interaction-v5的旧服务，在页面执行前明确拒绝', async t => {
  const temp = await testDirectory(), port = await freePort(), server = createServer(), token = randomBytes(32).toString('hex');
  const websocket = new WebSocketServer({ server });
  let browser: Browser | undefined, connection: WebSocket | undefined;
  let hello: JsonObject | undefined, proofOk = false, resolveReply: ((reply: WireReply) => void) | undefined;
  websocket.on('connection', socket => {
    connection = socket;
    let clientNonce = '', serverNonce = '';
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()) as JsonObject;
      // 握手 v2：这个“旧服务”只是缺少 interaction-v5/admin-origin-v1，握手本身要按新协议应答（先证明自己，再核对扩展的证明），扩展才会走到能力核对
      if (message.type === 'hello') {
        clientNonce = String(message.nonce); serverNonce = randomBytes(16).toString('hex');
        socket.send(JSON.stringify({ type: 'challenge', nonce: serverNonce, proof: bridgeProof(token, 'server', clientNonce, serverNonce) }));
      } else if (message.type === 'auth') {
        const profile = message.profile as JsonObject;
        hello = message; proofOk = message.proof === bridgeProof(token, 'client', clientNonce, serverNonce, String(profile.id), String(profile.instanceId));
        socket.send(JSON.stringify({ type: 'ready', capabilities: ['execution-v3', 'interaction-v4'] }));
      } else if (message.type === 'result') resolveReply?.(message as unknown as WireReply);
    });
  });
  t.after(async () => {
    try { await browser?.close(); }
    finally {
      for (const socket of websocket.clients) socket.terminate();
      await new Promise<void>(resolve => websocket.close(() => resolve()));
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await temp.cleanup();
    }
  });
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  const extensionDir = path.join(temp.directory, 'extension');
  await cp(path.join(projectDir, 'dist/extension'), extensionDir, { recursive: true });
  await writeFile(path.join(extensionDir, 'pairing.json'), JSON.stringify({ port, token }));
  browser = await launchTestChrome({ headless: true, pipe: true, userDataDir: path.join(temp.directory, 'chrome'), enableExtensions: [extensionDir], args: ['--no-first-run'] });
  const workerTarget = await browser.waitForTarget(target => target.type() === 'service_worker');
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${new URL(workerTarget.url()).host}/options.html`);
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('版本不兼容'));
  assert.ok(proofOk, '扩展按 v2 握手发来了正确的证明');
  assert.ok(Array.isArray((hello?.profile as JsonObject)?.capabilities) && ((hello!.profile as JsonObject).capabilities as string[]).includes('interaction-v5'));
  assert.equal((hello!.profile as JsonObject).codeVersion, VERSION, '握手带后台代码编译进去的版本（服务端据此认出 Chrome 沿用了旧后台脚本）');
  const worker = await workerTarget.worker(); assert.ok(worker);
  await worker.evaluate(() => {
    (globalThis as any).__compatibilityCalls = 0;
    const send = chrome.debugger.sendCommand;
    chrome.debugger.sendCommand = function (...args: Parameters<typeof send>) {
      (globalThis as any).__compatibilityCalls++;
      return Reflect.apply(send, chrome.debugger, args);
    } as typeof send;
  });
  const reply = new Promise<WireReply>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Missing incompatible-service response')), 3000);
    resolveReply = result => { clearTimeout(timer); resolve(result); };
  });
  connection!.send(JSON.stringify({ type: 'command', id: randomUUID(), operation: 'page.inspect', args: { tabId: 123 }, deadline: Date.now() + 2000 }));
  const result = await reply;
  assert.equal(result.error?.code, 'SERVICE_UPDATE_REQUIRED');
  assert.equal(result.error?.phase, 'precondition'); assert.equal(result.error?.outcome, 'not_dispatched');
  assert.equal(await worker.evaluate(() => (globalThis as any).__compatibilityCalls), 0);
});
