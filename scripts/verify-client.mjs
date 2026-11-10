import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../dist/config.js';

const config = await loadConfig();
const generated = JSON.parse(await readFile(path.join(config.dataDir, 'mcp-config.json'), 'utf8'));
const entry = generated.mcpServers['saltedfish'];
const client = new Client({ name: 'installed-client-check', version: '1' });
const transport = new StdioClientTransport({ ...entry, env: { ...process.env, ...entry.env }, stderr: 'pipe' });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const result = await client.callTool({ name: 'chrome_profiles', arguments: {} });
  if (result.isError) throw new Error(JSON.stringify(result.structuredContent));
  console.log(JSON.stringify({ transport: 'stdio', tools: tools.tools.length, profiles: result.structuredContent.data.profiles.map(profile => ({ id: profile.id, label: profile.label })) }, null, 2));
} finally { await client.close(); }
