import { codexTestExecutable } from './local-tools.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { copyFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import { ClientSetup } from '../src/client-setup.js';
import { fixture, fakeProfile, testDirectory, freePort } from './helpers.js';
import { projectDir } from '../src/config.js';
import { startGateway } from '../src/remote-gateway.js';
import { VERSION } from '../src/version.js';

const remote = process.argv.includes('--remote');
const executable = codexTestExecutable();
const temp = await testDirectory(), f = await fixture(), codexHome = path.join(temp.directory, '.codex');
await mkdir(codexHome);
const env = { ...process.env, CODEX_HOME: codexHome, PWD: temp.directory };
const writes: string[] = [];
const profile = await fakeProfile(f.config, 'trust-fixture', command => {
  if (command.operation === 'tabs.list') return [{ tabId: 7, windowId: 1, title: 'Synthetic trust test', url: 'https://fixture.invalid/' }];
  writes.push(command.operation); return { completed: true };
});
let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
async function run(args: string[], prompt = '') {
  const child = spawn(executable, args, { cwd: temp.directory, env, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  child.stdin.end(prompt); let output = '', stderr = '';
  child.stdout.on('data', data => output += data); child.stderr.on('data', data => stderr += data);
  const timer = setTimeout(() => child.kill(), 180000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timer));
  assert.equal(code, 0, stderr.slice(-1500)); return output;
}
async function effective() {
  const child = spawn(executable, ['app-server','--strict-config','--stdio'], { cwd: temp.directory, env, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  child.stderr.resume(); const lines = createInterface({ input: child.stdout });
  const send = (method: string, id: number | undefined, params: unknown) => child.stdin.write(JSON.stringify({ method, ...(id === undefined ? {} : { id }), params }) + '\n');
  try {
    return await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Codex config/read timeout')), 15000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', () => { clearTimeout(timer); reject(new Error('Codex exited before config/read')); });
      lines.on('line', line => {
        const message = JSON.parse(line);
        if (message.error) { clearTimeout(timer); reject(new Error('Codex config error')); }
        if (message.id === 1) { send('initialized', undefined, {}); send('config/read', 2, { includeLayers: false }); }
        if (message.id === 2) { clearTimeout(timer); resolve(message.result.config); }
      });
      send('initialize', 1, { clientInfo: { name: 'feng-trust-test', version: '1' }, capabilities: { experimentalApi: true } });
    });
  } finally { lines.close(); child.stdin.end(); child.kill(); }
}
try {
  // 仅为此隔离进程复用用户已有登录；测试结束连同私有 home 清理，不写回用户登录。
  await copyFile(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json'), path.join(codexHome, 'auth.json'));
  await writeFile(path.join(codexHome, 'config.toml'), 'approval_policy = "never"\nsandbox_mode = "read-only"\nmodel = "gpt-6.1-sol"\nmodel_reasoning_effort = "xhigh"\n[features]\nshell_tool = false\n', { mode: 0o600 });
  await writeFile(path.join(f.config.dataDir, 'config.json'), JSON.stringify(f.config));
  const credential = f.service.state.createClient('trust-test', [profile.id], false), tokenFile = path.join(temp.directory, 'client.token');
  await writeFile(tokenFile, credential.token, { mode: 0o600 });
  let entry: any = { command: process.execPath, args: [path.join(projectDir, 'dist/cli.js'), 'mcp'], env: { CHROME_MCP_DATA_DIR: f.config.dataDir, CHROME_MCP_TOKEN_FILE: tokenFile } };
  if (remote) {
    const device = { id: randomUUID(), label: 'fixture', token: randomBytes(32).toString('hex') };
    const agent = { id: randomUUID(), label: 'codex', token: randomBytes(32).toString('hex'), deviceId: device.id, profiles: [profile.id], readOnly: false };
    const port = await freePort(); gateway = await startGateway({ host: '127.0.0.1', port, devices: [device], agents: [agent] });
    await f.remote.configure({ enabled: true, url: `http://127.0.0.1:${port}`, token: device.token, profiles: [profile.id], readOnly: false });
    for (let i = 0; i < 100 && f.remote.status().state !== 'connected'; i++) await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.remote.status().state, 'connected'); entry = { url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${agent.token}` } };
  }
  const setup = new ClientSetup({ dataDir: temp.directory }, { home: temp.directory, entries: { codex: entry } });
  await setup.apply((await setup.preview('codex', { trust: 'service' })).planId);
  const loaded = await effective(); assert.equal(loaded.mcp_servers['saltedfish'].default_tools_approval_mode, 'approve');
  assert.equal(loaded.approval_policy, 'never'); assert.equal(loaded.sandbox_mode, 'read-only'); assert.equal(loaded.features.shell_tool, false);
  const args = ['exec','--strict-config','--ephemeral','--skip-git-repo-check','--json','-'];
  const prompt = `Only test the saltedfish MCP against a synthetic fixture. No shell, files, other servers, web, subagents or actual browsers. Call chrome_network_stop exactly once with profileId ${profile.id}, tabId 7. This fixture does not have a real browser. If tool approval is denied, report it and stop; never use an alternative. Otherwise report the actual result.`;
  await run(args, prompt); assert.equal(writes.filter(value => value === 'network.stop').length, 1);
  await run(args, prompt); assert.equal(writes.filter(value => value === 'network.stop').length, 2, 'second fresh client process retains server trust');
  await setup.apply((await setup.preview('codex', { trust: 'prompt' })).planId);
  const revoked = await effective(); assert.equal(revoked.mcp_servers['saltedfish'].default_tools_approval_mode, 'prompt');
  const blocked = await run(args, prompt); assert.equal(writes.filter(value => value === 'network.stop').length, 2);
  assert.match(blocked, /approval|denied|permission|审批|授权/i);
  const report = { version: VERSION, client: (await run(['--version'])).trim(), transport: remote ? 'streamable-http' : 'stdio', requestedModel: 'gpt-6.1-sol', reasoning: 'xhigh', passed: true, checks: { generatedConfigLoaded: true, serverTrustPersistsAcrossProcesses: true, twoUnpromptedWrites: true, revokeBlocksDispatch: true, globalPoliciesUnchanged: true } };
  await mkdir(path.join(projectDir, '.local/verification'), { recursive: true });
  await writeFile(path.join(projectDir, `.local/verification/codex-trust${remote ? '-remote' : ''}.json`), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await gateway?.close(); await f.cleanup(); await temp.cleanup(); }
