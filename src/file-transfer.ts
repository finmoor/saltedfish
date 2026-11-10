import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, readdir, realpath, rename, stat, lstat, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { allowsProfile, type Principal } from './auth.js';
import { BrowserError, NOT_DISPATCHED } from './shared.js';
import { checkUploadFile, filePolicy, type FilePolicy } from './upload-policy.js';
import { FILE_CHUNK_BYTES, FILE_MAX_BYTES, transferFilename } from './file-transfer-tools.js';

export interface FileTransferContext { principal: Principal; profileId: string; assertActive?: () => void }
export interface FileUploadLease { paths: string[]; release: () => void }
export interface FileTransferOptions {
  maxFileBytes?: number; totalBytes?: number; principalBytes?: number; maxTransfers?: number; principalTransfers?: number; ttlMs?: number;
  now?: () => number; policy?: FilePolicy;
}
const stored = z.object({ format: z.literal(1), id: z.string().uuid(), owner: z.string().regex(/^[a-f0-9]{64}$/), profileId: z.string().min(1), filename: transferFilename,
  size: z.number().int().nonnegative().max(FILE_MAX_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/), receivedBytes: z.number().int().nonnegative(),
  direction: z.enum(['import', 'export']), state: z.enum(['receiving', 'ready', 'failed']), createdAt: z.number().finite(), expiresAt: z.number().finite(), submissionId: z.string().uuid(), downloadId: z.number().int().nonnegative().optional() }).strict();
type Transfer = z.infer<typeof stored>;
export interface DownloadForExport { id: number; filename: string; state: string; exists?: boolean; error?: string; fileSize?: number; totalBytes?: number }
export interface BrowserDownloadChunk {offset:number;size:number;snapshot:string;base64:string;eof:boolean}
const fail = (code: string, message: string): never => { throw new BrowserError(code, message, NOT_DISPATCHED); };
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const ownerKey = (principal: Principal) => sha(principal.submissionScope ?? principal.id);
const missing = (): never => fail('FILE_TRANSFER_NOT_FOUND', '该传输不存在、已到期，或不属于本客户端与账号；请重新发起传输。');

/** 专用暂存文件；持久元数据只记录文件身份和进度，永不自动执行网页动作。 */
export class FileTransferManager {
  private readonly root: string;
  private readonly records = new Map<string, Transfer>();
  private readonly uploadPins = new Map<string, number>();
  private readonly limits: Required<Omit<FileTransferOptions, 'policy'>>;
  private readonly policy: () => FilePolicy;
  private initialized?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private rootReal = '';
  private untrackedBytes = 0;
  private closed = false;
  constructor(config: { dataDir: string }, options: FileTransferOptions = {}) {
    this.root = path.join(path.resolve(config.dataDir), 'file-transfers');
    this.policy = () => options.policy ?? filePolicy(config);
    this.limits = { maxFileBytes: FILE_MAX_BYTES, totalBytes: 1024 * 1024 * 1024, principalBytes: 256 * 1024 * 1024, maxTransfers: 256, principalTransfers: 64, ttlMs: 60 * 60 * 1000, now: Date.now, ...options };
  }
  private payload(record: Transfer) { return path.join(this.root, record.id, record.filename); }
  private file(id: string, suffix = 'json') { return path.join(this.root, `${id}.${suffix}`); }
  private async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink()) fail('FILE_TRANSFER_STORAGE', '文件暂存目录不能是符号链接。');
    this.rootReal = await realpath(this.root);
    const entries = await readdir(this.root, { withFileTypes: true });
    if (entries.length > 2048) fail('FILE_TRANSFER_STORAGE', '暂存目录存在过多文件，请由管理员核查。');
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9-]{36}\.json$/.test(entry.name)) continue;
      try {
        const metadata = this.file(entry.name.slice(0, -5), 'json');
        if ((await stat(metadata)).size > 8192) continue;
        const value = stored.parse(JSON.parse(await readFile(metadata, 'utf8')));
        if (`${value.id}.json` !== entry.name || value.receivedBytes > value.size || value.expiresAt <= value.createdAt) continue;
        this.records.set(value.id, value);
      } catch { /* 损坏元数据不提供读取或上传；其文件仍计入容量。 */ }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      const children = await readdir(path.join(this.root, entry.name), { withFileTypes: true });
      if (children.length > 100) fail('FILE_TRANSFER_STORAGE', '暂存目录中存在异常文件，请由管理员核查。');
      const record = this.records.get(entry.name);
      for (const child of children) if (child.isFile()) {
        const size = (await stat(path.join(this.root, entry.name, child.name))).size;
        if (!record || child.name !== record.filename) this.untrackedBytes += size;
        else {
          if (size > record.size) this.untrackedBytes += size - record.size;
          if (record.state === 'receiving' && record.direction === 'import' && size <= record.size) record.receivedBytes = size; // 崩溃可能发生在数据落盘和元数据落盘之间。
          else if (record.state !== 'failed' && size !== record.size) record.state = 'failed';
        }
      }
    }
  }
  private async run<T>(context: FileTransferContext, job: () => Promise<T>): Promise<T> {
    if (this.closed) fail('FILE_TRANSFER_CLOSED', '文件传输服务正在关闭。');
    context.assertActive?.();
    const result = this.tail.then(async () => {
      context.assertActive?.();
      await (this.initialized ??= this.init());
      if (await realpath(this.root) !== this.rootReal) fail('FILE_TRANSFER_STORAGE', '暂存目录身份已变化，请停止服务后核查。');
      await this.expire();
      context.assertActive?.();
      const value = await job();
      context.assertActive?.();
      return value;
    });
    this.tail = result.catch(() => {});
    return result;
  }
  private async save(record: Transfer) {
    const temp = this.file(record.id, `${randomUUID()}.tmp`);
    if (await realpath(this.root) !== this.rootReal) fail('FILE_TRANSFER_STORAGE', '暂存目录身份已变化，未保存元数据。');
    const handle = await open(temp, 'wx', 0o600);
    try {
      try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
      if (await realpath(this.root) !== this.rootReal) fail('FILE_TRANSFER_STORAGE', '暂存目录身份已变化，未替换元数据。');
      await rename(temp, this.file(record.id, 'json'));
    } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  private async discardCreated(record: Transfer) {
    // 清理失败仍保留占额记录，不能靠连续失败绕过磁盘预算。
    try {
      await unlink(this.payload(record)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await rmdir(path.dirname(this.payload(record))).catch(error => { if (error.code !== 'ENOENT') throw error; });
      for (const suffix of ['json', 'json.tmp']) await unlink(this.file(record.id, suffix)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      this.records.delete(record.id);
    } catch { record.state = 'failed'; this.records.set(record.id, record); await this.save(record).catch(() => {}); }
  }
  private authorize(context: FileTransferContext, write = false) {
    context.assertActive?.();
    if (!allowsProfile(context.principal, context.profileId)) fail('PROFILE_NOT_AUTHORIZED', '客户端没有该账号的文件传输授权。');
    if (write && context.principal.readOnly) fail('CLIENT_READ_ONLY', '只读客户端不能创建或写入文件传输。');
  }
  private get(context: FileTransferContext, id: string, write = false) {
    this.authorize(context, write);
    const record = this.records.get(id);
    if (!record || record.profileId !== context.profileId || record.owner !== ownerKey(context.principal)) return missing();
    return record;
  }
  private summary(record: Transfer) {
    return { transferId: record.id, filename: record.filename, size: record.size, sha256: record.sha256, receivedBytes: record.receivedBytes, state: record.state, direction: record.direction, expiresAt: record.expiresAt, chunkBytes: FILE_CHUNK_BYTES };
  }
  private async expire() {
    for (const record of this.records.values()) if (record.expiresAt <= this.limits.now() && !this.uploadPins.has(record.id)) {
      // 只删除已登记传输的精确文件；目录中多出的文件不递归删除。
      const directory = path.dirname(this.payload(record));
      const directoryInfo = await lstat(directory).catch(() => undefined);
      if (directoryInfo?.isSymbolicLink() || directoryInfo && await realpath(directory) !== path.join(this.rootReal, record.id)) fail('FILE_TRANSFER_STORAGE', '到期暂存目录身份变化，未清理。');
      await unlink(this.payload(record)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await rmdir(directory).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
      await unlink(this.file(record.id, 'json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await unlink(this.file(record.id, 'json.tmp')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      this.records.delete(record.id);
    }
  }
  private reserve(context: FileTransferContext, size: number) {
    if (size > this.limits.maxFileBytes || !Number.isSafeInteger(size) || size < 0) fail('FILE_TRANSFER_TOO_LARGE', '文件超过单文件传输上限。');
    const own = ownerKey(context.principal), all = [...this.records.values()], owned = all.filter(record => record.owner === own);
    if (all.length >= this.limits.maxTransfers || owned.length >= this.limits.principalTransfers || this.untrackedBytes + all.reduce((n, record) => n + record.size, 0) + size > this.limits.totalBytes || owned.reduce((n, record) => n + record.size, 0) + size > this.limits.principalBytes)
      fail('FILE_TRANSFER_QUOTA', '文件暂存额度不足；请等待旧传输到期或由管理员核查暂存目录。');
  }
  private duplicate(context: FileTransferContext, submissionId: string) {
    return [...this.records.values()].find(record => record.owner === ownerKey(context.principal) && record.profileId === context.profileId && record.submissionId === submissionId);
  }
  private create(context: FileTransferContext, input: { filename: string; size: number; sha256: string; submissionId: string }, direction: Transfer['direction']): Transfer {
    const now = this.limits.now();
    return { format: 1, id: randomUUID(), owner: ownerKey(context.principal), profileId: context.profileId, filename: transferFilename.parse(input.filename), size: input.size, sha256: input.sha256.toLowerCase(), submissionId: input.submissionId, direction, state: 'receiving', receivedBytes: 0, createdAt: now, expiresAt: now + this.limits.ttlMs };
  }
  async begin(context: FileTransferContext, input: { filename: string; size: number; sha256: string; submissionId: string }) {
    return this.run(context, async () => {
      this.authorize(context, true);
      transferFilename.parse(input.filename); z.string().uuid().parse(input.submissionId); z.string().regex(/^[a-f0-9]{64}$/i).parse(input.sha256);
      const previous = this.duplicate(context, input.submissionId);
      if (previous) {
        if (previous.direction !== 'import' || previous.filename !== input.filename || previous.size !== input.size || previous.sha256 !== input.sha256.toLowerCase()) fail('FILE_TRANSFER_CONFLICT', '同一 submissionId 的文件声明已变化；没有覆盖原传输。');
        return { ...this.summary(previous), deduplicated: true };
      }
      this.reserve(context, input.size);
      const record = this.create(context, input, 'import');
      context.assertActive?.();
      await mkdir(path.dirname(this.payload(record)), { mode: 0o700 });
      const handle = await open(this.payload(record), 'wx', 0o600);
      await handle.close();
      this.records.set(record.id, record);
      try { await this.save(record); } catch (error) { await this.discardCreated(record); throw error; }
      return { ...this.summary(record), deduplicated: false };
    });
  }
  private async openPayload(record: Transfer, writable = false) {
    const file = this.payload(record), info = await lstat(file).catch(() => missing());
    if (!info.isFile() || info.isSymbolicLink() || path.dirname(await realpath(file)) !== path.join(this.rootReal, record.id)) fail('FILE_TRANSFER_CORRUPT', '暂存文件身份不正确，未提供内容。');
    const handle = await open(file, (writable ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0));
    const actual = await handle.stat();
    if (!actual.isFile() || actual.dev !== info.dev || actual.ino !== info.ino) { await handle.close(); fail('FILE_TRANSFER_CORRUPT', '暂存文件在打开期间变化。'); }
    return handle;
  }
  async write(context: FileTransferContext, id: string, offset: number, base64: string) {
    return this.run(context, async () => {
      const record = this.get(context, id, true);
      if (record.direction !== 'import' || record.state === 'failed') fail('FILE_TRANSFER_STATE', '此传输不能继续写入。');
      if (!Number.isSafeInteger(offset) || offset < 0 || typeof base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64) || base64.length > Math.ceil(FILE_CHUNK_BYTES / 3) * 4) fail('FILE_TRANSFER_CHUNK', '块偏移或 base64 格式无效。');
      const bytes = Buffer.from(base64, 'base64');
      if (!bytes.length || bytes.length > FILE_CHUNK_BYTES || bytes.toString('base64') !== base64 || offset + bytes.length > record.size) fail('FILE_TRANSFER_CHUNK', '块大小或内容不符合文件声明。');
      if (offset > record.receivedBytes || offset < record.receivedBytes && offset + bytes.length > record.receivedBytes) fail('FILE_TRANSFER_OFFSET', '请从 receivedBytes 继续；不能跳过或部分覆盖已有内容。');
      const handle = await this.openPayload(record, true);
      try {
        if (offset < record.receivedBytes) {
          const previous = Buffer.alloc(bytes.length), { bytesRead } = await handle.read(previous, 0, previous.length, offset);
          if (bytesRead !== bytes.length || !previous.equals(bytes)) fail('FILE_TRANSFER_CONFLICT', '重试块与已接收内容不同，未覆盖。');
          return { ...this.summary(record), deduplicated: true };
        }
        if (record.state !== 'receiving') fail('FILE_TRANSFER_STATE', '传输已经提交，不能追加内容。');
        for (let written = 0; written < bytes.length;) { context.assertActive?.(); const result = await handle.write(bytes, written, bytes.length - written, offset + written); if (!result.bytesWritten) fail('FILE_TRANSFER_STORAGE', '无法继续写入暂存文件。'); written += result.bytesWritten; }
        await handle.sync(); record.receivedBytes += bytes.length; await this.save(record);
        return { ...this.summary(record), deduplicated: false };
      } finally { await handle.close(); }
    });
  }
  private async verify(record: Transfer, context: FileTransferContext) {
    const handle = await this.openPayload(record), hash = createHash('sha256'), bytes = Buffer.alloc(FILE_CHUNK_BYTES);
    try {
      const info = await handle.stat();
      if (info.size !== record.size) fail('FILE_TRANSFER_INCOMPLETE', '暂存文件长度与声明不符；请查询进度后继续传输。');
      for (let offset = 0; offset < record.size;) { context.assertActive?.(); const { bytesRead } = await handle.read(bytes, 0, Math.min(bytes.length, record.size - offset), offset); if (!bytesRead) fail('FILE_TRANSFER_CORRUPT', '暂存文件提前结束。'); hash.update(bytes.subarray(0, bytesRead)); offset += bytesRead; }
      if (hash.digest('hex') !== record.sha256) fail('FILE_TRANSFER_HASH_MISMATCH', '文件 SHA256 与声明不符，未提供文件；请重新发起传输。');
    } finally { await handle.close(); }
  }
  async commit(context: FileTransferContext, id: string) {
    return this.run(context, async () => {
      const record = this.get(context, id, true);
      if (record.direction !== 'import' || record.state === 'failed') fail('FILE_TRANSFER_STATE', '此传输不能提交。');
      if (record.receivedBytes !== record.size) fail('FILE_TRANSFER_INCOMPLETE', '文件尚未传完；请从 receivedBytes 继续。');
      try { await this.verify(record, context); } catch (error) {
        if (error instanceof BrowserError && ['FILE_TRANSFER_HASH_MISMATCH', 'FILE_TRANSFER_CORRUPT', 'FILE_TRANSFER_INCOMPLETE'].includes(error.code)) { record.state = 'failed'; await this.save(record); }
        throw error;
      }
      context.assertActive?.();
      const deduplicated = record.state === 'ready'; record.state = 'ready'; await this.save(record);
      return { ...this.summary(record), deduplicated };
    });
  }
  async status(context: FileTransferContext, id: string) { return this.run(context, async () => this.summary(this.get(context, id))); }
  async read(context: FileTransferContext, id: string, offset = 0, length = 16384) {
    return this.run(context, async () => {
      const record = this.get(context, id);
      if (record.state !== 'ready') fail('FILE_TRANSFER_STATE', '文件尚未完成校验，不能读取。');
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > record.size || !Number.isSafeInteger(length) || length < 1 || length > FILE_CHUNK_BYTES) fail('FILE_TRANSFER_CHUNK', '读取范围无效。');
      const handle = await this.openPayload(record);
      try {
        if ((await handle.stat()).size !== record.size) fail('FILE_TRANSFER_CORRUPT', '已完成文件的长度已变化。');
        const bytes = Buffer.alloc(Math.min(length, record.size - offset)), { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
        context.assertActive?.();
        if (bytesRead !== bytes.length) fail('FILE_TRANSFER_CORRUPT', '读取的内容长度不完整。');
        return { transferId: id, offset, nextOffset: offset + bytesRead, eof: offset + bytesRead === record.size, size: record.size, sha256: record.sha256, base64: bytes.toString('base64') };
      } finally { await handle.close(); }
    });
  }
  private async existingExport(context: FileTransferContext, input: { downloadId: number; submissionId: string }) {
    this.authorize(context, true); z.string().uuid().parse(input.submissionId);
    const previous = this.duplicate(context, input.submissionId);
    if (!previous) return undefined;
    if (previous.direction !== 'export' || previous.downloadId !== input.downloadId) fail('FILE_TRANSFER_CONFLICT', '同一 submissionId 已用于另一个文件。');
    if (previous.state !== 'ready') fail('FILE_TRANSFER_STATE', '此前导出未形成可读快照；请核查传输状态后重新发起。');
    await this.verify(previous, context);
    return { ...this.summary(previous), deduplicated: true };
  }
  /** service 必须在 capture/downloads.list 之前查询：已完成快照不依赖原 Chrome 或原下载文件继续存在。 */
  async lookupExport(context: FileTransferContext, input: { downloadId: number; submissionId: string }) {
    return this.run(context, () => this.existingExport(context, input));
  }
  /** 仅由 service 从已授权配置的 downloads.list 结果调用，不暴露源路径参数。 */
  async exportDownload(context: FileTransferContext, input: { downloadId: number; submissionId: string }, download: DownloadForExport) {
    return this.run(context, async () => {
      const previous = await this.existingExport(context, input);
      if (previous) return previous;
      if (download.id !== input.downloadId || download.state !== 'complete' || download.exists === false || download.error) fail('FILE_DOWNLOAD_NOT_READY', '下载尚未完成、已删除或已中断；请先核对 downloads。');
      await checkUploadFile(download.filename, this.policy());
      const sourcePath = await realpath(download.filename);
      await checkUploadFile(sourcePath, this.policy());
      const source = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let record: Transfer | undefined;
      try {
        const before = await source.stat();
        if (!before.isFile()) fail('FILE_DOWNLOAD_NOT_READY', '下载目标不是普通文件。');
        this.reserve(context, before.size);
        record = this.create(context, { filename: path.basename(download.filename), size: before.size, sha256: '0'.repeat(64), submissionId: input.submissionId }, 'export'); record.downloadId = input.downloadId;
        await mkdir(path.dirname(this.payload(record)), { mode: 0o700 });
        const destination = await open(this.payload(record), 'wx', 0o600), hash = createHash('sha256'), buffer = Buffer.alloc(FILE_CHUNK_BYTES);
        this.records.set(record.id, record);
        try {
          for (let offset = 0; offset < before.size;) {
            context.assertActive?.();
            const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
            if (!bytesRead) fail('FILE_DOWNLOAD_CHANGED', '下载文件在读取时变化，请重新核对下载。');
            hash.update(buffer.subarray(0, bytesRead));
            for (let written = 0; written < bytesRead;) { context.assertActive?.(); const result = await destination.write(buffer, written, bytesRead - written, offset + written); if (!result.bytesWritten) fail('FILE_TRANSFER_STORAGE', '无法保存下载快照。'); written += result.bytesWritten; }
            offset += bytesRead;
          }
          const after = await source.stat();
          if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail('FILE_DOWNLOAD_CHANGED', '下载文件在读取时变化，请重新核对下载。');
          await destination.sync(); record.sha256 = hash.digest('hex'); record.receivedBytes = record.size; record.state = 'ready';
        } finally { await destination.close(); }
        await this.save(record); return { ...this.summary(record), deduplicated: false };
      } catch (error) {
        if (record) await this.discardCreated(record);
        throw error;
      } finally { await source.close(); }
    });
  }
  /** 直连浏览器的文件由它所在电脑的可选助手读取；服务不把浏览器路径当作自己的路径。 */
  async exportBrowserDownload(context:FileTransferContext,input:{downloadId:number;submissionId:string},download:DownloadForExport,read:(offset:number,length:number,snapshot?:string)=>Promise<unknown>){
    return this.run(context,async()=>{
      const previous=await this.existingExport(context,input);if(previous)return previous;
      if(download.id!==input.downloadId||download.state!=='complete'||download.exists===false||download.error)fail('FILE_DOWNLOAD_NOT_READY','下载尚未完成或已不可用。');
      const Chunk=z.object({offset:z.number().int().nonnegative(),size:z.number().int().min(0).max(FILE_MAX_BYTES),snapshot:z.string().length(64).regex(/^[a-f0-9]+$/),base64:z.string().max(Math.ceil(FILE_CHUNK_BYTES/3)*4),eof:z.boolean()}).strict();
      let part=Chunk.parse(await read(0,FILE_CHUNK_BYTES));context.assertActive?.();this.reserve(context,part.size);
      const record=this.create(context,{filename:transferFilename.parse(path.win32.basename(download.filename)),size:part.size,sha256:'0'.repeat(64),submissionId:input.submissionId},'export');record.downloadId=input.downloadId;
      let destination:Awaited<ReturnType<typeof open>>|undefined;
      try{
        await mkdir(path.dirname(this.payload(record)),{mode:0o700});destination=await open(this.payload(record),'wx',0o600);this.records.set(record.id,record);
        const hash=createHash('sha256'),snapshot=part.snapshot;let offset=0;
        for(;;){
          context.assertActive?.();if(part.offset!==offset||part.size!==record.size||part.snapshot!==snapshot||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.base64))fail('FILE_DOWNLOAD_CHANGED','下载快照或文件块不一致，未提供导出文件。');
          const bytes=Buffer.from(part.base64,'base64'),expected=Math.min(FILE_CHUNK_BYTES,record.size-offset);
          if(bytes.length!==expected||part.eof!==(offset+expected===record.size))fail('FILE_DOWNLOAD_CHANGED','下载内容长度变化，未提供导出文件。');
          hash.update(bytes);for(let done=0;done<bytes.length;){context.assertActive?.();const result=await destination.write(bytes,done,bytes.length-done,offset+done);if(!result.bytesWritten)fail('FILE_TRANSFER_STORAGE','无法保存下载快照。');done+=result.bytesWritten;}
          offset+=bytes.length;if(part.eof)break;part=Chunk.parse(await read(offset,FILE_CHUNK_BYTES,snapshot));
        }
        context.assertActive?.();await destination.sync();await destination.close();destination=undefined;record.sha256=hash.digest('hex');record.receivedBytes=record.size;record.state='ready';await this.save(record);return{...this.summary(record),deduplicated:false};
      }catch(error){await destination?.close();await this.discardCreated(record);throw error;}
    });
  }
  private async verifiedUploads(context: FileTransferContext, ids: string[]) {
    this.authorize(context, true);
    if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length) fail('FILE_TRANSFER_CHUNK', 'transferIds 需要 1–100 个不同的传输 ID。');
    const records = ids.map(id => this.get(context, id));
    const paths: string[] = [];
    for (const record of records) {
      if (record.expiresAt <= this.limits.now()) missing();
      if (record.state !== 'ready') fail('FILE_TRANSFER_STATE', '只能上传校验完成的文件。');
      await this.verify(record, context); paths.push(this.payload(record));
    }
    // 长哈希期间也可能跨过 TTL；旧在途上传仍被 pin，但到期文件不接受新的上传。
    if (records.some(record => record.expiresAt <= this.limits.now())) missing();
    return paths;
  }
  /** 无租约解析仅供即时校验；真正浏览器派发必须使用 leaseUploads 并在整个调用结束后 release。 */
  async resolveUploads(context: FileTransferContext, ids: string[]) {
    return this.run(context, () => this.verifiedUploads(context, ids));
  }
  /** 批次预检、窗口排队、派发与结果收尾共同持有；引用计数不依赖调用耗时。 */
  async leaseUploads(context: FileTransferContext, ids: string[]): Promise<FileUploadLease> {
    let lease: FileUploadLease | undefined;
    try {
      return await this.run(context, async () => {
        const paths = await this.verifiedUploads(context, ids);
        for (const id of ids) this.uploadPins.set(id, (this.uploadPins.get(id) ?? 0) + 1);
        let released = false;
        lease = { paths, release: () => {
          if (released) return; released = true;
          for (const id of ids) { const remaining = (this.uploadPins.get(id) ?? 1) - 1; if (remaining > 0) this.uploadPins.set(id, remaining); else this.uploadPins.delete(id); }
        } };
        return lease;
      });
    } catch (error) {
      // run 的返回前授权复查也可能抛错；调用方尚未拿到 lease，此处负责撤销 pin。
      lease?.release(); throw error;
    }
  }
  stats() { return { fileTransfers: this.records.size, transferReservedBytes: [...this.records.values()].reduce((n, record) => n + record.size, this.untrackedBytes), untrackedTransferBytes: this.untrackedBytes, pinnedTransfers: this.uploadPins.size, uploadFileLeases: [...this.uploadPins.values()].reduce((n, count) => n + count, 0) }; }
  async close() { this.closed = true; await this.tail; }
}
