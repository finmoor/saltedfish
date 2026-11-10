import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { unifiedFixture, fakeProfile } from './helpers.js';
import { BrowserError, CAPABILITY, EXTENSION_CAPABILITIES, type WireCommand } from '../src/shared.js';
import { toolMap } from '../src/tools.js';

// 上传走本机路径（浏览器和服务同机），不经内容暂存。
const here = process.platform === 'win32' ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36' : process.platform === 'darwin' ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36' : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

// 11-08 那批使用反馈的服务端部分：参数校验、find 的 selector 换成 locator.inside、
// 用到 inside 或 attached 时要 interaction-v10、旧扩展报不能按按钮上传时的提示、截图坐标的说明。页面里的行为在 interaction-feedback-1108.integration.ts。
test('locator.inside、state:"attached"：参数校验，find 的 selector 当 inside 发，用到时要 interaction-v10，旧扩展一条都收不到', async t => {
  const f = await unifiedFixture(); t.after(() => f.cleanup());
  const seen: WireCommand[] = [];
  const reply = (command: WireCommand) => { seen.push(command); return command.operation === 'page.wait' ? { matched: true, value: true } : command.operation === 'page.batch' ? { completed: true, results: [] } : command.operation === 'page.find' ? { elements: [], totalElements: 0, nextOffset: null } : { clicked: true }; };
  const profile = await fakeProfile(f.service.config, 'A', reply);
  const invoke = (name: string, args: Record<string, unknown>, profileId = profile.id) => f.service.invoke(name, { profileId, tabId: 7, ...args }, 'admin');
  const last = (operation: string) => seen.filter(command => command.operation === operation).at(-1)!.args;

  assert.equal((await invoke('chrome_find', { selector: '[class*=suggest]', locator: { text: '英语听力' } })).ok, true);
  assert.deepEqual(last('page.find').locator, { text: '英语听力', exact: true, inside: '[class*=suggest]' }, 'find 的 selector 换成 locator.inside');
  assert.equal(last('page.find').selector, undefined, '扩展的 selector 是“目标本身”，不能原样发过去');
  assert.equal((await invoke('chrome_find', { selector: '.a', locator: { text: 'x', inside: '.b' } })).error?.code, 'INVALID_ARGUMENT', 'selector 和 inside 只能给一个');

  assert.equal((await invoke('chrome_action', { action: 'click', locator: { text: '英语听力', inside: '[class*=suggest]' } })).ok, true);
  assert.equal((last('page.action').locator as any).inside, '[class*=suggest]');
  assert.equal((await invoke('chrome_wait', { selector: 'input[type=file]', state: 'attached', timeoutMs: 1000 })).ok, true);
  assert.equal(last('page.wait').state, 'attached');
  assert.equal((await invoke('chrome_wait', { state: 'attached' })).error?.code, 'INVALID_ARGUMENT', 'attached 要有元素');

  const old = await fakeProfile(f.service.config, 'B', reply, undefined, { userAgent: here, capabilities: EXTENSION_CAPABILITIES.filter(capability => capability !== CAPABILITY.interactionV10) });
  const before = seen.filter(command => command.operation !== 'page.cdp').length;
  for (const [name, args] of [
    ['chrome_find', { selector: '.list', locator: { text: 'x' } }],
    ['chrome_find', { locator: { text: 'x', inside: '.list' } }],
    ['chrome_action', { action: 'click', locator: { text: 'x', inside: '.list' } }],
    ['chrome_upload', { locator: { text: '上传封面', inside: '[role=dialog]' }, paths: [process.execPath] }],
    ['chrome_wait', { selector: 'input[type=file]', state: 'attached' }],
    ['chrome_action', { action: 'click', selector: '#a', postcondition: { locator: { role: 'option', inside: '.list' } } }],
    ['chrome_batch', { steps: [{ operation: 'page.wait', args: { selector: '#a', state: 'attached' } }] }],
    ['chrome_batch', { steps: [{ operation: 'page.action', args: { action: 'drag', selector: '#a', to: { locator: { text: 'x', inside: '.list' } } } }] }],
  ] as [string, Record<string, unknown>][]) assert.equal((await invoke(name, args, old.id)).error?.code, 'EXTENSION_UPDATE_REQUIRED', `${name} ${JSON.stringify(args)}`);
  assert.equal(seen.filter(command => command.operation !== 'page.cdp').length, before, '旧扩展一条都没收到');
  assert.equal((await invoke('chrome_find', { locator: { text: 'x' } }, old.id)).ok, true, '不用新字段旧扩展照常');
  assert.equal((await invoke('chrome_wait', { selector: '#a', state: 'hidden' }, old.id)).ok, true);
});

test('旧扩展按上传按钮定位报 NOT_FILE_INPUT 时，说明要更新扩展；新扩展的消息原样', async t => {
  const f = await unifiedFixture(); t.after(() => f.cleanup());
  const reject = (command: WireCommand) => { if (command.operation === 'page.upload') throw new BrowserError('NOT_FILE_INPUT', 'NOT_FILE_INPUT', { phase: 'precondition', outcome: 'not_dispatched' }); return {}; };
  const old = await fakeProfile(f.service.config, 'A', reject, undefined, { userAgent: here, capabilities: EXTENSION_CAPABILITIES.filter(capability => capability !== CAPABILITY.interactionV10) });
  const failed = await f.service.invoke('chrome_upload', { profileId: old.id, tabId: 7, selector: '.upload-area', paths: [process.execPath] }, 'admin');
  assert.equal(failed.error?.code, 'NOT_FILE_INPUT');
  assert.match(failed.error!.message, /扩展更新到 0\.3\.26 以后，可以按看得见的上传按钮或区域定位/);
  assert.equal(failed.error?.outcome, 'not_dispatched');
  const fresh = await fakeProfile(f.service.config, 'B', (command: WireCommand) => { if (command.operation === 'page.upload') throw new BrowserError('NOT_FILE_INPUT', '目标不是文件框，它里面和往上直到 body 都没有文件框。', { phase: 'precondition', outcome: 'not_dispatched' }); return {}; }, undefined, { userAgent: here });
  const plain = await f.service.invoke('chrome_upload', { profileId: fresh.id, tabId: 7, selector: '.nothing', paths: [process.execPath] }, 'admin');
  assert.equal(plain.error?.message, '目标不是文件框，它里面和往上直到 body 都没有文件框。');
});

test('截图坐标的说明：视口截图只说除以 scale；其余用 toViewport；固定元素说清画在图里哪个高度，页面滚过才建议先滚到顶', async t => {
  const f = await unifiedFixture(); t.after(() => f.cleanup());
  const data = Buffer.from('png').toString('base64');
  let coordinates: Record<string, unknown> = {};
  const profile = await fakeProfile(f.service.config, 'A', () => ({ mimeType: 'image/png', data, coordinates }));
  const note = async (value: Record<string, unknown>, args: Record<string, unknown> = {}) => { coordinates = value; const shot = await f.service.invoke('chrome_screenshot', { profileId: profile.id, tabId: 7, ...args }, 'admin'); assert.equal(shot.ok, true, JSON.stringify(shot.error)); return String((shot.data as any).coordinates.note); };
  assert.match(await note({ cssPixels: true, viewport: true, scale: 0.5 }, { scale: 0.5 }), /图片坐标 ÷ 0\.5 就是 chrome_action 的 x\/y/);
  const page = await note({ cssPixels: true, area: { x: 0, y: 0, width: 1905, height: 1583 }, scroll: { x: 0, y: 638 }, toViewport: { x: 0, y: -638 }, fixed: [{ selector: 'header.top', box: [0, 319, 952, 30] }], scale: 0.5 }, { fullPage: true, scale: 0.5 });
  assert.match(page, /chrome_action 的 x = 图片 x ÷ 0\.5 \+ toViewport\.x/);
  assert.match(page, /header\.top 画在图片 y≈319/);
  assert.match(page, /先用 chrome_action 的 scroll 滚到顶再截/);
  const top = await note({ cssPixels: true, area: { x: 0, y: 0, width: 800, height: 3000 }, scroll: { x: 0, y: 0 }, toViewport: { x: 0, y: 0 }, fixed: [{ selector: 'footer.bar', box: [0, 560, 800, 40] }] }, { fullPage: true });
  assert.match(top, /footer\.bar 画在图片 y≈560/); assert.doesNotMatch(top, /滚到顶/, '没滚过的页面，滚到顶也没用');
  assert.match(await note({ cssPixels: true, area: { x: 0, y: 0, width: 10, height: 10 }, scroll: { x: 0, y: 0 } }, { fullPage: true }), /area\.x\/y - scroll\.x\/y/, '旧扩展没有 toViewport，照旧按 area、scroll 说');
});

test('说明文字：locator.inside、find 的 selector、attached、上传可以定位按钮', () => {
  const schema = (name: string) => JSON.stringify(z.toJSONSchema(toolMap.get(name)!.schema, { target: 'draft-7', io: 'input' }));
  assert.match(schema('chrome_action'), /"inside"/);
  assert.match(schema('chrome_find'), /同 locator\.inside/);
  assert.match(schema('chrome_wait'), /attached 只要元素在 DOM 里/);
  assert.match(toolMap.get('chrome_upload')!.description, /看得见的上传按钮或区域/);
});
