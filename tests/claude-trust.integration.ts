import { claudeTestExecutable } from './local-tools.js';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { ClientSetup } from '../src/client-setup.js';
import { claudePermission } from '../src/client-permissions.js';
import { fixture, fakeProfile, freePort, testDirectory } from './helpers.js';
import { projectDir } from '../src/config.js';
import { VERSION } from '../src/version.js';

// 真实 Claude Code 在隔离 HOME 里读向导写的文件，权限判断走它自己的代码；只有模型换成本地桩，不用额度，也不依赖模型是否照做。
const executable = claudeTestExecutable();
const toolName = 'mcp__saltedfish__chrome_network_stop';
const temp = await testDirectory(), f = await fixture(), work = path.join(temp.directory, 'work');
const settingsFile = path.join(temp.directory, '.claude/settings.json');
const results: { is_error?: boolean; content?: unknown }[] = [];
let calls = 0, toolOffered = false;
const profile = await fakeProfile(f.config, 'trust-fixture', command => { if (command.operation === 'network.stop') calls++; return { completed: true }; });

function sse(event: string, data: Record<string, unknown>) { return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`; }
const model = createServer(async (request, response) => {
  let text = ''; for await (const chunk of request) text += chunk;
  if (request.method !== 'POST' || !request.url?.startsWith('/v1/messages') || request.url.includes('count_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":1}'); return; }
  const input = JSON.parse(text), result = input.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).findLast((block: any) => block.type === 'tool_result');
  if (result) results.push(result);
  const offered = !!input.tools?.some((tool: any) => tool.name === toolName), callTool = offered && !result; toolOffered ||= offered;
  const usage = { input_tokens: 1, output_tokens: 1 }, stop_reason = callTool ? 'tool_use' : 'end_turn', id = `msg_${randomUUID()}`, arguments_ = { profileId: profile.id, tabId: 7 };
  const tool = { type: 'tool_use', id: `toolu_${randomUUID().replaceAll('-', '')}`, name: toolName };
  if (!input.stream) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: input.model, content: [callTool ? { ...tool, input: arguments_ } : { type: 'text', text: 'done' }], stop_reason, stop_sequence: null, usage })); return; }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  response.end([
    sse('message_start', { message: { id, type: 'message', role: 'assistant', model: input.model, content: [], stop_reason: null, stop_sequence: null, usage } }),
    sse('content_block_start', { index: 0, content_block: callTool ? { ...tool, input: {} } : { type: 'text', text: '' } }),
    sse('content_block_delta', { index: 0, delta: callTool ? { type: 'input_json_delta', partial_json: JSON.stringify(arguments_) } : { type: 'text_delta', text: 'done' } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } }),
    sse('message_stop', {}),
  ].join(''));
});
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform !== 'win32') { child.kill(); return; }
  await new Promise<void>(resolve => { const kill = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); kill.once('close', () => resolve()); });
}
async function capture(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(executable, args, { cwd: work, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', timedOut = false; child.stdout!.on('data', data => output += data); child.stderr!.on('data', data => output += data);
  const timer = setTimeout(() => { timedOut = true; void stop(child); }, 120000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); }).finally(() => clearTimeout(timer));
  assert.ok(!timedOut, 'Non-interactive approval does not hang'); return { code, output };
}
try {
  await mkdir(work);
  await writeFile(path.join(f.config.dataDir, 'config.json'), JSON.stringify(f.config));
  const credential = f.service.state.createClient('trust-test', [profile.id], false), tokenFile = path.join(temp.directory, 'client.token');
  await writeFile(tokenFile, credential.token, { mode: 0o600 });
  const entry = { command: process.execPath, args: [path.join(projectDir, 'dist/cli.js'), 'mcp'], env: { CHROME_MCP_DATA_DIR: f.config.dataDir, CHROME_MCP_TOKEN_FILE: tokenFile } };
  const setup = new ClientSetup({ dataDir: temp.directory }, { home: temp.directory, entries: { claude: entry } });
  await setup.apply((await setup.preview('claude', { trust: 'service' })).planId);
  assert.deepEqual(JSON.parse(await readFile(settingsFile, 'utf8')).permissions.allow, [claudePermission]);

  const port = await freePort(); await new Promise<void>(resolve => model.listen(port, '127.0.0.1', resolve));
  const env: NodeJS.ProcessEnv = { ...process.env, PWD: work, HOME: temp.directory, USERPROFILE: temp.directory, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'local-stub-not-a-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  for (const name of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']) delete env[name];
  const phase = () => capture(['-p', '--tools', '', '--no-chrome', '--no-session-persistence', '--output-format', 'json', '--max-turns', '4', 'run the synthetic fixture'], env);
  const listed = await capture(['mcp', 'list'], env); assert.match(listed.output, /saltedfish.*(✔|✓|√)/, listed.output.slice(-600));

  const trusted = await phase(); assert.equal(trusted.code, 0, trusted.output.slice(-1200)); assert.ok(toolOffered, 'generated user config exposes the tool');
  assert.equal(calls, 1, `trusted rule dispatches once: ${trusted.output.slice(-800)}`); assert.equal(JSON.parse(trusted.output).permission_denials.length, 0);

  await setup.apply((await setup.preview('claude', { trust: 'prompt' })).planId);
  assert.deepEqual(JSON.parse(await readFile(settingsFile, 'utf8')).permissions.allow, []);
  const revoked = await phase(); assert.equal(calls, 1, `revoked rule blocks dispatch: ${revoked.output.slice(-800)}`);
  assert.equal(JSON.parse(revoked.output).permission_denials[0].tool_name, toolName); assert.equal(results.at(-1)?.is_error, true);

  const report = { version: VERSION, client: (await capture(['--version'], env)).output.trim(), model: 'local stub', rule: claudePermission, passed: true, checks: { userConfigConnected: true, trustedRuleDispatches: true, revokedRuleBlocksDispatch: true } };
  await mkdir(path.join(projectDir, '.local/verification'), { recursive: true }); await writeFile(path.join(projectDir, '.local/verification/claude-trust.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { model.close(); await f.cleanup(); await temp.cleanup(); }
