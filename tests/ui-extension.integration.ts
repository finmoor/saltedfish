import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, cp, copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { type Browser } from 'puppeteer-core';
import { launchTestChrome } from './chrome-launch.js';
import { WebSocketServer } from 'ws';
import { fixture, freePort, testDirectory } from './helpers.js';
import { bridgeToken } from '../src/auth.js';
import { projectDir } from '../src/config.js';

const current = path.join(projectDir, 'dist/extension');
// 旧扩展用本机保留的历史安装目录里的真实文件：0.2.0-beta.21（扩展 0.2.9）是升级到 beta.22 的直接前驱，beta.8（0.2.1）是很早的版本。
// 它们只存在于做过这些发行的开发机上，干净检出里没有——那时相关用例跳过，而不是拿当前构建冒充“旧扩展”。目录只读使用，不改动。
const legacyVersions = ['0.2.0-beta.21', '0.2.0-beta.8'];
const legacyDirectory = (version: string) => path.join(projectDir, '.local/beta-install/versions', version, 'dist/extension');
const hasLegacy = (version: string) => readFile(path.join(legacyDirectory(version), 'background.js')).then(() => true, () => false);
const manifestVersion = async (directory: string) => (JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')) as { version: string }).version;
const atLeast = (actual: string, minimum: string) => { const a = actual.split('.').map(Number), b = minimum.split('.').map(Number); for (let index = 0; index < Math.max(a.length, b.length); index++) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0); return true; };

// 一个带真实扩展的 Chrome 和一个本机服务。扩展目录里的 pairing.json 指向这个服务；用户数据目录固定，刷新后扩展存储（配置 ID、名称、配对密钥）原样保留。
async function harness(t: TestContext, source: string) {
  const f = await fixture(), extensionDir = path.join(f.config.dataDir, 'extension'), userDataDir = path.join(f.config.dataDir, 'chrome');
  await cp(source, extensionDir, { recursive: true });
  const pairing = JSON.stringify({ port: f.config.port, token: bridgeToken(f.config) }); await writeFile(path.join(extensionDir, 'pairing.json'), pairing);
  let browser: Browser | undefined; t.after(async () => { await browser?.close(); await f.cleanup(); });
  const launch = async () => {
    const started = browser = await launchTestChrome({ headless: true, pipe: true, userDataDir, enableExtensions: [extensionDir], args: ['--no-first-run', '--no-default-browser-check'] });
    const worker = await started.waitForTarget(target => target.type() === 'service_worker');
    return { browser: started, extensionId: new URL(worker.url()).host };
  };
  // 模拟用户在 chrome://extensions 点“刷新”：新构建落盘（pairing.json 仍指向本机服务），Chrome 重新注册扩展的 service worker，扩展存储保留。
  // 无头 Chrome 里 chrome.runtime.reload() 不会把 CDP 加载的扩展重新装回；而 Chrome 会缓存已注册的 service worker 脚本，只换文件、重启浏览器仍然跑旧后台。
  // 所以这里关闭浏览器、清掉用户数据目录里的 Service Worker 缓存，再用同一个用户数据目录重新启动（Local Extension Settings 里的设置保留）。
  const refresh = async () => {
    await browser!.close();
    await cp(current, extensionDir, { recursive: true, force: true }); await writeFile(path.join(extensionDir, 'pairing.json'), pairing);
    await rm(path.join(userDataDir, 'Default', 'Service Worker'), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    return launch();
  };
  return { f, extensionDir, launch, refresh };
}

// beta.22 起扩展与服务的桥接握手硬切到 v2（配对密钥不再明文上线），旧扩展发的明文 hello 被服务有意拒绝。
// 用户升级时第一眼看到的就是扩展设置页：必须明确告诉他“刷新扩展”，而不是沉默、转圈或语义不明的报错。
for (const version of legacyVersions) test(`旧扩展 ${version} 遇到新服务：不被登记；设置页给出能照做的刷新提示（新版设置页配旧后台也一样）`, async t => {
  if (!await hasLegacy(version)) return t.skip(`本机没有 ${version} 的历史安装目录`);
  const h = await harness(t, legacyDirectory(version)), { browser, extensionId } = await h.launch();
  const options = await browser.newPage(); await options.goto(`chrome-extension://${extensionId}/options.html`);
  // 旧扩展自己的设置页直接显示服务返回的说明。
  await options.waitForFunction(() => document.querySelector('#status')!.textContent!.includes('旧版握手'));
  const prompt = await options.$eval('#status', node => node.textContent!);
  // 说明要能照做：在哪里做、做什么、刷新到哪个版本、会不会丢设置。说明要求的最低版本必须是当前构建满足、旧扩展不满足的，否则照做也没用。
  assert.match(prompt, /chrome:\/\/extensions/); assert.match(prompt, /刷新/); assert.match(prompt, /配置 ID.*保持不变/);
  const minimum = /（(\d+(?:\.\d+)+) 或更高）/.exec(prompt)?.[1]; assert.ok(minimum, `说明里要写明最低扩展版本：${prompt}`);
  assert.equal(atLeast(await manifestVersion(current), minimum), true, `当前构建的扩展版本达不到说明要求的 ${minimum}`);
  assert.equal(atLeast(await manifestVersion(legacyDirectory(version)), minimum), false, `旧扩展本来就满足 ${minimum}，说明没有意义`);
  assert.deepEqual(h.f.service.broker.listProfiles(), [], '旧扩展没有被登记为浏览器'); assert.deepEqual(h.f.service.state.knownProfiles(), [], '也没有写进已知配置');

  // 服务升级会先把新文件同步进扩展目录；用户还没点刷新时打开的是新设置页，后台仍是内存里的旧版本：说明必须同样可见，远程面板也不能把它说成别的状态。
  const instance = () => options.evaluate(() => chrome.runtime.sendMessage({ type: 'settings.get' }).then(response => response.instanceId as string));
  const oldBackground = await instance();
  await options.close();
  for (const file of ['options.html', 'options.js', 'options.js.map', 'options.css']) await copyFile(path.join(current, file), path.join(h.extensionDir, file));
  const reopened = await browser.newPage(); await reopened.goto(`chrome-extension://${extensionId}/options.html`);
  await reopened.waitForFunction(() => document.querySelector('#status')!.textContent!.includes('旧版握手'));
  assert.equal(await reopened.$eval('#status', node => node.textContent), prompt, '新设置页显示的是同一条说明');
  assert.equal(await reopened.$eval('#service-connection-state',node=>node.textContent),'未连接 · 本机 HTTP');
  assert.equal(await reopened.evaluate(() => chrome.runtime.sendMessage({ type: 'settings.get' }).then(response => response.instanceId as string)), oldBackground, '只换了设置页文件，后台仍是没有重启的旧版本');
  // 出错的状态条在真实 Chrome 里是醒目的出错样式，不能和“已连接”一样是绿色条。
  const backgrounds = await reopened.$eval('#status', node => { const element = node as HTMLElement, state = element.dataset.state!, error = getComputedStyle(element).backgroundColor; element.dataset.state = 'connected'; const connected = getComputedStyle(element).backgroundColor; element.dataset.state = state; return { state, error, connected }; });
  assert.equal(backgrounds.state, 'error'); assert.notEqual(backgrounds.error, backgrounds.connected, '出错状态条要有自己的底色');
  assert.deepEqual(h.f.service.broker.listProfiles(), [], '换了设置页文件之后旧后台仍然没有被登记');
  if (version === legacyVersions[0]) { await mkdir(path.join(projectDir, '.local/verification'), { recursive: true }); await reopened.setViewport({ width: 380, height: 900 }); await (await reopened.$('main'))!.screenshot({ path: path.join(projectDir, '.local/verification/extension-popup-refresh-prompt.png') }); }
});

// 按提示刷新扩展之后：同一个配置 ID、名称和设置自动连上；弹窗显示远程入口和服务器地址，点击复用已登录的工作台标签。
test('按提示刷新旧扩展后自动连上且身份、设置不变；远程入口显示服务器地址，点击复用已登录的工作台标签', async t => {
  let version: string | undefined; for (const candidate of legacyVersions) if (!version && await hasLegacy(candidate)) version = candidate;
  if (!version) return t.skip('本机没有可用的历史安装目录');
  const h = await harness(t, legacyDirectory(version)), f = h.f; let { browser, extensionId } = await h.launch();
  let options = await browser.newPage(); await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.waitForFunction(() => document.querySelector('#status')!.textContent!.includes('旧版握手'));
  const before = await options.evaluate(() => chrome.storage.local.get('settings')) as { settings: { profileId: string; label: string } };
  assert.deepEqual(f.service.broker.listProfiles(), [], '刷新之前旧扩展没有被登记');
  ({ browser, extensionId } = await h.refresh());
  options = await browser.newPage(); await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.waitForFunction(() => document.querySelector('#status')!.textContent!.includes('可供 Agent 使用'));
  const original = f.service.broker.listProfiles()[0]!;
  assert.equal(f.service.broker.listProfiles().length, 1); assert.equal(original.id, before.settings.profileId, '刷新后沿用同一个配置 ID'); assert.equal(original.label, before.settings.label, '名称也不变');
  assert.equal(await options.$eval('#status', node => (node as HTMLElement).dataset.state), 'connected');
  assert.deepEqual(await options.evaluate(() => chrome.storage.local.get('settings')), before, '刷新不改动已保存的设置（名称、端口、配对密钥、是否启用）');
  await options.close();
  await f.remote.configure({ enabled: false, url: 'https://192.168.1.10:18443', token: '', profiles: [original.id], readOnly: false });
  const dashboard = await browser.newPage(); await dashboard.goto(`http://127.0.0.1:${f.config.port}/#${f.config.token}`);
  await dashboard.waitForFunction(() => document.querySelector<HTMLElement>('#login')!.hidden);
  await dashboard.evaluate(() => { window.name = 'verified-dashboard'; });
  const reopened = await browser.newPage(); await reopened.goto(`chrome-extension://${extensionId}/options.html`);
  await reopened.waitForSelector('#open-workbench[aria-disabled="false"]');
  assert.equal(await reopened.$eval('#service-address',element=>element.textContent),`http://127.0.0.1:${f.config.port}`);
  assert.equal(await reopened.$eval('details', element => (element as HTMLDetailsElement).open), false);
  assert.deepEqual(await reopened.evaluate(() => chrome.storage.local.get('settings')), before);
  assert.equal(f.service.broker.listProfiles()[0]!.instanceId, original.instanceId, '只是打开设置页，后台没有被重启');
  await mkdir(path.join(projectDir, '.local/verification'), { recursive: true });
  await reopened.setViewport({ width: 380, height: 900 });
  await (await reopened.$('main'))!.screenshot({ path: path.join(projectDir, '.local/verification/extension-popup-after-refresh.png') });
  await reopened.click('#open-workbench');
  await dashboard.waitForFunction(() => location.hash === '#overview' && document.querySelector<HTMLElement>('#login')!.hidden);
  assert.equal(await dashboard.evaluate(() => window.name), 'verified-dashboard', '点击复用的是已登录的那个工作台标签，没有另开');
  assert.equal((await browser.pages()).filter(page => page.url().startsWith(`http://127.0.0.1:${f.config.port}/`)).length, 1);
});

// 反方向：先刷新了扩展、服务还是旧版。旧服务不认识新握手（第一帧里没有 token），不发 challenge 就直接拒绝；设置页要说清是服务版本较旧、该怎么办。
// 用最小的假旧服务复现这种拒绝（不带 code 的 rejected 帧），扩展是当前构建的真实文件。
test('新扩展遇到旧服务：设置页说明是服务版本较旧，要把服务更新到与扩展相同的版本', async t => {
  const directory = await testDirectory(), port = await freePort(), server = new WebSocketServer({ host: '127.0.0.1', port });
  let browser: Browser | undefined; t.after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); await directory.cleanup(); });
  server.on('connection', socket => { socket.once('message', () => { socket.send(JSON.stringify({ type: 'rejected', message: 'Invalid input: expected string, received undefined' })); socket.close(1008); }); });
  const extensionDir = path.join(directory.directory, 'extension'); await cp(current, extensionDir, { recursive: true });
  await writeFile(path.join(extensionDir, 'pairing.json'), JSON.stringify({ port, token: 'ab12'.repeat(16) }));
  browser = await launchTestChrome({ headless: true, pipe: true, userDataDir: path.join(directory.directory, 'chrome'), enableExtensions: [extensionDir], args: ['--no-first-run', '--no-default-browser-check'] });
  const worker = await browser.waitForTarget(target => target.type() === 'service_worker'); const extensionId = new URL(worker.url()).host;
  const options = await browser.newPage(); await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.waitForFunction(() => document.querySelector('#status')!.textContent!.includes('服务版本较旧'));
  const prompt = await options.$eval('#status', node => node.textContent!);
  assert.match(prompt, /更新到与扩展相同的版本/); assert.match(prompt, /Invalid input/, '同时保留服务返回的原话，方便排查');
  assert.equal(await options.$eval('#status', node => (node as HTMLElement).dataset.state), 'error');
});

// ui:12：保存账号设置必须有看得见的结果。配对密钥格式不对时后台会静默忽略，所以弹窗先校验并说明原因，且不改动已保存的设置；
// 带空白或大写的有效密钥规范化后保存并提示。使用当前构建的 dist/extension（需先 npm run build）。
test('设置弹窗拒绝无效浏览器配对码，正确配对直连且保留原身份',async t=>{
 const h=await harness(t,current),f=h.f,{browser,extensionId}=await h.launch(),options=await browser.newPage();await options.goto('chrome-extension://'+extensionId+'/options.html');await options.waitForFunction(()=>document.querySelector('#status')!.textContent!.includes('可供 Agent 使用'));const before:any=await options.evaluate(()=>chrome.storage.local.get('settings'));
 await options.click('#settings-toggle');await options.type('input[name=connectionCode]','sf-connect:invalid');await options.click('#settings button[type=submit]');await options.waitForFunction(()=>document.querySelector('#save-result')!.getAttribute('data-error')==='true');assert.deepEqual(await options.evaluate(()=>chrome.storage.local.get('settings')),before);
 const pairing=await f.pairings.create({label:'新独立配对',profileId:before.settings.profileId}),code='sf-connect:'+Buffer.from(JSON.stringify({version:1,serviceUrl:'http://127.0.0.1:'+f.config.port,...pairing})).toString('base64url');await options.$eval('input[name=connectionCode]',(e,value)=>(e as HTMLInputElement).value=value,code);await options.click('#settings button[type=submit]');await options.waitForFunction(()=>document.querySelector('#save-result')!.textContent!.includes('连接设置已保存'));await options.waitForFunction(()=>document.querySelector('#status')!.textContent!.includes('可供 Agent 使用'));const after:any=await options.evaluate(()=>chrome.storage.local.get('settings'));assert.equal(after.settings.profileId,before.settings.profileId);assert.equal(after.settings.token,pairing.token);assert.equal(f.service.broker.listProfiles()[0]!.connectionType,'direct');assert.equal(await options.$eval('input[name=connectionCode]',e=>(e as HTMLInputElement).value),'');
});
