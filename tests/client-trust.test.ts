import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { ClientSetup } from '../src/client-setup.js';
import { mergeCodex, parseCodex } from '../src/codex-config.js';
import { testDirectory } from './helpers.js';
import { VERSION } from '../src/version.js';
import { toolMap } from '../src/tools.js';

const entry = { command: 'C:/Chrome MCP/program.exe', args: ['mcp'], env: { CHROME_MCP_TOKEN_FILE: 'private/client.token' } };
const verify = async () => ({ tools: 51, profiles: 0 });

test('Codex TOML 合并按语法范围定位，保留全局策略、其他服务、注释、BOM/CRLF 和工具例外', async () => {
  const temp = await testDirectory();
  try {
    const target = path.join(temp.directory, 'config.toml');
    const other = '[mcp_servers.other]\r\ncommand = "untouched" # keep\r\n';
    const source = '\ufeff# user\r\napproval_policy = "on-request"\r\nsandbox_mode = "read-only"\r\nmodel = "unchanged"\r\n[mcp_servers."saltedfish"]\r\ncommand = "old"\r\n' + other + '[mcp_servers.saltedfish.tools.chrome_click]\r\napproval_mode = "prompt"\r\n';
    await writeFile(target, source);
    const setup = new ClientSetup({ dataDir: temp.directory }, { home: temp.directory, entries: { codex: entry }, verify });
    const plan = await setup.preview('codex', { configPath: target, trust: 'service' });
    assert.ok(plan.notices.some(note => note.includes('逐工具例外'))); assert.ok(!JSON.stringify(plan).includes('private/client.token'));
    const result = await setup.apply(plan.planId), text = await readFile(target, 'utf8'), data = parseCodex(text);
    assert.ok(text.startsWith('\ufeff# user\r\n')); assert.ok(text.includes(other)); assert.ok(!text.replaceAll('\r\n', '').includes('\n'));
    assert.equal(data.approval_policy, 'on-request'); assert.equal(data.sandbox_mode, 'read-only'); assert.equal(data.model, 'unchanged');
    assert.equal(data.mcp_servers['saltedfish'].default_tools_approval_mode, 'approve');
    assert.equal(data.mcp_servers['saltedfish'].tools.chrome_click.approval_mode, 'prompt');
    assert.deepEqual(data.mcp_servers['saltedfish'].env, {...entry.env,SALTEDFISH_CATALOG_VERSION:VERSION});
    const repeat = await setup.preview('codex', { configPath: target, trust: 'service' }); assert.equal(repeat.unchanged, true);
    const historyCount = (await setup.history()).length; await setup.apply(repeat.planId); assert.equal((await setup.history()).length, historyCount);
    assert.ok(result.changeId); await new ClientSetup({ dataDir: temp.directory }).restore(result.changeId);
    assert.equal(await readFile(target, 'utf8'), source);
  } finally { await temp.cleanup(); }
});

test('Codex 点分键、内联表、多行字符串与恶意同名注释不会误改其他表', () => {
  const forms = [
    'mcp_servers = { other = { command = "keep" }, "saltedfish" = {command = "old"}}\n',
    '[mcp_servers]\nother = { command = "keep" }\nsaltedfish.command = "old"\n',
    'mcp_servers.saltedfish.command = "old"\nmcp_servers.other.command = "keep"\n',
    '# [mcp_servers.saltedfish]\nnotes = """\n[mcp_servers.saltedfish]\n"""\n[mcp_servers.other]\ncommand="keep"\n',
  ];
  for (const source of forms) {
    const after = mergeCodex(source, { command: 'new', env: { VALUE: '路径\\x\nvalue' }, default_tools_approval_mode: 'approve' });
    const parsed = parseCodex(after); assert.equal(parsed.mcp_servers.other.command, 'keep'); assert.equal(parsed.mcp_servers['saltedfish'].command, 'new');
    if (source.includes('notes =')) assert.equal(parsed.notes, '\n[mcp_servers.saltedfish]\n'.slice(1));
  }
  for (const source of ['model="a"\nmodel="b"', '[mcp_servers.saltedfish\n', 'mcp_servers="wrong"']) assert.throws(() => mergeCodex(source, { command: 'new' }));
});

test('Codex 默认/项目路径，远程替换清理旧传输，撤销信任恢复逐工具审批且冲突不覆盖', async () => {
  const temp = await testDirectory();
  try {
    await mkdir(path.join(temp.directory, '.codex'));
    const target = path.join(temp.directory, '.codex/config.toml');
    await writeFile(target, '[mcp_servers.saltedfish]\ncommand="old"\nenv={ OLD="unused" }\ntools={ chrome_action={ approval_mode="approve" } }\n');
    const setup = new ClientSetup({ dataDir: temp.directory }, { home: temp.directory, entries: { codex: { url: 'http://127.0.0.1:18444/mcp', headers: { Authorization: 'Bearer fixture-secret' } } }, verify });
    const plan = await setup.preview('codex', { trust: 'service' }); assert.equal(plan.target, target);
    await setup.apply(plan.planId); let server = parseCodex(await readFile(target, 'utf8')).mcp_servers['saltedfish'];
    assert.equal(server.command, undefined); assert.equal(server.env, undefined); assert.equal(server.http_headers.Authorization, 'Bearer fixture-secret');
    await setup.apply((await setup.preview('codex', { trust: 'prompt' })).planId); server = parseCodex(await readFile(target, 'utf8')).mcp_servers['saltedfish'];
    assert.equal(server.default_tools_approval_mode, 'prompt'); assert.equal(server.tools.chrome_action.approval_mode, 'prompt');
    const stale = await setup.preview('codex', { trust: 'service' }); await writeFile(target, '# manual change\n');
    await assert.rejects(setup.apply(stale.planId), { code: 'CLIENT_CONFIG_CHANGED' }); assert.equal(await readFile(target, 'utf8'), '# manual change\n');
    assert.equal((await setup.preview('codex', { projectDirectory: temp.directory })).target, target);
  } finally { await temp.cleanup(); }
});

test('OpenCode 2 一次信任仅修改此服务的工具规则，幂等、不开放 execute、可恢复审批', async () => {
  const temp = await testDirectory();
  try {
    const target = path.join(temp.directory, 'opencode.jsonc');
    const original = '\ufeff{\r\n // user config\r\n "permissions":[{"action":"*","resource":"*","effect":"ask"},{"action":"shell","resource":"*","effect":"deny"}],\r\n "mcp":{"servers":{"other":{"type":"local","command":["keep"]}}},\r\n}\r\n';
    await writeFile(target, original);
    const setup = new ClientSetup({ dataDir: temp.directory }, { home: temp.directory, entries: { opencode: entry }, verify });
    const select = { configPath: target, trust: 'service' as const };
    const applied = await setup.apply((await setup.preview('opencode', select)).planId);
    let text = await readFile(target, 'utf8'), result = parse(text.slice(1));
    assert.ok(text.includes('// user config')); assert.equal(result.mcp.servers['saltedfish'].codemode, false);
    assert.deepEqual(result.permissions, [{ action: '*', resource: '*', effect: 'ask' }, { action: 'shell', resource: '*', effect: 'deny' }, { action: 'saltedfish_*', resource: '*', effect: 'allow' }]);
    assert.equal(result.mcp.servers.other.command[0], 'keep');
    assert.equal((await setup.preview('opencode', select)).unchanged, true);
    assert.ok(applied.changeId); await setup.restore(applied.changeId); assert.equal(await readFile(target, 'utf8'), original);
    await setup.apply((await setup.preview('opencode', select)).planId);
    await setup.apply((await setup.preview('opencode', { ...select, trust: 'prompt' })).planId);
    result = parse((await readFile(target, 'utf8')).slice(1)); assert.equal(result.permissions.at(-1).effect, 'ask');
    await assert.rejects(setup.preview('opencode', { ...select, format: 'v1' }), { code: 'TRUST_UNSUPPORTED' });
    await writeFile(target, '{"permissions":{"*":"allow"}}'); await assert.rejects(setup.preview('opencode', select), { code: 'CLIENT_CONFIG_INVALID' });
    await writeFile(target, '{"mcp":{"servers":{"saltedfish_other":{"type":"local","command":["other"]}}}}');
    await assert.rejects(setup.preview('opencode', select), { code: 'TRUST_NAMESPACE_CONFLICT' });
  } finally { await temp.cleanup(); }
});

test('一次信任预览如实说明授权范围：能做什么、服务端仍限制什么、撤销撤不回什么', async () => {
  const temp = await testDirectory();
  try {
    const setup = new ClientSetup({ dataDir: temp.directory }, { home: temp.directory, entries: { codex: entry, opencode: entry }, verify });
    const file = (client: string) => path.join(temp.directory, client === 'codex' ? 'config.toml' : 'opencode.json');
    for (const client of ['codex', 'opencode'] as const) {
      const plan = await setup.preview(client, { configPath: file(client), trust: 'service' }), text = plan.notices.join('\n');
      // 授予了什么：说出的每种能力都对应一个真实存在、且需要写权限的 MCP 工具——一次信任正是让这些调用不再逐次确认。
      for (const [fact, tools] of [['点击', ['chrome_action']], ['输入', ['chrome_action']], ['页面脚本', ['chrome_evaluate']], ['读取页面', ['chrome_inspect', 'chrome_accessibility']], ['截图', ['chrome_screenshot']]] as const) {
        assert.ok(text.includes(fact), `${client}：说明里缺少“${fact}”`);
        for (const name of tools) assert.ok(toolMap.has(name), `${name} 不存在，说明里的“${fact}”已失实`);
      }
      for (const name of ['chrome_action', 'chrome_evaluate']) assert.equal(toolMap.get(name)!.readOnly, false, `${name} 是写工具：一次信任之后不再逐次确认`);
      assert.match(text, /已登录的身份/, `${client}：要说明是以浏览器里已登录的身份操作网站`);
      // 服务端仍然限制什么：管理页保护、授权范围与只读、只接本机 Agent；文件路径交给 Agent 自己的权限设置，只拦数据目录
      for (const fact of ['授权给该客户端的 Chrome 配置', '只读授权不能执行写操作', '服务管理页', '扩展自身页面', '不能被读取或操作', '不能把标签页导航到它们', '标签页列表里隐藏', '只能从服务所在的电脑连接', '自己的权限设置', '数据目录', 'Chrome 下载的那个文件']) assert.ok(text.includes(fact), `${client}：说明里缺少“${fact}”`);
      // 撤销：只管之后的调用
      assert.match(text, /撤销只阻止之后的调用，已发出的操作不会撤回/);
      assert.match(text, /并不撤销该客户端在 SaltedFish 的授权/);
      // 旧文案的笼统说法不能回来：它曾让人以为范围约束总是成立
      assert.ok(!text.includes('范围仍受本机客户端授权与远程账号选择限制'), `${client}：旧的笼统说法不应保留`);
      assert.ok(!text.includes('上传和页面脚本'), `${client}：旧文案把上传和页面脚本并列成无条件能力`);
    }
    // 保留审批的接入不改变审批，不应带一次信任的授权说明；撤销预览要说明撤销的边界
    assert.ok(!(await setup.preview('codex', { configPath: file('codex'), trust: 'preserve' })).notices.join('\n').includes('一次信任'));
    const revoke = (await setup.preview('codex', { configPath: file('codex'), trust: 'prompt' })).notices.join('\n');
    assert.match(revoke, /交回客户端审批/); assert.match(revoke, /已发出的操作不会撤回/); assert.match(revoke, /不会撤销该客户端在 SaltedFish 的授权/);
  } finally { await temp.cleanup(); }
});

test('inspect 遇到畸形的 permissions 规则（null 等）不崩溃：忽略它、照常判断信任；写入预览仍拒绝', async () => {
  const temp = await testDirectory();
  try {
    const target = path.join(temp.directory, 'opencode.jsonc'), selection = { configPath: target };
    const setup = new ClientSetup({ dataDir: temp.directory }, { home: temp.directory, entries: { opencode: entry }, verify });
    await setup.apply((await setup.preview('opencode', { ...selection, trust: 'service' })).planId);
    const good = parse(await readFile(target, 'utf8'));
    assert.equal((await setup.inspect('opencode', selection) as { trusted?: boolean }).trusted, true);
    // 规则数组里混入 null：该条不可能匹配，真正的 allow 规则仍然算数；旧实现读 null.action 抛 TypeError，管理页的接入检查直接失败
    await writeFile(target, JSON.stringify({ ...good, permissions: [null, 5, 'x', ...good.permissions] }));
    const mixed = await setup.inspect('opencode', selection) as { connection: string; trusted?: boolean };
    assert.equal(mixed.connection, 'configured'); assert.equal(mixed.trusted, true);
    await writeFile(target, JSON.stringify({ ...good, permissions: [null] }));
    assert.equal((await setup.inspect('opencode', selection) as { trusted?: boolean }).trusted, false);
    // 改写权限的路径仍把畸形规则当作无效配置拒绝，不会在它上面叠加新规则
    await assert.rejects(setup.preview('opencode', { ...selection, trust: 'service' }), { code: 'CLIENT_CONFIG_INVALID' });
  } finally { await temp.cleanup(); }
});
