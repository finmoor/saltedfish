import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { access, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeNativeSettingsMessage, readNativeSettingsMessage, runNativeSettings, type NativeSettingsResponse } from '../src/native-settings.js';
import { fixture, freePort, testDirectory } from './helpers.js';
import { projectDir, type Config } from '../src/config.js';

const origin = `chrome-extension://${'a'.repeat(32)}/`;
const otherOrigin = `chrome-extension://${'b'.repeat(32)}/`;
const profile = '00000000-0000-4000-8000-000000000001';
const request = (target = 'setup') => encodeNativeSettingsMessage({ action: 'open-settings', target });
function decode(bytes: Buffer): NativeSettingsResponse {
  assert.ok(bytes.length >= 5); assert.equal(bytes.readUInt32LE(), bytes.length - 4);
  return JSON.parse(bytes.subarray(4).toString()) as NativeSettingsResponse;
}
async function registered(config: Pick<Config, 'dataDir' | 'port' | 'token'>) {
  await mkdir(path.join(config.dataDir, 'native-settings'), { recursive: true });
  await writeFile(path.join(config.dataDir, 'config.json'), JSON.stringify({ port: config.port, token: config.token }));
  await writeFile(path.join(config.dataDir, 'native-settings', 'host.json'), JSON.stringify({ name: `com.saltedfish.settings.p${config.port}`, type: 'stdio', allowed_origins: [origin] }));
}
async function invoke(dataDir: string, message = request(), args = [origin], timeoutMs = 1000) {
  const output = new PassThrough(), chunks: Buffer[] = []; output.on('data', chunk => chunks.push(Buffer.from(chunk)));
  await runNativeSettings(dataDir, args, { input: Readable.from([message]), output, timeoutMs });
  return decode(Buffer.concat(chunks));
}
function safeFailure(value: NativeSettingsResponse, code: string, secrets: string[] = []) {
  assert.equal(value.ok, false); if (value.ok) assert.fail('unexpected success');
  assert.equal(value.error.code, code); assert.equal('url' in value, false);
  for (const secret of secrets) assert.ok(!JSON.stringify(value).includes(secret));
}

test('Native Messaging 帧支持拆开的头和 UTF-8 正文，完整后不等待 EOF', async () => {
  const message = { value: '汉字', action: 'open-settings', target: 'setup' }, frame = encodeNativeSettingsMessage(message), input = new PassThrough();
  const result = readNativeSettingsMessage(input);
  for (let offset = 0; offset < frame.length; offset++) input.write(frame.subarray(offset, offset + 1));
  assert.deepEqual(await result, message); assert.equal(input.listenerCount('data'), 0); input.destroy();
});

test('Native Messaging 拒绝过长、空、截断、额外帧、坏 JSON 与坏 UTF-8', async () => {
  const oversized = Buffer.alloc(4); oversized.writeUInt32LE(4097);
  const invalidUtf8 = Buffer.from([1, 0, 0, 0, 255]);
  const frame = request();
  for (const value of [oversized, Buffer.alloc(4), frame.subarray(0, 3), frame.subarray(0, frame.length - 1), Buffer.concat([frame, frame]), Buffer.from([1, 0, 0, 0, 123]), invalidUtf8]) {
    await assert.rejects(readNativeSettingsMessage(Readable.from([value])), /设置请求无效/);
  }
  assert.throws(() => encodeNativeSettingsMessage('a'.repeat(4096)), /设置请求无效/);
});

test('Native Messaging 无输入会到期并移除监听器', async () => {
  const input = new PassThrough(); await assert.rejects(readNativeSettingsMessage(input, 15), /打开设置超时/);
  for (const event of ['data', 'end', 'error', 'close']) assert.equal(input.listenerCount(event), 0);
  input.destroy();
});

test('Native Messaging 严格 caller origin 与 argv 拒绝不生成配置', async t => {
  const temp = await testDirectory(); t.after(() => temp.cleanup());
  const dataDir = path.join(temp.directory, 'missing'), args = [[], ['https://example.test/'], [origin.slice(0, -1)], [origin + '\n'], [origin, '--parent-window=-1'], [origin, '--parent-window=1\n'], [origin, '--parent-window=1', '--extra'], [origin.toUpperCase()], [`chrome-extension://${'q'.repeat(32)}/`]];
  for (const argv of args) safeFailure(await invoke(dataDir, request(), argv), 'CALLER_NOT_ALLOWED', [dataDir]);
  safeFailure(await invoke(dataDir), 'SETTINGS_UNAVAILABLE', [dataDir]);
  await assert.rejects(access(dataDir));
});

test('Native Messaging 仅登记的扩展和白名单目标能签码，非法请求不耗费码', async t => {
  const f = await fixture(); t.after(() => f.cleanup()); await registered(f.config);
  safeFailure(await invoke(f.config.dataDir, request(), [otherOrigin]), 'CALLER_NOT_ALLOWED');
  for (const target of ['https://other.test/', 'setup?add=1', 'remote#token', 'agents?profile=bad', 'agents?add=1&add=1', 'agents?add=%31', 'agents?add=1&', 'overview/../remote']) {
    safeFailure(await invoke(f.config.dataDir, request(target)), 'INVALID_REQUEST');
  }
  for (const message of [{ action: 'execute', target: 'setup' }, { action: 'open-settings', target: 'remote', command: 'stop' }, { action: 'open-settings', target: { route: 'setup' } }]) {
    safeFailure(await invoke(f.config.dataDir, encodeNativeSettingsMessage(message)), 'INVALID_REQUEST');
  }
  assert.equal(f.sessions.stats().pendingCodes, 0);
});

test('Native Messaging 返回固定本机目标的一次码，管理员密钥不出进程', async t => {
  const f = await fixture(); t.after(() => f.cleanup()); await registered(f.config);
  const before = await readFile(path.join(f.config.dataDir, 'config.json'));
  for (const target of ['overview', 'setup', 'remote', `agents?profile=${profile}&add=1`]) {
    const value = await invoke(f.config.dataDir, request(target), [origin, '--parent-window=123']);
    assert.equal(value.ok, true); if (!value.ok) assert.fail('unexpected failure');
    assert.ok(!value.url.includes(f.config.token)); assert.ok(!value.url.includes(f.config.dataDir));
    const url = new URL(value.url); assert.equal(url.origin, `http://127.0.0.1:${f.config.port}`); assert.equal(url.pathname, '/');
    assert.equal(url.searchParams.get('target'), target.split('?')[0]); assert.match(url.hash, /^#[a-f0-9]{64}$/);
    if (target.startsWith('agents')) { assert.equal(url.searchParams.get('profile'), profile); assert.equal(url.searchParams.get('add'), '1'); }
    const redeem = () => fetch(`${url.origin}/session`, { method: 'POST', headers: { Authorization: `Bearer ${url.hash.slice(1)}`, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal((await redeem()).status, 200); assert.equal((await redeem()).status, 401);
  }
  assert.deepEqual(await readFile(path.join(f.config.dataDir, 'config.json')), before);
  assert.equal(f.sessions.stats().pendingCodes, 0);
});

test('Native Messaging 未运行服务、认证拒绝及损坏登记只输出通用错误，不写数据', async t => {
  const temp = await testDirectory(); t.after(() => temp.cleanup());
  const config = { dataDir: temp.directory, port: await freePort(), token: 'c'.repeat(64) }; await registered(config);
  const before = await readdir(temp.directory);
  safeFailure(await invoke(config.dataDir), 'SETTINGS_UNAVAILABLE', [config.token, config.dataDir]);
  assert.deepEqual(await readdir(temp.directory), before);
  await writeFile(path.join(config.dataDir, 'native-settings', 'host.json'), JSON.stringify({ allowed_origins: ['*'] }));
  safeFailure(await invoke(config.dataDir), 'SETTINGS_UNAVAILABLE', [config.token, config.dataDir]);
  const f = await fixture(); t.after(() => f.cleanup()); await registered({ ...f.config, token: config.token });
  safeFailure(await invoke(f.config.dataDir), 'SETTINGS_UNAVAILABLE', [f.config.token, config.token, f.config.dataDir]);
  assert.equal(f.sessions.stats().pendingCodes, 0);
});

test('Native Messaging 不跟随签码接口重定向，限制响应体且拒绝回传长期密钥', async t => {
  const temp = await testDirectory(); t.after(() => temp.cleanup());
  const config = { dataDir: temp.directory, port: await freePort(), token: 'd'.repeat(64) }; await registered(config);
  let mode = 'redirect', requests = 0;
  const server = createServer((request, response) => {
    requests++; assert.equal(request.url, '/session/code'); assert.equal(request.headers.authorization, `Bearer ${config.token}`);
    if (mode === 'redirect') { response.writeHead(302, { Location: `http://127.0.0.1:${config.port}/must-not-follow` }); response.end(); }
    else if (mode === 'large') response.end(JSON.stringify({ code: 'e'.repeat(64), extra: 'x'.repeat(5000) }));
    else response.end(JSON.stringify({ code: config.token, detail: config.dataDir }));
  });
  await new Promise<void>(resolve => server.listen(config.port, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  for (mode of ['redirect', 'large', 'master']) safeFailure(await invoke(config.dataDir), 'SETTINGS_UNAVAILABLE', [config.token, config.dataDir]);
  assert.equal(requests, 3);
});

test('Windows 原生 host 实际二进制保持帧与中文路径，校验双名单并丢弃 stderr', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const f = await fixture(); t.after(() => f.cleanup()); await registered(f.config);
  const directory = path.join(f.config.dataDir, 'native-settings'), executable = path.join(directory, 'SaltedFish.NativeSettings.exe'), entry = path.join(f.config.dataDir, '中文 固定入口.mjs');
  await copyFile(path.join(projectDir, 'dist/native-settings/SaltedFish.NativeSettings.exe'), executable);
  await writeFile(entry, `import {runNativeSettings} from ${JSON.stringify(pathToFileURL(path.join(projectDir, 'src/native-settings.ts')).href)}; process.stderr.write(${JSON.stringify(f.config.token)}); await runNativeSettings(process.env.CHROME_MCP_DATA_DIR,process.argv.slice(3)); process.stdin.destroy();`);
  const descriptor = { product: 'saltedfish-native-settings', port: f.config.port, dataDir: f.config.dataDir, command: process.execPath, args: ['--import', 'tsx', entry], allowedOrigins: [origin] };
  await writeFile(path.join(directory, 'native-launch.json'), JSON.stringify(descriptor));
  const manifest = { name: `com.saltedfish.settings.p${f.config.port}`, type: 'stdio', path: executable, allowed_origins: [origin] };
  await writeFile(path.join(directory, 'host.json'), JSON.stringify(manifest));
  async function call(argv: string[], message = request()) {
    const child = spawn(executable, argv, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [], stderr: Buffer[] = []; child.stdout.on('data', value => stdout.push(Buffer.from(value))); child.stderr.on('data', value => stderr.push(Buffer.from(value))); child.stdin.on('error', () => {});
    const timeout = setTimeout(() => child.kill(), 15000); const closed = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', () => resolve()); });
    child.stdin.end(message); await closed.finally(() => clearTimeout(timeout));
    assert.equal(Buffer.concat(stderr).length, 0); assert.ok(!Buffer.concat(stdout).includes(f.config.token)); return decode(Buffer.concat(stdout));
  }
  const success = await call([origin, '--parent-window=1'], request('remote')); assert.equal(success.ok, true);
  if (success.ok) assert.equal(new URL(success.url).searchParams.get('target'), 'remote');
  const count = f.sessions.stats().pendingCodes;
  for (const args of [[otherOrigin], [origin, '--parent-window=-1'], [origin, '--arbitrary'], [origin, '--parent-window=1', 'extra']]) safeFailure(await call(args), 'CALLER_NOT_ALLOWED');
  await writeFile(path.join(directory, 'host.json'), JSON.stringify({ ...manifest, allowed_origins: [origin, otherOrigin] }));
  safeFailure(await call([origin]), 'SETTINGS_UNAVAILABLE'); assert.equal(f.sessions.stats().pendingCodes, count);
});

test('Windows 原生 host 的坏入口不读 stdin 时仍超时，并结束它的子进程', { skip: process.platform !== 'win32', timeout: 25000 }, async t => {
  const temp = await testDirectory(); t.after(() => temp.cleanup());
  const config = { dataDir: temp.directory, port: await freePort(), token: 'f'.repeat(64) }; await registered(config);
  const directory = path.join(config.dataDir, 'native-settings'), executable = path.join(directory, 'SaltedFish.NativeSettings.exe'), entry = path.join(config.dataDir, 'unresponsive.mjs'), marker = path.join(config.dataDir, 'owned-pids.json');
  await copyFile(path.join(projectDir, 'dist/native-settings/SaltedFish.NativeSettings.exe'), executable);
  await writeFile(entry, `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`);
  await writeFile(path.join(directory, 'native-launch.json'), JSON.stringify({ product: 'saltedfish-native-settings', port: config.port, dataDir: config.dataDir, command: process.execPath, args: [entry], allowedOrigins: [origin] }));
  await writeFile(path.join(directory, 'host.json'), JSON.stringify({ name: `com.saltedfish.settings.p${config.port}`, type: 'stdio', path: executable, allowed_origins: [origin] }));
  const child = spawn(executable, [origin], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }), stdout: Buffer[] = [], stderr: Buffer[] = [];
  t.after(() => { if (child.exitCode === null) child.kill(); });
  child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk))); child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk))); child.stdin.on('error', () => {});
  const started = Date.now(), timeout = setTimeout(() => child.kill(), 17000);
  child.stdin.end(encodeNativeSettingsMessage({ x: 'x'.repeat(4088) }));
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', () => resolve()); }).finally(() => clearTimeout(timeout));
  safeFailure(decode(Buffer.concat(stdout)), 'SETTINGS_UNAVAILABLE'); assert.equal(Buffer.concat(stderr).length, 0); assert.ok(Date.now() - started < 16000);
  const pids = JSON.parse(await readFile(marker, 'utf8')) as number[];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let attempts = 0; attempts < 50 && pids.some(alive); attempts++) await delay(20);
  const remaining = pids.filter(alive);
  // 若回归失败，仅结束夹具自己记录的两个进程，不触碰任何已安装服务。
  for (const pid of remaining) process.kill(pid);
  assert.deepEqual(remaining, [], 'wrapper 退出必须结束固定入口的全部子进程');
});
