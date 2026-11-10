import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { projectDir } from '../src/config.js';
import { testDirectory } from './helpers.js';

// U25：原生 install / rollback / uninstall 共用按安装根目录取的互斥。用 Windows PowerShell 5 跑（脚本要求兼容它），只在 Windows 上有意义。
const packaging = path.join(projectDir, 'packaging'), common = path.join(packaging, 'common.ps1');
const shell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const run = (args: string[]) => spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const probe = (root: string) => run(['-Command', `. ${quote(common)}; try { $m = Enter-InstallLock ${quote(root)}; Exit-InstallLock $m; 'ACQUIRED' } catch { 'BUSY' }`]).stdout.trim();

// 在另一个进程里持有互斥，直到被结束。
async function holder(root: string) {
  const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `. ${quote(common)}; $m = Enter-InstallLock ${quote(root)}; 'HELD'; Start-Sleep -Seconds 120`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.stdout.on('data', chunk => { if (String(chunk).includes('HELD')) resolve(); }); child.once('exit', () => reject(new Error('持有进程提前退出'))); });
  return { stop: () => new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill(); }) };
}

test('安装级互斥：同一根目录（大小写、尾部斜杠不同）第二个拿不到，换目录不受影响，持有者退出后可立即接手', { skip: process.platform !== 'win32' || !existsSync(shell) }, async () => {
  const temp = await testDirectory(), root = path.join(temp.directory, 'Install Root');
  try {
    assert.equal(probe(root), 'ACQUIRED', '没人持有时能取到，且释放后可再取');
    const held = await holder(root);
    try {
      assert.equal(probe(root), 'BUSY');
      assert.equal(probe(root.toUpperCase() + '\\'), 'BUSY', '按规范化后的根目录判断');
      assert.equal(probe(path.join(temp.directory, 'Other Root')), 'ACQUIRED');
    } finally { await held.stop(); }
    assert.equal(probe(root), 'ACQUIRED', '持有进程被强杀后可以接手');
  } finally { await temp.cleanup(); }
});

test('安装级互斥：被占用时 install.ps1、rollback.ps1、uninstall.ps1 在动任何东西之前直接拒绝，不进入失败恢复', { skip: process.platform !== 'win32' || !existsSync(shell) }, async () => {
  const temp = await testDirectory(), root = path.join(temp.directory, 'Install Root'), fresh = path.join(temp.directory, 'Fresh Root');
  try {
    // 一个假的原生安装目录：只有标记和 common.ps1，足够让 rollback、uninstall 走到取锁那一步。
    await mkdir(root); await writeFile(path.join(root, 'installation.json'), '{"product":"feng-chrome-mcp"}'); await copyFile(common, path.join(root, 'common.ps1'));
    await mkdir(path.join(root, '.staging', 'other-transaction'), { recursive: true });
    await writeFile(path.join(root, 'active-version.txt'), '0.0.1'); await writeFile(path.join(root, 'previous-version.txt'), '0.0.0');
    const before = JSON.stringify(await readdir(root, { recursive: true }));
    const held = await holder(root), heldFresh = await holder(fresh);
    try {
      for (const [script, args, target] of [['rollback.ps1', ['-InstallRoot', root], root], ['uninstall.ps1', ['-InstallRoot', root], root], ['install.ps1', ['-InstallRoot', fresh, '-NoStart', '-NoOnboarding'], fresh]] as const) {
        const result = run(['-File', path.join(packaging, script), ...args]);
        assert.notEqual(result.status, 0, `${script} 应被拒绝`);
        assert.ok((result.stderr + result.stdout).replace(/\s+/g, '').includes(target.replace(/\s+/g, '')), `${script} 的失败原因应是安装锁（消息里带安装目录）：${result.stderr}`);
      }
      assert.equal(JSON.stringify(await readdir(root, { recursive: true })), before, '别人的 .staging 和安装目录原样保留');
      assert.ok(!existsSync(path.join(fresh, 'installation.json')), 'install.ps1 没有写任何文件');
    } finally { await held.stop(); await heldFresh.stop(); }
  } finally { await temp.cleanup(); }
});
