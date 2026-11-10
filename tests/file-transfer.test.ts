import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { FileTransferManager, type FileTransferContext } from '../src/file-transfer.js';
import { fileTransferToolDefinitions, FILE_CHUNK_BYTES } from '../src/file-transfer-tools.js';
import { testDirectory } from './helpers.js';
import type { FilePolicy } from '../src/upload-policy.js';
import { BrowserError, NOT_DISPATCHED } from '../src/shared.js';

const digest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const context = (id = 'client-a', profileId = 'profile-a'): FileTransferContext => ({ profileId, principal: { id, label: id, admin: false, readOnly: false, profiles: [profileId] } });
const declared = (data: Uint8Array, filename = '文件.txt') => ({ filename, size: data.length, sha256: digest(data), submissionId: randomUUID() });
const code = async (promise: Promise<unknown>, expected: string) => assert.rejects(promise, { code: expected });
async function setup(options: ConstructorParameters<typeof FileTransferManager>[1] = {}) {
  const temp = await testDirectory(), dataDir = path.join(temp.directory, 'data'), downloads = path.join(temp.directory, 'home', 'Downloads');
  await mkdir(downloads, { recursive: true });
  const policy: FilePolicy = { denied: [dataDir] };
  const manager = new FileTransferManager({ dataDir }, { policy, ...options });
  return { manager, temp, downloads, dataDir, policy, async close() { await manager.close(); await temp.cleanup(); } };
}

test('分块接收、重复请求和块重试、SHA256提交、读取与真实上传文件名', async t => {
  const f = await setup(); t.after(() => f.close()); const who = context(), data = Buffer.from('中文内容😀\nabc'), input = declared(data);
  const started = await f.manager.begin(who, input), duplicate = await f.manager.begin(who, input);
  assert.equal(duplicate.transferId, started.transferId); assert.equal(duplicate.deduplicated, true);
  await f.manager.write(who, started.transferId, 0, data.subarray(0, 5).toString('base64'));
  const repeat = await f.manager.write(who, started.transferId, 0, data.subarray(0, 5).toString('base64'));
  assert.equal(repeat.receivedBytes, 5); assert.equal(repeat.deduplicated, true);
  await f.manager.write(who, started.transferId, 5, data.subarray(5).toString('base64'));
  assert.equal((await f.manager.commit(who, started.transferId)).state, 'ready');
  assert.equal((await f.manager.commit(who, started.transferId)).deduplicated, true);
  const chunks: Buffer[] = []; let offset = 0;
  while (offset < data.length) { const result = await f.manager.read(who, started.transferId, offset, 3); chunks.push(Buffer.from(result.base64, 'base64')); offset = result.nextOffset; assert.equal(result.eof, offset === data.length); }
  assert.deepEqual(Buffer.concat(chunks), data);
  const [upload] = await f.manager.resolveUploads(who, [started.transferId]); assert.equal(path.basename(upload!), input.filename); assert.deepEqual(await readFile(upload!), data);
  assert.equal('path' in (await f.manager.status(who, started.transferId)), false);
});

test('拒绝跳块、部分覆盖、冲突重试、非规范base64；拒绝不完整提交', async t => {
  const f = await setup(); t.after(() => f.close()); const who = context(), data = Buffer.from('abcdefgh'), record = await f.manager.begin(who, declared(data));
  await code(f.manager.write(who, record.transferId, 1, 'YQ=='), 'FILE_TRANSFER_OFFSET');
  await code(f.manager.write(who, record.transferId, 0, 'YQ=\n='), 'FILE_TRANSFER_CHUNK');
  await code(f.manager.write(who, record.transferId, 0, 'YR=='), 'FILE_TRANSFER_CHUNK');
  await f.manager.write(who, record.transferId, 0, data.subarray(0, 4).toString('base64'));
  await code(f.manager.write(who, record.transferId, 2, data.subarray(2, 6).toString('base64')), 'FILE_TRANSFER_OFFSET');
  await code(f.manager.write(who, record.transferId, 0, Buffer.from('xxxx').toString('base64')), 'FILE_TRANSFER_CONFLICT');
  await code(f.manager.commit(who, record.transferId), 'FILE_TRANSFER_INCOMPLETE');
  assert.equal((await f.manager.status(who, record.transferId)).receivedBytes, 4);
});

test('不正确SHA256拒绝提交、读取和上传；同一submission不可换内容', async t => {
  const f = await setup(); t.after(() => f.close()); const who = context(), input = { ...declared(Buffer.from('abc')), sha256: 'f'.repeat(64) }, record = await f.manager.begin(who, input);
  await f.manager.write(who, record.transferId, 0, Buffer.from('abc').toString('base64'));
  await code(f.manager.commit(who, record.transferId), 'FILE_TRANSFER_HASH_MISMATCH');
  await code(f.manager.read(who, record.transferId), 'FILE_TRANSFER_STATE');
  await code(f.manager.resolveUploads(who, [record.transferId]), 'FILE_TRANSFER_STATE');
  await code(f.manager.begin(who, { ...input, sha256: digest('abc') }), 'FILE_TRANSFER_CONFLICT');
});

test('客户端、账号和只读权限隔离；远程重连稳定身份保留自己的传输', async t => {
  const f = await setup(); t.after(() => f.close()); const who = context(), input = declared(Buffer.from('x')), record = await f.manager.begin(who, input);
  await code(f.manager.status(context('other'), record.transferId), 'FILE_TRANSFER_NOT_FOUND');
  await code(f.manager.status(context('client-a', 'profile-b'), record.transferId), 'FILE_TRANSFER_NOT_FOUND');
  await code(f.manager.status({ ...who, profileId: 'not-authorized' }, record.transferId), 'PROFILE_NOT_AUTHORIZED');
  await code(f.manager.begin({ ...who, principal: { ...who.principal, readOnly: true } }, declared(Buffer.alloc(0))), 'CLIENT_READ_ONLY');
  const remote = { ...who, principal: { ...who.principal, id: 'remote:old', submissionScope: 'stable-agent' } }, remoteRecord = await f.manager.begin(remote, input);
  assert.equal((await f.manager.status({ ...remote, principal: { ...remote.principal, id: 'remote:new' } }, remoteRecord.transferId)).transferId, remoteRecord.transferId);
  await code(f.manager.status({ ...remote, principal: { ...remote.principal, submissionScope: 'other-agent' } }, remoteRecord.transferId), 'FILE_TRANSFER_NOT_FOUND');
});

test('配额按声明预留且并发准入不超卖，单主体不占满总额', async t => {
  const f = await setup({ totalBytes: 12, principalBytes: 8 }); t.after(() => f.close());
  const accepted = await Promise.allSettled([f.manager.begin(context(), declared(Buffer.alloc(5))), f.manager.begin(context(), declared(Buffer.alloc(5)))]);
  assert.equal(accepted.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal((accepted.find(x => x.status === 'rejected') as PromiseRejectedResult).reason.code, 'FILE_TRANSFER_QUOTA');
  await f.manager.begin(context('other'), declared(Buffer.alloc(5)));
  await code(f.manager.begin(context('third'), declared(Buffer.alloc(3))), 'FILE_TRANSFER_QUOTA');
  assert.equal(f.manager.stats().transferReservedBytes, 10);
});

test('下载导出保留文件快照，分块内容可校验；重复export不受源文件变化影响', async t => {
  const f = await setup(); t.after(() => f.close()); const who = context(), source = path.join(f.downloads, 'report.csv'), bytes = Buffer.from('a,b\n1,2');
  await writeFile(source, bytes); const input = { downloadId: 4, submissionId: randomUUID() }, download = { id: 4, filename: source, state: 'complete', exists: true };
  const exported = await f.manager.exportDownload(who, input, download); assert.equal(exported.sha256, digest(bytes)); assert.equal(exported.direction, 'export');
  await writeFile(source, 'changed');
  assert.equal((await f.manager.exportDownload(who, input, download)).transferId, exported.transferId);
  assert.deepEqual(Buffer.from((await f.manager.read(who, exported.transferId)).base64, 'base64'), bytes);
  await code(f.manager.write(who, exported.transferId, 0, 'YQ=='), 'FILE_TRANSFER_STATE');
});

test('导出仅接受已完成的明确downloadId；下载在哪都行，只拒绝数据目录（联接绕进去也拒绝）', async t => {
  const f = await setup(); t.after(() => f.close()); const who = context(), source = path.join(f.downloads, 'ok.txt'); await writeFile(source, 'ok');
  const input = { downloadId: 4, submissionId: randomUUID() };
  for (const download of [{ id: 5, filename: source, state: 'complete' }, { id: 4, filename: source, state: 'in_progress' }, { id: 4, filename: source, state: 'complete', exists: false }]) await code(f.manager.exportDownload(who, input, download), 'FILE_DOWNLOAD_NOT_READY');
  await mkdir(f.dataDir, { recursive: true }); const secret = path.join(f.dataDir, 'config.json'); await writeFile(secret, '{}');
  await code(f.manager.exportDownload(who, input, { id: 4, filename: secret, state: 'complete' }), 'UPLOAD_PATH_NOT_ALLOWED');
  const link = path.join(f.downloads, 'escape'); await symlink(f.dataDir, link, 'junction');
  await code(f.manager.exportDownload(who, input, { id: 4, filename: path.join(link, 'config.json'), state: 'complete' }), 'UPLOAD_PATH_NOT_ALLOWED');
  const outside = path.join(f.temp.directory, 'elsewhere.txt'); await writeFile(outside, 'elsewhere');
  assert.ok((await f.manager.exportDownload(who, input, { id: 4, filename: outside, state: 'complete' })).transferId, '下载目录以外的下载也能导出');
});

test('到期只清传输暂存和精确元数据，不删除原始Chrome下载', async t => {
  let now = 1000; const f = await setup({ ttlMs: 100, now: () => now }); t.after(() => f.close()); const who = context(), source = path.join(f.downloads, 'x.txt'); await writeFile(source, 'keep');
  const record = await f.manager.exportDownload(who, { downloadId: 1, submissionId: randomUUID() }, { id: 1, filename: source, state: 'complete' });
  now = 1101; await code(f.manager.status(who, record.transferId), 'FILE_TRANSFER_NOT_FOUND');
  assert.equal(await readFile(source, 'utf8'), 'keep'); assert.deepEqual(await readdir(path.join(f.dataDir, 'file-transfers')), []);
});

test('重启恢复接收进度和已提交内容，不重新执行任何浏览器动作', async t => {
  const f = await setup(); t.after(() => f.close()); const who = context(), bytes = Buffer.from('abcdefgh'), input = declared(bytes), record = await f.manager.begin(who, input);
  await f.manager.write(who, record.transferId, 0, bytes.subarray(0, 4).toString('base64')); await f.manager.close();
  const next = new FileTransferManager({ dataDir: f.dataDir }, { policy: f.policy }); t.after(() => next.close());
  assert.equal((await next.begin(who, input)).receivedBytes, 4);
  await next.write(who, record.transferId, 4, bytes.subarray(4).toString('base64')); await next.commit(who, record.transferId);
  assert.deepEqual(Buffer.from((await next.read(who, record.transferId)).base64, 'base64'), bytes);
});

test('空文件可完成，超大块拒绝；spool文件被替换不能作为上传来源', async t => {
  const f = await setup(); t.after(() => f.close()); const who = context(), empty = await f.manager.begin(who, declared(Buffer.alloc(0)));
  assert.equal((await f.manager.commit(who, empty.transferId)).state, 'ready'); assert.equal((await f.manager.read(who, empty.transferId)).eof, true);
  const record = await f.manager.begin(who, declared(Buffer.alloc(FILE_CHUNK_BYTES + 1)));
  await code(f.manager.write(who, record.transferId, 0, Buffer.alloc(FILE_CHUNK_BYTES + 1).toString('base64')), 'FILE_TRANSFER_CHUNK');
  const [payload] = await f.manager.resolveUploads(who, [empty.transferId]); await writeFile(payload!, 'tampered');
  await code(f.manager.resolveUploads(who, [empty.transferId]), 'FILE_TRANSFER_INCOMPLETE');
});

test('文件名和工具schema拒绝路径、设备名、无界内容；不暴露source路径', () => {
  const begin = fileTransferToolDefinitions.find(x => x.name === 'chrome_file_begin')!.schema;
  const common = { profileId: 'p', size: 0, sha256: digest(''), submissionId: randomUUID() };
  for (const filename of ['../x', 'C:\\x', 'x/y', 'a:b', 'CON', 'CONIN$', 'CONOUT$', 'COM¹.txt', 'lpt1.txt', '.', '..', 'a.', 'a ', 'x\0y']) assert.equal(begin.safeParse({ ...common, filename }).success, false, filename);
  assert.equal(begin.safeParse({ ...common, filename: '中文文件.txt' }).success, true);
  const exportSchema = fileTransferToolDefinitions.find(x => x.name === 'chrome_file_export')!.schema;
  assert.equal(exportSchema.safeParse({ profileId: 'p', downloadId: 4, submissionId: randomUUID(), path: 'secret' }).success, false);
});

test('长哈希中撤销及时停止，授权失效不把完整传输永久标坏；返回内容前再次复查', async t => {
  const f = await setup(); t.after(() => f.close()); const who = context(), bytes = Buffer.alloc(FILE_CHUNK_BYTES * 2, 17), record = await f.manager.begin(who, declared(bytes));
  for (let offset = 0; offset < bytes.length; offset += FILE_CHUNK_BYTES) await f.manager.write(who, record.transferId, offset, bytes.subarray(offset, offset + FILE_CHUNK_BYTES).toString('base64'));
  let checks = 0;
  const stale = { ...who, assertActive: () => { if (++checks === 6) throw new BrowserError('CLIENT_AUTHORIZATION_FAILED', 'revoked', NOT_DISPATCHED); } };
  await code(f.manager.commit(stale, record.transferId), 'CLIENT_AUTHORIZATION_FAILED');
  assert.equal((await f.manager.status(who, record.transferId)).state, 'receiving');
  assert.equal((await f.manager.commit(who, record.transferId)).state, 'ready');
  checks = 0;
  await code(f.manager.read(stale, record.transferId, 0, 4), 'CLIENT_AUTHORIZATION_FAILED');
});

test('导出重试先取已保存快照，不依赖原下载；核对主体、downloadId、完整性和TTL', async t => {
  let now = 1000; const f = await setup({ now: () => now, ttlMs: 100 }); t.after(() => f.close()); const who = context(), source = path.join(f.downloads, 'lost.txt'), input = { downloadId: 7, submissionId: randomUUID() };
  await writeFile(source, 'kept snapshot');
  assert.equal(await f.manager.lookupExport(who, input), undefined);
  const exported = await f.manager.exportDownload(who, input, { id: 7, filename: source, state: 'complete' });
  await unlink(source);
  const existing = await f.manager.lookupExport(who, input); assert.equal(existing?.transferId, exported.transferId); assert.equal(existing?.deduplicated, true);
  assert.equal(await f.manager.lookupExport(context('another'), input), undefined);
  await code(f.manager.lookupExport(who, { ...input, downloadId: 8 }), 'FILE_TRANSFER_CONFLICT');
  assert.equal((await f.manager.exportDownload(who, input, { id: 7, filename: source, state: 'interrupted', exists: false })).transferId, exported.transferId);
  now = 1101; assert.equal(await f.manager.lookupExport(who, input), undefined);
});

test('在途上传以引用计数保留文件，排队超过TTL仍不被清理；到期拒绝新的lease，最后释放后才回收', async t => {
  let now = 1000; const f = await setup({ now: () => now, ttlMs: 100 }); t.after(() => f.close()); const who = context(), bytes = Buffer.from('upload once');
  const record = await f.manager.begin(who, declared(bytes)); await f.manager.write(who, record.transferId, 0, bytes.toString('base64')); await f.manager.commit(who, record.transferId);
  const first = await f.manager.leaseUploads(who, [record.transferId]), second = await f.manager.leaseUploads(who, [record.transferId]);
  now = 1_000_000;
  await f.manager.status(who, record.transferId); assert.deepEqual(await readFile(first.paths[0]!), bytes); assert.equal(f.manager.stats().uploadFileLeases, 2);
  await code(f.manager.leaseUploads(who, [record.transferId]), 'FILE_TRANSFER_NOT_FOUND');
  first.release(); first.release(); await f.manager.status(who, record.transferId); assert.deepEqual(await readFile(second.paths[0]!), bytes); assert.equal(f.manager.stats().uploadFileLeases, 1);
  second.release(); await code(f.manager.status(who, record.transferId), 'FILE_TRANSFER_NOT_FOUND'); assert.equal(f.manager.stats().uploadFileLeases, 0);
  await assert.rejects(readFile(second.paths[0]!), { code: 'ENOENT' });
});

test('lease返回前授权失效会撤销pin；只读调用不能申请上传lease', async t => {
  let now = 1000; const f = await setup({ now: () => now, ttlMs: 100 }); t.after(() => f.close()); const who = context(), record = await f.manager.begin(who, declared(Buffer.alloc(0))); await f.manager.commit(who, record.transferId);
  const stale = { ...who, assertActive: () => { if (f.manager.stats().uploadFileLeases) throw new BrowserError('CLIENT_AUTHORIZATION_FAILED', 'revoked', NOT_DISPATCHED); } };
  await code(f.manager.leaseUploads(stale, [record.transferId]), 'CLIENT_AUTHORIZATION_FAILED'); assert.equal(f.manager.stats().uploadFileLeases, 0);
  await code(f.manager.leaseUploads({ ...who, principal: { ...who.principal, readOnly: true } }, [record.transferId]), 'CLIENT_READ_ONLY');
  now = 1101; await code(f.manager.status(who, record.transferId), 'FILE_TRANSFER_NOT_FOUND');
});
