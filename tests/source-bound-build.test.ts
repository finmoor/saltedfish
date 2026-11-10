import test from 'node:test';
import assert from 'node:assert/strict';

const { sourceBoundBuild } = await import(new URL('../scripts/source-bound-build.mjs', import.meta.url).href);

test('构建前固定源码指纹，构建或打包中变更不能登记旧字节候选', async () => {
  for (const changedAt of ['build', 'pack', 'unchanged']) {
    let source = 'before', packed = false, committed = false;
    const work = sourceBoundBuild({
      fingerprint: async () => source,
      build: async () => { if (changedAt === 'build') source = 'after'; },
      pack: async (fingerprint: string) => { packed = true; if (changedAt === 'pack') source = 'after'; return { fingerprint, bytes: 'built-from-before' }; },
      commit: async (record: { fingerprint: string; bytes: string }) => { assert.equal(record.fingerprint, 'before'); assert.equal(record.bytes, 'built-from-before'); committed = true; },
    });
    if (changedAt === 'unchanged') { await work; assert.equal(committed, true); }
    else { await assert.rejects(work, /源码变化/); assert.equal(committed, false); }
    assert.equal(packed, changedAt !== 'build');
  }
});
