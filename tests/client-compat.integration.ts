import { homedir } from 'node:os';
import { claudeTestExecutable, openCodeTestExecutable } from './local-tools.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { startGateway } from '../src/remote-gateway.js';
import { fixture, fakeProfile, freePort } from './helpers.js';
import { projectDir } from '../src/config.js';
import { openCodeConfig } from '../src/client-config.js';
import { VERSION } from '../src/version.js';
import { ClientSetup } from '../src/client-setup.js';

const selected = process.argv[2] || 'claude';
const diagnose = process.argv.includes('--diagnose');
const remote = process.argv.includes('--remote');
const trustSetup = process.argv.includes('--trust-setup');
const interaction = process.argv.includes('--interaction');
const bom = process.argv.includes('--bom') ? '\ufeff' : '';
assert.ok(['claude', 'opencode', 'opencode-direct'].includes(selected));
const directory = path.join(projectDir, '.local', 'client-compat', `${selected}-${Date.now()}`);
await mkdir(directory, { recursive: true });
const f = await fixture(); f.config.outputLimit = 1200;
await writeFile(path.join(f.config.dataDir, 'config.json'), JSON.stringify(f.config));
const audits: { name: string; ok: boolean; code?: string; pagedEnd: boolean; image: boolean;interactionContract?:boolean }[] = [];
const original = f.service.invoke.bind(f.service);
f.service.invoke = async (...args) => {
  const result = await original(...args);
  const input=args[1] as any;
  audits.push({ name: args[0], ok: result.ok, code: result.error?.code, image: !!result.image,
    pagedEnd: args[0] === 'chrome_read_result' && JSON.stringify(result.data).includes('COMPAT-LONG-END'),interactionContract:args[0]==='chrome_batch'?input.steps?.[0]?.args.inputMode==='keySequence'&&input.steps?.[0]?.postcondition?.valueEquals==='abc':args[0]==='chrome_task_submit'?!!input.submissionId&&input.steps?.[0]?.postcondition?.valueEquals==='sample':undefined });
  return result;
};
const visible = await fakeProfile(f.config, 'compat-visible', command => {
  if (command.operation === 'tabs.list') return [{ tabId: 7, windowId: 1, title: 'Synthetic compatibility fixture', url: 'https://fixture.invalid/' }];
  if (command.operation === 'page.inspect') return { title: 'Synthetic fixture', text: '测'.repeat(40000) + 'COMPAT-LONG-END' };
  if (command.operation === 'page.screenshot') return { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' };
  return {};
});
let hiddenCalls = 0;
const hidden = await fakeProfile(f.config, 'compat-hidden', () => { hiddenCalls++; return {}; });
const credential = f.service.state.createClient(`compat-${selected}`, [visible.id], true);
const tokenFile = path.join(directory, 'client.token'); await writeFile(tokenFile, credential.token, { mode: 0o600 });
const entry = { command: process.execPath, args: [path.join(projectDir, 'dist/cli.js'), 'mcp'], env: { CHROME_MCP_DATA_DIR: f.config.dataDir, CHROME_MCP_TOKEN_FILE: tokenFile } };
let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
let remoteEntry: { type: string; url: string; headers: Record<string, string> } | undefined;
if (remote) {
  const device = { id: randomUUID(), label: '兼容测试电脑', token: randomBytes(32).toString('hex') };
  const agent = { id: randomUUID(), label: selected, token: randomBytes(32).toString('hex'), deviceId: device.id, profiles: [visible.id], readOnly: true };
  const port = await freePort(); gateway = await startGateway({ host: '127.0.0.1', port, devices: [device], agents: [agent] });
  await f.remote.configure({ enabled: true, url: `http://127.0.0.1:${port}`, token: device.token, profiles: '*', readOnly: false });
  for (let i = 0; i < 100 && f.remote.status().state !== 'connected'; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.remote.status().state, 'connected');
  remoteEntry = { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${agent.token}` } };
}
const configFile = path.join(directory, 'mcp.json');
await writeFile(configFile, bom + JSON.stringify({ mcpServers: { 'saltedfish': remoteEntry || entry } }, null, 2));
const prompt = `Run this synthetic MCP interoperability test using only saltedfish MCP tools. Do not read files or invoke other tools. This is a test fixture, not anyone's live browser.
1. Call chrome_profiles. Exactly one profile compat-visible must appear.
2. Call chrome_tabs for that profile, then chrome_inspect on tabId 7. Its large result must be saved, not lost.
3. Use chrome_read_result with the returned artifactId, offset=max(0,totalCharacters-128), limit=128. Confirm COMPAT-LONG-END appears.
4. Call chrome_screenshot on tabId 7; confirm an image response.
5. Call chrome_tabs with profileId ${hidden.id}; expect PROFILE_NOT_AUTHORIZED.
6. Call chrome_action for the visible profile and tabId 7 with action fill, selector #test, text sample. This client is deliberately read-only: expect CLIENT_READ_ONLY. Do not retry or seek other access.
${interaction?`7. Independently test the new batch schema ONCE: chrome_batch for this profile/tabId 7, steps=[{operation:"page.action",args:{action:"type",selector:"#test",text:"abc",inputMode:"keySequence"},postcondition:{selector:"#test",valueEquals:"abc",stableMs:100}}]. Expect CLIENT_READ_ONLY, not a schema error.
8. Independently test the task schema ONCE: chrome_task_submit with this profile/tabId 7, name="schema test",submissionId="${randomUUID()}",steps=[{operation:"page.action",args:{action:"fill",selector:"#test",text:"sample",fillMode:"input"},postcondition:{selector:"#test",valueEquals:"sample"}}]. Expect CLIENT_READ_ONLY. These are separate authorized expected-denial cases; do not retry any of them.`:''}
Return a concise result naming each check. Never claim success without these actual calls. No subagents, shell, file changes or other services.`;
let executable: string, args: string[];
const env: NodeJS.ProcessEnv = { ...process.env, PWD: directory };
if (selected === 'claude') {
  executable = claudeTestExecutable();
  args = ['-p', '--restricted', '--strict-mcp-config', '--mcp-config', configFile, '--tools', '', '--allowedTools', 'mcp__saltedfish__*',
    '--no-chrome', '--no-session-persistence', '--output-format', 'stream-json', '--verbose', '--max-turns', '12', '--max-budget-usd', '2', prompt];
} else {
  executable = openCodeTestExecutable();
  const config = openCodeConfig(entry) as { mcp: { servers: Record<string, unknown> } };
  if (remoteEntry) config.mcp.servers['saltedfish'] = { ...remoteEntry, type: 'remote', oauth: false };
  // 隔离测试不连接用户原有浏览器 MCP；只读取名称，替换为禁用的无凭据占位项。
  try {
    const global = JSON.parse(await readFile(path.join(homedir(), '.config/opencode/opencode.json'), 'utf8'));
    for (const key of Object.keys(global.mcp?.servers || global.mcp || {})) {
      if (key !== 'saltedfish' && key !== 'timeout') config.mcp.servers[key] = { type: 'local', command: [process.execPath, '--version'], disabled: true };
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (selected === 'opencode-direct') (config.mcp.servers['saltedfish'] as Record<string, unknown>).codemode = false;
  const permissions = [{ action: '*', resource: '*', effect: 'deny' }, { action: 'execute', resource: '*', effect: 'allow' }, { action: 'saltedfish_*', resource: '*', effect: 'allow' }];
  const rendered = process.argv.includes('--legacy-config') ? openCodeConfig(entry, 1) : config;
  await writeFile(path.join(directory, 'opencode.json'), bom + JSON.stringify({ ...rendered, permissions: trustSetup ? [{ action: '*', resource: '*', effect: 'deny' }] : permissions }, null, 2));
  if (trustSetup) {
    const setup = new ClientSetup({ dataDir: directory }, { home: directory, entries: { opencode: remoteEntry || entry } });
    await setup.apply((await setup.preview('opencode', { configPath: path.join(directory, 'opencode.json'), trust: 'service' })).planId);
  }
  env.OPENCODE_CONFIG_DIR = directory; env.OPENCODE_CONFIG = path.join(directory, 'opencode.json');
  env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = '1';
  args = ['run', '--standalone', '--format', 'json', '--model', 'openai/gpt-6.1-sol#xhigh', '--title', 'Chrome MCP synthetic compatibility', prompt];
  if (diagnose) args = ['api', '--standalone', 'GET', process.argv.includes('--config-api') ? '/api/config' : '/api/mcp'];
}
const started = Date.now();
let stdout = '', stderr = '', timedOut = false;
let privateServer: ReturnType<typeof spawn> | undefined;
try {
  const clientVersion = await new Promise<string>((resolve, reject) => {
    const probe = spawn(executable, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let value = '';
    const deadline = setTimeout(() => { probe.kill(); reject(new Error('Client version probe timed out')); }, 10000);
    probe.stdout.on('data', data => { value += String(data); });
    probe.once('error', error => { clearTimeout(deadline); reject(error); });
    probe.once('close', code => { clearTimeout(deadline); code === 0 ? resolve(value.trim()) : reject(new Error('Client version probe failed')); });
  });
  if (selected !== 'claude') {
    const base = `http://127.0.0.1:${await freePort()}`;
    const serverPassword = randomUUID() + randomUUID();
    env.OPENCODE_PASSWORD = serverPassword; env.OPENCODE_SERVER_PASSWORD = serverPassword;
    privateServer = spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', new URL(base).port], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let startup = ''; privateServer.stdout!.on('data', data => { startup = (startup + String(data)).slice(-100000); });
    privateServer.stderr!.on('data', data => { startup = (startup + String(data)).slice(-100000); });
    let connection: unknown;
    let ready = false;
    for (let retry = 0; retry < 150; retry++) {
      try {
        const response = await fetch(`${base}/api/mcp`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${serverPassword}`).toString('base64')}` }, signal: AbortSignal.timeout(2000) });
        const body = await response.json() as { data?: { name: string; status: any }[] };
        connection = body;
        ready = !!body.data?.some(item => item.name === 'saltedfish' && (item.status === 'connected' || item.status?.type === 'connected' || item.status?.status === 'connected'));
        if (ready || response.status === 400 || response.status === 401) break;
      } catch { /* 服务和 MCP 均完成初始化之后才调用模型。 */ }
      if (privateServer.exitCode !== null) throw new Error(`OpenCode server exited: ${startup.slice(-2000)}`);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    await writeFile(path.join(directory, 'mcp-status.json'), JSON.stringify(connection, null, 2));
    const safeStartup = startup.replace(/server password \S+/g, 'server password [redacted]').replaceAll(serverPassword, '[redacted]');
    await writeFile(path.join(directory, 'server.log'), safeStartup);
    assert.ok(ready, `MCP not ready: ${JSON.stringify(connection)} ${safeStartup.slice(-1200)}`);
    const standalone = args.indexOf('--standalone'); args.splice(standalone, 1, '--server', base);
  }
  const child = spawn(executable, args, { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32' && child.pid) spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGTERM');
  }, 180000);
  child.stdout.on('data', data => { stdout = (stdout + String(data)).slice(-8 * 1024 * 1024); });
  child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-500000); });
  const exitCode = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); }).finally(() => clearTimeout(timer));
  await writeFile(path.join(directory, 'client.jsonl'), stdout);
  await writeFile(path.join(directory, 'stderr.log'), stderr);
  const checks = { processExited: exitCode === 0 && !timedOut, discovery: audits.some(a => a.name === 'chrome_profiles' && a.ok),
    inspection: audits.some(a => a.name === 'chrome_inspect' && a.ok), longResultPaging: audits.some(a => a.pagedEnd),
    image: audits.some(a => a.image), scopedError: audits.some(a => a.code === 'PROFILE_NOT_AUTHORIZED'),
    readOnlyError: audits.some(a => a.name === 'chrome_action' && a.code === 'CLIENT_READ_ONLY'), noCrossProfileDispatch: hiddenCalls === 0,
    ...(interaction?{batchSchema:audits.some(a=>a.name==='chrome_batch'&&a.interactionContract&&a.code==='CLIENT_READ_ONLY'),taskSchema:audits.some(a=>a.name==='chrome_task_submit'&&a.interactionContract&&a.code==='CLIENT_READ_ONLY')}:{}) };
  const report = { version: VERSION, client: selected, clientVersion, trustSetup, transport: remote ? 'streamable-http + outbound-websocket' : 'stdio', configEncoding: bom ? 'utf8-bom' : 'utf8', requestedModel: selected === 'claude' ? 'client default' : 'openai/gpt-6.1-sol#xhigh', elapsedMs: Date.now() - started, exitCode, timedOut, checks, passed: Object.values(checks).every(Boolean), audit: audits, directory };
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  await mkdir(path.join(projectDir, '.local/verification'), { recursive: true });
  await writeFile(path.join(projectDir, `.local/verification/${diagnose ? 'diagnostic' : 'client'}-${selected}${interaction?'-interaction-beta17':''}${remote ? '-remote' : ''}${bom ? '-bom' : ''}${trustSetup ? '-trust' : ''}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) { console.error(stderr.slice(-2500)); console.error(stdout.slice(-3500)); process.exitCode = 1; }
} finally {
  if (privateServer && privateServer.exitCode === null && privateServer.pid) {
    if (process.platform === 'win32') await new Promise<void>(resolve => { const stopped = spawn('taskkill.exe', ['/pid', String(privateServer!.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); stopped.once('exit', () => resolve()); });
    else privateServer.kill('SIGTERM');
  }
  await gateway?.close(); await f.cleanup();
}
