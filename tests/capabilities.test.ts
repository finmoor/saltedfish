import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { projectDir } from '../src/config.js';
import { CAPABILITY, EXTENSION_CAPABILITIES, EXTENSION_REQUIRES_SERVER, SERVER_CAPABILITIES, REQUIRED_EXTENSION_CAPABILITY } from '../src/shared.js';
import { FAKE_CAPABILITIES } from './helpers.js';

// 能力名是扩展与服务之间的协议字面量。单一事实源在 src/shared.ts：扩展声明、服务公布、两端的最低要求和测试替身都从那里派生。
const all: string[] = Object.values(CAPABILITY);
const read = (file: string) => readFile(path.join(projectDir, file), 'utf8');

test('能力表自洽：无重复、只含已登记的名称、两端的最低要求互相覆盖、不超过握手上限', () => {
  assert.equal(new Set(all).size, all.length);
  for (const list of [EXTENSION_CAPABILITIES, EXTENSION_REQUIRES_SERVER, SERVER_CAPABILITIES]) {
    assert.equal(new Set(list).size, list.length);
    for (const name of list) assert.ok(all.includes(name), name);
  }
  for (const name of EXTENSION_REQUIRES_SERVER) assert.ok(SERVER_CAPABILITIES.includes(name), `扩展要求的 ${name} 服务必须公布`);
  assert.ok(EXTENSION_CAPABILITIES.includes(REQUIRED_EXTENSION_CAPABILITY), '管理页据以提示刷新的最低能力，扩展必须声明');
  // src/http-server.ts 的 BridgeProfile：最多 30 项，每项最长 100 字符。
  assert.ok(EXTENSION_CAPABILITIES.length <= 30); for (const name of all) assert.ok(name.length <= 100);
});

test('interaction-v6（修饰键与元素定位滚轮）只由扩展声明：服务只在请求用到它时才要求，不抬高两端的最低要求', () => {
  assert.ok(EXTENSION_CAPABILITIES.includes(CAPABILITY.interactionV6));
  assert.ok(!EXTENSION_REQUIRES_SERVER.includes(CAPABILITY.interactionV6) && !SERVER_CAPABILITIES.includes(CAPABILITY.interactionV6));
  assert.notEqual(REQUIRED_EXTENSION_CAPABILITY, CAPABILITY.interactionV6);
  assert.equal(REQUIRED_EXTENSION_CAPABILITY, CAPABILITY.interactionV5, '管理页的“需要刷新扩展”基线保持 interaction-v5');
});

test('握手线上内容保持：服务公布的能力与此前版本逐项相同（含仓库内已无消费方、为更早扩展保留的 execution-v2）', () => {
  assert.deepEqual([...SERVER_CAPABILITIES], ['execution-v2', 'execution-v3', 'interaction-v4', 'interaction-v5', 'admin-origin-v1']);
  assert.deepEqual([...EXTENSION_REQUIRES_SERVER], ['execution-v3', 'interaction-v4', 'interaction-v5', 'admin-origin-v1']);
});

test('真实扩展后台使用这张表，自己不再手写能力字符串', async () => {
  const source = await read('extension/background.ts');
  assert.ok(source.includes('EXTENSION_CAPABILITIES') && source.includes('EXTENSION_REQUIRES_SERVER'));
  for (const name of all) assert.ok(!source.includes(`'${name}'`) && !source.includes(`"${name}"`), `background.ts 不应手写 '${name}'`);
});

test('测试替身：假扩展 = 真扩展的声明去掉三项有意缺省的能力（dialog-control 需要的用例自己加；activity 无消费方；tab-groups 要真的 Chrome）', () => {
  assert.deepEqual(FAKE_CAPABILITIES, EXTENSION_CAPABILITIES.filter(name => name !== CAPABILITY.dialogControl && name !== CAPABILITY.activity && name !== CAPABILITY.tabGroupsV1));
});

test('源码里没有手写的能力字符串：只有 shared.ts 定义；浏览器端 ui/app.js 的 pause-control 字面量与表一致', async () => {
  // 服务端（service/broker/http-server）与扩展都已改为引用 CAPABILITY / SERVER_CAPABILITIES / REQUIRED_EXTENSION_CAPABILITY；新增的手写位置会让本用例失败。
  const files: string[] = [];
  for (const directory of ['src', 'extension']) for (const name of await readdir(path.join(projectDir, directory))) if (name.endsWith('.ts')) files.push(`${directory}/${name}`);
  const literal = new RegExp(`['"\`](?:${all.map(name => name.replace(/[-]/g, '\\-')).join('|')})['"\`]`);
  const offenders: string[] = [];
  for (const file of files) {
    if (file === 'src/shared.ts') continue;
    if (literal.test(await read(file))) offenders.push(file);
  }
  assert.deepEqual(offenders, [], '这些文件手写了能力名，请改为引用 src/shared.ts 的 CAPABILITY');
  assert.ok((await read('ui/app.js')).includes(`'${CAPABILITY.pauseControl}'`), 'ui/app.js 以字符串引用 pause-control（浏览器端脚本不能导入 TS 模块）');
});
