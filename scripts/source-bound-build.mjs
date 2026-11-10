import assert from 'node:assert/strict';

// 指纹在构建之前固定。不能用打包结束时的新源码指纹，为此前生成的旧 dist 背书。
export async function sourceBoundBuild({ fingerprint, build, pack, commit }) {
  const expected = await fingerprint();
  await build();
  assert.equal(await fingerprint(), expected, '构建期间源码变化，拒绝生成候选记录');
  const result = await pack(expected);
  assert.equal(await fingerprint(), expected, '复制或打包期间源码变化，候选未登记；请重新构建');
  await commit(result);
  return result;
}
