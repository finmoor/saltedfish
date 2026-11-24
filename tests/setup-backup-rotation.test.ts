import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { ClientSetup } from '../src/client-setup.js';
import { testDirectory } from './helpers.js';

// 每次升级都会改写每个已接入客户端的目录版本、各记一份备份。原来满 100 份就拒绝接入，升级十几次后刷新全被挡住。
const entry = { command: 'fixture.exe', args: ['mcp'], env: { CHROME_MCP_TOKEN_FILE: 'private/client.token' } };
const entries = { claude: entry, opencode: entry, codex: entry };
const verify = async () => ({ tools: 51, profiles: 0 });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1) + minute * 60000).toISOString();

async function workspace(run: (context: { home: string; data: string; folder: string }) => Promise<void>) {
  const temp = await testDirectory();
  try {
    const home = path.join(temp.directory, 'home'), data = path.join(temp.directory, 'data');
    await mkdir(home); await mkdir(data);
    // 记录里存的是规范化后的真实路径，合成记录也按它写，否则 restore 前的路径核对会把它当成目标已变。
    await run({ home: await realpath(home), data, folder: path.join(data, 'setup-backups') });
  } finally { await temp.cleanup(); }
}
async function record(folder: string, target: string, createdAt: string, hashes: { before?: string; after?: string } = {}) {
  const id = randomUUID(), before = hashes.before ?? sha('before');
  await writeFile(path.join(folder, `${id}.json`), JSON.stringify({ id, client: 'claude', target, existed: before !== 'missing', beforeHash: before, afterHash: hashes.after ?? sha(randomUUID()), createdAt }));
  if (before !== 'missing') await writeFile(path.join(folder, `${id}.config`), 'before');
  return id;
}
async function saved(folder: string) {
  const files = await readdir(folder), ids = new Set(files.filter(file => file.endsWith('.json')).map(file => file.slice(0, -5)));
  // 删备份时连同 .config、.permissions 一起删，不留孤立的副本。
  assert.deepEqual(files.filter(file => !file.endsWith('.json') && !ids.has(file.replace(/\.(config|permissions)$/, ''))), []);
  return ids;
}

test('升级几十次也不会攒满备份：每个配置文件留原样和最近 5 份，刷新照常、最新一份能恢复', () => workspace(async ({ home, data, folder }) => {
  const claude = path.join(home, '.claude.json'), opencode = path.join(home, '.config/opencode/opencode.json'), original = '{"keep":true}';
  await writeFile(claude, original);
  const first = new ClientSetup({ dataDir: data }, { home, entries, verify, catalogRevision: 'first' });
  for (const client of ['claude', 'opencode', 'codex'] as const) await first.apply((await first.preview(client)).planId);
  // 3 个客户端升级 35 次是 108 份，原来到第 33 次左右就报 SETUP_BACKUP_CAPACITY。
  for (let i = 0; i < 35; i++) {
    const result = await new ClientSetup({ dataDir: data }, { home, entries, verify, catalogRevision: `r${i}` }).refreshCatalogs();
    // 刷新中途的轮换会删掉同一配置文件的旧记录，不能因此报“记录损坏”。
    assert.equal(result.completed.length, 3); assert.deepEqual(result.skipped, [], `第 ${i + 1} 次升级`);
  }
  assert.equal((await saved(folder)).size, 18, '每个配置文件 1 份原样 + 最近 5 份');
  const setup = new ClientSetup({ dataDir: data }, { home, entries, verify, catalogRevision: 'r35' }), history = await setup.history();
  const oldest = history.filter(item => item.target === claude).at(-1)!;
  assert.equal(await readFile(path.join(folder, `${oldest.changeId}.config`), 'utf8'), original, '第一次接入前的原样一直留着');
  const newest = history.find(item => item.target === opencode)!;
  assert.ok(newest.canRestore); await setup.restore(newest.changeId);
  assert.ok((await readFile(opencode, 'utf8')).includes('"r33"'), '恢复到上一次升级写的内容');
  // 轮换不能删掉各配置文件最新的那份：刷新靠它认出用户恢复过，不再自动接回去。
  const after = await setup.refreshCatalogs();
  assert.equal(after.completed.length, 2); assert.deepEqual(after.skipped.map(item => item.target), [opencode]);
  assert.equal((await saved(folder)).size, 18);
}));

test('轮换不删各配置文件最新的一份、眼下还能恢复的和读不出来的，其余超出最近 5 份的删掉', () => workspace(async ({ home, data, folder }) => {
  await mkdir(folder);
  const target = path.join(home, 'settings.json'); await writeFile(target, 'current');
  const ids: string[] = [];
  for (let i = 0; i < 9; i++) ids.push(await record(folder, target, at(i), i === 2 ? { after: sha('current') } : {}));
  const damaged = randomUUID(); await writeFile(path.join(folder, `${damaged}.json`), '{');
  const setup = new ClientSetup({ dataDir: data }, { home, entries, verify });
  await setup.apply((await setup.preview('claude', { configPath: path.join(home, 'new.json') })).planId);
  const kept = await saved(folder);
  // 0 是第一次接入前的原样，2 眼下还能恢复，4–8 是最近 5 份（8 是最新的）。
  assert.deepEqual(ids.map(id => kept.has(id)), [true, false, true, false, true, true, true, true, true]);
  assert.ok(kept.has(damaged), '读不出来的记录看不出属于谁，不自动删');
  assert.equal(kept.size, 9);
}));

test('总数到 100 份时从最旧的删起，仍不删各配置文件最新的一份和眼下还能恢复的', () => workspace(async ({ home, data, folder }) => {
  await mkdir(folder);
  const restorable = path.join(home, 'restorable.json'); await writeFile(restorable, 'current');
  const old = await record(folder, restorable, at(0), { after: sha('current') }), latest = await record(folder, restorable, at(200));
  const damaged = randomUUID(); await writeFile(path.join(folder, `${damaged}.json`), '{');
  // 25 个配置文件各 3–4 份，每个都在“原样 + 最近 5 份”以内，只能按总数删。
  const ids: string[] = [];
  for (let i = 0; i < 97; i++) ids.push(await record(folder, path.join(home, `g${i % 25}.json`), at(1 + i)));
  assert.equal((await saved(folder)).size, 100);
  const setup = new ClientSetup({ dataDir: data }, { home, entries, verify });
  await setup.apply((await setup.preview('claude', { configPath: path.join(home, 'new.json') })).planId);
  const kept = await saved(folder);
  assert.equal(kept.size, 100);
  assert.deepEqual(ids.filter(id => !kept.has(id)), [ids[0]], '只删最旧的那一份');
  for (const id of [old, latest, damaged, ...ids.slice(-25)]) assert.ok(kept.has(id));
}));

test('全是不能自动删的记录时说清备份文件夹在哪，本次不改配置', () => workspace(async ({ home, data, folder }) => {
  await mkdir(folder);
  for (let i = 0; i < 100; i++) await writeFile(path.join(folder, `${randomUUID()}.json`), '{');
  const target = path.join(home, 'new.json'), setup = new ClientSetup({ dataDir: data }, { home, entries, verify });
  const plan = await setup.preview('claude', { configPath: target });
  await assert.rejects(setup.apply(plan.planId), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'SETUP_BACKUP_CAPACITY');
    assert.ok(error.message.includes(folder) && error.message.includes('saltedfish connect --history'), error.message);
    return true;
  });
  await assert.rejects(readFile(target), { code: 'ENOENT' });
  assert.equal((await saved(folder)).size, 100);
}));
