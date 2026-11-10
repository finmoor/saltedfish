import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture, fakeProfile } from './helpers.js';
import { projectDir } from '../src/config.js';

test('真实 MCP stdio 握手、工具发现、结构化调用及错误语义', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  await writeFile(path.join(f.config.dataDir, 'config.json'), JSON.stringify(f.config));
  const browser = await fakeProfile(f.config, '测试配置');
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(projectDir, 'dist', 'cli.js'), 'mcp'], env: { ...Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => typeof pair[1] === 'string')), CHROME_MCP_DATA_DIR: f.config.dataDir }, stderr: 'pipe' });
  const client = new Client({ name: 'test-client', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools(); assert.ok(tools.tools.length >= 25);
  assert.equal(tools.tools.find(tool => tool.name === 'chrome_evaluate')?.annotations?.readOnlyHint, false);
  const profiles = await client.callTool({ name: 'chrome_profiles', arguments: {} });
  assert.equal(profiles.isError, false); assert.ok(JSON.stringify(profiles.structuredContent).includes(browser.id));
  const missing = await client.callTool({ name: 'chrome_evaluate', arguments: { profileId: 'missing', tabId: 7, expression: '1' } });
  assert.equal(missing.isError, true); assert.ok(JSON.stringify(missing).includes('PROFILE_OFFLINE'));
});

test('stdio 接入按令牌读开关：默认目录，打开高级工具后完整目录，查不到时按默认目录', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  await writeFile(path.join(f.config.dataDir, 'config.json'), JSON.stringify(f.config));
  const count = async (token: string) => {
    const tokenFile = path.join(f.config.dataDir, `token-${Date.now()}`);
    await writeFile(tokenFile, token);
    const env = { ...Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => typeof pair[1] === 'string')), CHROME_MCP_DATA_DIR: f.config.dataDir, CHROME_MCP_TOKEN_FILE: tokenFile };
    const client = new Client({ name: 'stdio-tools', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(projectDir, 'dist', 'cli.js'), 'mcp'], env }));
    try { return (await client.listTools()).tools.length; } finally { await client.close(); }
  };
  const created = f.service.state.createClient('stdio');
  assert.equal(await count(created.token), 46);
  f.service.state.setClientTools(created.id, true);
  assert.equal(await count(created.token), 64);
  assert.equal(await count('not-a-client-token'), 46);
});
