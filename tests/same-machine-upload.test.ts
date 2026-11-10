import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unifiedFixture, fakeProfile } from './helpers.js';
import { browserOnServiceMachine } from '../src/browser-upload.js';
import { FILE_MAX_BYTES } from '../src/file-limits.js';
import { serviceInternalUrl } from '../src/service-network.js';
import { projectDir } from '../src/config.js';
import type { WireCommand } from '../src/shared.js';

const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const linux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const here = process.platform === 'win32' ? windows : process.platform === 'darwin' ? mac : linux;
const elsewhere = process.platform === 'win32' ? linux : windows;
// 稀疏文件：超过内容传送上限，但测试不真的写几百 MiB。
async function bigFile(file: string, size: number) { const handle = await open(file, 'w'); try { await handle.truncate(size); } finally { await handle.close(); } }

test('同机判断：两端地址相同且浏览器系统一致才算，认不出的用户代理当作别的电脑', () => {
  assert.equal(browserOnServiceMachine('127.0.0.1', '127.0.0.1', windows, 'win32'), true);
  assert.equal(browserOnServiceMachine('::ffff:127.0.0.1', '::ffff:127.0.0.1', windows, 'win32'), true);
  assert.equal(browserOnServiceMachine('::1', '::1', linux, 'linux'), true);
  assert.equal(browserOnServiceMachine('192.168.1.10', '192.168.1.10', linux, 'linux'), true, '本机网卡地址');
  assert.equal(browserOnServiceMachine('192.168.1.30', '192.168.1.10', linux, 'linux'), false, '另一台电脑');
  assert.equal(browserOnServiceMachine('127.0.0.1', '127.0.0.1', windows, 'linux'), false, '端口转发进来的 Windows Chrome');
  assert.equal(browserOnServiceMachine('127.0.0.1', '127.0.0.1', 'test', 'win32'), false);
  assert.equal(browserOnServiceMachine('127.0.0.1', '127.0.0.1', 'Mozilla/5.0 (Linux; Android 14) Chrome/156', 'linux'), false);
  assert.equal(browserOnServiceMachine(undefined, '127.0.0.1', windows, 'win32'), false);
});

test('同机浏览器上传直接交真实路径：不限大小，不走内容暂存；受限客户端哪里都能传，只拒绝数据目录', async t => {
  const f = await unifiedFixture(); t.after(() => f.cleanup());
  const seen: WireCommand[] = [];
  const profile = await fakeProfile(f.service.config, '同机', command => { seen.push(command); if (command.operation === 'page.upload') return { files: (command.args.expectedFiles as unknown[]) }; return {}; }, undefined, { userAgent: here });
  const remote = await fakeProfile(f.service.config, '别的电脑', command => { seen.push(command); return command.operation === 'file.stage.write' ? { nextOffset: 0 } : {}; }, undefined, { userAgent: elsewhere });
  const listed = f.service.listProfiles();
  assert.equal((listed.find(item => item.id === profile.id) as { sameMachine?: boolean } | undefined)?.sameMachine, true);
  assert.equal((listed.find(item => item.id === remote.id) as { sameMachine?: boolean } | undefined)?.sameMachine, false);
  const roots = path.join(f.config.dataDir, '..', path.basename(f.config.dataDir) + '-roots'), allowed = path.join(roots, '成片'), outside = path.join(roots, 'outside');
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(roots, { recursive: true, force: true }); });
  await mkdir(allowed, { recursive: true }); await mkdir(outside, { recursive: true });
  const video = path.join(allowed, '第3集 原片.mov'), size = FILE_MAX_BYTES + 5 * 1024 * 1024; await bigFile(video, size);
  const stray = path.join(outside, 'x.mp4'); await writeFile(stray, 'x');

  const admin = await f.service.invoke('chrome_upload', { profileId: profile.id, tabId: 3, selector: '#file', paths: [video] }, 'admin');
  assert.equal(admin.ok, true, JSON.stringify(admin.error));
  const sent = seen.find(command => command.operation === 'page.upload')!;
  assert.deepEqual(sent.args.paths, [await realpath(video)]);
  assert.deepEqual(sent.args.expectedFiles, [{ name: '第3集 原片.mov', size }]);
  assert.equal(seen.some(command => command.operation.startsWith('file.stage')), false, '同机不暂存内容');
  assert.deepEqual(admin.data, { files: [{ name: '第3集 原片.mov', size }], transport: 'path' });

  // 受限客户端：路径由它自己的 harness 管，哪里的文件都能传；SaltedFish 的数据目录拒绝且不派发。
  const client = f.service.state.authenticate(f.service.state.createClient('uploader', [profile.id, remote.id]).token)!;
  seen.length = 0;
  const secret = path.join(f.config.dataDir, 'config.json'); await writeFile(secret, '{}').catch(() => {});
  assert.equal((await f.service.invoke('chrome_upload', { profileId: profile.id, tabId: 3, selector: '#file', paths: [secret] }, 'c', client)).error?.code, 'UPLOAD_PATH_NOT_ALLOWED');
  assert.equal(seen.length, 0);
  const anywhere = await f.service.invoke('chrome_upload', { profileId: profile.id, tabId: 3, selector: '#file', paths: [stray] }, 'c', client);
  assert.equal(anywhere.ok, true, JSON.stringify(anywhere.error));
  seen.length = 0;
  const batch = await f.service.invoke('chrome_batch', { profileId: profile.id, tabId: 3, steps: [{ operation: 'page.upload', args: { selector: '#file', paths: [video] } }] }, 'c', client);
  assert.equal(batch.ok, true, JSON.stringify(batch.error));
  const step = (seen.find(command => command.operation === 'page.batch')!.args.steps as { args: Record<string, unknown> }[])[0]!;
  assert.deepEqual(step.args.paths, [await realpath(video)]);

  // 原始 CDP 的文件方法：同机放行（数据目录仍拒绝），不同机器继续要求由服务传内容。
  seen.length = 0;
  assert.equal((await f.service.invoke('chrome_cdp', { profileId: profile.id, tabId: 3, method: 'DOM.setFileInputFiles', params: { files: [video], nodeId: 1 } }, 'c', client)).ok, true);
  assert.equal((await f.service.invoke('chrome_cdp', { profileId: profile.id, tabId: 3, method: 'DOM.setFileInputFiles', params: { files: [secret], nodeId: 1 } }, 'c', client)).error?.code, 'UPLOAD_PATH_NOT_ALLOWED');
  assert.equal((await f.service.invoke('chrome_cdp', { profileId: remote.id, tabId: 3, method: 'DOM.setFileInputFiles', params: { files: [video], nodeId: 1 } }, 'c', client)).error?.code, 'FILE_LOCATION_REQUIRED');
  assert.equal(seen.filter(command => command.operation === 'page.cdp').length, 1);

  // 不同机器、或管理员关掉同机路径：按内容传，大文件在暂存前就拒绝。
  seen.length = 0;
  const far = await f.service.invoke('chrome_upload', { profileId: remote.id, tabId: 3, selector: '#file', paths: [video] }, 'c', client);
  assert.equal(far.error?.code, 'BROWSER_UPLOAD_CAPACITY'); assert.equal(far.error?.outcome, 'not_dispatched');
  f.service.config.uploadByPath = 'never';
  assert.equal((await f.service.invoke('chrome_upload', { profileId: profile.id, tabId: 3, selector: '#file', paths: [video] }, 'c', client)).error?.code, 'BROWSER_UPLOAD_CAPACITY');
  assert.equal(seen.some(command => command.operation === 'page.upload' || command.operation === 'file.stage.begin'), false);
});
