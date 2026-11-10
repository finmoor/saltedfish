import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { fixture, testDirectory } from './helpers.js';
import { ClientSetup } from '../src/client-setup.js';
const entry = { command: 'fixture.exe', args: ['mcp'], env: {} };
test('UTF-8 BOM 配置可合并并按原字节恢复，保留 JSONC 注释和 CRLF', async () => {
  const f = await fixture(), temp = await testDirectory();
  try {
    const setup = new ClientSetup(f.config, { home: temp.directory, entries: { claude: entry, opencode: entry }, verify: async () => ({ tools: 51, profiles: 0 }) });
    for (const client of ['claude', 'opencode'] as const) {
      const target = path.join(temp.directory, `${client}.json${client === 'opencode' ? 'c' : ''}`);
      const original = '\ufeff{\r\n' + (client === 'opencode' ? ' // 用户注释\r\n' : '') + ' "keep": true\r\n}\r\n'; await writeFile(target, original);
      const result = await setup.apply((await setup.preview(client, { configPath: target })).planId), changed = await readFile(target, 'utf8');
      assert.ok(changed.startsWith('\ufeff')); assert.ok(changed.includes('\r\n')); assert.equal(parse(changed.slice(1)).keep, true);
      if (client === 'opencode') assert.ok(changed.includes('// 用户注释'));
      assert.ok(result.changeId); await setup.restore(result.changeId); assert.deepEqual(await readFile(target), Buffer.from(original));
    }
  } finally { await f.cleanup(); await temp.cleanup(); }
});
test('Windows 配置被其他程序占用，释放后同一预览可重试且只保留一份备份', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture(), temp = await testDirectory(); let locker: ReturnType<typeof spawn> | undefined;
  try {
    const target = path.join(temp.directory, '.claude.json'), original = '{"keep":true}'; await writeFile(target, original);
    const setup = new ClientSetup(f.config, { home: temp.directory, entries: { claude: entry }, verify: async () => ({ tools: 51, profiles: 0 }) });
    const preview = await setup.preview('claude');
    const script = `$s=[IO.File]::Open('${target.replaceAll("'", "''")}','Open','Read','Read'); [Console]::Out.WriteLine('LOCKED'); [Console]::In.ReadLine() | Out-Null; $s.Dispose()`;
    locker = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('Lock fixture timeout')), 10000); locker!.stdout!.on('data', data => { if (String(data).includes('LOCKED')) { clearTimeout(timeout); resolve(); } }); locker!.on('error', error => { clearTimeout(timeout); reject(error); }); });
    await assert.rejects(setup.apply(preview.planId), { code: 'CLIENT_CONFIG_BUSY' }); assert.equal(await readFile(target, 'utf8'), original);
    const exit = once(locker, 'exit'); locker.stdin!.end('\n'); await exit;
    const backup = path.join(f.config.dataDir, 'setup-backups', `${preview.planId}.config`); await writeFile(backup, 'tampered');
    await assert.rejects(setup.apply(preview.planId), { code: 'BACKUP_INVALID' }); assert.equal(await readFile(target, 'utf8'), original); await writeFile(backup, original);
    const applied = await setup.apply(preview.planId); assert.equal((await setup.history()).length, 1);
    assert.ok(applied.changeId); await setup.restore(applied.changeId); assert.equal(await readFile(target, 'utf8'), original);
  } finally { if (locker && locker.exitCode === null) { const exit = once(locker, 'exit'); locker.kill(); await exit; } await f.cleanup(); await temp.cleanup(); }
});
