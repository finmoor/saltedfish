import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { VERSION } from '../dist/version.js';

const read = file => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const json = async file => JSON.parse(await read(file));
const pkg = await json('package.json'), lock = await json('package-lock.json');
assert.equal(VERSION, pkg.version, '构建代码版本与 package.json 不一致');
assert.equal(lock.version, pkg.version); assert.equal(lock.packages[''].version, pkg.version);
assert.equal(pkg.name, 'saltedfish'); assert.equal(lock.name, pkg.name); assert.equal(lock.packages[''].name, pkg.name);
for (const file of ['extension/manifest.json', 'dist/extension/manifest.json']) assert.equal((await json(file)).version_name, pkg.version, file);
// 0.3.19 起服务和扩展用同一个版本号；只有 0.3.0-beta.N 这种 Chrome 写不进的旧版本号才另有扩展数值版本。
const unified = !pkg.version.includes('-'), extensionVersion = (await json('extension/manifest.json')).version;
if (unified) for (const file of ['extension/manifest.json', 'dist/extension/manifest.json']) assert.equal((await json(file)).version, pkg.version, `${file} 的 version 要和 package.json 相同`);
for (const file of ['extension/manifest.json', 'dist/extension/manifest.json']) assert.equal((await json(file)).name, 'SaltedFish', file);
assert.match(await read('README.md'), /^# SaltedFish\r?\n/);
assert.ok((await read('ui/index.html')).includes('<title>SaltedFish'));
assert.ok((await read('extension/options.html')).includes('<title>SaltedFish'));
for (const [file, pattern] of [
  ['README.md', /当前版本 \*\*([^*]+)\*\*/],
  ['README.en.md', /Current version: \*\*([^*]+)\*\*/],
]) assert.equal((await read(file)).match(pattern)?.[1], pkg.version, `${file} 的当前版本未更新`);
assert.equal(pkg.license, 'MIT', 'package.json 的 license 应为 MIT');
assert.match(await read('LICENSE'), /^MIT License\r?\n/, 'LICENSE 缺失或不是 MIT');
for (const file of ['README.md', 'docs/npm.md']) {
  for (const match of (await read(file)).matchAll(/saltedfish-(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?:-windows-x64\.zip|\.tgz)/g)) assert.equal(match[1], pkg.version, `${file} 的当前安装命令过时`);
}
if (!unified) assert.ok((await read('README.md')).includes(`扩展数值版本为 **${extensionVersion}**`), 'README 扩展内部版本过时');
console.log(`PASS release version consistency: ${pkg.version}`);
