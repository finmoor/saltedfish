import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fixture, freePort, testDirectory } from './helpers.js';
import { AdminSessions, SESSION_CODE_TTL_MS, SESSION_IDLE_MS, SESSION_MAX_MS, SHORT_CODE_ATTEMPTS, bridgeToken } from '../src/auth.js';
import { projectDir, type Config } from '../src/config.js';
import { startServer } from '../src/http-server.js';

// 管理页登录：URL 片段里只放一次性登录码，换成有期限、可撤销、重启即失效的会话令牌；长期管理员密钥不再进入页面可读的存储。
const hex64 = /^[a-f0-9]{64}$/;
const clock = () => { let now = Date.parse('2026-10-25T00:00:00Z'); return { now: () => now, advance: (ms: number) => { now += ms; } }; };
async function api(config: Config, route: string, method: string, token: string) {
  const response = await fetch(`http://127.0.0.1:${config.port}${route}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
}
const login = async (config: Config, credential: string) => { const result = await api(config, '/session', 'POST', credential); assert.equal(result.status, 200); assert.match(result.body.token, hex64); return result.body.token as string; };
const issue = async (config: Config) => { const result = await api(config, '/session/code', 'POST', config.token); assert.equal(result.status, 200); return result.body.code as string; };

test('登录码一次有效；会话令牌不是管理员密钥，也不是桥接或客户端密钥，却能访问管理 API', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const code = await issue(f.config);
  assert.match(code, hex64); assert.notEqual(code, f.config.token);
  const session = await api(f.config, '/session', 'POST', code);
  assert.equal(session.status, 200); assert.match(session.body.token, hex64); assert.notEqual(session.body.token, f.config.token); assert.notEqual(session.body.token, code);
  assert.equal(session.body.idleSeconds, 1800); assert.ok(Date.parse(session.body.expiresAt) > Date.now() && Date.parse(session.body.expiresAt) <= Date.now() + SESSION_MAX_MS + 1000);
  assert.equal((await api(f.config, '/dashboard', 'GET', session.body.token)).status, 200);
  assert.equal((await api(f.config, '/clients', 'GET', session.body.token)).status, 200);
  assert.equal((await api(f.config, '/session', 'POST', code)).status, 401, '登录码用过就作废');
  assert.equal((await api(f.config, '/session', 'POST', '0'.repeat(64))).status, 401);
  assert.equal((await api(f.config, '/session', 'POST', 'x')).status, 401);
  // 其他凭据不能换会话
  for (const credential of [bridgeToken(f.config), f.service.state.createClient('客户端').token, session.body.token]) assert.equal((await api(f.config, '/session', 'POST', credential)).status, 401);
  // 旧链接/手工粘贴的长期管理员密钥仍可换会话，但页面只保存换来的会话
  assert.notEqual(await login(f.config, f.config.token), f.config.token);
});

test('会话令牌不能自我续期成长期凭据：不能签发登录码，也不能撤销全部会话', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const token = await login(f.config, await issue(f.config));
  assert.equal((await api(f.config, '/session/code', 'POST', token)).status, 403);
  assert.equal((await api(f.config, '/sessions', 'DELETE', token)).status, 403);
  assert.equal((await api(f.config, '/session/code', 'POST', 'wrong')).status, 401);
  assert.equal((await api(f.config, '/dashboard', 'GET', token)).status, 200);
});

test('过期：登录码 5 分钟，会话空闲 30 分钟（每次使用顺延）且最长 12 小时', async t => {
  const c = clock(), f = await fixture({ sessions: new AdminSessions(c.now) }); t.after(() => f.cleanup());
  // 登录码
  const stale = await issue(f.config); c.advance(SESSION_CODE_TTL_MS + 1);
  assert.equal((await api(f.config, '/session', 'POST', stale)).status, 401);
  const fresh = await issue(f.config); c.advance(SESSION_CODE_TTL_MS - 1000);
  const token = await login(f.config, fresh);
  // 空闲期限随使用顺延
  for (let i = 0; i < 3; i++) { c.advance(SESSION_IDLE_MS - 1000); assert.equal((await api(f.config, '/dashboard', 'GET', token)).status, 200, `第 ${i + 1} 次`); }
  c.advance(SESSION_IDLE_MS + 1);
  assert.equal((await api(f.config, '/dashboard', 'GET', token)).status, 401, '空闲超过 30 分钟失效');
  // 最长 12 小时：持续使用也不能超过
  const long = await login(f.config, await issue(f.config));
  for (let i = 0; i < 36; i++) { c.advance(SESSION_IDLE_MS - 10 * 60 * 1000); assert.equal((await api(f.config, '/dashboard', 'GET', long)).status, 200); }
  // 36 次 × 20 分钟正好 12 小时：此刻仍有效，再过 1 毫秒就失效，哪怕一直在使用
  c.advance(1);
  assert.equal((await api(f.config, '/dashboard', 'GET', long)).status, 401, '超过 12 小时一定失效');
  assert.deepEqual(f.sessions.stats(), { sessions: 0, pendingCodes: 0 });
});

test('撤销：退出只撤销自己的会话；dashboard --logout-all 的接口撤销全部会话和未使用的登录码', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const a = await login(f.config, await issue(f.config)), b = await login(f.config, await issue(f.config)), unused = await issue(f.config);
  const revoked = await api(f.config, '/session', 'DELETE', a);
  assert.equal(revoked.status, 200); assert.equal(revoked.body.revoked, true);
  assert.equal((await api(f.config, '/dashboard', 'GET', a)).status, 401); assert.equal((await api(f.config, '/dashboard', 'GET', b)).status, 200);
  const all = await api(f.config, '/sessions', 'DELETE', f.config.token);
  assert.equal(all.status, 200); assert.equal(all.body.revoked, 1);
  assert.equal((await api(f.config, '/dashboard', 'GET', b)).status, 401); assert.equal((await api(f.config, '/session', 'POST', unused)).status, 401);
});

test('服务重启后所有会话和登录码失效（只存内存）', async t => {
  const temp = await testDirectory(); t.after(() => temp.cleanup());
  const config: Config = { port: await freePort(), token: randomBytes(32).toString('hex'), dataDir: temp.directory, outputLimit: 24000, eventLimit: 100 };
  const first = await startServer(config);
  let token: string, code: string;
  try { token = await login(config, await issue(config)); code = await issue(config); assert.equal((await api(config, '/dashboard', 'GET', token)).status, 200); } finally { await first.close(); }
  const second = await startServer(config);
  try { assert.equal((await api(config, '/dashboard', 'GET', token)).status, 401); assert.equal((await api(config, '/session', 'POST', code)).status, 401); assert.equal((await api(config, '/dashboard', 'GET', config.token)).status, 200); }
  finally { await second.close(); }
});

const anotherShortCode = (code: string) => code === 'ABCD' ? 'ABCE' : 'ABCD';
test('4 位登录码：手敲容错，用一次就失效，和链接算同一次登录', () => {
  const sessions = new AdminSessions(), first = sessions.issueCode(undefined, true);
  assert.match(first.shortCode!, /^[2-9A-HJKMNP-Z]{4}$/);
  assert.ok(sessions.consumeShort(` ${first.shortCode!.toLowerCase().split('').join(' ')} `), '小写和空格都能用');
  assert.equal(sessions.consumeShort(first.shortCode!), undefined, '用过的不能再用');
  assert.equal(sessions.consume(first.code), undefined, '短码用掉后链接也失效');
  const second = sessions.issueCode(undefined, true);
  assert.ok(sessions.consume(second.code)); assert.equal(sessions.consumeShort(second.shortCode!), undefined, '链接用掉后短码也失效');
  assert.equal(sessions.issueCode().shortCode, undefined, '默认不发短码');
});

test('4 位登录码：输错 5 次作废但链接还能用；只有最新的有效；过期和全部退出都失效', () => {
  let now = 1_000_000; const sessions = new AdminSessions(() => now);
  const limited = sessions.issueCode(undefined, true);
  for (let i = 0; i < SHORT_CODE_ATTEMPTS; i++) assert.equal(sessions.consumeShort(anotherShortCode(limited.shortCode!)), undefined);
  assert.equal(sessions.consumeShort(limited.shortCode!), undefined, '第 6 次即使对了也不行');
  assert.ok(sessions.consume(limited.code), '别人乱试不会把链接也锁掉');
  const almost = sessions.issueCode(undefined, true);
  for (let i = 0; i < SHORT_CODE_ATTEMPTS - 1; i++) sessions.consumeShort(anotherShortCode(almost.shortCode!));
  assert.ok(sessions.consumeShort(almost.shortCode!), '没用完次数时还能登录');
  let old = sessions.issueCode(undefined, true), latest = sessions.issueCode(undefined, true);
  while (latest.shortCode === old.shortCode) { old = latest; latest = sessions.issueCode(undefined, true); }
  assert.equal(sessions.consumeShort(old.shortCode!), undefined, '旧的短码不再有效'); assert.ok(sessions.consumeShort(latest.shortCode!));
  const expired = sessions.issueCode(undefined, true); now += SESSION_CODE_TTL_MS + 1; assert.equal(sessions.consumeShort(expired.shortCode!), undefined);
  const revoked = sessions.issueCode(undefined, true); sessions.revokeAll(); assert.equal(sessions.consumeShort(revoked.shortCode!), undefined);
});

test('POST /session 接受 4 位登录码，没发过短码时 4 位输入一律拒绝；不带 short 参数不发短码', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const issue = async (query = '') => (await api(f.config, '/session/code' + query, 'POST', f.config.token)).body as { code: string; shortCode?: string };
  assert.equal((await api(f.config, '/session', 'POST', 'ABCD')).status, 401);
  const plain = await issue(); assert.equal(plain.shortCode, undefined);
  const { shortCode } = await issue('?short=1'); assert.match(shortCode!, /^[2-9A-HJKMNP-Z]{4}$/);
  const response = await api(f.config, '/session', 'POST', shortCode!.toLowerCase()); assert.equal(response.status, 200);
  assert.equal((await api(f.config, '/dashboard', 'GET', response.body.token)).status, 200);
  assert.equal((await api(f.config, '/session', 'POST', shortCode!)).status, 401, '只能用一次');
});

test('dashboard 命令把一次性登录码放进地址，长期管理员密钥不出现在输出里；--logout-all 撤销现有会话', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  await writeFile(path.join(f.config.dataDir, 'config.json'), JSON.stringify({ port: f.config.port, token: f.config.token, outputLimit: 24000, eventLimit: 100 }));
  const run = (...args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(projectDir, 'src', 'cli.ts'), 'dashboard', ...args], { cwd: projectDir, windowsHide: true, env: { ...process.env, CHROME_MCP_DATA_DIR: f.config.dataDir, SALTEDFISH_NO_BROWSER: '1' } });
    let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('dashboard 命令超时')); }, 60000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  const opened = await run('--onboarding');
  assert.equal(opened.code, 0, opened.stderr);
  const match = new RegExp(`^http://127\\.0\\.0\\.1:${f.config.port}/\\?onboarding=1#([a-f0-9]{64})\\s*$`).exec(opened.stdout);
  assert.ok(match, opened.stdout);
  assert.ok(!opened.stdout.includes(f.config.token) && !opened.stderr.includes(f.config.token) && match[1] !== f.config.token);
  const token = await login(f.config, match[1]!);
  assert.equal((await api(f.config, '/session', 'POST', match[1]!)).status, 401, '地址里的登录码只能用一次');
  const out = await run('--logout-all');
  assert.equal(out.code, 0, out.stderr); assert.equal(JSON.parse(out.stdout).revoked, 1);
  assert.equal((await api(f.config, '/dashboard', 'GET', token)).status, 401);
  const printed = await run(), short = /登录码 ([2-9A-HJKMNP-Z]{4})/.exec(printed.stderr);
  assert.ok(short, printed.stderr); assert.equal(printed.stdout.trim().split('\n').length, 1, 'stdout 还是只有一个地址，脚本不受影响');
  assert.equal((await api(f.config, '/session', 'POST', short[1]!)).status, 200, '终端里显示的登录码能登录');
});

test('管理页脚本不再把长期管理员密钥放进页面可读的存储，只保存会话令牌，并清掉旧版遗留的密钥', async () => {
  const source = await readFile(path.join(projectDir, 'ui', 'app.js'), 'utf8');
  assert.ok(!/sessionStorage\.setItem\(\s*['"]chrome-mcp-token['"]/.test(source), '不再写入旧的长期密钥键');
  assert.match(source, /SESSION_KEY\s*=\s*'chrome-mcp-session'/); assert.match(source, /storage\.set\(SESSION_KEY/);
  assert.match(source, /storage\.remove\(LEGACY_KEY\)/, '遗留的长期密钥读出后立刻删除');
  assert.match(source, /fetch\('\/session',\s*\{\s*method:\s*'POST'/, '登录码/管理员密钥先换会话');
  assert.match(source, /if \(revoke && token\) void fetch\('\/session', \{ method: 'DELETE'/, '主动退出时撤销服务端会话');
  assert.match(source, /onLock:\(\)=>disconnect\('[^']*',\s*true\)/, '“退出管理页”按钮走撤销分支');
});
