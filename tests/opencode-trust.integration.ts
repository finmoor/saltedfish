import { openCodeTestExecutable } from './local-tools.js';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import { ClientSetup } from '../src/client-setup.js';
import { fixture, fakeProfile, testDirectory, freePort } from './helpers.js';
import { projectDir } from '../src/config.js';
import { startGateway } from '../src/remote-gateway.js';
import { VERSION } from '../src/version.js';

const remote = process.argv.includes('--remote');
const executable = openCodeTestExecutable();
const temp = await testDirectory(), f = await fixture(), configPath = path.join(temp.directory, 'opencode.json');
const env = { ...process.env, PWD: temp.directory, OPENCODE_CONFIG_DIR: temp.directory, OPENCODE_CONFIG: configPath, OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1', OPENCODE_PASSWORD: randomUUID() + randomUUID(), OPENCODE_SERVER_PASSWORD: '' };
env.OPENCODE_SERVER_PASSWORD = env.OPENCODE_PASSWORD;
let calls = 0, gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
const profile = await fakeProfile(f.config, 'trust-fixture', command => { if (command.operation === 'network.stop') calls++; return { completed: true }; });
async function clientVersion() {
  const child = spawn(executable, ['--version'], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  let result = ''; child.stdout.on('data', data => result += data); child.stderr.resume();
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0); return result.trim();
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform !== 'win32') { child.kill(); return; }
  await new Promise<void>(resolve => { const kill = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); kill.once('close', () => resolve()); });
}
async function phase() {
  const base = `http://127.0.0.1:${await freePort()}`, headers = { authorization: `Basic ${Buffer.from(`opencode:${env.OPENCODE_PASSWORD}`).toString('base64')}` };
  const server = spawn(executable, ['serve','--hostname','127.0.0.1','--port',new URL(base).port], { cwd: temp.directory, env, windowsHide: true, stdio: 'ignore' });
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try {
        const data: any = await (await fetch(`${base}/api/mcp`, { headers, signal: AbortSignal.timeout(1000) })).json();
        ready = data.data?.some((server: any) => server.name === 'saltedfish' && server.status.status === 'connected'); if (ready) break;
      } catch { /* 等待独立测试服务初始化。 */ }
      if (server.exitCode !== null) throw new Error('OpenCode private server exited');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(ready, 'OpenCode loaded generated MCP config');
    const prompt = `Only use saltedfish_chrome_network_stop once, with profileId ${profile.id} and tabId 7. This is a synthetic MCP fixture, not a real browser. No execute, shell, file, other MCP, web or subagents. If approval is refused, report it and stop; do not use any alternative. Otherwise report the tool result.`;
    const child = spawn(executable, ['run','--server',base,'--format','json','--model','openai/gpt-6.1-sol#xhigh',prompt], { cwd: temp.directory, env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let output = '', timedOut = false; child.stdout!.on('data', data => output += data); child.stderr!.on('data', data => output += data);
    const timer = setTimeout(() => { timedOut = true; void stop(child); }, 120000);
    const code = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); }).finally(() => clearTimeout(timer));
    assert.ok(!timedOut, 'Non-interactive approval does not hang'); assert.equal(code, 0, output.slice(-1200)); return output;
  } finally { await stop(server); }
}
try {
  const servers: Record<string, unknown> = {};
  // 屏蔽日常其他 MCP，仅复制名称，不复制任何凭据。测试模型仍使用用户已有独立登录。
  try {
    const source = JSON.parse(await readFile(path.join(os.homedir(), '.config/opencode/opencode.json'), 'utf8'));
    for (const key of Object.keys(source.mcp?.servers || {})) if (key !== 'saltedfish') servers[key] = { type: 'local', command: [process.execPath, '--version'], disabled: true };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await writeFile(configPath, JSON.stringify({ mcp: { servers }, permissions: [{ action: '*', resource: '*', effect: 'deny' }] }), { mode: 0o600 });
  await writeFile(path.join(f.config.dataDir, 'config.json'), JSON.stringify(f.config));
  const credential = f.service.state.createClient('trust-test', [profile.id], false), tokenFile = path.join(temp.directory, 'client.token');
  await writeFile(tokenFile, credential.token, { mode: 0o600 });
  let entry: any = { command: process.execPath, args: [path.join(projectDir, 'dist/cli.js'), 'mcp'], env: { CHROME_MCP_DATA_DIR: f.config.dataDir, CHROME_MCP_TOKEN_FILE: tokenFile } };
  if (remote) {
    const device = { id: randomUUID(), label: 'fixture', token: randomBytes(32).toString('hex') };
    const agent = { id: randomUUID(), label: 'opencode', token: randomBytes(32).toString('hex'), deviceId: device.id, profiles: [profile.id], readOnly: false };
    const port = await freePort(); gateway = await startGateway({ host: '127.0.0.1', port, devices: [device], agents: [agent] });
    await f.remote.configure({ enabled: true, url: `http://127.0.0.1:${port}`, token: device.token, profiles: [profile.id], readOnly: false });
    for (let i = 0; i < 100 && f.remote.status().state !== 'connected'; i++) await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.remote.status().state, 'connected'); entry = { url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${agent.token}` } };
  }
  const setup = new ClientSetup({ dataDir: temp.directory }, { home: temp.directory, entries: { opencode: entry } });
  await setup.apply((await setup.preview('opencode', { configPath, trust: 'service' })).planId);
  const allowed = JSON.parse(await readFile(configPath, 'utf8')); assert.equal(allowed.permissions[0].effect, 'deny'); assert.equal(allowed.permissions.length, 2); assert.equal(allowed.mcp.servers['saltedfish'].codemode, false);
  await phase(); assert.equal(calls, 1);
  await phase(); assert.equal(calls, 2, 'fresh OpenCode server retains trust');
  await setup.apply((await setup.preview('opencode', { configPath, trust: 'prompt' })).planId);
  const output = await phase(); assert.equal(calls, 2); assert.match(output, /permission|rejected|denied|拒绝|审批|授权/i);
  const report = { version: VERSION, client: await clientVersion(), transport: remote ? 'streamable-http' : 'stdio', requestedModel: 'openai/gpt-6.1-sol#xhigh', passed: true, checks: { generatedConfigLoaded: true, serverTrustPersistsAcrossProcesses: true, twoUnpromptedWrites: true, revokeBlocksDispatch: true, otherToolsRemainDenied: true } };
  await mkdir(path.join(projectDir, '.local/verification'), { recursive: true }); await writeFile(path.join(projectDir, `.local/verification/opencode-trust${remote ? '-remote' : ''}.json`), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await gateway?.close(); await f.cleanup(); await temp.cleanup(); }
