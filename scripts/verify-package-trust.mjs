import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2]), launcher = path.join(root, 'SaltedFish.exe');
const version = (await readFile(path.join(root, 'active-version.txt'), 'utf8')).trim();
const { parseCodex } = await import(pathToFileURL(path.join(root, 'versions', version, 'dist/codex-config.js')).href);
const folder = path.join(root, 'data', 'isolated-client-test'); await mkdir(folder);
const codex = path.join(folder, 'codex.toml'), opencode = path.join(folder, 'opencode.jsonc');
const original = '# user settings\napproval_policy="on-request"\nsandbox_mode="read-only"\n'; await writeFile(codex, original);
await writeFile(opencode, '{ // user settings\n "permissions":[{"action":"shell","resource":"*","effect":"deny"}]\n}');
async function run(args) {
  const child = spawn(launcher, ['connect', ...args], { windowsHide: true, cwd: folder, env: { ...process.env, PATH: `${process.env.SystemRoot}\\System32` }, stdio: ['ignore','pipe','pipe'] });
  let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
  const timer = setTimeout(() => child.kill(), 30000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timer));
  assert.equal(code, 0, output.slice(-1500)); return output;
}
await run(['--clients','codex','--config',codex,'--trust-browser']);
const configured = parseCodex(await readFile(codex, 'utf8'));
assert.equal(configured.mcp_servers['saltedfish'].default_tools_approval_mode, 'approve');
assert.equal(configured.mcp_servers['saltedfish'].command, launcher); assert.equal(configured.approval_policy, 'on-request'); assert.equal(configured.sandbox_mode, 'read-only');
const first = JSON.parse(await run(['--history'])).changes[0];
await run(['--clients','codex','--config',codex,'--trust-browser']); assert.equal(JSON.parse(await run(['--history'])).changes.length, 1);
await run(['--clients','opencode','--config',opencode,'--trust-browser']);
const text = await readFile(opencode, 'utf8'); assert.ok(text.includes('// user settings') && text.includes('saltedfish_*') && text.includes('"deny"'));
await run(['--clients','codex','--config',codex,'--revoke-trust']); assert.equal(parseCodex(await readFile(codex, 'utf8')).mcp_servers['saltedfish'].default_tools_approval_mode, 'prompt');
const latest = JSON.parse(await run(['--history'])).changes[0]; await run(['--restore',latest.changeId]); await run(['--restore',first.changeId]);
assert.equal(await readFile(codex, 'utf8'), original);
console.log('PASS installed trust: native launcher, both clients, idempotency, revoke, original bytes restored');
