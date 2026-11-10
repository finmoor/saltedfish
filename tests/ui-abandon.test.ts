import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { projectDir } from '../src/config.js';
import { mountApp, createServer, uuid, buttonByText, defer, addPending, type FakeServer, type FakeProfile, type MountedApp } from './fake-app.js';
import * as dom from './fake-dom.js';
import { same, choose, FakeEvent, type FakeElement } from './fake-dom.js';

// 管理页的“放弃永不再连接的配置”入口（审核结论 server:2 的界面部分）：服务端的预览/确认接口见 tests/offline-profile-abandon.test.ts。
// 这里在假 DOM 里运行真实 index.html 和 ui/app.js，核对：什么配置才提供入口、先预览再数量二次确认、各种拒绝的处理、焦点与反馈的落点。
// 真实 Chrome 里的布局、颜色和原生焦点行为见 tests/ui-review.integration.ts 里同主题的用例（本轮没有运行过浏览器）。
const HOUR = 3_600_000, DAY = 24 * HOUR, ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const typeText = dom.type;
const online = (n: number, label: string, extra: object = {}): FakeProfile => ({ id: uuid(n), label, online: true, version: '0.2.10', capabilities: ['interaction-v5', 'pause-control'], ...extra });
const gone = (n: number, label: string, age = 3 * DAY, extra: object = {}): FakeProfile => ({ id: uuid(n), label, online: false, version: '0.2.9', lastSeen: ago(age), ...extra });
const login = (app: MountedApp, secret: string) => { app.$('#token').value = secret; app.$('#login-form').dispatchEvent(new FakeEvent('submit', true)); };
const posts = (app: MountedApp) => app.server.log.filter(request => request.method === 'POST' && request.path === '/profiles/abandon');
const previews = (app: MountedApp) => app.server.log.filter(request => request.method === 'GET' && request.path.startsWith('/profiles/abandon'));
const labels = (root: FakeElement) => root.querySelectorAll('button').map(node => node.textContent);
const rowOf = (app: MountedApp, text: string) => app.$$('#protection-notice .protection-profile').find(row => row.textContent.includes(text))!;
const abandonButton = (app: MountedApp, text: string) => buttonByText(rowOf(app, text), '放弃此配置…');
// 活动页的操作记录：按假服务器的 pending 生成，形状与 chrome_operations 一致
const noPairings = (server: FakeServer) => { server.hooks['GET /browser-pairings'] = () => ({ status: 200, body: { pairings: [] } }); };
const cardOf = (app: MountedApp, text: string) => app.$$('.profile-card').find(card => card.textContent.includes(text))!;
function operationsFromPending(server: FakeServer) {
  server.rpc.chrome_operations = (args: any) => {
    const items = (server.pending[args.profileId] ?? []).filter(item => args.state === undefined || item.state === args.state).map(item => ({ ...item, profileId: args.profileId, owner: 'agent', finishedAt: null, acknowledgedAt: null }));
    return { items: items.slice(args.offset, args.offset + args.limit), total: items.length, nextOffset: args.offset + args.limit < items.length ? args.offset + args.limit : null };
  };
}
// 一个常见场景：一个在线配置、一个三天没出现的旧配置（名下两条 unknown：一条带标签页，一条整个浏览器）
async function oldProfileScene(t: Parameters<typeof mountApp>[0], extra: { profiles?: FakeProfile[]; setup?: (server: FakeServer) => void } = {}) {
  const live = online(1, '在线配置'), old = gone(2, '旧配置'), server = createServer({ profiles: [live, old, ...(extra.profiles ?? [])] });
  addPending(server, old.id, 1, { tabId: 7, tool: 'chrome_evaluate', errorCode: 'COMMAND_TIMEOUT' });
  addPending(server, old.id, 1, { tabId: null, tool: 'chrome_new_tab', errorCode: 'SERVICE_RESTARTED' });
  operationsFromPending(server); extra.setup?.(server);
  const app = await mountApp(t, { server });
  return { app, server, live, old, dialog: app.$('#profile-abandon'), count: app.$('#profile-abandon-count'), confirm: app.$('#confirm-profile-abandon'), cancel: app.$('#cancel-profile-abandon'), feedback: app.$('#profile-abandon [data-feedback]') };
}

test('待核查提示：只有离线且长期未见的配置才多一个“放弃此配置…”；在线、刚离线、旧服务（没有在线状态）都只有原来的核查按钮', async t => {
  const live = online(1, '在线配置'), old = gone(2, '旧配置', 3 * DAY), recent = gone(3, '刚关掉的', 2 * HOUR), edge = gone(4, '超过一天', DAY + 60_000), ghost = uuid(9), legacy = uuid(8);
  const server = createServer({ profiles: [live, old, recent, edge] });
  for (const [id, count] of [[live.id, 1], [old.id, 2], [recent.id, 1], [edge.id, 1], [ghost, 1]] as const) addPending(server, id, count);
  server.protection.profiles.push({ profileId: legacy, unknown: 1, running: 0 }); server.protection.unknown++; // 旧服务的汇总项：没有 online/label/lastSeen
  const app = await mountApp(t, { server });
  assert.match(app.text('#overview-title'), /有操作需要先核查/);
  assert.deepEqual(labels(rowOf(app, '在线配置')), ['在线配置 · 核查 1 条']);
  assert.deepEqual(labels(rowOf(app, '旧配置')), ['旧配置 · 核查 2 条', '放弃此配置…']);
  assert.match(rowOf(app, '旧配置').textContent, /未连接，最后在线 .+。如果这个配置已经不存在，可以放弃它的待核查记录/);
  assert.deepEqual(labels(rowOf(app, '刚关掉的')), ['刚关掉的 · 核查 1 条'], '离线才 2 小时：很可能只是浏览器关了');
  assert.match(rowOf(app, '刚关掉的').textContent, /未连接，最后在线 .+。请打开原来的 Chrome 继续连接后再核查；超过 24 小时没有出现，才可以放弃这个配置/);
  assert.deepEqual(labels(rowOf(app, '超过一天')), ['超过一天 · 核查 1 条', '放弃此配置…'], '超过 24 小时即可放弃');
  assert.deepEqual(labels(rowOf(app, ghost)), [`${ghost} · 核查 1 条`, '放弃此配置…'], '服务端完全没有这个配置的记录：只能用 ID 称呼，也只能放弃');
  assert.match(rowOf(app, ghost).textContent, /未连接，没有最后在线时间的记录/);
  assert.deepEqual(labels(rowOf(app, legacy)), [`${legacy} · 核查 1 条`], '旧服务没有 online：一律走原来的“解除保护”');
  assert.equal(previews(app).length, 0, '只是显示按钮，不会预先读取预览');
  // 读屏按按钮列表浏览时分得清是哪一个配置：可访问名称以可见文字开头，再带上账号名称
  assert.equal(abandonButton(app, '旧配置').getAttribute('aria-label'), '放弃此配置…（旧配置）');
});

test('按服务端时钟（checkedAt）判断“长期未见”，不受本机时钟影响', async t => {
  const old = gone(2, '旧配置', 0, { lastSeen: '2026-10-20T00:00:00.000Z' }), server = createServer({ profiles: [old] });
  addPending(server, old.id, 1); server.checkedAt = () => '2026-10-20T00:30:00.000Z'; // 服务端认为只离开了 30 分钟，即使本机时钟早已过了很多天
  const app = await mountApp(t, { server });
  assert.deepEqual(labels(rowOf(app, '旧配置')), ['旧配置 · 核查 1 条']);
  server.checkedAt = () => '2026-10-23T00:30:00.000Z'; await app.tick(5000);
  assert.deepEqual(labels(rowOf(app, '旧配置')), ['旧配置 · 核查 1 条', '放弃此配置…'], '时间过去后，提示区跟着重建出现放弃入口');
});

test('放弃离线配置：先 GET 预览并列出受影响的记录，数量二次确认后才 POST；成功后提示区消失、状态栏写明没有重放', async t => {
  const { app, server, old, dialog, count, confirm, feedback } = await oldProfileScene(t);
  const opener = abandonButton(app, '旧配置'); opener.focus(); opener.click(); await app.flush();
  assert.deepEqual(previews(app).map(request => request.path), [`/profiles/abandon?profileId=${old.id}`]);
  assert.equal(previews(app)[0]!.bearer, app.storedSession(), '和其他管理请求一样带管理页会话令牌');
  assert.equal(dialog.open, true); assert.equal(posts(app).length, 0, '预览阶段不改任何东西');
  const text = dialog.textContent;
  assert.match(app.text('#profile-abandon-context'), /^旧配置\n配置 ID：/); assert.ok(text.includes(old.id)); assert.match(text, /当前未连接 · 最后在线 .+（3 天前）/); assert.match(text, /待核查的操作：2 条/);
  assert.match(text, /chrome_evaluate/); assert.match(text, /标签 7/); assert.match(text, /COMMAND_TIMEOUT/); assert.match(text, /chrome_new_tab/); assert.match(text, /整个浏览器/); assert.match(text, /SERVICE_RESTARTED/); assert.match(text, /结果待确认/);
  assert.equal(app.$$('#profile-abandon-operations li').length, 2);
  assert.match(app.$$('#profile-abandon-operations li')[0]!.textContent, /chrome_new_tab/, '最新的在最前面');
  assert.match(text, /不会连接浏览器，不会重放、撤销或重新执行任何操作/); assert.match(text, /只是暂时离线/);
  assert.match(app.text('#profile-abandon-count-text'), /（2）/);
  assert.equal(confirm.disabled, true, '没有输入数量前不能确认'); same(app.doc.activeElement, count, '焦点进入数量输入框');
  for (const wrong of ['', '1', '3', '22', '2x', '02', '二']) { typeText(count, wrong); assert.equal(confirm.disabled, true, `输入 ${JSON.stringify(wrong)} 不应放行`); }
  typeText(count, ' 2 '); assert.equal(confirm.disabled, false, '首尾空白不影响'); typeText(count, '２'); assert.equal(confirm.disabled, false, '全角数字同样接受'); typeText(count, '2'); assert.equal(confirm.disabled, false);
  confirm.click(); await app.flush();
  assert.deepEqual(posts(app).map(request => request.body), [{ profileId: old.id, expectedUnknown: 2, confirm: true }]);
  assert.equal(posts(app)[0]!.bearer, app.storedSession());
  assert.equal(dialog.open, false); assert.equal(server.pending[old.id], undefined);
  assert.equal(app.$('#protection-notice').hidden, true); assert.doesNotMatch(app.text('#overview-title'), /核查/);
  assert.match(app.text('#status'), /已放弃「旧配置」：确认了 2 条待核查记录，并把它从列表移除/); assert.match(app.text('#status'), /没有连接浏览器，也没有重放任何操作/); assert.equal(app.$('#status').dataset.error, 'false');
  assert.equal(app.$$('#overview-browsers .browser-summary').length, 1, '已放弃的配置从浏览器列表移除');
  assert.equal(feedback.textContent, '', '对话框里的反馈不残留');
  assert.equal(count.value, '', '数量输入不残留'); assert.equal(confirm.disabled, true);
  same(app.doc.activeElement, app.$('#overview-title'), '触发按钮已随提示区消失：焦点落在概览标题，读屏会读出新的状态');
});

test('成功后若还有别的待核查配置，焦点落在提示区里第一个可用按钮', async t => {
  const { app, server, live, old } = await oldProfileScene(t);
  addPending(server, live.id, 1); await app.tick(5000);
  const opener = abandonButton(app, '旧配置'); opener.focus(); opener.click(); await app.flush();
  typeText(app.$('#profile-abandon-count'), '2'); app.click('#confirm-profile-abandon'); await app.flush();
  assert.equal(app.$('#profile-abandon').open, false); assert.equal(app.$('#protection-notice').hidden, false);
  assert.deepEqual(app.$$('#protection-notice .protection-profile').map(row => row.querySelector('button')!.textContent), ['在线配置 · 核查 1 条']);
  same(app.doc.activeElement, app.$('#protection-notice button')); assert.equal(server.pending[old.id], undefined);
});

test('预览之后又出现新的待核查记录：服务端拒绝（ABANDON_COUNT_CHANGED），对话框按最新记录刷新并清空数量，不会自动重试', async t => {
  const { app, server, old, dialog, count, confirm, feedback } = await oldProfileScene(t);
  abandonButton(app, '旧配置').click(); await app.flush();
  addPending(server, old.id, 1, { tool: 'chrome_batch', tabId: 9, errorCode: 'CONNECTION_LOST' });
  typeText(count, '2'); confirm.click(); await app.flush();
  assert.equal(posts(app).length, 1, '只提交了一次'); assert.equal(dialog.open, true); assert.equal(server.pending[old.id]!.length, 3, '什么都没确认');
  assert.equal(feedback.dataset.error, 'true'); assert.match(feedback.textContent, /变化/); assert.match(feedback.textContent, /现在是 3 条/);
  assert.match(app.text('#profile-abandon-context'), /待核查的操作：3 条/); assert.equal(app.$$('#profile-abandon-operations li').length, 3); assert.match(dialog.textContent, /chrome_batch/);
  assert.match(app.text('#profile-abandon-count-text'), /（3）/); assert.equal(count.value, ''); assert.equal(confirm.disabled, true, '必须按新数量重新确认');
  typeText(count, '2'); assert.equal(confirm.disabled, true, '旧数量不再放行'); typeText(count, '3'); assert.equal(confirm.disabled, false);
  confirm.click(); await app.flush();
  assert.deepEqual(posts(app).map(request => request.body.expectedUnknown), [2, 3]); assert.equal(dialog.open, false); assert.equal(server.pending[old.id], undefined);
});

test('确认前这个配置重新连上了：服务端拒绝（PROFILE_ONLINE），对话框显示在线状态并禁用确认，什么都不确认', async t => {
  const { app, server, old, dialog, count, confirm, feedback } = await oldProfileScene(t);
  abandonButton(app, '旧配置').click(); await app.flush();
  old.online = true; typeText(count, '2'); confirm.click(); await app.flush();
  assert.equal(dialog.open, true); assert.equal(feedback.dataset.error, 'true'); assert.match(feedback.textContent, /重新连接/); assert.match(feedback.textContent, /解除保护/);
  assert.match(app.text('#profile-abandon-context'), /当前在线/); assert.equal(count.disabled, true); assert.equal(confirm.disabled, true);
  assert.equal(server.pending[old.id]!.length, 2); assert.equal(posts(app).length, 1);
  typeText(count, '2'); assert.equal(confirm.disabled, true, '在线的配置不可能再被放行');
});

test('预览显示仍有运行中的操作：不能放弃，数量输入和确认都禁用，焦点落在“返回”', async t => {
  const { app, dialog, count, confirm, cancel, feedback } = await oldProfileScene(t, { setup: server => { addPending(server, uuid(2), 1, { state: 'running', tool: 'chrome_batch' }); } }); // uuid(2) 就是“旧配置”
  abandonButton(app, '旧配置').click(); await app.flush();
  assert.equal(dialog.open, true); assert.match(feedback.textContent, /1 个操作仍在运行/); assert.equal(feedback.dataset.error, 'true');
  assert.match(app.text('#profile-abandon-context'), /另有 1 个操作仍在运行/); assert.match(dialog.textContent, /进行中/);
  assert.equal(count.disabled, true); assert.equal(confirm.disabled, true); same(app.doc.activeElement, cancel);
  typeText(count, '2'); assert.equal(confirm.disabled, true); confirm.click(); await app.flush(); assert.equal(posts(app).length, 0);
});

test('预览时已经没有待核查记录（别处刚确认完）：不提供放弃，说明原因', async t => {
  const { app, server, old, dialog, count, confirm, feedback } = await oldProfileScene(t);
  server.pending[old.id] = []; // 仪表盘还没轮询到，服务端已经没有记录
  abandonButton(app, '旧配置').click(); await app.flush();
  assert.equal(dialog.open, true); assert.match(feedback.textContent, /没有待核查的记录/); assert.equal(count.disabled, true); assert.equal(confirm.disabled, true);
  assert.equal(app.$$('#profile-abandon-operations li').length, 0);
});

test('预览本身失败（例如配置和记录都不存在）：不打开对话框，错误写在页面状态栏，按钮恢复可点并保持焦点', async t => {
  const { app, server, old, dialog } = await oldProfileScene(t);
  server.hooks[`GET /profiles/abandon?profileId=${old.id}`] = () => ({ status: 400, body: { ok: false, error: { code: 'PROFILE_NOT_FOUND', message: '没有这个配置，也没有它的待核查记录。' } } });
  const opener = abandonButton(app, '旧配置'); opener.focus(); opener.click(); await app.frame();
  assert.equal(dialog.open, false); assert.match(app.text('#status'), /没有这个配置/); assert.equal(app.$('#status').dataset.error, 'true');
  assert.equal(opener.disabled, false); same(app.doc.activeElement, opener); assert.equal(posts(app).length, 0);
});

test('提交失败（数据库暂时不可用等非预期错误）：错误写进对话框，对话框保持打开，可以重试', async t => {
  const { app, server, old, dialog, count, confirm, feedback } = await oldProfileScene(t);
  abandonButton(app, '旧配置').click(); await app.flush();
  let broken = true; server.hooks['POST /profiles/abandon'] = () => broken ? { status: 400, body: { ok: false, error: { code: 'INTERNAL', message: '数据库暂时不可用' } } } : undefined;
  typeText(count, '2'); confirm.click(); await app.flush();
  assert.equal(dialog.open, true); assert.equal(feedback.textContent, '数据库暂时不可用'); assert.equal(feedback.dataset.error, 'true'); assert.equal(app.text('#status'), '', '不写进被 modal 遮住的全局状态栏');
  assert.equal(previews(app).length, 1, '非预期错误不重新预览'); assert.equal(confirm.disabled, false, '数量仍然有效，可以直接重试'); assert.equal(count.value, '2');
  broken = false; confirm.click(); await app.flush(); assert.equal(dialog.open, false); assert.equal(server.pending[old.id], undefined);
});

test('取消、Esc 关闭对话框：焦点回到触发按钮（按钮在异步读取期间失焦也一样），不提交任何东西，下次打开不残留', async t => {
  const { app, server, old, dialog, count, feedback, confirm } = await oldProfileScene(t), gate = defer();
  server.hooks[`GET /profiles/abandon?profileId=${old.id}`] = async () => { await gate.promise; };
  const opener = abandonButton(app, '旧配置'); opener.focus(); opener.click(); await app.frame();
  assert.equal(opener.disabled, true); same(app.doc.activeElement, app.doc.body, '前提：忙碌的按钮已失焦，showModal 记不到该还给谁');
  gate.resolve(); await app.flush(); assert.equal(dialog.open, true);
  typeText(count, '2'); feedback.textContent = '上一次的提示'; app.click('#cancel-profile-abandon'); await app.frame();
  assert.equal(dialog.open, false); same(app.doc.activeElement, opener); assert.equal(posts(app).length, 0);
  delete server.hooks[`GET /profiles/abandon?profileId=${old.id}`];
  opener.focus(); opener.click(); await app.frame(); assert.equal(dialog.open, true);
  assert.equal(count.value, '', '数量输入不残留'); assert.equal(feedback.textContent, '', '反馈不残留'); assert.equal(confirm.disabled, true);
  dialog.close(); await app.frame(); same(app.doc.activeElement, opener); // 浏览器的 Esc 就是直接关闭对话框
});

test('连续点了两个配置的“放弃”：只显示最后一次点击对应的预览，较早返回的预览被丢弃', async t => {
  const other = gone(3, '另一个旧配置', 5 * DAY), gate = defer();
  const { app, server, old } = await oldProfileScene(t, { profiles: [other], setup: server => { addPending(server, other.id, 1, { tool: 'chrome_click' }); } });
  server.hooks[`GET /profiles/abandon?profileId=${old.id}`] = async () => { await gate.promise; };
  abandonButton(app, '旧配置').click(); await app.flush(); abandonButton(app, '另一个旧配置').click(); await app.flush();
  assert.equal(app.$('#profile-abandon').open, true); assert.match(app.text('#profile-abandon-context'), /^另一个旧配置\n/);
  gate.resolve(); await app.flush();
  assert.match(app.text('#profile-abandon-context'), /^另一个旧配置\n/, '较早的预览晚到也不能覆盖'); assert.match(app.text('#profile-abandon-count-text'), /（1）/);
});

test('较早点击的预览晚到时，用户已经取消了后一次的对话框：它也不能再弹出来', async t => {
  const other = gone(3, '另一个旧配置', 5 * DAY), gate = defer();
  const { app, server, old, dialog } = await oldProfileScene(t, { profiles: [other], setup: server => { addPending(server, other.id, 1, { tool: 'chrome_click' }); } });
  server.hooks[`GET /profiles/abandon?profileId=${old.id}`] = async () => { await gate.promise; };
  const first = abandonButton(app, '旧配置'); first.click(); await app.flush();
  abandonButton(app, '另一个旧配置').click(); await app.flush(); assert.equal(dialog.open, true);
  app.click('#cancel-profile-abandon'); await app.flush(); assert.equal(dialog.open, false);
  gate.resolve(); await app.flush();
  assert.equal(dialog.open, false, '用户已经做出选择：较早点击的预览晚到也不能再弹出对话框'); assert.equal(first.disabled, false, '较早点击的按钮已恢复可用');
});

test('预览读取中退出管理页：迟到的预览不会打开对话框；重新登录后入口仍可用', async t => {
  const { app, server, old, dialog } = await oldProfileScene(t), gate = defer();
  server.hooks[`GET /profiles/abandon?profileId=${old.id}`] = async () => { await gate.promise; };
  abandonButton(app, '旧配置').click(); await app.flush();
  app.click('#lock-dashboard'); await app.flush(); assert.equal(app.$('#login').hidden, false);
  gate.resolve(); await app.flush(); assert.equal(dialog.open, false, '旧会话的预览不能在退出后弹出来'); assert.equal(app.text('#status'), '', '也不显示旧会话的错误');
  delete server.hooks[`GET /profiles/abandon?profileId=${old.id}`];
  login(app, server.credential); await app.flush(); abandonButton(app, '旧配置').click(); await app.flush();
  assert.equal(dialog.open, true);
});

test('提交在途时用户关闭了对话框：放弃仍然完成，页面照常刷新并给出结果说明；提交期间确认按钮不能重复点击', async t => {
  const { app, server, old, dialog, count, confirm } = await oldProfileScene(t), gate = defer();
  server.hooks['POST /profiles/abandon'] = async () => { await gate.promise; };
  abandonButton(app, '旧配置').click(); await app.flush(); typeText(count, '2'); confirm.click(); await app.flush();
  assert.equal(confirm.disabled, true, '提交期间确认按钮处于忙碌态'); confirm.click(); assert.equal(posts(app).length, 1, '禁用的按钮不会重复提交');
  dialog.close(); await app.flush(); // 用户在等待期间按了 Esc
  gate.resolve(); await app.flush();
  assert.equal(server.pending[old.id], undefined); assert.equal(app.$('#protection-notice').hidden, true); assert.match(app.text('#status'), /已放弃「旧配置」/);
  assert.equal(confirm.disabled, true, '对话框已关闭，确认按钮不会被忙碌态结束后重新启用'); assert.equal(posts(app).length, 1);
});

test('放弃时恰好有一次仪表盘轮询在途：等它结束后再读一次，不把放弃之前的旧状态留在页面上', async t => {
  const { app, server, old, count, confirm } = await oldProfileScene(t), gate = defer(); let armed = false;
  // 这次轮询在放弃之前就已经读到了数据（快照），却在放弃之后才返回
  server.hooks['GET /dashboard'] = async () => {
    if (!armed) return undefined; armed = false;
    const body = structuredClone({ version: '0.2.0-beta.22', checkedAt: new Date().toISOString(), extensionDir: 'C:/saltedfish/extension', profiles: server.profiles, remote: server.remote, requiredExtensionCapability: 'interaction-v5', protection: server.protection });
    await gate.promise; return { status: 200, body };
  };
  abandonButton(app, '旧配置').click(); await app.flush(); typeText(count, '2');
  armed = true; await app.tick(5000); // 轮询发出，卡在 gate 上
  confirm.click(); await app.flush(); assert.equal(server.pending[old.id], undefined, '服务端已经放弃');
  gate.resolve(); await app.flush();
  assert.equal(app.$('#protection-notice').hidden, true, '页面不能停在放弃之前的旧快照上'); assert.doesNotMatch(app.text('#overview-title'), /核查/);
  assert.equal(app.$$('#overview-browsers .browser-summary').length, 1);
});

test('对话框打开时退出管理页：对话框随之关闭，不留下可操作的确认', async t => {
  const { app, dialog, count, confirm } = await oldProfileScene(t);
  abandonButton(app, '旧配置').click(); await app.flush(); typeText(count, '2'); assert.equal(confirm.disabled, false);
  app.click('#lock-dashboard'); await app.flush();
  assert.equal(dialog.open, false); assert.equal(confirm.disabled, true); assert.equal(count.value, ''); assert.equal(posts(app).length, 0);
});

test('记录很多时只列出最近 50 条并说明总数；数量确认仍按总数', async t => {
  const old = gone(2, '旧配置'), server = createServer({ profiles: [old] }); addPending(server, old.id, 60);
  const app = await mountApp(t, { server }); abandonButton(app, '旧配置').click(); await app.flush();
  assert.equal(app.$$('#profile-abandon-operations li').length, 50); assert.equal(app.$('#profile-abandon-more').hidden, false); assert.match(app.text('#profile-abandon-more'), /仅列出最近 50 条，共 60 条/);
  assert.match(app.text('#profile-abandon-count-text'), /（60）/); typeText(app.$('#profile-abandon-count'), '50'); assert.equal(app.$('#confirm-profile-abandon').disabled, true);
  typeText(app.$('#profile-abandon-count'), '60'); assert.equal(app.$('#confirm-profile-abandon').disabled, false);
});

test('配置名称、工具名、错误码都只作为文本显示，不会被当作标记解析', async t => {
  const hostile = '<img src=x onerror=alert(1)>', old = gone(2, hostile), server = createServer({ profiles: [old] });
  addPending(server, old.id, 1, { tool: '<b>chrome_evaluate</b>', errorCode: '<script>alert(2)</script>' });
  const app = await mountApp(t, { server });
  assert.equal(app.$$('img').length, 0); assert.ok(app.text('#protection-notice').includes(hostile));
  abandonButton(app, hostile).click(); await app.flush();
  assert.equal(app.$$('#profile-abandon img').length, 0); assert.equal(app.$$('#profile-abandon script').length, 0); assert.equal(app.$$('#profile-abandon b').length, 0);
  assert.ok(app.text('#profile-abandon-context').includes(hostile)); assert.ok(app.text('#profile-abandon-operations').includes('<b>chrome_evaluate</b>')); assert.ok(app.text('#profile-abandon-operations').includes('<script>alert(2)</script>'));
});

test('预览里的记录没有标签页、状态是不认识的取值：显示“整个浏览器”和原样状态，不出现 undefined', async t => {
  const { app, server, old, dialog } = await oldProfileScene(t), at = ago(HOUR);
  server.hooks[`GET /profiles/abandon?profileId=${old.id}`] = () => ({ status: 200, body: { profileId: old.id, label: '旧配置', online: false, lastSeen: ago(3 * DAY), unknown: 2, running: 0, canAbandon: true, note: '', operations: [
    { id: uuid(0x20001), tabId: null, tool: 'chrome_new_tab', state: 'queued', startedAt: at, errorCode: null }, { id: uuid(0x20002), tool: 'chrome_click', state: 'unknown', startedAt: at }] } });
  abandonButton(app, '旧配置').click(); await app.flush();
  const items = app.$$('#profile-abandon-operations li').map(node => node.textContent);
  assert.equal(dialog.open, true); assert.equal(items.length, 2);
  assert.match(items[0]!, /^chrome_new_tab · 整个浏览器 · queued/); assert.match(items[1]!, /^chrome_click · 整个浏览器 · 结果待确认/); assert.doesNotMatch(dialog.textContent, /undefined|null/);
});

test('对话框的结构：有名称和描述、数量输入有关联的标签、反馈区是 alert、记录列表可聚焦且有名称', async t => {
  const { app, dialog } = await oldProfileScene(t);
  const byId = (id: string) => app.$(`#${id}`);
  assert.equal(dialog.getAttribute('aria-labelledby'), 'profile-abandon-title'); assert.ok(byId('profile-abandon-title').textContent);
  for (const id of dialog.getAttribute('aria-describedby')!.split(' ')) assert.ok(byId(id), `描述 ${id} 存在`);
  assert.equal(app.$('label[for=profile-abandon-count]').querySelector('input')?.id, 'profile-abandon-count');
  assert.equal(app.$('#profile-abandon [data-feedback]').getAttribute('role'), 'alert');
  const list = byId('profile-abandon-operations'); assert.equal(list.getAttribute('tabindex'), '0'); assert.ok(list.getAttribute('aria-label')); assert.equal(list.getAttribute('role'), 'list');
  assert.equal(byId('confirm-profile-abandon').className.split(' ').includes('danger'), true, '不可逆操作使用警示样式');
  assert.equal(byId('profile-abandon-count').getAttribute('inputmode'), 'numeric'); assert.equal(byId('profile-abandon-count').getAttribute('autocomplete'), 'off');
  assert.equal(byId('overview-title').getAttribute('tabindex'), '-1', '概览标题可以接收程序设置的焦点');
});

// ───────── 活动页：离线配置的说明、放弃入口，以及逐条核查对话框里的出路 ─────────
test('活动页：离线且长期未见的配置显示说明和“放弃此配置…”；刚离线的只给说明；在线的什么都不加', async t => {
  const recent = gone(3, '刚关掉的', 2 * HOUR);
  const { app, old, live } = await oldProfileScene(t, { profiles: [recent], setup: server => { addPending(server, recent.id, 1); addPending(server, uuid(1), 1); } });
  await app.navigate('activity'); choose(app.$('#activity-profile'), old.id); await app.flush();
  assert.equal(app.$$('#operations tbody tr').length, 2);
  const banner = app.$('#operations .offline-note'); assert.match(banner.textContent, /当前未连接/); assert.match(banner.textContent, /3 天前/); assert.match(banner.textContent, /已经不存在/); assert.deepEqual(labels(banner), ['放弃此配置…']);
  choose(app.$('#activity-profile'), recent.id); await app.flush();
  assert.match(app.text('#operations .offline-note'), /当前未连接/); assert.match(app.text('#operations .offline-note'), /超过 24 小时/); assert.deepEqual(labels(app.$('#operations .offline-note')), []);
  choose(app.$('#activity-profile'), live.id); await app.flush();
  assert.equal(app.$$('#operations .offline-note').length, 0); assert.equal(app.$$('#operations tbody tr').length, 1);
});

test('活动页：离线配置没有待核查记录时不显示说明', async t => {
  const { app, old } = await oldProfileScene(t); await app.navigate('activity');
  app.server.pending[old.id] = []; choose(app.$('#activity-profile'), old.id); await app.flush();
  assert.equal(app.$$('#operations .offline-note').length, 0); assert.match(app.text('#operations'), /没有待核查操作/);
});

test('活动页的“放弃此配置…”：打开同一个对话框，取消后焦点回到这个按钮；成功后列表回到“选择浏览器”', async t => {
  const { app, server, old, dialog } = await oldProfileScene(t); await app.navigate('activity'); choose(app.$('#activity-profile'), old.id); await app.flush();
  const opener = buttonByText(app.$('#operations .offline-note'), '放弃此配置…'); opener.focus(); opener.click(); await app.frame();
  assert.equal(dialog.open, true); assert.match(app.text('#profile-abandon-context'), /^旧配置\n/);
  app.click('#cancel-profile-abandon'); await app.frame(); same(app.doc.activeElement, opener);
  opener.click(); await app.flush(); typeText(app.$('#profile-abandon-count'), '2'); app.click('#confirm-profile-abandon'); await app.flush();
  assert.equal(dialog.open, false); assert.equal(server.pending[old.id], undefined);
  assert.equal(app.$('#activity-profile').value, '', '已放弃的配置不再出现在选择列表里'); assert.match(app.text('#operations'), /选择浏览器后查看操作记录/);
  same(app.doc.activeElement, app.$('#activity-profile'), '按钮随列表消失：焦点落在账号选择框');
  assert.match(app.text('#status'), /已放弃「旧配置」/);
});

test('逐条核查对话框：离线配置显示出路；确认被服务端按 PROFILE_OFFLINE 拒绝时给出能照着做的说明，而不是接口路径', async t => {
  const { app, server, old } = await oldProfileScene(t); await app.navigate('activity'); choose(app.$('#activity-profile'), old.id); await app.flush();
  server.rpc.chrome_recover_operation = () => { throw Object.assign(new Error(`配置 ${old.id} 未连接，无法在原页面核查这条记录。……管理接口 POST /profiles/abandon，先 GET 同一路径预览）。`), { code: 'PROFILE_OFFLINE' }); };
  const row = app.$('#operations [data-recover]'); row.focus(); row.click(); await app.flush();
  const hint = app.$('#operation-recovery-offline'); assert.equal(hint.hidden, false); assert.match(hint.textContent, /当前未连接/); assert.match(hint.textContent, /3 天前/); assert.equal(app.$('#abandon-from-recovery').hidden, false);
  app.click('#operation-reviewed'); app.click('#confirm-operation-recovery'); await app.flush();
  const feedback = app.$('#operation-recovery [data-feedback]'); assert.equal(feedback.dataset.error, 'true');
  assert.match(feedback.textContent, /打开原来的 Chrome/); assert.match(feedback.textContent, /放弃/); assert.doesNotMatch(feedback.textContent, /POST|\/profiles\/abandon/);
  // 从这里直接放弃：先读预览，成功后才换对话框；取消后焦点回到触发核查的那一行按钮
  app.click('#abandon-from-recovery'); await app.flush();
  assert.equal(app.$('#operation-recovery').open, false); assert.equal(app.$('#profile-abandon').open, true);
  app.click('#cancel-profile-abandon'); await app.frame(); same(app.doc.activeElement, row);
});

test('逐条核查对话框：预览读取失败时错误留在这个对话框里，对话框保持打开', async t => {
  const { app, server, old } = await oldProfileScene(t); await app.navigate('activity'); choose(app.$('#activity-profile'), old.id); await app.flush();
  server.hooks[`GET /profiles/abandon?profileId=${old.id}`] = () => ({ status: 400, body: { ok: false, error: { code: 'PROFILE_NOT_FOUND', message: '没有这个配置，也没有它的待核查记录。' } } });
  app.click('#operations [data-recover]'); await app.flush(); app.click('#abandon-from-recovery'); await app.flush();
  assert.equal(app.$('#operation-recovery').open, true); assert.equal(app.$('#profile-abandon').open, false); assert.match(app.text('#operation-recovery [data-feedback]'), /没有这个配置/);
});

test('逐条核查对话框：刚离线的配置只提示先回到原 Chrome（没有放弃按钮）；在线配置不显示任何离线提示，行为不变', async t => {
  const recent = gone(3, '刚关掉的', 2 * HOUR), live = online(1, '在线配置'), server = createServer({ profiles: [live, recent] }); addPending(server, recent.id, 1); addPending(server, live.id, 1); operationsFromPending(server);
  server.rpc.chrome_recover_operation = () => ({});
  const app = await mountApp(t, { server }); await app.navigate('activity');
  choose(app.$('#activity-profile'), recent.id); await app.flush(); app.click('#operations [data-recover]'); await app.flush();
  assert.equal(app.$('#operation-recovery-offline').hidden, false); assert.match(app.text('#operation-recovery-offline'), /超过 24 小时/); assert.equal(app.$('#abandon-from-recovery').hidden, true);
  app.click('#cancel-operation-recovery'); await app.flush();
  choose(app.$('#activity-profile'), live.id); await app.flush(); app.click('#operations [data-recover]'); await app.flush();
  assert.equal(app.$('#operation-recovery-offline').hidden, true, '在线配置：原来的“解除保护”不变');
  app.click('#operation-reviewed'); app.click('#confirm-operation-recovery'); await app.flush();
  assert.equal(app.$('#operation-recovery').open, false); assert.equal(server.rpcCalls('chrome_recover_operation').length, 1);
});

// ───────── 页脚与接入向导里的授权说明 ─────────
// 这些说明必须和接入向导“一次信任”预览里的事实一致（src/client-setup.ts 的 notices）：任何一边改了口径，这里就会提醒另一边同步。
const sharedClaims = ['只能使用授权给', '不再逐次确认', '服务管理页和扩展自身页面受保护', 'Agent 只能从服务所在的电脑连接', '路径由 Agent 自己的权限设置决定，SaltedFish 只拒绝它自己的数据目录和网络共享路径', '撤销只阻止之后的调用，已发出的操作不会撤回'];
test('页脚如实描述授权边界，并与接入向导预览使用同一套说法', async t => {
  const app = await mountApp(t, { server: createServer({ profiles: [online(1, '个人')] }) }), footer = app.text('footer'), preview = readFileSync(path.join(projectDir, 'src', 'client-setup.ts'), 'utf8');
  assert.doesNotMatch(footer, /仅能访问你授权的配置/, '旧页脚过于乐观');
  for (const claim of sharedClaims) { assert.ok(footer.includes(claim), `页脚缺少：${claim}`); assert.ok(preview.includes(claim), `接入向导预览里没有这句话了（页脚需要同步）：${claim}`); }
  assert.match(footer, /浏览器保持你的登录状态/); assert.match(footer, /一次信任后/);
});

test('接入向导卡片里的提示与预览口径一致，并指向预览里的完整说明', async t => {
  const app = await mountApp(t, { server: createServer({ profiles: [online(1, '个人')] }) }); await app.navigate('setup');
  const hints = app.$$('.setup-card[data-client=codex] small').map(node => node.textContent).filter(text => text.includes('一次信任'));
  assert.equal(hints.length, 1); const hint = hints[0]!;
  for (const claim of ['不再逐次确认', '撤销只阻止之后的调用，已发出的操作不会撤回']) assert.ok(hint.includes(claim), `提示缺少：${claim}`);
  assert.match(hint, /默认覆盖全部已配对配置/); assert.match(hint, /预览接入/); assert.match(hint, /“客户端授权”/);
  assert.doesNotMatch(hint, /信任后可读取和操作已授权的 Chrome/);
});

test('pi 的卡片没有授权选项，只说明它默认不逐次确认；agy 不能选项目目录', async t => {
  const app = await mountApp(t, { server: createServer({ profiles: [online(1, '个人')] }) }); await app.navigate('setup');
  assert.equal(app.$$('.setup-card[data-client=pi] .setup-trust').length, 0);
  assert.ok(app.$$('.setup-card[data-client=pi] small').some(node => node.textContent.includes('pi 默认不逐次确认')));
  assert.ok(!app.$$('.setup-card[data-client=pi] small').some(node => node.textContent.includes('一次信任后')));
  assert.equal(app.$$('.setup-card[data-client=agy] .setup-trust').length, 1);
  assert.deepEqual(app.$$('.setup-card[data-client=agy] .setup-scope option').map(node => node.value), ['default', 'custom']);
  assert.deepEqual(app.$$('.setup-card[data-client=codex] .setup-scope option').map(node => node.value), ['default', 'project', 'custom']);
  for (const client of ['claude-desktop', 'workbuddy']) {
    assert.equal(app.$$(`.setup-card[data-client=${client}] .setup-trust`).length, 0);
    assert.deepEqual(app.$$(`.setup-card[data-client=${client}] .setup-scope option`).map(node => node.value), ['default', 'custom']);
    assert.ok(app.$$(`.setup-card[data-client=${client}] small`).some(node => node.textContent.includes('审批设置')));
  }
  assert.equal(app.$$('.setup-card[data-client=codebuddy] .setup-trust').length, 1);
});

test('离线卡片点“重新连接”：就地给出配对码，轮询不收起，连上后收起', async t => {
  const old = gone(2, '旧电脑'), server = createServer({ profiles: [online(1, '在线配置'), old] }); noPairings(server);
  server.hooks['POST /browser-pairings'] = () => ({ status: 201, body: { connectionCode: 'sf-connect:new-code' } });
  const app = await mountApp(t, { server }); await app.navigate('accounts');
  assert.deepEqual(labels(cardOf(app, '在线配置')).filter(text => ['重新连接', '移除…'].includes(text)), [], '在线的浏览器没有这两个入口');
  assert.match(cardOf(app, '旧电脑').querySelector('.profile-description')!.textContent, /重新连接/);
  buttonByText(cardOf(app, '旧电脑'), '重新连接').click(); await app.flush();
  assert.deepEqual(server.log.filter(request => request.method === 'POST' && request.path === '/browser-pairings').map(request => request.body), [{ label: '旧电脑', profileId: old.id, replace: true }]);
  const panel = cardOf(app, '旧电脑').querySelector('.reconnect-panel')!;
  assert.equal(panel.querySelector('textarea')!.value, 'sf-connect:new-code'); assert.match(panel.textContent, /原来的配对已作废/);
  buttonByText(panel, '复制配对码').click(); await app.flush(); assert.deepEqual(app.copied, ['sf-connect:new-code']);
  await app.tick(5000); assert.equal(app.$$('.reconnect-panel').length, 1, '轮询时配对码还在');
  old.online = true; await app.tick(5000); assert.equal(app.$$('.reconnect-panel').length, 0, '连上后收起');
  old.online = false; await app.tick(5000); assert.equal(app.$$('.reconnect-panel').length, 0, '再掉线也不会露出旧配对码');
});

test('配对记录只列有效的，用浏览器现在的名字', async t => {
  const a = online(1, '现在的名字'), server = createServer({ profiles: [a] });
  server.hooks['GET /browser-pairings'] = () => ({ status: 200, body: { pairings: [{ id: uuid(11), label: '当初的名字', profileId: a.id, revoked: false, canManage: false }, { id: uuid(12), label: '作废的', profileId: a.id, revoked: true, canManage: false }] } });
  const app = await mountApp(t, { server }); await app.navigate('accounts');
  assert.equal(app.$$('.pairing-row').length, 1); assert.match(app.text('#browser-pairings'), /现在的名字/); assert.doesNotMatch(app.text('#browser-pairings'), /当初的名字|作废的/);
});

test('没有待核查记录的离线浏览器确认后移除，有记录的走放弃对话框', async t => {
  const clean = gone(2, '不用了'), busy = gone(3, '有记录'), server = createServer({ profiles: [online(1, '在线配置'), clean, busy] }); noPairings(server); addPending(server, busy.id, 1); operationsFromPending(server);
  const app = await mountApp(t, { server }); await app.navigate('accounts');
  buttonByText(cardOf(app, '不用了'), '移除…').click(); await app.flush();
  assert.match(app.confirms[0]!, /移除“不用了”/); assert.deepEqual(posts(app).map(request => request.body), [{ profileId: clean.id, expectedUnknown: 0, confirm: true }]);
  assert.equal(cardOf(app, '不用了'), undefined, '卡片消失');
  buttonByText(cardOf(app, '有记录'), '移除…').click(); await app.flush();
  assert.equal(app.confirms.length, 1, '不走简单确认'); assert.equal(app.$('#profile-abandon').open, true); assert.equal(posts(app).length, 1);
});
