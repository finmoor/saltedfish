import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fixture } from './helpers.js';
import { fromThisMachine, HttpMcp } from '../src/mcp-http.js';

// 文件读写交给 Agent 自己的 harness，前提是 Agent 和服务在同一台电脑上：/mcp 只接本机连接。
test('fromThisMachine：回环和两端地址相同算本机，别的电脑和读不出地址的都不算', () => {
  for (const [peer, here] of [['127.0.0.1', '127.0.0.1'], ['127.0.0.5', '192.168.1.10'], ['::1', '::1'], ['::ffff:127.0.0.1', '::ffff:127.0.0.1'], ['192.168.1.10', '192.168.1.10'], ['::ffff:192.168.1.10', '192.168.1.10']])
    assert.equal(fromThisMachine(peer, here), true, `${peer} → ${here}`);
  for (const [peer, here] of [['192.168.1.20', '192.168.1.10'], ['::ffff:192.168.1.20', '::ffff:192.168.1.10'], ['fe80::1', '::1'], [undefined, '127.0.0.1'], ['not-an-ip', 'not-an-ip']])
    assert.equal(fromThisMachine(peer as string | undefined, here), false, `${peer} → ${here}`);
});

test('/mcp：别的电脑连进来回 403 MCP_LOCAL_ONLY，令牌对也不行、不建会话；本机地址照常往下走', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const mcp = new HttpMcp(f.service); t.after(() => mcp.close());
  const token = f.service.state.createClient('别的电脑上的 Agent', '*').token;
  const call = async (remoteAddress: string, localAddress: string) => {
    let status = 0, body = '';
    const response: Record<string, unknown> = {
      headersSent: false,
      writeHead(code: number) { status = code; response.headersSent = true; return response; },
      setHeader() { return this; },
      end(chunk?: string) { if (chunk) body += chunk; return this; },
      on() { return this; }, once() { return this; },
    };
    const request = { method: 'DELETE', url: '/mcp', headers: { authorization: 'Bearer ' + token }, socket: { remoteAddress, localAddress }, on() { return this; }, once() { return this; } } as unknown as IncomingMessage;
    await mcp.handle(request, response as unknown as ServerResponse);
    return { status, body };
  };
  const remote = await call('192.168.1.20', '192.168.1.10');
  assert.equal(remote.status, 403);
  const parsed = JSON.parse(remote.body);
  assert.equal(parsed.error, 'MCP_LOCAL_ONLY'); assert.match(parsed.message, /同一台电脑/);
  // 本机地址过了这一关，后面才轮到会话检查（DELETE 不带会话 ID 不会是 MCP_LOCAL_ONLY）。
  const local = await call('192.168.1.10', '192.168.1.10');
  assert.notEqual(local.status, 403); assert.doesNotMatch(local.body, /MCP_LOCAL_ONLY/);
});
