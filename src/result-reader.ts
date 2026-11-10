import { open, type FileHandle } from 'node:fs/promises';
import { BrowserError } from './shared.js';

const CHUNK_BYTES = 64 * 1024;
const INDEX_BUDGET = 4 * 1024 * 1024;
interface Checkpoint { bytes: number; characters: number }
interface Index { signature: string; totalCharacters: number; points: Checkpoint[] }

// 完整 UTF-8 序列边界；仅保留至多3个尾字节，避免把汉字/emoji拆成替换符。
function completePrefix(buffer: Buffer) {
  let start = buffer.length - 1;
  while (start >= 0 && start >= buffer.length - 4 && (buffer[start]! & 0xc0) === 0x80) start--;
  if (start < 0) return buffer.length;
  const lead = buffer[start]!;
  const length = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 1;
  return buffer.length - start < length ? start : buffer.length;
}
const signature = (info: NonNullable<Awaited<ReturnType<FileHandle['stat']>>>) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;

export class ResultReader {
  private indexes = new Map<string, Index>();
  private builds = new Map<string, Promise<Index>>();
  private active = 0;
  private waiting: Array<() => void> = [];

  stats() { return { resultReaders: this.active, resultReadQueue: this.waiting.length, resultIndexBytes: this.indexBytes() }; }
  private indexBytes() { return [...this.indexes.values()].reduce((sum, item) => sum + item.points.length * 32, 0); }
  private async permit() {
    if (this.active < 4) { this.active++; return; }
    if (this.waiting.length >= 128) throw new BrowserError('RESULT_READ_BUSY', '结果读取队列已满，请稍后读取；不需要重跑浏览器操作。');
    await new Promise<void>(resolve => this.waiting.push(resolve));
  }
  private release() { const next = this.waiting.shift(); if (next) next(); else this.active--; }
  private remember(file: string, value: Index) {
    this.indexes.delete(file); this.indexes.set(file, value);
    while (this.indexes.size > 64 || this.indexBytes() > INDEX_BUDGET) this.indexes.delete(this.indexes.keys().next().value!);
  }
  private async *chunks(handle: FileHandle, offset = 0) {
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let position = offset, pending = Buffer.alloc(0), consumed = offset;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) { if (pending.length) yield { bytes: consumed + pending.length, text: pending.toString('utf8') }; return; }
      position += bytesRead;
      const input = pending.length ? Buffer.concat([pending, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
      const end = completePrefix(input);
      pending = Buffer.from(input.subarray(end)); consumed += end;
      if (end) yield { bytes: consumed, text: input.toString('utf8', 0, end) };
    }
  }
  private async index(file: string, handle: FileHandle, version: string): Promise<Index> {
    const cached = this.indexes.get(file);
    if (cached?.signature === version) { this.remember(file, cached); return cached; }
    const key = `${file}\0${version}`, building = this.builds.get(key);
    if (building) return building;
    const promise = (async () => {
      const points: Checkpoint[] = [{ bytes: 0, characters: 0 }]; let totalCharacters = 0;
      for await (const chunk of this.chunks(handle)) {
        totalCharacters += chunk.text.length;
        points.push({ bytes: chunk.bytes, characters: totalCharacters });
      }
      if (signature(await handle.stat()) !== version) throw new BrowserError('RESULT_CHANGED', '结果文件在读取期间发生变化，请重新读取；不要重跑浏览器操作。');
      const result = { signature: version, points, totalCharacters }; this.remember(file, result); return result;
    })();
    this.builds.set(key, promise);
    try { return await promise; } finally { this.builds.delete(key); }
  }
  async read(file: string, offset: number, limit: number) {
    await this.permit(); let handle: FileHandle | undefined;
    try {
      handle = await open(file, 'r'); const version = signature(await handle.stat());
      const index = await this.index(file, handle, version);
      let low = 0, high = index.points.length - 1;
      while (low < high) { const middle = Math.ceil((low + high) / 2); if (index.points[middle]!.characters <= offset) low = middle; else high = middle - 1; }
      const point = index.points[low]!; let characters = point.characters, text = '';
      if (offset < index.totalCharacters) for await (const chunk of this.chunks(handle, point.bytes)) {
        const start = Math.max(0, offset - characters), remaining = limit - text.length;
        if (start < chunk.text.length) text += chunk.text.slice(start, start + remaining);
        characters += chunk.text.length; if (text.length >= limit) break;
      }
      if (signature(await handle.stat()) !== version) throw new BrowserError('RESULT_CHANGED', '结果文件在读取期间发生变化，请重新读取。');
      return { text, totalCharacters: index.totalCharacters, nextOffset: offset + limit < index.totalCharacters ? offset + limit : null };
    } finally { try { await handle?.close(); } finally { this.release(); } }
  }
  forget(file: string) { this.indexes.delete(file); }
}
