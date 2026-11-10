import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { projectDir } from '../src/config.js';
import { CAPABILITY, EXTENSION_CAPABILITIES, extensionCapabilities } from '../src/shared.js';
import { testDirectory } from './helpers.js';

const run = promisify(execFile);

test('应用商店版扩展的能力：去掉 self-update-v1、加上 store-build，个数不变（服务限 30 个）', () => {
  const store = extensionCapabilities(true), normal = extensionCapabilities(false);
  assert.deepEqual(normal, [...EXTENSION_CAPABILITIES]);
  assert.ok(normal.includes(CAPABILITY.selfUpdateV1)); assert.ok(!normal.includes(CAPABILITY.storeBuild));
  assert.ok(!store.includes(CAPABILITY.selfUpdateV1)); assert.ok(store.includes(CAPABILITY.storeBuild));
  assert.equal(store.length, normal.length); assert.ok(store.length <= 30);
});

test('--store 构建出的扩展没有一键更新的代码，默认构建照旧有', { timeout: 120000 }, async t => {
  const temp = await testDirectory(); t.after(() => temp.cleanup());
  const build = async (dir: string, store: boolean) => {
    await run(process.execPath, ['scripts/build-extension.mjs', ...(store ? ['--store'] : []), '--outdir', dir], { cwd: projectDir, windowsHide: true });
    return { options: await readFile(path.join(dir, 'options.js'), 'utf8'), background: await readFile(path.join(dir, 'background.js'), 'utf8') };
  };
  const store = await build(path.join(temp.directory, 'store'), true), normal = await build(path.join(temp.directory, 'normal'), false);
  for (const word of ['showDirectoryPicker', 'createWritable']) {
    assert.ok(normal.options.includes(word), `默认构建应有 ${word}，否则这个对照没有意义`);
    assert.ok(!store.options.includes(word) && !store.background.includes(word), `商店版不应有 ${word}`);
  }
  assert.match(store.background, /STORE_BUILD = true/); assert.match(normal.background, /STORE_BUILD = false/);
  assert.equal(JSON.parse(await readFile(path.join(temp.directory, 'store', 'pairing.json'), 'utf8')).token, '', '商店版不带配对密钥');
  // 商店版 manifest 只多了本地化：描述和工具栏标题走 _locales，其余和源 manifest 一样
  const source = JSON.parse(await readFile(path.join(projectDir, 'extension/manifest.json'), 'utf8')), built = JSON.parse(await readFile(path.join(temp.directory, 'store', 'manifest.json'), 'utf8'));
  assert.deepEqual(built, { ...source, default_locale: 'en', description: '__MSG_extDescription__', action: { ...source.action, default_title: '__MSG_actionTitle__' } });
  for (const locale of ['en', 'zh_CN']) {
    const messages = JSON.parse(await readFile(path.join(temp.directory, 'store', '_locales', locale, 'messages.json'), 'utf8'));
    assert.ok(messages.extDescription.message.length <= 132, `${locale} 描述超过商店的 132 字上限`); assert.ok(messages.actionTitle.message);
  }
  assert.equal(JSON.parse(await readFile(path.join(temp.directory, 'normal', 'manifest.json'), 'utf8')).default_locale, undefined, '默认版不带 _locales（一键更新只认平铺文件）');
});
