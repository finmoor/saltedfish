import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { fixture, fakeProfile, testDirectory } from './helpers.js';
import { FILE_CHUNK_BYTES } from '../src/file-transfer-tools.js';
import type { WireCommand } from '../src/shared.js';
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

test('MCP文件闭环：大块读取不再次存artifact，transferIds按原文件名上传且不放宽普通paths', async t => {
  const f = await fixture(); t.after(() => f.cleanup()); const dispatched: WireCommand[] = [];
  const profile = await fakeProfile(f.config, 'A', command => { dispatched.push(command); return {}; });
  const principal = f.service.state.authenticate(f.service.state.createClient('writer', [profile.id]).token)!;
  const invoke = (name: string, args: Record<string, unknown>) => f.service.invoke(name, { profileId: profile.id, ...args }, 'session-a', principal);
  const bytes = Buffer.alloc(FILE_CHUNK_BYTES, 65);
  const begun = await invoke('chrome_file_begin', { filename: 'report.csv', size: bytes.length, sha256: sha(bytes), submissionId: randomUUID() }); assert.equal(begun.ok, true);
  const transferId = (begun.data as any).transferId;
  assert.equal((await invoke('chrome_file_write', { transferId, offset: 0, base64: bytes.toString('base64') })).ok, true);
  assert.equal((await invoke('chrome_file_commit', { transferId })).ok, true);
  const before = f.service.stats().resultBytes, read = await invoke('chrome_file_read', { transferId, length: FILE_CHUNK_BYTES });
  assert.equal(read.ok, true); assert.deepEqual(Buffer.from((read.data as any).base64, 'base64'), bytes); assert.equal((read.data as any).artifactId, undefined); assert.equal(f.service.stats().resultBytes, before);
  assert.equal(dispatched.length, 0, '文件分块不操作浏览器');
  const uploaded = await invoke('chrome_upload', { tabId: 1, selector: '#file', transferIds: [transferId] }); assert.equal(uploaded.ok, true, JSON.stringify(uploaded));
  const upload = dispatched.find(item => item.operation === 'page.upload')!;
  assert.equal(upload.args.transferIds, undefined); const local = (upload.args.paths as string[])[0]!; assert.equal(path.basename(local), 'report.csv'); assert.deepEqual(await readFile(local), bytes);
  const rawPath = await invoke('chrome_upload', { tabId: 1, selector: '#file', paths: [local] }); assert.equal(rawPath.error?.code, 'UPLOAD_PATH_NOT_ALLOWED');
  assert.equal((await invoke('chrome_upload', { tabId: 1, selector: '#file', paths: [local], transferIds: [transferId] })).error?.code, 'INVALID_ARGUMENT');
});

test('MCP文件作用域：其他主体或账号不能读/上传transferId，批次不绕过归属', async t => {
  const f = await fixture(); t.after(() => f.cleanup()); const seen: WireCommand[] = [];
  const profile = await fakeProfile(f.config, 'A', command => { seen.push(command); return {}; }), otherProfile = await fakeProfile(f.config, 'B');
  const principal = f.service.state.authenticate(f.service.state.createClient('a', [profile.id, otherProfile.id]).token)!, stranger = f.service.state.authenticate(f.service.state.createClient('b', [profile.id]).token)!;
  const result = await f.service.invoke('chrome_file_begin', { profileId: profile.id, filename: 'empty.txt', size: 0, sha256: sha(Buffer.alloc(0)), submissionId: randomUUID() }, 'a', principal), transferId = (result.data as any).transferId;
  await f.service.invoke('chrome_file_commit', { profileId: profile.id, transferId }, 'a', principal);
  assert.equal((await f.service.invoke('chrome_file_read', { profileId: profile.id, transferId }, 'b', stranger)).error?.code, 'FILE_TRANSFER_NOT_FOUND');
  assert.equal((await f.service.invoke('chrome_upload', { profileId: otherProfile.id, tabId: 1, selector: '#file', transferIds: [transferId] }, 'a', principal)).error?.code, 'FILE_TRANSFER_NOT_FOUND');
  assert.equal((await f.service.invoke('chrome_batch', { profileId: profile.id, tabId: 1, steps: [{ operation: 'page.upload', args: { selector: '#file', transferIds: [transferId] } }] }, 'b', stranger)).error?.code, 'FILE_TRANSFER_NOT_FOUND');
  assert.equal(seen.length, 0);
});

test('MCP排队文件请求撤销后不写入，旧远程连接不能读取；只读声明与实际授权一致', async t => {
  const f = await fixture(); t.after(() => f.cleanup()); const profileId = randomUUID();
  const grant = f.service.state.createClient('writer', [profileId]), principal = f.service.state.authenticate(grant.token)!;
  const pending = f.service.invoke('chrome_file_begin', { profileId, filename: 'x', size: 0, sha256: sha(Buffer.alloc(0)), submissionId: randomUUID() }, 'a', principal);
  f.service.state.revokeClient(grant.id); const refused = await pending;
  assert.equal(refused.error?.code, 'CLIENT_AUTHORIZATION_FAILED'); assert.equal(f.service.transfers.stats().fileTransfers, 0);
  const reader = f.service.state.authenticate(f.service.state.createClient('reader', [profileId], true).token)!;
  assert.equal((await f.service.invoke('chrome_file_begin', { profileId, filename: 'x', size: 0, sha256: sha(Buffer.alloc(0)), submissionId: randomUUID() }, 'r', reader)).error?.code, 'CLIENT_READ_ONLY');
  const remote = { ...principal, id: 'remote:old', submissionScope: 'stable' }; f.service.state.remotePrincipals.set(remote.id, remote);
  const begin = await f.service.invoke('chrome_file_begin', { profileId, filename: 'x', size: 0, sha256: sha(Buffer.alloc(0)), submissionId: randomUUID() }, 'old', remote);
  assert.equal(begin.ok, true); f.service.state.remotePrincipals.delete(remote.id);
  assert.equal((await f.service.invoke('chrome_file_status', { profileId, transferId: (begin.data as any).transferId }, 'old', remote)).error?.code, 'REMOTE_CONNECTION_CHANGED');
});

test('MCP导出只查询明确账号的Chrome downloadId，未完成/不存在/任意路径拒绝', async t => {
  const f = await fixture(), files = await testDirectory(); t.after(async () => { await f.cleanup(); await files.cleanup(); });
  const downloads = path.join(files.directory, 'Downloads'); await mkdir(downloads);
  const filename = path.join(downloads, 'result.txt'); await writeFile(filename, 'download result'); let state = 'in_progress'; const seen: WireCommand[] = [];
  const profile = await fakeProfile(f.config, 'A', command => { seen.push(command); if (command.operation === 'downloads.list') return command.args.downloadId === 7 ? [{ id: 7, filename, state, exists: true }] : []; return {}; });
  const principal = f.service.state.authenticate(f.service.state.createClient('reader', [profile.id]).token)!;
  const invoke = (args: Record<string, unknown>) => f.service.invoke('chrome_file_export', { profileId: profile.id, submissionId: randomUUID(), ...args }, 'a', principal);
  assert.equal((await invoke({ downloadId: 7 })).error?.code, 'FILE_DOWNLOAD_NOT_READY');
  assert.equal((await invoke({ downloadId: 8 })).error?.code, 'DOWNLOAD_NOT_FOUND');
  assert.equal((await invoke({ downloadId: 7, path: filename })).error?.code, 'INVALID_ARGUMENT');
  state = 'complete'; const submissionId = randomUUID(), exported = await invoke({ downloadId: 7, submissionId }); assert.equal(exported.ok, true, JSON.stringify(exported));
  const read = await f.service.invoke('chrome_file_read', { profileId: profile.id, transferId: (exported.data as any).transferId }, 'a', principal);
  assert.equal(Buffer.from((read.data as any).base64, 'base64').toString(), 'download result'); assert.equal(seen.every(command => command.operation === 'downloads.list'), true);
  const before = seen.length, closed = once(profile.socket, 'close'); profile.socket.terminate(); await closed;
  for (let i = 0; i < 100 && f.service.broker.profiles.has(profile.id); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.service.broker.profiles.has(profile.id), false); await unlink(filename);
  const repeated = await invoke({ downloadId: 7, submissionId }); assert.equal(repeated.ok, true, JSON.stringify(repeated)); assert.equal((repeated.data as any).transferId, (exported.data as any).transferId); assert.equal((repeated.data as any).deduplicated, true); assert.equal(seen.length, before, '既有快照重试不访问离线Chrome');
  assert.equal((await invoke({ downloadId: 8, submissionId })).error?.code, 'FILE_TRANSFER_CONFLICT');
});

test('服务持有文件lease直到浏览器完成，批次后续预检失败与标签占用拒绝都释放已取得的lease', async t => {
  const f = await fixture(); let finish!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { finish = resolve; });
  t.after(async () => { finish(); await f.cleanup(); });
  const profile = await fakeProfile(f.config, 'A', async command => { if (command.operation === 'tabs.list') return [{ tabId: 7 }]; if (command.operation === 'page.upload') { entered(); await gate; } return {}; });
  const principal = f.service.state.authenticate(f.service.state.createClient('writer', [profile.id]).token)!, other = f.service.state.authenticate(f.service.state.createClient('other', [profile.id]).token)!;
  const invoke = (name: string, args: Record<string, unknown>, who = principal) => f.service.invoke(name, { profileId: profile.id, ...args }, who.id, who);
  const input = { filename: 'empty.txt', size: 0, sha256: sha(Buffer.alloc(0)), submissionId: randomUUID() }, begun = await invoke('chrome_file_begin', input), transferId = (begun.data as any).transferId;
  await invoke('chrome_file_commit', { transferId });
  const foreign = await invoke('chrome_file_begin', { ...input, submissionId: randomUUID() }, other), foreignId = (foreign.data as any).transferId;
  await invoke('chrome_file_commit', { transferId: foreignId }, other);
  const args = { tabId: 7, selector: '#file', transferIds: [transferId] };
  const batch = await invoke('chrome_batch', { tabId: 7, steps: [{ operation: 'page.upload', args: { selector: '#file', transferIds: [transferId] } }, { operation: 'page.upload', args: { selector: '#file', transferIds: [foreignId] } }] });
  assert.equal(batch.error?.code, 'FILE_TRANSFER_NOT_FOUND'); assert.equal(f.service.transfers.stats().uploadFileLeases, 0);
  assert.equal((await invoke('chrome_claim_tab', { tabId: 7 }, other)).ok, true);
  assert.equal((await invoke('chrome_upload', args)).error?.code, 'TAB_CLAIMED'); assert.equal(f.service.transfers.stats().uploadFileLeases, 0);
  await invoke('chrome_release_tab', { tabId: 7 }, other);
  const pending = invoke('chrome_upload', args); await started;
  assert.equal(f.service.transfers.stats().uploadFileLeases, 1); finish(); assert.equal((await pending).ok, true); assert.equal(f.service.transfers.stats().uploadFileLeases, 0);
});
