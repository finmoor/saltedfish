import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ResultReader } from '../src/result-reader.js';
import { testDirectory } from './helpers.js';

test('结果分页保持UTF-16语义，跨UTF-8块/代理对/损坏尾字节仍与原slice一致', async () => {
  const temp = await testDirectory(), reader = new ResultReader(), file = path.join(temp.directory, 'result.json');
  try {
    for (const buffer of [Buffer.from('中😀a'.repeat(40000)), Buffer.concat([Buffer.from('x'.repeat(65535)),Buffer.from([0xe4,0xb8,0xad,0xf0,0x9f,0x98,0x80,0xe4,0xb8])])]) {
      await writeFile(file, buffer); const expected = buffer.toString('utf8');
      for (const offset of [0,1,2,3,16382,32767,65533,65534,65535,65536,expected.length-1,expected.length+20]) {
        const actual = await reader.read(file, offset, 127);
        assert.equal(actual.text, expected.slice(offset,offset+127)); assert.equal(actual.totalCharacters,expected.length);
      }
    }
    await unlink(file); await assert.rejects(reader.read(file,0,10),{code:'ENOENT'});
    assert.equal(reader.stats().resultReaders,0); assert.equal(reader.stats().resultReadQueue,0);
  } finally { await temp.cleanup(); }
});

test('大结果小页并发读取不保留正文，缓存索引有界且文件变化会失效', async () => {
  const temp = await testDirectory(), reader = new ResultReader(), file = path.join(temp.directory,'large.json');
  try {
    const expected = '中😀'.repeat(2 * 1024 * 1024);
    await writeFile(file,expected);
    const pages = await Promise.all(Array.from({length:16},(_,i)=>reader.read(file,expected.length-2000+i,256)));
    pages.forEach((page,i)=>assert.equal(page.text,expected.slice(expected.length-2000+i,expected.length-2000+i+256)));
    assert.ok(reader.stats().resultIndexBytes < 64 * 1024); assert.equal(reader.stats().resultReaders,0);
    await writeFile(file,'新的内容'); assert.equal((await reader.read(file,0,256)).text,'新的内容');
  } finally { await temp.cleanup(); }
});
