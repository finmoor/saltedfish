import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, unifiedFixture, fakeProfile, FAKE_CAPABILITIES } from './helpers.js';
import { toolMap } from '../src/tools.js';
import { BrowserError, CAPABILITY, unknownResult, type JsonObject, type WireCommand } from '../src/shared.js';
import { serviceInternalUrl } from '../src/service-network.js';
import { projectDir } from '../src/config.js';

// 夜间无人值守跑视频平台创作者后台时遇到的需求（0.3.0-beta.18）：服务端这一侧的语义。页面里的行为在 interaction.integration.ts 用真 Chrome 测。
const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const linux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const here = process.platform === 'win32' ? windows : linux;
const parse = (name: string, args: JsonObject) => toolMap.get(name)!.schema.safeParse({ profileId: 'p', tabId: 1, ...args });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

test('参数：choose 要定位和 option，nth、match 要定位，scopeRef 和 scopeSelector 二选一；批次步骤去掉说明后校验不变', () => {
  assert.equal(parse('chrome_action', { action: 'choose', locator: { role: 'combobox', name: '分类' }, option: '知识' }).success, true);
  for (const args of [{ action: 'choose', locator: { role: 'combobox' } }, { action: 'choose', option: '知识', x: 1, y: 1 }, { action: 'click', selector: '#a', option: '知识' }, { action: 'choose', selector: '#a', option: '' }])
    assert.equal(parse('chrome_action', args).success, false, JSON.stringify(args));
  assert.equal(parse('chrome_action', { action: 'click', locator: { text: '保存', nth: 1 } }).success, true);
  assert.equal(parse('chrome_action', { action: 'click', locator: { text: '保存', nth: -1 } }).success, false);
  assert.equal(parse('chrome_action', { action: 'click', locator: { text: '保存', nth: 1000 } }).success, false);
  assert.equal(parse('chrome_wait', { locator: { role: 'option' }, match: 'all', state: 'visible' }).success, true);
  assert.equal(parse('chrome_wait', { selector: '.item', match: 'any' }).success, true);
  assert.equal(parse('chrome_wait', { match: 'any', expression: 'true' }).success, false, 'match 只对元素条件有意义');
  assert.equal(parse('chrome_find', { scopeRef: 'r1', locator: { role: 'option' } }).success, true);
  assert.equal(parse('chrome_find', { scopeRef: 'r1', scopeSelector: '#list', locator: { role: 'option' } }).success, false);
  assert.equal(parse('chrome_inspect', { scopeRef: 'r1', scopeSelector: '#list' }).success, false);
  // 批次步骤是去掉说明的副本（bare）：同样的拒绝规则必须还在，否则省下来的说明换来的是校验漏洞。
  const batch = (steps: JsonObject[]) => parse('chrome_batch', { steps });
  assert.equal(batch([{ operation: 'page.action', args: { action: 'choose', locator: { role: 'combobox' }, option: '知识' }, postcondition: { locator: { role: 'option', name: '知识' }, match: 'all', state: 'hidden' } }]).success, true);
  assert.equal(batch([{ operation: 'page.action', args: { action: 'choose', locator: { role: 'combobox' } } }]).success, false);
  assert.equal(batch([{ operation: 'page.action', args: { action: 'click', selector: '#a', unexpected: 1 } }]).success, false);
  assert.equal(batch([{ operation: 'page.wait', args: { selector: '#a', timeoutMs: 1500 } }]).success, true);
  assert.equal(batch([{ operation: 'page.wait', args: { selector: '#a', timeoutMs: 50 } }]).success, false);
  assert.equal(parse('chrome_wait', { selector: '#a', timeoutMs: 1500 }).success, true, '单独的 wait 本来就有 timeoutMs');
});

test('interaction-v8 门禁：只有用到新字段的调用要求新扩展，旧扩展在派发前被拒绝，普通调用不受影响', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const seen: WireCommand[] = [];
  const old = await fakeProfile(f.config, 'old-extension', command => { seen.push(command); return command.operation === 'page.batch' ? { completed: true, results: [] } : {}; }, undefined, { capabilities: FAKE_CAPABILITIES.filter(name => name !== CAPABILITY.interactionV8) });
  const call = (name: string, args: JsonObject, profileId = old.id) => f.service.invoke(name, { profileId, tabId: 1, ...args }, 'owner');
  const needs: [string, JsonObject][] = [
    ['chrome_action', { action: 'choose', locator: { role: 'combobox' }, option: '知识' }], ['chrome_action', { action: 'click', locator: { text: '保存', nth: 1 } }],
    ['chrome_action', { action: 'drag', selector: '#a', to: { locator: { text: 'x', nth: 0 } } }], ['chrome_find', { scopeRef: 'r1', locator: { role: 'option' } }],
    ['chrome_inspect', { scopeRef: 'r1' }], ['chrome_wait', { selector: '.item', match: 'all' }],
    ['chrome_batch', { steps: [{ operation: 'page.wait', args: { selector: '#a', timeoutMs: 1000 } }] }],
    ['chrome_batch', { steps: [{ operation: 'page.action', args: { action: 'click', selector: '#a' }, postcondition: { selector: '.item', match: 'any' } }] }],
  ];
  const free: [string, JsonObject][] = [
    ['chrome_action', { action: 'click', locator: { text: '保存' } }], ['chrome_find', { scopeSelector: '#list', locator: { role: 'option' } }], ['chrome_wait', { selector: '.item' }],
    ['chrome_batch', { steps: [{ operation: 'page.action', args: { action: 'click', selector: '#a' }, postcondition: { selector: '.item' } }] }],
  ];
  const before = seen.length;
  for (const [name, args] of needs) {
    const result = await call(name, args);
    assert.equal(result.error?.code, 'EXTENSION_UPDATE_REQUIRED', `${name} ${JSON.stringify(args)}`); assert.equal(result.error?.outcome, 'not_dispatched');
  }
  assert.equal(seen.length, before, '被拒绝的调用不会到达扩展');
  for (const [name, args] of free) assert.notEqual((await call(name, args)).error?.code, 'EXTENSION_UPDATE_REQUIRED', `${name} ${JSON.stringify(args)}`);
  const fresh = await fakeProfile(f.config, 'new-extension', () => ({ completed: true, results: [] }));
  for (const [name, args] of needs) assert.notEqual((await call(name, args, fresh.id)).error?.code, 'EXTENSION_UPDATE_REQUIRED', `${name} ${JSON.stringify(args)}`);
});

test('动作做完、核对没通过（dispatched）不算结果不明：记为失败，标签页不暂停，错误详情原样传到调用方', async t => {
  assert.equal(unknownResult({ code: 'POSTCONDITION_TIMEOUT', message: '', outcome: 'dispatched' }), false);
  assert.equal(unknownResult({ code: 'X', message: '', outcome: 'unknown' }), true);
  const f = await fixture(); t.after(() => f.cleanup());
  const detail = { matches: [{ ref: 'r1', selector: 'li' }, { ref: 'r2', selector: 'li' }], total: 2 };
  let mode = 'batch', writes = 0;
  const profile = await fakeProfile(f.config, 'unattended', command => {
    if (command.operation === 'page.batch' && mode === 'batch') return { completed: false, failedIndex: 0, results: [], failedStep: { index: 0, operation: 'page.action', result: { clicked: true }, postcondition: { matched: false } }, error: { code: 'POSTCONDITION_TIMEOUT', message: '第 1 步的动作已经做完，但后置条件没有满足', phase: 'postcondition', outcome: 'dispatched' } };
    if (command.operation === 'page.action') writes++;
    return {};
  });
  const batch = await f.service.invoke('chrome_batch', { profileId: profile.id, tabId: 7, steps: [{ operation: 'page.action', args: { action: 'click', selector: '#publish' }, postcondition: { selector: '.done' } }] }, 'owner');
  assert.equal(batch.batch?.error?.outcome ?? (batch.data as any)?.error?.outcome, 'dispatched', JSON.stringify(batch));
  assert.deepEqual((batch.data as any).failedStep.result, { clicked: true }, '失败那一步的动作结果交回调用方');
  const [record] = f.service.state.list(profile.id, undefined, 0, 50).items as any[];
  assert.equal(record.state, 'failed', '不是 unknown');
  mode = 'none';
  const next = await f.service.invoke('chrome_action', { profileId: profile.id, tabId: 7, action: 'click', selector: '#other' }, 'owner');
  assert.equal(next.ok, true, `标签页照常可写：${JSON.stringify(next.error)}`); assert.equal(writes, 1);

  // 扩展直接抛出的 dispatched 错误（choose 点开了下拉但选项有歧义）：经过桥接帧校验，outcome 和 detail 都保留。
  const second = await fakeProfile(f.config, 'unattended-2', command => {
    if (command.operation === 'page.action' && command.args.action === 'choose') throw new BrowserError('AMBIGUOUS_OPTION', '点开了下拉，但有 2 个选项都叫「知识」', { phase: 'postcondition', outcome: 'dispatched', detail });
    return {};
  });
  const chosen = await f.service.invoke('chrome_action', { profileId: second.id, tabId: 3, action: 'choose', locator: { role: 'combobox' }, option: '知识' }, 'owner');
  assert.equal(chosen.error?.code, 'AMBIGUOUS_OPTION'); assert.equal(chosen.error?.outcome, 'dispatched'); assert.deepEqual(chosen.error?.detail, detail);
  assert.equal((f.service.state.list(second.id, undefined, 0, 50).items as any[])[0].state, 'failed');
  assert.equal((await f.service.invoke('chrome_action', { profileId: second.id, tabId: 3, action: 'click', selector: '#x' }, 'owner')).ok, true);
});

test('上传记进操作记录：文件名、大小和 SHA-256，不存内容；批次里记第几步', async t => {
  const f = await unifiedFixture(); t.after(() => f.cleanup());
  const profile = await fakeProfile(f.service.config, '同机', command => {
    if (command.operation === 'page.upload') return { files: command.args.expectedFiles };
    if (command.operation === 'page.batch') return { completed: true, results: [] };
    return {};
  }, undefined, { userAgent: here });
  const directory = path.join(f.config.dataDir, '..', path.basename(f.config.dataDir) + '-uploads');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(directory, { recursive: true });
  const cover = path.join(directory, '封面 1.png'), video = path.join(directory, '第3集.mp4');
  await writeFile(cover, 'cover-bytes'); await writeFile(video, 'video-bytes-video-bytes');
  const single = await f.service.invoke('chrome_upload', { profileId: profile.id, tabId: 3, selector: '#file', paths: [cover] }, 'admin');
  assert.equal(single.ok, true, JSON.stringify(single.error));
  const batch = await f.service.invoke('chrome_batch', { profileId: profile.id, tabId: 3, steps: [{ operation: 'page.action', args: { action: 'click', selector: '#a' } }, { operation: 'page.upload', args: { selector: '#file', paths: [video] } }] }, 'admin');
  assert.equal(batch.ok, true, JSON.stringify(batch.error));
  // SHA-256 在后台补上。
  let records: any[] = [];
  for (let i = 0; i < 100; i++) { records = f.service.state.list(profile.id, undefined, 0, 50).items as any[]; if (records.every(item => item.detail?.files?.every((file: any) => file.sha256))) break; await new Promise(resolve => setTimeout(resolve, 20)); }
  const byTool = (tool: string) => records.find(item => item.tool === tool);
  assert.deepEqual(byTool('chrome_upload').detail, { files: [{ name: '封面 1.png', size: (await stat(cover)).size, sha256: sha('cover-bytes') }] });
  assert.deepEqual(byTool('chrome_batch').detail, { files: [{ step: 1, name: '第3集.mp4', size: (await stat(video)).size, sha256: sha('video-bytes-video-bytes') }] });
  assert.ok(!JSON.stringify(records).includes(directory.replaceAll('\\', '\\\\')) && !JSON.stringify(records).includes(directory), '不记完整路径');
  const listed = await f.service.invoke('chrome_operations', { profileId: profile.id }, 'admin');
  assert.ok(JSON.stringify(listed.data).includes(sha('cover-bytes')), 'chrome_operations 能读到');
});

test('截图和结果存哪里由 Agent 的 harness 决定：受限客户端能存进仓库这类目录，只拒绝数据目录；上传同样；upload-roots、save-roots 接口和命令都没了', async t => {
  const f = await unifiedFixture(); t.after(() => f.cleanup());
  const config = f.service.config;
  const root = path.join(config.dataDir, '..', path.basename(config.dataDir) + '-repo', 'data', 'publish');
  t.after(() => rm(path.dirname(path.dirname(root)), { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  const client = f.service.state.createClient('unattended', '*'), principal = f.service.state.authenticate(client.token)!;
  const profile = await fakeProfile(config, '同机', command => command.operation === 'page.screenshot' ? { mimeType: 'image/png', data: Buffer.from('png').toString('base64') } : {}, undefined, { userAgent: here });
  const shot = await f.service.invoke('chrome_screenshot', { profileId: profile.id, tabId: 1, savePath: path.join(root, 'a.png'), returnImage: false }, 'c', principal);
  assert.equal(shot.ok, true, JSON.stringify(shot.error));
  assert.equal(await readFile(path.join(root, 'a.png'), 'utf8'), 'png');
  await writeFile(path.join(root, 'x.mp4'), 'x');
  const upload = await f.service.invoke('chrome_upload', { profileId: profile.id, tabId: 1, selector: '#f', paths: [path.join(root, 'x.mp4')] }, 'c', principal);
  assert.equal(upload.ok, true, JSON.stringify(upload.error));
  const data = await f.service.invoke('chrome_screenshot', { profileId: profile.id, tabId: 1, savePath: path.join(config.dataDir, 'a.png'), returnImage: false }, 'c', principal);
  assert.equal(data.error?.code, 'OUTPUT_PATH_NOT_ALLOWED'); assert.match(data.error!.message, /数据目录/);
  const missing = await f.service.invoke('chrome_screenshot', { profileId: profile.id, tabId: 1, savePath: path.join(root + '-missing', 'a.png'), returnImage: false }, 'c', principal);
  assert.equal(missing.error?.code, 'OUTPUT_DIRECTORY_NOT_FOUND');

  for (const route of ['/upload-roots', '/save-roots']) {
    const response = await fetch(serviceInternalUrl(config) + route, { headers: { authorization: 'Bearer ' + config.token } });
    assert.equal(response.status, 404, route); await response.text();
  }
  const { execFile } = await import('node:child_process');
  const run = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => execFile(process.execPath, [path.join(projectDir, 'dist', 'cli.js'), ...args], { env: { ...process.env, CHROME_MCP_DATA_DIR: config.dataDir }, windowsHide: true }, (error, stdout, stderr) => resolve({ code: error ? Number((error as any).code) || 1 : 0, stdout, stderr })));
  for (const command of ['upload-roots', 'save-roots']) assert.notEqual((await run(command, 'list')).code, 0, `${command} 命令已删除`);
});
