import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Script } from 'node:vm';
import { unifiedFixture, fixture, fakeProfile } from './helpers.js';
import { DownloadTabs, type CreatedDownload } from '../extension/download-tabs.js';
import { writeOutputFile } from '../src/output-files.js';
import { adminPrincipal } from '../src/auth.js';
import { JOB_REGISTER_FUNCTION, jobStatusExpression } from '../src/page-jobs.js';
import { serviceInternalUrl } from '../src/service-network.js';
import { EXTENSION_CAPABILITIES, type WireCommand } from '../src/shared.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const sibling = (directory: string, name: string) => path.join(path.dirname(directory), path.basename(directory) + '-' + name);

test('下载配对：Page.downloadWillBegin 和 onCreated 谁先到都能配上标签页，配不上的 2 秒后照常报出', async () => {
  const published: [CreatedDownload, number | undefined][] = [];
  const tabs = new DownloadTabs((item, tabId) => published.push([item, tabId]));
  tabs.willBegin(7, 'blob:https://creator.example/a');
  tabs.created({ id: 1, url: 'blob:https://creator.example/a', filename: 'a.json' });
  tabs.created({ id: 2, url: 'https://creator.example/export?b', finalUrl: 'https://cdn.example/b.csv' });
  tabs.willBegin(9, 'https://cdn.example/b.csv');
  tabs.created({ id: 3, url: 'https://elsewhere.example/c' });
  assert.deepEqual(published.map(([item, tabId]) => [item.id, tabId]), [[1, 7], [2, 9]]);
  assert.equal(tabs.tabOf(1), 7); assert.equal(tabs.tabOf(2), 9); assert.equal(tabs.tabOf(3), undefined);
  await new Promise(resolve => setTimeout(resolve, 2100));
  assert.deepEqual(published.map(([item, tabId]) => [item.id, tabId]), [[1, 7], [2, 9], [3, undefined]], '来源不明的下载也要报出来');
});

test('输出文件：受限客户端写哪里由它的 harness 决定，只拒绝数据目录、可执行扩展名和未声明的覆盖；旧网关连进来的不能写本机', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const root = sibling(f.config.dataDir, 'out'), allowed = path.join(root, 'allowed'), outside = path.join(root, 'outside');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(allowed, { recursive: true }); await mkdir(outside, { recursive: true });
  const config = f.config, client = f.service.state.authenticate(f.service.state.createClient('c', '*').token)!;
  const code = (promise: Promise<unknown>) => promise.then(() => 'OK', (error: { code?: string }) => error.code);
  const saved = await writeOutputFile(config, client, { path: path.join(allowed, '数据.json') }, '{"a":1}', ['.json']);
  assert.equal(saved.bytes, 7); assert.equal(await readFile(path.join(allowed, '数据.json'), 'utf8'), '{"a":1}');
  assert.equal(await code(writeOutputFile(config, client, { path: path.join(allowed, '数据.json') }, 'x', ['.json'])), 'FILE_EXISTS');
  assert.equal((await writeOutputFile(config, client, { path: path.join(allowed, '数据.json'), overwrite: true }, '{"b":2}', ['.json'])).overwritten, true);
  assert.equal(await readFile(path.join(allowed, '数据.json'), 'utf8'), '{"b":2}');
  assert.equal(await code(writeOutputFile(config, client, { path: path.join(outside, 'x.json') }, 'x', ['.json'])), 'OK', '任意已存在的目录');
  assert.equal(await code(writeOutputFile(config, client, { path: path.join(allowed, 'run.bat') }, 'x', ['.json'])), 'OUTPUT_TYPE_NOT_ALLOWED');
  assert.equal(await code(writeOutputFile(config, client, { path: path.join(allowed, 'missing', 'x.json') }, 'x', ['.json'])), 'OUTPUT_DIRECTORY_NOT_FOUND');
  assert.equal(await code(writeOutputFile(config, client, { path: 'relative.json' }, 'x', ['.json'])), 'ABSOLUTE_PATH_REQUIRED');
  assert.equal(await code(writeOutputFile(config, client, { path: path.join(f.config.dataDir, 'x.json') }, 'x', ['.json'])), 'OUTPUT_PATH_NOT_ALLOWED', '数据目录始终拒绝');
  assert.equal(await code(writeOutputFile(config, { ...client, remoteAgentId: 'remote-agent' }, { path: path.join(allowed, 'r.json') }, 'x', ['.json'])), 'OUTPUT_PATH_NOT_ALLOWED', '别的电脑连进来的 Agent');
  assert.equal(await code(writeOutputFile(config, adminPrincipal, { path: path.join(outside, 'x.png') }, png, ['.png'])), 'OK');
});

test('截图存文件与元素截图：先查能不能写再截，returnImage:false 不回图，元素和 clip 需要新扩展', async t => {
  const f = await unifiedFixture(); t.after(() => f.cleanup());
  const config = f.service.config, seen: WireCommand[] = [];
  const root = sibling(config.dataDir, 'shots'); t.after(() => rm(root, { recursive: true, force: true })); await mkdir(root, { recursive: true });
  const profile = await fakeProfile(config, 'A', command => { seen.push(command); return command.operation === 'page.screenshot' ? { mimeType: 'image/png', data: png.toString('base64') } : {}; });
  const client = f.service.state.authenticate(f.service.state.createClient('c', [profile.id]).token)!;
  const shot = (args: Record<string, unknown>) => f.service.invoke('chrome_screenshot', { profileId: profile.id, tabId: 4, ...args }, 'c', client);
  const saved = await shot({ selector: '#chart', savePath: path.join(root, '图.png'), returnImage: false });
  assert.equal(saved.ok, true, JSON.stringify(saved.error)); assert.equal(saved.image, undefined); assert.equal((saved.data as any).saved.bytes, png.length);
  assert.deepEqual(await readFile(path.join(root, '图.png')), png);
  const wire = seen.find(command => command.operation === 'page.screenshot')!;
  assert.equal(wire.args.selector, '#chart'); assert.equal(wire.args.savePath, undefined, '写文件的参数不发给扩展');
  seen.length = 0;
  assert.equal((await shot({ fullPage: true, savePath: path.join(root, '图.png') })).error?.code, 'FILE_EXISTS');
  assert.equal(seen.length, 0, '存不下就不截');
  const inline = await shot({ clip: { x: 0, y: 100, width: 300, height: 200 } });
  assert.equal(inline.ok, true); assert.ok(inline.image); assert.ok(inline.artifact, '没给 savePath 照旧保存原图');
  assert.equal((await shot({ fullPage: true, selector: '#x' })).error?.code, 'INVALID_ARGUMENT');
  const old = await fakeProfile(config, 'old', () => ({ mimeType: 'image/png', data: png.toString('base64') }), undefined, { capabilities: ['semantic-locators', 'execution-v3', 'interaction-v4', 'interaction-v5', 'admin-origin-v1'] });
  assert.equal((await f.service.invoke('chrome_screenshot', { profileId: old.id, tabId: 1, selector: '#chart' }, 'c')).error?.code, 'EXTENSION_UPDATE_REQUIRED');
  assert.equal((await f.service.invoke('chrome_screenshot', { profileId: old.id, tabId: 1 }, 'c')).ok, true, '整页截图不要求新扩展');
});

test('evaluate 存文件、replMode 要新扩展；后台作业：启动只发一次 evaluate，状态用只读表达式读，结果可以存成文件', async t => {
  const f = await unifiedFixture(); t.after(() => f.cleanup());
  const config = f.service.config, seen: WireCommand[] = [];
  const root = sibling(config.dataDir, 'jobs'); t.after(() => rm(root, { recursive: true, force: true })); await mkdir(root, { recursive: true });
  const profile = await fakeProfile(config, 'A', command => {
    seen.push(command);
    if (command.operation === 'page.jobStart') return { jobId: command.args.jobId };
    if (command.operation === 'page.evaluate' && command.args.readOnly) return { state: 'done', progress: 3, startedAt: 1, endedAt: 2, value: { rows: [1, 2, 3] } };
    if (command.operation === 'page.wait') return { matched: true };
    return 'a,b\n1,2';
  });
  const client = f.service.state.authenticate(f.service.state.createClient('c', [profile.id]).token)!;
  const call = (name: string, args: Record<string, unknown>) => f.service.invoke(name, { profileId: profile.id, tabId: 2, ...args }, 'c', client);
  const csv = await call('chrome_evaluate', { expression: 'exportCsv()', savePath: path.join(root, 'data.csv') });
  assert.equal(csv.ok, true, JSON.stringify(csv.error)); assert.equal(await readFile(path.join(root, 'data.csv'), 'utf8'), 'a,b\n1,2', '字符串结果写进 .csv 时按原文');
  assert.equal((await call('chrome_evaluate', { expression: '1', savePath: path.join(config.dataDir, 'escape.json') })).error?.code, 'OUTPUT_PATH_NOT_ALLOWED', '数据目录');
  assert.equal((await call('chrome_evaluate', { expression: 'const a=1', replMode: true })).ok, true);
  const old = await fakeProfile(config, 'old', () => 1, undefined, { capabilities: ['semantic-locators', 'execution-v3', 'interaction-v4', 'interaction-v5', 'admin-origin-v1', 'read-only-eval-v1'] });
  assert.equal((await f.service.invoke('chrome_evaluate', { profileId: old.id, tabId: 1, expression: 'const a=1', replMode: true }, 'c')).error?.code, 'EXTENSION_UPDATE_REQUIRED');

  seen.length = 0;
  const started = await call('chrome_job_start', { expression: 'async report => { report(1); return 1; }' });
  assert.equal(started.ok, true, JSON.stringify(started.error));
  const jobId = (started.data as any).jobId;
  assert.match(jobId, /^[0-9a-f-]{36}$/); assert.equal((started.data as any).state, 'running');
  assert.equal(seen.length, 1); assert.equal(seen[0]!.operation, 'page.jobStart'); assert.equal(seen[0]!.args.jobId, jobId);
  assert.equal((await f.service.invoke('chrome_job_start', { profileId: old.id, tabId: 1, expression: '1' }, 'c')).error?.code, 'EXTENSION_UPDATE_REQUIRED');
  const status = await call('chrome_job_status', { jobId, waitMs: 5000, savePath: path.join(root, 'rows.json') });
  assert.equal(status.ok, true, JSON.stringify(status.error));
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'rows.json'), 'utf8')), { rows: [1, 2, 3] });
  assert.equal((status.data as any).value, undefined, '存了文件就不在回复里带结果'); assert.equal((status.data as any).state, 'done');
  assert.deepEqual(seen.slice(1).map(command => [command.operation, command.args.readOnly]), [['page.wait', true], ['page.evaluate', true]]);
  assert.equal((await f.service.state.list(profile.id, undefined, 0, 50)).items.some((item: any) => item.tool === 'chrome_job_status'), false, '读状态不记操作');
});

test('作业登记函数和状态表达式：都能编译，状态读法不写页面', () => {
  assert.doesNotThrow(() => new Script(`(${JOB_REGISTER_FUNCTION})`), '登记函数可以编译（只编译，不执行）');
  assert.doesNotThrow(() => new Script(jobStatusExpression('00000000-0000-4000-8000-000000000000')));
  assert.ok(!/=/.test(jobStatusExpression('00000000-0000-4000-8000-000000000000').replace(/[!=]==|=>|status\.\w+=|const \w+=/g, '')), '状态表达式只给局部变量赋值');
});

test('离线原因：取消调试、Agent 暂停、用户暂停和普通断开各自说清怎么恢复，重连后清掉', async t => {
  const f = await unifiedFixture(); t.after(() => f.cleanup());
  const config = f.service.config;
  const reason = (id: string) => (f.service.listProfiles().find(item => item.id === id) as { offline?: { reason: string; recovery: string } } | undefined)?.offline;
  // 同一个浏览器之后要重连，配对自己建，两次连接共用。
  const canceledId = randomUUID(), pairing = await (await fetch(serviceInternalUrl(config) + '/browser-pairings', { method: 'POST', headers: { authorization: 'Bearer ' + config.token, 'content-type': 'application/json' }, body: JSON.stringify({ label: '取消调试', profileId: canceledId }) })).json() as { pairingId: string; token: string };
  const canceled = await fakeProfile(config, '取消调试', undefined, canceledId, { pairing });
  canceled.socket.send(JSON.stringify({ type: 'event', method: 'bridge.userPaused', params: { reason: 'canceled_by_user' }, tabId: 3 }));
  canceled.socket.close(); await once(canceled.socket, 'close');
  for (let i = 0; i < 50 && !reason(canceled.id); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(reason(canceled.id)?.reason, 'debugging-canceled'); assert.match(reason(canceled.id)!.recovery, /继续连接/);
  const offline = await f.service.invoke('chrome_tabs', { profileId: canceled.id }, 'c');
  assert.equal(offline.error?.code, 'PROFILE_OFFLINE'); assert.match(offline.error!.message, /取消/);
  const user = await fakeProfile(config, '用户暂停');
  user.socket.send(JSON.stringify({ type: 'event', method: 'bridge.paused', params: { reason: 'user' } })); user.socket.close(); await once(user.socket, 'close');
  const agent = await fakeProfile(config, 'Agent 暂停', command => command.operation === 'profile.pause' ? { paused: true } : {});
  assert.equal((await f.service.invoke('chrome_pause_profile', { profileId: agent.id }, 'c')).ok, true); agent.socket.close(); await once(agent.socket, 'close');
  const gone = await fakeProfile(config, '断开'); gone.socket.close(); await once(gone.socket, 'close');
  for (let i = 0; i < 50 && !(reason(user.id) && reason(gone.id)); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual([reason(user.id)?.reason, reason(agent.id)?.reason, reason(gone.id)?.reason], ['user', 'agent', 'disconnected']);
  await fakeProfile(config, '取消调试', undefined, canceled.id, { pairing });
  assert.equal(reason(canceled.id), undefined, '重新连上就不再报离线原因');
});

test('按标签页等下载：认 15 秒内刚开始的，结果带 sequence；超时时按网站设置提示是否被 Chrome 拦下', async t => {
  const f = await unifiedFixture(); t.after(() => f.cleanup());
  const config = f.service.config;
  let setting = 'ask';
  const profile = await fakeProfile(config, 'A', command => {
    if (command.operation === 'downloads.list') return [{ id: Number(command.args.downloadId), state: 'complete', filename: 'C:\\Downloads\\report.json', exists: true }];
    if (command.operation === 'tabs.list') return [{ tabId: 5, url: 'https://creator.example/data' }];
    if (command.operation === 'site.permission') return { setting, origin: 'https://creator.example' };
    return {};
  });
  const event = (method: string, params: Record<string, unknown>, tabId?: number) => profile.socket.send(JSON.stringify({ type: 'event', method, params, tabId }));
  event('downloads.created', { id: 41, tabId: 5 }, 5);
  await new Promise(resolve => setTimeout(resolve, 50));
  const first = await f.service.invoke('chrome_wait_download', { profileId: profile.id, tabId: 5, timeoutMs: 2000 }, 'c');
  assert.equal(first.ok, true, JSON.stringify(first.error));
  assert.equal((first.data as any).downloadId, 41); assert.equal((first.data as any).tabId, 5);
  const since = (first.data as any).sequence;
  const blocked = await f.service.invoke('chrome_wait_download', { profileId: profile.id, tabId: 5, since, timeoutMs: 300 }, 'c');
  assert.equal(blocked.error?.code, 'DOWNLOAD_WAIT_TIMEOUT'); assert.match(blocked.error!.message, /ask[\s\S]*chrome_site_permission/);
  setting = 'allow';
  const later = f.service.invoke('chrome_wait_download', { profileId: profile.id, tabId: 5, since, timeoutMs: 2000 }, 'c');
  event('downloads.created', { id: 42, tabId: 6 }, 6); event('downloads.created', { id: 43, tabId: 5 }, 5);
  assert.equal(((await later).data as any).downloadId, 43, '别的标签页的下载不算');
  const caught = await f.service.invoke('chrome_wait_download', { profileId: profile.id, tabId: 5, since, timeoutMs: 100 }, 'c');
  assert.equal(caught.ok, true);
  // 从最后一个下载之后等，等不到：已经 allow 就不提示自动下载设置（游标要合法，超出当前序列的会报 EVENT_CURSOR_INVALID）。
  const quiet = await f.service.invoke('chrome_wait_download', { profileId: profile.id, tabId: 5, since: (caught.data as any).sequence, timeoutMs: 200 }, 'c');
  assert.equal(quiet.error?.code, 'DOWNLOAD_WAIT_TIMEOUT', JSON.stringify(quiet.error));
  assert.doesNotMatch(quiet.error!.message, /自动下载设置是/, '已经 allow 就不提示自动下载设置');
  assert.equal((await f.service.invoke('chrome_wait_download', { profileId: profile.id, downloadId: 1, tabId: 5 }, 'c')).error?.code, 'INVALID_ARGUMENT');

  // 这个标签页从没下载过：自动下载设置拦不到第一个下载，不往那里指；这段时间页面的报错一起给出（例如页面报“链接打开失败,可能已被浏览器拦截”）。
  setting = 'ask';
  event('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: '普通日志' }] }, 7);
  const fresh = f.service.invoke('chrome_wait_download', { profileId: profile.id, tabId: 7, timeoutMs: 400 }, 'c');
  await new Promise(resolve => setTimeout(resolve, 50));
  event('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: '链接打开失败,可能已被浏览器拦截:' }, { type: 'string', value: 'http://erp.example/download?id=1' }] }, 7);
  event('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is undefined' } } }, 7);
  const never = await fresh;
  assert.equal(never.error?.code, 'DOWNLOAD_WAIT_TIMEOUT');
  assert.doesNotMatch(never.error!.message, /自动下载设置是/);
  assert.match(never.error!.message, /链接打开失败,可能已被浏览器拦截: http:\/\/erp\.example\/download\?id=1[\s\S]*TypeError: x is undefined[\s\S]*popups/);
  assert.doesNotMatch(never.error!.message, /普通日志/);
  assert.deepEqual((never.error as any).detail, { downloadedBefore: false, console: ['链接打开失败,可能已被浏览器拦截: http://erp.example/download?id=1', 'TypeError: x is undefined'] });
});

test('events 按网址片段、资源类型筛（请求整组，发出得早也算）；downloads 截短长网址', async t => {
  const f = await unifiedFixture(); t.after(() => f.cleanup());
  const long = 'https://erp.example/download?token=' + 'x'.repeat(5000);
  const profile = await fakeProfile(f.service.config, 'A', command => command.operation === 'downloads.list' ? [{ id: 1, url: long, finalUrl: long, referrer: 'https://erp.example/list', filename: 'C:\\Downloads\\a.zip', state: 'complete' }] : {});
  const event = (method: string, params: Record<string, unknown>) => profile.socket.send(JSON.stringify({ type: 'event', method, params, tabId: 3 }));
  event('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://erp.example/api/exportzip?id=1', method: 'POST' }, type: 'XHR' });
  event('Network.requestWillBeSent', { requestId: 'r2', request: { url: 'https://erp.example/app.js', method: 'GET' }, type: 'Script' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const since = ((await f.service.invoke('chrome_events', { profileId: profile.id, tabId: 3 }, 'admin')).data as any).latestSequence;
  event('Network.responseReceived', { requestId: 'r1', response: { url: 'https://erp.example/api/exportzip?id=1', status: 200, mimeType: 'application/json' }, type: 'XHR' });
  event('Network.loadingFinished', { requestId: 'r1', encodedDataLength: 120 });
  event('Network.loadingFinished', { requestId: 'r2', encodedDataLength: 9000 });
  event('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'boom' }] });
  await new Promise(resolve => setTimeout(resolve, 50));
  const items = async (args: Record<string, unknown>) => (((await f.service.invoke('chrome_events', { profileId: profile.id, tabId: 3, since, ...args }, 'admin')).data as any).items as any[]).map(item => `${item.method}:${item.params.requestId ?? ''}`);
  assert.deepEqual(await items({ urlContains: 'exportzip' }), ['Network.responseReceived:r1', 'Network.loadingFinished:r1'], '请求在 since 之前发出，后面的响应和结束照样认得出');
  assert.deepEqual(await items({ resourceType: 'script' }), ['Network.loadingFinished:r2'], '资源类型不分大小写，非网络事件不算');
  assert.equal((await items({})).length, 4);
  const listed = (await f.service.invoke('chrome_downloads', { profileId: profile.id, limit: 5 }, 'admin')).data as any[];
  assert.equal(listed[0].url.length, 300); assert.equal(listed[0].urlTruncated, true); assert.equal(listed[0].finalUrlTruncated, true);
  assert.equal(listed[0].referrer, 'https://erp.example/list'); assert.equal(listed[0].referrerTruncated, undefined); assert.equal(listed[0].filename, 'C:\\Downloads\\a.zip');
});

test('网站自动下载设置：不给 setting 是只读查看，暂停写入的标签页也能看；设置要新扩展', async t => {
  const f = await unifiedFixture(); t.after(() => f.cleanup());
  const seen: WireCommand[] = [];
  const profile = await fakeProfile(f.service.config, 'A', command => { seen.push(command); return { setting: command.args.setting ?? 'ask' }; });
  const read = await f.service.invoke('chrome_site_permission', { profileId: profile.id, url: 'https://creator.example/a' }, 'admin');
  assert.equal(read.ok, true); assert.equal(read.operationId, undefined, '查看不记操作');
  const set = await f.service.invoke('chrome_site_permission', { profileId: profile.id, url: 'https://creator.example/a', setting: 'allow' }, 'admin');
  assert.equal(set.ok, true); assert.ok(set.operationId, '设置记一条操作'); assert.equal(seen.at(-1)!.args.setting, 'allow');
  assert.equal((await f.service.invoke('chrome_site_permission', { profileId: profile.id }, 'c')).error?.code, 'INVALID_ARGUMENT');
  // 弹窗：只有 allow、block；旧扩展不认 permission，会去改自动下载设置，所以要新扩展。
  const popups = await f.service.invoke('chrome_site_permission', { profileId: profile.id, url: 'https://erp.example/a', permission: 'popups', setting: 'allow' }, 'admin');
  assert.equal(popups.ok, true, JSON.stringify(popups.error)); assert.equal(seen.at(-1)!.args.permission, 'popups');
  assert.equal((await f.service.invoke('chrome_site_permission', { profileId: profile.id, url: 'https://erp.example/a', permission: 'popups', setting: 'ask' }, 'admin')).error?.code, 'INVALID_ARGUMENT');
  const old = await fakeProfile(f.service.config, 'B', () => ({ setting: 'ask' }), undefined, { capabilities: EXTENSION_CAPABILITIES.filter(capability => capability !== 'site-permission-v2') });
  assert.equal((await f.service.invoke('chrome_site_permission', { profileId: old.id, url: 'https://erp.example/a', permission: 'popups', setting: 'allow' }, 'admin')).error?.code, 'EXTENSION_UPDATE_REQUIRED');
  assert.equal((await f.service.invoke('chrome_site_permission', { profileId: old.id, url: 'https://erp.example/a', setting: 'allow' }, 'admin')).ok, true, '自动下载设置旧扩展照常');
});

test('截图：clipViewport 要和 clip 一起用，scale 在 0.1–1；用到时要新扩展，说明按 scale 换算', async t => {
  const f = await unifiedFixture(); t.after(() => f.cleanup());
  const seen: WireCommand[] = [], data = Buffer.from('png').toString('base64');
  const reply = (command: WireCommand) => { seen.push(command); return { mimeType: 'image/png', data, coordinates: { cssPixels: true, area: { x: 0, y: 0, width: 400, height: 300 }, scroll: { x: 0, y: 0 }, viewport: true, ...(command.args.scale ? { scale: command.args.scale } : {}) } }; };
  const profile = await fakeProfile(f.service.config, 'A', reply), shotArgs = () => seen.filter(command => command.operation === 'page.screenshot').at(-1)!.args;
  const shot = await f.service.invoke('chrome_screenshot', { profileId: profile.id, tabId: 7, scale: 0.5 }, 'admin');
  assert.equal(shot.ok, true, JSON.stringify(shot.error)); assert.equal(shotArgs().scale, 0.5);
  assert.match(JSON.stringify(shot.data), /÷ 0\.5 就是 chrome_action 的 x\/y/);
  const clipped = await f.service.invoke('chrome_screenshot', { profileId: profile.id, tabId: 7, clip: { x: 10, y: 20, width: 30, height: 40 }, clipViewport: true }, 'admin');
  assert.equal(clipped.ok, true, JSON.stringify(clipped.error)); assert.equal(shotArgs().clipViewport, true);
  for (const args of [{ clipViewport: true }, { scale: 0.05 }, { scale: 2 }]) assert.equal((await f.service.invoke('chrome_screenshot', { profileId: profile.id, tabId: 7, ...args }, 'admin')).error?.code, 'INVALID_ARGUMENT', JSON.stringify(args));
  const old = await fakeProfile(f.service.config, 'B', reply, undefined, { capabilities: EXTENSION_CAPABILITIES.filter(capability => capability !== 'screenshot-v3') });
  assert.equal((await f.service.invoke('chrome_screenshot', { profileId: old.id, tabId: 7, scale: 0.5 }, 'admin')).error?.code, 'EXTENSION_UPDATE_REQUIRED');
  assert.equal((await f.service.invoke('chrome_screenshot', { profileId: old.id, tabId: 7, clip: { x: 0, y: 0, width: 5, height: 5 }, clipViewport: true }, 'admin')).error?.code, 'EXTENSION_UPDATE_REQUIRED');
  assert.equal((await f.service.invoke('chrome_screenshot', { profileId: old.id, tabId: 7, clip: { x: 0, y: 0, width: 5, height: 5 } }, 'admin')).ok, true, '页面坐标的 clip 旧扩展照常');
});

test('HTTP 会话：客户端的推送流断开超过宽限期就结束会话；一直有请求的不算', async t => {
  const f = await fixture({ mcpTiming: { sweepMs: 50, idleMs: 60_000, streamGraceMs: 300 } }, async (config, options) => (await import('../src/http-server.js')).startServer({ ...config, directConnections: true }, options));
  t.after(() => f.cleanup());
  const client = f.service.state.createClient('http', '*'), url = serviceInternalUrl(f.config) + '/mcp';
  const headers = { authorization: 'Bearer ' + client.token, accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
  const init = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stream-test', version: '1' } } }) });
  const session = init.headers.get('mcp-session-id')!; assert.ok(session); await init.text();
  await (await fetch(url, { method: 'POST', headers: { ...headers, 'mcp-session-id': session }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })).text();
  const sessions = () => f.service.agents().find(item => item.id === client.id)?.sessionCount ?? 0;
  assert.equal(sessions(), 1);
  const stream = new AbortController();
  const opened = await fetch(url, { method: 'GET', headers: { ...headers, accept: 'text/event-stream', 'mcp-session-id': session }, signal: stream.signal });
  assert.equal(opened.status, 200);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(sessions(), 1, '推送流开着，会话还在');
  stream.abort();
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.equal(sessions(), 0, '推送流断了超过宽限期，会话结束');
});
