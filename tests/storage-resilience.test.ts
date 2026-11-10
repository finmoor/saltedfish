import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile, rename, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ClientSetup } from '../src/client-setup.js';
import { fixture, fakeProfile, testDirectory } from './helpers.js';
import { startServer } from '../src/http-server.js';
const entry = { command: 'fixture.exe', args: ['mcp'], env: {} };
test('重启后将未登记的结果文件计入额度，不自动删除已有残留', async () => {
  const f = await fixture(); let restarted: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await f.close(); const folder = path.join(f.config.dataDir, 'results'); await mkdir(folder);
    const file = path.join(folder, `${randomUUID()}.png`); await writeFile(file, 'orphan'); f.config.resultByteLimit = 6;
    restarted = await startServer(f.config); const p = await fakeProfile(f.config, 'orphan-test', () => ({ mimeType: 'image/png', data: 'YQ==' }));
    const result = await restarted.service.invoke('chrome_screenshot', { profileId: p.id, tabId: 1 }, 'fixture');
    assert.equal(result.ok, true); assert.equal(result.warnings?.[0]?.code, 'RESULT_STORAGE_FAILED');
    assert.equal(restarted.service.stats().untrackedResultBytes, 6); assert.equal(await readFile(file, 'utf8'), 'orphan'); assert.equal((await readdir(folder)).length, 1);
  } finally { await restarted?.close(); await f.cleanup(); }
});
test('结果元数据写入失败会清理本次临时文件，保持业务成功警告', async () => {
  const f = await fixture(), add = f.service.state.addArtifact.bind(f.service.state);
  try {
    const p = await fakeProfile(f.config, 'storage', () => ({ mimeType: 'image/png', data: 'YQ==' }));
    f.service.state.addArtifact = () => { throw new Error('fixture SQLITE_FULL'); };
    const response = await f.service.invoke('chrome_screenshot', { profileId: p.id, tabId: 1 }, 'fixture');
    assert.equal(response.ok, true); assert.equal(response.warnings?.[0]?.code, 'RESULT_STORAGE_FAILED');
    assert.deepEqual(await readdir(path.join(f.config.dataDir, 'results')), []);
  } finally { f.service.state.addArtifact = add; await f.cleanup(); }
});
test('单条备份损坏或目标配置过大，不影响其他记录的查看与恢复', async () => {
  const f = await fixture(), temp = await testDirectory();
  try {
    const setup = new ClientSetup(f.config, { home: temp.directory, entries: { claude: entry }, verify: async () => ({ tools: 51, profiles: 0 }) });
    const applied = await setup.apply((await setup.preview('claude')).planId);
    const damaged = randomUUID(); await writeFile(path.join(f.config.dataDir, 'setup-backups', `${damaged}.json`), '{');
    const history = await setup.history(); assert.ok(history.find(item => item.changeId === applied.changeId)?.canRestore); assert.equal(history.find(item => item.changeId === damaged)?.canRestore, false);
    assert.ok(applied.changeId); await setup.restore(applied.changeId);
    const next = await setup.apply((await setup.preview('claude')).planId); await writeFile(path.join(temp.directory, '.claude.json'), ' '.repeat(4 * 1024 * 1024 + 1));
    assert.equal((await setup.history()).find(item => item.changeId === next.changeId)?.canRestore, false);
  } finally { await f.cleanup(); await temp.cleanup(); }
});
test('预检期间配置目录被重定向，接入拒绝改写新的实际目标', async () => {
  const f = await fixture(), temp = await testDirectory();
  try {
    const target = path.join(temp.directory, 'target'), moved = path.join(temp.directory, 'moved'), other = path.join(temp.directory, 'other');
    await mkdir(target); await mkdir(other); for (const folder of [target, other]) await writeFile(path.join(folder, 'config.json'), '{}');
    const setup = new ClientSetup(f.config, { home: temp.directory, entries: { claude: entry }, verify: async () => { await rename(target, moved); await symlink(other, target, 'junction'); return { tools: 51, profiles: 0 }; } });
    const preview = await setup.preview('claude', { configPath: path.join(target, 'config.json') });
    await assert.rejects(setup.apply(preview.planId), { code: 'SETUP_TARGET_CHANGED' });
    assert.equal(await readFile(path.join(other, 'config.json'), 'utf8'), '{}'); assert.equal(await readFile(path.join(moved, 'config.json'), 'utf8'), '{}');
  } finally { await f.cleanup(); await temp.cleanup(); }
});
