import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { projectDir } from '../src/config.js';
import { testDirectory } from './helpers.js';
import { withManagementMutex } from '../src/management-lock.js';
import { recoverLock, withLock } from '../src/npm-runtime.js';

const busy = /另一个安装或恢复操作仍在进行/;

test('管理互斥：持有期间第二个请求立即被拒绝且不执行工作；正常结束或抛错后都会释放', async () => {
  const temp = await testDirectory();
  try {
    let inner = 0;
    const value = await withManagementMutex(temp.directory, async () => {
      await assert.rejects(withManagementMutex(temp.directory, async () => { inner++; }), busy);
      return 'held';
    });
    assert.equal(value, 'held'); assert.equal(inner, 0, '被拒绝的请求不能执行任何工作');
    assert.equal(await withManagementMutex(temp.directory, async () => 'released'), 'released');
    await assert.rejects(withManagementMutex(temp.directory, async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await withManagementMutex(temp.directory, async () => 'released after failure'), 'released after failure');
  } finally { await temp.cleanup(); }
});

test('另一个进程持有管理互斥时，recover-lock 与安装/升级入口都被拒绝，进程被强杀后立即可再次获取', async () => {
  const temp = await testDirectory(), module = pathToFileURL(path.join(projectDir, 'src/management-lock.ts')).href;
  const code = `const {withManagementMutex}=await import(${JSON.stringify(module)});await withManagementMutex(${JSON.stringify(temp.directory)},async()=>{console.log('held');await new Promise(()=>setInterval(()=>{},1000));});`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); child.once('exit', () => reject(new Error('lock holder exited before holding the mutex'))); });
    let worked = 0;
    await assert.rejects(withManagementMutex(temp.directory, async () => { worked++; }), busy);
    // recoverLock 与 withLock 都靠这个互斥和正常的安装/启停/升级操作串行；互斥失效时它们会并行执行。
    await assert.rejects(recoverLock(temp.directory), busy);
    await assert.rejects(withLock(temp.directory, async () => { worked++; }), busy);
    assert.equal(worked, 0);
    child.kill(); await closed;
    // 操作系统在进程结束时释放文件锁，不会留下需要人工清理的自旋锁。
    assert.deepEqual(await recoverLock(temp.directory), { recovered: false });
    assert.equal(await withLock(temp.directory, async () => 'ran'), 'ran');
  } finally { child.kill(); await closed; await temp.cleanup(); }
});

test('U47：下载锁与管理锁互相独立；下载进行时第二个下载立即被拒绝并说明，且不影响管理锁', async () => {
  const temp = await testDirectory(), message = '另一个 upgrade 正在下载新版本', download = <T>(work: () => Promise<T>) => withManagementMutex(temp.directory, work, 'download-lock.sqlite', message);
  try {
    let second = 0;
    await download(async () => {
      await assert.rejects(download(async () => { second++; }), new RegExp(message));
      assert.equal(await withManagementMutex(temp.directory, async () => 'management'), 'management', '下载期间管理锁可用（新包接着切换要取它）');
    });
    assert.equal(second, 0);
    await withManagementMutex(temp.directory, async () => { assert.equal(await download(async () => 'download'), 'download'); });
    assert.equal(await download(async () => 'released'), 'released', '结束后释放');
  } finally { await temp.cleanup(); }
});
