import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { compareVersions, installPrefix, registryVersion } from '../src/npm-update.js';

const { compareVersions: releaseCompare } = await import(new URL('../scripts/release-evidence.mjs', import.meta.url).href);

test('版本比较和发行脚本的规则一致', () => {
  const versions = ['0.3.0-beta.9', '0.3.0-beta.10', '0.3.0-beta.14', '0.3.0-beta.14.upgrade-test', '0.3.0-beta.15', '0.3.0-beta.19', '0.3.0', '0.3.1-beta.1', '0.3.19', '0.3.20', '1.0.0'];
  for (const a of versions) for (const b of versions) assert.equal(compareVersions(a, b), releaseCompare(a, b), `${a} 对 ${b}`);
  assert.equal(compareVersions('0.3.0-beta.10', '0.3.0-beta.9'), 1, '按数字比，不按字符串');
  assert.equal(compareVersions('0.3.0', '0.3.0-beta.14'), 1, '正式版比测试版新');
  // 0.3.19 起服务和扩展同一个版本号：upgrade 要把它当成 0.3.0-beta.19 之后的新版
  assert.equal(compareVersions('0.3.19', '0.3.0-beta.19'), 1);
  assert.equal(compareVersions('0.3.20', '0.3.19'), 1);
});

test('新包装回运行命令的那个全局目录；不在 node_modules 下就不下载', () => {
  assert.equal(installPrefix('/root/.nvm/versions/node/v24/lib/node_modules/saltedfish', 'linux'), '/root/.nvm/versions/node/v24');
  assert.equal(installPrefix('C:/nvm/.nodejs/node_modules/saltedfish', 'win32'), 'C:/nvm/.nodejs');
  assert.equal(installPrefix('/repo/chrome-mcp', 'linux'), undefined);
});

const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
test('查版本用包里写的标签，地址结尾有没有斜杠都行', async () => {
  const seen: string[] = [];
  const request = (async (url: URL) => { seen.push(String(url)); return new Response(JSON.stringify({ 'dist-tags': { beta: '0.3.0-beta.15', latest: '0.3.0-beta.14' } })); }) as unknown as typeof fetch;
  assert.equal(await registryVersion('http://192.168.1.10:4873', 'beta', request), '0.3.0-beta.15');
  assert.equal(await registryVersion('http://192.168.1.10:4873/', 'latest', request), '0.3.0-beta.14');
  assert.deepEqual(seen, ['http://192.168.1.10:4873/saltedfish', 'http://192.168.1.10:4873/saltedfish']);
});

test('仓库出错或没有这个标签时报原因', async () => {
  await assert.rejects(registryVersion('http://registry.test', 'beta', respond(503, {})), /HTTP 503/);
  await assert.rejects(registryVersion('http://registry.test', 'beta', respond(200, { 'dist-tags': { latest: '1.0.0' } })), /没有 beta 版本/);
});
