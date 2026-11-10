import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture, testDirectory, fakeProfile, freePort } from './helpers.js';
import { startServer } from '../src/http-server.js';
import { httpAgentConfigurations } from '../src/client-config.js';
import { runMcpBridge, localOnlyRejection } from '../src/mcp-bridge.js';
import { projectDir } from '../src/config.js';

const launch = (env: Record<string, string>) => new StdioClientTransport({ command: process.execPath, args: [path.join(projectDir, 'dist/npm-cli.js'), 'mcp-bridge'], env, stderr: 'pipe' });

test('Desktop 远程桥接转发真实目录、客户端身份和独立权限，不初始化本地安装', async () => {
  const temp = await testDirectory(), f = await fixture({}, (config, options) => startServer({ ...config, directConnections: true }, options));
  const profile = await fakeProfile({ ...f.config, directConnections: true }, 'bridge-test', () => ({ profiles: [] }));
  const grant = f.service.state.createClient('desktop-bridge', [profile.id], true), local = path.join(temp.directory, 'unused');
  const entry = JSON.parse(httpAgentConfigurations(`http://127.0.0.1:${f.config.port}/mcp`, grant.token)['claude-desktop']).mcpServers.saltedfish;
  const client = new Client({ name: 'desktop-test', version: '1' }), transport = launch({ ...entry.env, CHROME_MCP_DATA_DIR: local, LOCALAPPDATA: local, HOME: local, USERPROFILE: local });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  try {
    await client.connect(transport, { timeout: 10000 }); assert.equal((await client.listTools()).tools.length, 46);
    const profiles = (await client.callTool({ name: 'chrome_profiles', arguments: {} })).structuredContent as any; assert.deepEqual(profiles.data.profiles.map((p: any) => p.id), [profile.id]);
    const denied = await client.callTool({ name: 'chrome_new_tab', arguments: { profileId: profile.id } }); assert.equal(denied.isError, true);
    assert.equal(f.service.agents().find(agent => agent.id === grant.id)?.sessions?.[0]?.client, 'desktop-test');
    await assert.rejects(access(local));
    f.service.state.revokeClient(grant.id); await assert.rejects(client.listTools(), /远程连接失败/);
    assert.ok(!stderr.includes(grant.token));
  } finally { await client.close(); profile.socket.terminate(); await f.cleanup(); await temp.cleanup(); }
});

test('桥接断线不重放 POST；图片原样转发、初始化通知携带协议版本；EOF 终止远端会话', async () => {
  let calls = 0, deleted = 0, authorization = '', protocol = '';
  const server = createServer(async (req, res) => {
    authorization = String(req.headers.authorization || '');
    if (req.method === 'DELETE') { deleted++; res.writeHead(200).end(); return; }
    if (req.method === 'GET') { res.writeHead(405).end(); return; }
    let text = ''; for await (const chunk of req) text += chunk;
    const request = JSON.parse(text);
    if (!('id' in request)) { protocol = String(req.headers['mcp-protocol-version']); res.writeHead(202).end(); return; }
    if (request.method === 'tools/call' && request.params.name === 'fail') { calls++; req.socket.destroy(); return; }
    const result = request.method === 'initialize' ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'bridge-fixture', version: '1' }, instructions: 'keep-me' } : request.method === 'tools/list' ? { tools: [] } : { content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }], structuredContent: { keep: true } };
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'bridge-session' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  const port = await freePort(); server.listen(port, '127.0.0.1'); await once(server, 'listening');
  const client = new Client({ name: 'bridge-test', version: '1' }), transport = launch({ SALTEDFISH_MCP_URL: `http://127.0.0.1:${port}/mcp`, SALTEDFISH_MCP_TOKEN: 'test-token' });
  try {
    await client.connect(transport, { timeout: 10000 }); assert.equal(client.getInstructions(), 'keep-me');
    const result = await client.callTool({ name: 'image', arguments: {} }); assert.deepEqual(result.content, [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }]); assert.deepEqual(result.structuredContent, { keep: true }); assert.ok(protocol);
    await assert.rejects(client.callTool({ name: 'fail', arguments: {} }), /结果可能不明/); assert.equal(calls, 1); assert.equal(authorization, 'Bearer test-token');
    await client.close(); assert.equal(deleted, 1);
  } finally { await client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('桥接拒绝缺凭据、带凭据地址和公网明文地址，不回退管理员凭据', async () => {
  for (const url of ['https://u:p@example.test/mcp', 'https://example.test/mcp?key=a', 'http://public.example/mcp', 'http://127.0.0.1/rpc']) await assert.rejects(runMcpBridge({ SALTEDFISH_MCP_URL: url, SALTEDFISH_MCP_TOKEN: 'test' }), /完整/);
  await assert.rejects(runMcpBridge({ SALTEDFISH_MCP_URL: 'http://127.0.0.1/mcp', CHROME_MCP_TOKEN_FILE: 'not-used' }), /TOKEN/);
});

test('SDK 收到服务的 403 MCP_LOCAL_ONLY 后抛出的错误能被桥接识别（桥接子进程跑 dist，改完 src 要重新构建才覆盖）', async () => {
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* 读完请求体 */ }
    res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'MCP_LOCAL_ONLY', message: '只接受同一台电脑' }));
  });
  const port = await freePort(); server.listen(port, '127.0.0.1'); await once(server, 'listening');
  const remote = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  try {
    await remote.start();
    await assert.rejects(remote.send({ jsonrpc: '2.0', id: 1, method: 'ping' }), (error: unknown) => localOnlyRejection(error));
  } finally { await remote.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('只有 403 且带 MCP_LOCAL_ONLY 才算本机限制拒绝', () => {
  assert.equal(localOnlyRejection({ code: 403, message: 'Error POSTing to endpoint: {"error":"MCP_LOCAL_ONLY"}' }), true);
  assert.equal(localOnlyRejection({ code: 403, message: 'forbidden' }), false);
  assert.equal(localOnlyRejection({ code: 401, message: 'MCP_LOCAL_ONLY' }), false);
  assert.equal(localOnlyRejection(undefined), false);
});

test('现行文档和管理页不再教用户把 Agent 配置导入别的电脑', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of ['README.md', 'packaging/npm-README.md', 'ui/index.html', 'ui/agents.js', 'ui/client-hints.js', 'docs/supported-clients.md', 'docs/client-compatibility.md', 'src/client-config.ts']) {
    const text = await readFile(path.join(projectDir, file), 'utf8');
    assert.ok(!/运行 Agent 的电脑|实际运行的电脑|可以运行在任意电脑|可从任意电脑接入|Desktop 连接其他电脑/.test(text), file);
  }
});
