import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, fakeProfile, testDirectory } from './helpers.js';
import { checkUploadFile, checkOutputDirectory, cdpUploadPaths, type FilePolicy } from '../src/upload-policy.js';
import { adminPrincipal, type Principal } from '../src/auth.js';
import { errorInfo, type WireCommand } from '../src/shared.js';

// 本机 Agent 读写哪些文件由它自己的 harness 决定：服务只拒绝 SaltedFish 的数据目录和网络共享路径，
// 联接/符号链接/.. 绕进数据目录也挡得住；从别的电脑经旧网关连进来的 Agent 不能用这台电脑上的路径；响应里不回传本机绝对路径。
const files_ok = (dirs: { downloads: string }) => path.join(dirs.downloads, 'ok.txt');
async function tree() {
  const temp = await testDirectory(), root = path.resolve(temp.directory);
  const dirs = { home: path.join(root, 'home'), downloads: path.join(root, 'home', 'Downloads'), documents: path.join(root, 'home', 'Documents'), ssh: path.join(root, 'home', '.ssh'), data: path.join(root, 'home', 'Downloads', 'saltedfish-data'), outside: path.join(root, 'outside') };
  for (const directory of Object.values(dirs)) await mkdir(directory, { recursive: true });
  const files = { ok: path.join(dirs.downloads, 'ok.txt'), doc: path.join(dirs.documents, 'doc.txt'), key: path.join(dirs.ssh, 'id_rsa'), config: path.join(dirs.data, 'config.json'), secret: path.join(dirs.outside, 'secret.txt') };
  for (const file of Object.values(files)) await writeFile(file, 'fixture');
  const policy: FilePolicy = { denied: [dirs.data] };
  return { temp, dirs, files, policy, root };
}
const code = async (promise: Promise<unknown>) => { try { await promise; return 'ALLOWED'; } catch (error) { const info = errorInfo(error); if (info.code !== 'ABSOLUTE_PATH_REQUIRED') assert.equal(info.outcome, 'not_dispatched'); return info.code;  } };

test('上传路径：哪里都行，只拒绝数据目录（联接、.. 绕进去也拒绝）和网络共享路径', async t => {
  const { temp, dirs, files, policy } = await tree(); t.after(() => temp.cleanup());
  for (const file of [files.ok, files.doc, files.secret, files.key]) assert.equal(await code(checkUploadFile(file, policy)), 'ALLOWED', file);
  assert.equal(await code(checkUploadFile(path.join(dirs.downloads, '..', '..', 'outside', 'secret.txt'), policy)), 'ALLOWED');
  assert.equal(await code(checkUploadFile(files.config, policy)), 'UPLOAD_PATH_NOT_ALLOWED', '数据目录');
  assert.equal(await code(checkUploadFile(path.join(dirs.documents, '..', 'Downloads', 'saltedfish-data', 'config.json'), policy)), 'UPLOAD_PATH_NOT_ALLOWED', '.. 绕进数据目录');
  const link = path.join(dirs.outside, 'link');
  await symlink(dirs.data, link, 'junction');
  assert.equal(await code(checkUploadFile(path.join(link, 'config.json'), policy)), 'UPLOAD_PATH_NOT_ALLOWED', '联接指进数据目录');
  assert.equal(await code(checkUploadFile(path.join(dirs.outside, 'missing.txt'), policy)), 'FILE_NOT_FOUND');
  assert.equal(await code(checkUploadFile('relative/ok.txt', policy)), 'ABSOLUTE_PATH_REQUIRED');
  assert.equal(await code(checkUploadFile(`${files.ok}\0.png`, policy)), 'INVALID_ARGUMENT');
  assert.equal(await code(checkUploadFile(dirs.downloads, policy)), 'NOT_A_FILE');
  if (process.platform === 'win32') {
    assert.equal(await code(checkUploadFile('\\\\localhost\\share\\x.txt', policy)), 'UPLOAD_PATH_NOT_ALLOWED', '网络共享路径不触发 SMB 访问');
    assert.equal(await code(checkUploadFile(files.config.toUpperCase(), policy)), 'UPLOAD_PATH_NOT_ALLOWED', 'Windows 路径大小写不敏感');
  }
});

test('输出目录：要已存在，只拒绝数据目录和网络共享路径', async t => {
  const { temp, dirs, policy } = await tree(); t.after(() => temp.cleanup());
  assert.equal(await checkOutputDirectory(dirs.documents, policy), await realpath(dirs.documents));
  assert.equal(await checkOutputDirectory(dirs.ssh, policy), await realpath(dirs.ssh), '点目录由 harness 决定');
  assert.equal(await code(checkOutputDirectory(dirs.data, policy)), 'OUTPUT_PATH_NOT_ALLOWED');
  assert.equal(await code(checkOutputDirectory(path.join(dirs.outside, 'missing'), policy)), 'OUTPUT_DIRECTORY_NOT_FOUND');
  if (process.platform === 'win32') assert.equal(await code(checkOutputDirectory('\\\\localhost\\share', policy)), 'OUTPUT_PATH_NOT_ALLOWED');
  assert.equal(await checkUploadFile(files_ok(dirs), policy), await realpath(files_ok(dirs)), '校验返回真实路径');
});

test('会交出本机文件的 CDP 方法与 chrome_upload 使用同一套路径', () => {
  assert.deepEqual(cdpUploadPaths('DOM.setFileInputFiles', { files: ['/a', '/b'], objectId: 'x' }), ['/a', '/b']);
  assert.deepEqual(cdpUploadPaths('dom.setfileinputfiles', { files: [] }), []);
  assert.deepEqual(cdpUploadPaths('Input.dispatchDragEvent', { type: 'drop', x: 1, y: 1, data: { files: ['/c'], items: [] } }), ['/c']);
  assert.deepEqual(cdpUploadPaths('Input.dispatchDragEvent', { type: 'dragEnter', x: 1, y: 1 }), []);
  assert.equal(cdpUploadPaths('Runtime.evaluate', { expression: '1' }), undefined);
  assert.throws(() => cdpUploadPaths('DOM.setFileInputFiles', { files: 'not-a-list' }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => cdpUploadPaths('DOM.setFileInputFiles', { files: [1] }), { code: 'INVALID_ARGUMENT' });
});

test('服务执行上传路径：受限 Agent 哪里都能传，只拒绝数据目录，批次与原始 CDP 一样；旧网关连进来的 Agent 不能用本机路径', async t => {
  const { temp, files } = await tree(); t.after(() => temp.cleanup());
  const f = await fixture(); t.after(() => f.cleanup());
  const seen: WireCommand[] = [];
  const profile = await fakeProfile(f.config, 'A', command => { seen.push(command); return {}; });
  const principal = f.service.state.authenticate(f.service.state.createClient('受限').token)!, target = { profileId: profile.id, tabId: 1 };
  const upload = (who: Principal, paths: string[]) => f.service.invoke('chrome_upload', { ...target, selector: '#f', paths }, `o-${who.id}`, who);
  const refused = (result: Awaited<ReturnType<typeof upload>>) => { assert.equal(result.error?.code, 'UPLOAD_PATH_NOT_ALLOWED', JSON.stringify(result.error)); assert.equal(result.error?.outcome, 'not_dispatched'); };

  for (const file of [files.ok, files.doc, files.secret, files.key]) assert.equal((await upload(principal, [file])).ok, true, file);
  assert.equal(seen.filter(command => command.operation === 'page.upload').length, 4);
  const config = path.join(f.config.dataDir, 'config.json');
  await writeFile(config, '{}').catch(() => {});
  refused(await upload(principal, [config]));
  refused(await upload(principal, [files.ok, config]));
  const before = seen.length;
  refused(await f.service.invoke('chrome_batch', { ...target, steps: [{ operation: 'page.upload', args: { selector: '#f', paths: [config] } }] }, 'b', principal));
  refused(await f.service.invoke('chrome_cdp', { ...target, method: 'DOM.setFileInputFiles', params: { files: [config], objectId: 'x' } }, 'c', principal));
  refused(await f.service.invoke('chrome_cdp', { ...target, method: 'Input.dispatchDragEvent', params: { type: 'drop', x: 1, y: 1, data: { files: [config], items: [] } } }, 'd', principal));
  const remote = { ...principal, remoteAgentId: 'remote-agent' };
  const fromRemote = await upload(remote, [files.ok]);
  refused(fromRemote); assert.match(fromRemote.error!.message, /transferIds/);
  assert.equal(seen.length, before, '以上都没有派发给扩展');
  assert.equal((await upload(adminPrincipal, [config])).ok, true, '管理员不受限制');
});

test('响应不向非管理员回传本机绝对路径：结果文件只给 artifactId 和文件名，错误信息里的数据目录被替换；管理员看到完整路径', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  f.config.outputLimit = 50;
  const profile = await fakeProfile(f.config, 'A', command => {
    if (command.operation === 'page.snapshot') throw new Error(`ENOENT: no such file ${path.join(f.config.dataDir, 'results', 'a.json')} and ${f.config.dataDir.replaceAll('\\', '/')}/x`);
    return command.operation === 'page.screenshot' ? { mimeType: 'image/png', data: Buffer.from('png').toString('base64') } : 'x'.repeat(500);
  });
  const principal = f.service.state.authenticate(f.service.state.createClient('受限').token)!, target = { profileId: profile.id, tabId: 1 };
  for (const [name, args] of [['chrome_evaluate', { ...target, expression: '1' }], ['chrome_screenshot', target]] as [string, Record<string, unknown>][]) {
    const limited = await f.service.invoke(name, args, 'r', principal), full = await f.service.invoke(name, args, 'a', adminPrincipal);
    const limitedData = limited.data as Record<string, unknown>, fullData = full.data as Record<string, unknown>;
    assert.match(String(limitedData.artifactId), /^[0-9a-f-]{36}$/); assert.match(String(limitedData.filename), /^[0-9a-f-]{36}\.(json|png)$/);
    assert.equal(limitedData.path, undefined, name); assert.ok(!JSON.stringify(limited).includes(f.config.dataDir), name);
    assert.equal(typeof fullData.path, 'string', name); assert.ok(String(fullData.path).startsWith(f.config.dataDir), name);
    // 非管理员仍能用 artifactId 读取自己的 JSON 结果（截图的原图是 PNG，本来就不走 read_result）
    if (String(limitedData.filename).endsWith('.json')) {
      const read = await f.service.invoke('chrome_read_result', { artifactId: limitedData.artifactId, offset: 0, limit: 100 }, 'r', principal);
      assert.equal(read.ok, true, JSON.stringify(read.error));
    }
  }
  const failed = await f.service.invoke('chrome_accessibility', { ...target, mode: 'raw' }, 'r', principal), failedAdmin = await f.service.invoke('chrome_accessibility', { ...target, mode: 'raw' }, 'a', adminPrincipal);
  assert.equal(failed.ok, false); assert.ok(failed.error!.message.includes('<数据目录>')); assert.ok(!failed.error!.message.includes(f.config.dataDir) && !failed.error!.message.includes(f.config.dataDir.replaceAll('\\', '/')));
  assert.ok(failedAdmin.error!.message.includes(f.config.dataDir));
});
