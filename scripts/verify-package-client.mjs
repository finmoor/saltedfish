import { readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(process.argv[2]);
const configuration = JSON.parse(await readFile(path.join(root, 'data', 'mcp-config.json'), 'utf8'));
const entry = configuration.mcpServers['saltedfish'];
assert.equal(path.resolve(entry.command), path.join(root, 'SaltedFish.exe'));
const client = new Client({ name: 'package-verification', version: '1' });
const command = process.argv[3] === '--legacy' ? path.join(root, 'FengChromeMCP.exe') : entry.command;
const transport = new StdioClientTransport({ ...entry, command, env: { ...process.env, PATH: process.env.SystemRoot + '\\System32', ...entry.env }, stderr: 'pipe' });
let stderr = '';
try {
  transport.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-5000); });
  await client.connect(transport, { timeout: 15000 });
  assert.equal(client.getServerVersion().title, 'SaltedFish');
  // 默认目录不列任务和流程工具；管理页打开高级工具后才列，这条路径由 tests/mcp.test.ts 覆盖。
  const tools = await client.listTools(); assert.ok(tools.tools.length >= 43);
  for (const name of ['chrome_action', 'chrome_inspect', 'chrome_batch', 'chrome_dialog', 'chrome_recover_tab']) assert.ok(tools.tools.some(tool => tool.name === name), name);
  assert.ok(!tools.tools.some(tool => /^chrome_(workflow|task)/.test(tool.name)));
  const profiles = await client.callTool({ name: 'chrome_profiles', arguments: {} });
  assert.equal(profiles.isError, false);
  console.log('PASS bundled native launcher + MCP stdio with Node/npm absent from PATH');
} catch (error) { console.error(stderr); throw error; }
finally { await client.close(); }
