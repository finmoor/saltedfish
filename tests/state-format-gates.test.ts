import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { databaseStateVersion, assertDatabaseReadable } from '../src/state-compatibility.js';
import { active, recoverLock, saveActive } from '../src/npm-runtime.js';
import { testDirectory } from './helpers.js';
import { projectDir } from '../src/config.js';

test('数据格式核查只读，缺失数据库不创建，高格式拒绝旧目标', async () => {
  const temp = await testDirectory(), file = path.join(temp.directory, 'state.sqlite');
  try {
    assert.equal(await databaseStateVersion(file), 0); await assert.rejects(access(file));
    const db = new DatabaseSync(file); db.exec('CREATE TABLE receipts(id TEXT); INSERT INTO receipts VALUES (\'keep\'); PRAGMA user_version=2'); db.close();
    const before = await readFile(file);
    assert.equal(await databaseStateVersion(file), 2);
    await assert.rejects(assertDatabaseReadable(file, 1), /修复当前版/);
    await assertDatabaseReadable(file, 2);
    assert.deepEqual(await readFile(file), before);
  } finally { await temp.cleanup(); }
});

for (const format of [1, 2, 3]) test(`失败升级按实际数据库格式${format}决定回退、向前完成或保留维护记录，数据库字节不变`, async () => {
  const temp = await testDirectory(), home = temp.directory;
  try {
    for (const folder of ['data/local', 'run', 'logs']) await mkdir(path.join(home, folder), { recursive: true });
    const old = { product: 'saltedfish-npm' as const, version: '0.2.0-beta.20', stateVersion: 1 };
    const next = { ...old, version: '0.2.0-beta.21', previous: old.version, stateVersion: 2 };
    for (const release of [old, next]) {
      const directory = path.join(home, 'versions', release.version), files: Record<string, string> = {};
      for (const name of ['package.json', 'dist/npm-cli.js', 'dist/npm-worker.js', 'dist/cli.js', 'dist/gateway-cli.js', 'dist/extension/manifest.json', 'ui/index.html']) {
        const target = path.join(directory, name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, '{}');
        files[name] = createHash('sha256').update('{}').digest('hex');
      }
      await writeFile(path.join(directory, 'saltedfish-release.json'), JSON.stringify({ ...release, files }));
    }
    // release manifest 不包含 active.previous。
    const nextManifest = path.join(home, 'versions', next.version, 'saltedfish-release.json');
    const manifest = JSON.parse(await readFile(nextManifest, 'utf8')); delete manifest.previous; await writeFile(nextManifest, JSON.stringify(manifest));
    await saveActive(home, next);
    const file = path.join(home, 'data/local/state.sqlite'), db = new DatabaseSync(file);
    db.exec(`CREATE TABLE receipts(id TEXT); INSERT INTO receipts VALUES ('fixture-receipt'); PRAGMA user_version=${format}`); db.close();
    const before = await readFile(file);
    await writeFile(path.join(home, 'maintenance'), JSON.stringify({ schemaVersion: 1, id: randomUUID(), pid: 2147483647, createdAt: new Date().toISOString(), phase: 'starting', before: old, after: next, wasRunning: [] }));
    if (format === 2) {
      // 新版本已把数据库升到格式 2，旧版本读不了：只能向前完成事务，绝不恢复旧任务库来降级，也不能让安装停在维护状态里。
      const recovery = (await recoverLock(home)).maintenance;
      assert.equal(recovery?.state, 'completed_forward');
      assert.equal(recovery?.version, next.version);
      assert.equal((await active(home)).version, next.version);
      await assert.rejects(access(path.join(home, 'maintenance')));
      assert.equal((await recoverLock(home)).recovered, false, '再次恢复是空操作');
    } else if (format === 3) {
      // 数据库比升级前后两个版本支持的格式都新：两边都不安全，fail-closed 并保留维护记录。
      await assert.rejects(recoverLock(home), /数据库格式 3.*支持的 2/);
      assert.equal((await active(home)).version, next.version);
      assert.equal(JSON.parse(await readFile(path.join(home, 'maintenance'), 'utf8')).phase, 'starting');
    } else {
      assert.equal((await recoverLock(home)).maintenance?.state, 'rolled_back');
      assert.equal((await active(home)).version, old.version);
      await assert.rejects(access(path.join(home, 'maintenance')));
    }
    assert.deepEqual(await readFile(file), before);
  } finally { await temp.cleanup(); }
});

test('原生兼容脚本使用同一只读格式门槛', { skip: process.platform !== 'win32' }, async () => {
  const temp = await testDirectory();
  try {
    const version = '0.2.0-beta.21', directory = path.join(temp.directory, 'versions', version, 'runtime');
    await mkdir(directory, { recursive: true }); await copyFile(process.execPath, path.join(directory, 'node.exe'));
    await mkdir(path.join(temp.directory, 'data'));
    const file = path.join(temp.directory, 'data/state.sqlite'), db = new DatabaseSync(file); db.exec('PRAGMA user_version=2'); db.close();
    const before = await readFile(file);
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const run = promisify(execFile), prefix = `. ${quote(path.join(projectDir, 'packaging/common.ps1'))}; Assert-StateCompatible ${quote(temp.directory)} ${quote(version)}`;
    await assert.rejects(run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `$ErrorActionPreference='Stop'; ${prefix} 1`], { windowsHide: true }));
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `$ErrorActionPreference='Stop'; ${prefix} 2`], { windowsHide: true });
    assert.deepEqual(await readFile(file), before);
  } finally { await temp.cleanup(); }
});
