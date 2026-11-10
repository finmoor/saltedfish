import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ClientSetup } from '../src/client-setup.js';
import { clientDocument } from '../src/client-document.js';
import { projectDir } from '../src/config.js';
import { testDirectory } from './helpers.js';

test('OpenCode 混合格式在检测、预览和连接检查中一致拒绝，显式格式不可被忽略', async () => {
  const temp = await testDirectory();
  try {
    const target = path.join(temp.directory, 'opencode.jsonc');
    const entry = { command: 'known-program', args: ['mcp'], env: {} };
    const local = { type: 'local', command: ['known-program', 'mcp'], environment: {} };
    let verified = 0;
    const setup = new ClientSetup({ dataDir: temp.directory }, { home: temp.directory, entries: { opencode: entry }, verify: async () => { verified++; return { tools: 51, profiles: 0 }; } });
    const selection = { configPath: target };
    await writeFile(target, JSON.stringify({ mcp: { 'saltedfish': local, servers: { 'saltedfish': local } } }));
    for (const method of ['inspect', 'preview', 'check'] as const) await assert.rejects(setup[method]('opencode', selection), { code: 'MIXED_OPENCODE_CONFIG' });
    assert.equal(verified, 0);
    await writeFile(target, JSON.stringify({ mcp: { 'saltedfish': local } }));
    assert.equal((await setup.inspect('opencode', selection)).format, 'v1');
    await setup.preview('opencode', selection);
    for (const method of ['inspect', 'preview', 'check'] as const) await assert.rejects(setup[method]('opencode', { ...selection, format: 'v2' }), { code: 'LEGACY_OPENCODE_CONFIG' });
    await writeFile(target, JSON.stringify({ mcp: { servers: { 'saltedfish': local } } }));
    for (const method of ['inspect', 'preview', 'check'] as const) await assert.rejects(setup[method]('opencode', { ...selection, format: 'v1' }), { code: 'MODERN_OPENCODE_CONFIG' });
    assert.equal(verified, 0);
  } finally { await temp.cleanup(); }
});

// ---- 接入向导不再自带第二套文档判定（maintainability:6）----
// beta.21 把 inspect / check / preview 的格式与条目判定统一到 client-document.ts；向导里留下的旧校验不可达，却会让人误以为那里还有一道有效校验。
// 下面两个用例：一个钉住“向导的结论与 clientDocument 完全一致”（清理前后都应通过），一个守住“规则只在 client-document.ts 里”（清理前失败）。
const LOCAL = '{"type":"local","command":["known-program","mcp"],"environment":{}}', CLAUDE_ENTRY = '{"command":"known-program","args":["mcp"],"env":{}}';
const documents: { client: 'claude' | 'codex' | 'opencode'; name: string; text: string }[] = [
  { client: 'opencode', name: '空对象', text: '{}' },
  { client: 'opencode', name: 'v1 条目', text: `{"mcp":{"saltedfish":${LOCAL}}}` },
  { client: 'opencode', name: 'v2 条目', text: `{"mcp":{"servers":{"saltedfish":${LOCAL}}}}` },
  { client: 'opencode', name: 'v1 与 v2 条目并存', text: `{"mcp":{"saltedfish":${LOCAL},"servers":{"saltedfish":${LOCAL}}}}` },
  { client: 'opencode', name: '旧版 permission', text: '{"permission":{"*":"ask"}}' },
  { client: 'opencode', name: '新版 permissions', text: '{"permissions":[]}' },
  { client: 'opencode', name: 'permission 与 permissions 并存', text: '{"permission":{},"permissions":[]}' },
  { client: 'opencode', name: '新版空 servers', text: '{"mcp":{"servers":{}}}' },
  { client: 'opencode', name: '中性 mcp.timeout', text: '{"mcp":{"timeout":5}}' },
  { client: 'opencode', name: '旧版其他 MCP', text: '{"mcp":{"other":{"type":"local","command":["o"]}}}' },
  { client: 'opencode', name: '旧版 permission + 新版 servers', text: `{"permission":{},"mcp":{"servers":{"saltedfish":${LOCAL}}}}` },
  { client: 'opencode', name: '新版 permissions + 旧版条目', text: `{"permissions":[],"mcp":{"saltedfish":${LOCAL}}}` },
  { client: 'opencode', name: 'servers 为 null', text: '{"mcp":{"servers":null}}' },
  { client: 'opencode', name: 'mcp 为字符串', text: '{"mcp":"x"}' },
  { client: 'opencode', name: 'v1 条目为 null', text: '{"mcp":{"saltedfish":null}}' },
  { client: 'opencode', name: 'v2 条目为字符串', text: '{"mcp":{"servers":{"saltedfish":"x"}}}' },
  { client: 'opencode', name: 'v2 条目为数组', text: '{"mcp":{"servers":{"saltedfish":[]}}}' },
  { client: 'opencode', name: 'v2 条目已停用', text: '{"mcp":{"servers":{"saltedfish":{"enabled":false}}}}' },
  { client: 'opencode', name: '重复键', text: '{"mcp":{"servers":{"saltedfish":{},"saltedfish":{}}}}' },
  { client: 'opencode', name: 'BOM + JSONC 注释 + 尾逗号', text: '\ufeff{ // 注释\n "mcp": {"servers": {"other": {"type":"local","command":["o"]},},},\n}' },
  { client: 'opencode', name: '不完整 JSON', text: '{"mcp":' },
  { client: 'opencode', name: '顶层不是对象', text: '[]' },
  // 手工改坏的条目字段：形状合法（条目是对象），所以由 inspect 自己归类为“不同的连接”，不能冒出原始 TypeError
  { client: 'opencode', name: 'v2 条目 command 是数字', text: '{"mcp":{"servers":{"saltedfish":{"type":"local","command":5,"environment":{}}}}}' },
  { client: 'opencode', name: 'v2 条目 environment 是 null', text: '{"mcp":{"servers":{"saltedfish":{"type":"local","command":["known-program","mcp"],"environment":null}}}}' },
  { client: 'opencode', name: 'v1 条目 command 是布尔值', text: '{"mcp":{"saltedfish":{"type":"local","command":true,"enabled":true}}}' },
  { client: 'opencode', name: 'v2 远程条目 headers 是 null', text: '{"mcp":{"servers":{"saltedfish":{"type":"remote","url":"http://127.0.0.1:1/mcp","headers":null}}}}' },
  { client: 'claude', name: '条目 env 是 null', text: '{"mcpServers":{"saltedfish":{"command":"known-program","args":["mcp"],"env":null}}}' },
  { client: 'claude', name: '远程条目 headers 是 null', text: '{"mcpServers":{"saltedfish":{"url":"http://127.0.0.1:1/mcp","headers":null}}}' },
  { client: 'claude', name: '空对象', text: '{}' },
  { client: 'claude', name: '已有条目', text: `{"mcpServers":{"saltedfish":${CLAUDE_ENTRY}}}` },
  { client: 'claude', name: 'mcpServers 为 null', text: '{"mcpServers":null}' },
  { client: 'claude', name: 'mcpServers 为数组', text: '{"mcpServers":[]}' },
  { client: 'claude', name: '条目为 null', text: '{"mcpServers":{"saltedfish":null}}' },
  { client: 'claude', name: '条目为字符串', text: '{"mcpServers":{"saltedfish":"x"}}' },
  { client: 'claude', name: '条目为数组', text: '{"mcpServers":{"saltedfish":[]}}' },
  { client: 'claude', name: '重复键', text: '{"mcpServers":{},"mcpServers":{}}' },
  { client: 'claude', name: 'Claude 配置不接受注释', text: '{ // 注释\n "mcpServers": {} }' },
  { client: 'claude', name: 'BOM', text: '\ufeff{"mcpServers":{}}' },
  { client: 'codex', name: '空文件', text: '' },
  { client: 'codex', name: '已有条目', text: '[mcp_servers.saltedfish]\ncommand = "old"\n' },
  { client: 'codex', name: 'mcp_servers 为字符串', text: 'mcp_servers = "x"\n' },
  { client: 'codex', name: '条目为字符串', text: '[mcp_servers]\nsaltedfish = "bad"\n' },
  { client: 'codex', name: '条目为数字', text: 'mcp_servers.saltedfish = 5\n' },
  { client: 'codex', name: '重复键', text: 'model = "a"\nmodel = "b"\n' },
  { client: 'codex', name: 'BOM + CRLF', text: '\ufeff[mcp_servers.other]\r\ncommand = "o"\r\n' },
  { client: 'codex', name: '不完整 TOML', text: '[mcp_servers.saltedfish\n' },
];

test('inspect / preview / check 对文档形状的结论与 clientDocument 完全一致：混合格式一致拒绝、显式格式生效、重复键/BOM/JSONC 判定相同；条目字段被改坏时不冒出原始 TypeError', async () => {
  const temp = await testDirectory();
  try {
    const local = { command: 'known-program', args: ['mcp'], env: {} }, remote = { url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer fixture' } };
    const file = { claude: 'claude.json', codex: 'codex.toml', opencode: 'opencode.jsonc' } as const;
    const seen = new Set<string>(); let accepted = 0;
    // 本机 stdio 和远程 HTTP 两种生成入口各跑一遍：条目比较走不同分支（command/env 与 url/headers）
    for (const [kind, entry] of [['本机', local], ['远程', remote]] as const) {
      const setup = new ClientSetup({ dataDir: temp.directory }, { home: temp.directory, entries: { claude: entry, codex: entry, opencode: entry }, verify: async () => ({ tools: 51, profiles: 0 }) });
      for (const { client, name, text } of documents) {
        const target = path.join(temp.directory, file[client]); await writeFile(target, text);
        for (const format of [undefined, 'v1', 'v2'] as const) {
          const label = `${kind} / ${client} / ${name} / ${format ?? '自动'}`, selection = { configPath: target, ...(format ? { format } : {}) };
          let expected: string | undefined;
          try { clientDocument(client, text, format); } catch (error) { expected = (error as { code?: string }).code; assert.ok(expected, `${label}：clientDocument 只应抛出带错误码的 BrowserError`); }
          if (expected) {
            seen.add(expected);
            for (const method of ['inspect', 'preview', 'check'] as const) await assert.rejects(setup[method](client, selection), { code: expected }, `${label} / ${method}：向导应沿用 clientDocument 的结论`);
          } else {
            accepted++;
            // 被接受的文档：任何方法都不应冒出非 BrowserError（手工改坏的条目字段也一样）
            await setup.inspect(client, selection); await setup.preview(client, selection);
            // check 在条目不存在 / 已停用 / 与本安装不同时按“未配置”拒绝；不会有第二个文档层面的错误码
            await setup.check(client, selection).catch(error => assert.equal(error.code, 'CLIENT_NOT_CONFIGURED', `${label} / check：${error.message}`));
          }
        }
      }
    }
    assert.ok(accepted >= 60, '矩阵里要有足够多被接受的文档，否则只是在测拒绝');
    for (const code of ['MIXED_OPENCODE_CONFIG', 'LEGACY_OPENCODE_CONFIG', 'MODERN_OPENCODE_CONFIG', 'DUPLICATE_CONFIG_KEY', 'CLIENT_CONFIG_INVALID']) assert.ok(seen.has(code), `矩阵没有覆盖 ${code}`);
  } finally { await temp.cleanup(); }
});

test('文档形状与条目判定只在 client-document.ts：向导不再重复抛出它负责的错误码', async () => {
  const thrown = (source: string) => [...source.matchAll(/new BrowserError\('([A-Z_]+)',\s*'([^']*)'/g)].map(match => ({ code: match[1]!, message: match[2]! }));
  const owned = new Set(thrown(await readFile(path.join(projectDir, 'src/client-document.ts'), 'utf8')).map(item => item.code));
  assert.ok(owned.has('MODERN_OPENCODE_CONFIG') && owned.has('CLIENT_CONFIG_INVALID'), '扫描应取到 client-document.ts 的错误码');
  const duplicated = thrown(await readFile(path.join(projectDir, 'src/client-setup.ts'), 'utf8')).filter(item => owned.has(item.code));
  // 唯一合法的例外：OpenCode 2 permissions 的规则数组校验——那是写入一次信任规则前的检查，不属于文档形状判定。
  assert.deepEqual(duplicated.filter(item => !/permissions/.test(item.message)), [], 'client-setup.ts 里这些检查在 clientDocument 之后不可达，应删除而不是保留成“第二道校验”');
});
