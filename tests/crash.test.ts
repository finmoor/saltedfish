import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectDir, type Config } from '../src/config.js';
import { startServer } from '../src/http-server.js';
import { callService } from '../src/mcp.js';
import { fakeProfile, freePort, testDirectory } from './helpers.js';

test('强杀正在执行写操作的服务后，重启保留未知结果且不重放', async t => {
  const temp = await testDirectory();
  const config: Config = { port: await freePort(), token: randomBytes(32).toString('hex'), dataDir: temp.directory, outputLimit: 24000, eventLimit: 100 };
  await writeFile(path.join(temp.directory, 'config.json'), JSON.stringify(config));
  const child = spawn(process.execPath, [path.join(projectDir, 'dist', 'cli.js'), 'serve'], { env: { ...process.env, CHROME_MCP_DATA_DIR: temp.directory }, windowsHide: true, stdio: 'ignore' });
  let restarted: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => { if (child.exitCode === null && !child.killed) child.kill(); await restarted?.close(); await temp.cleanup(); });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${config.port}/health`)).ok) break; } catch { /* 等待测试子进程监听。 */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  let dispatched!: () => void; const sent = new Promise<void>(resolve => { dispatched = resolve; });
  const first = await fakeProfile(config, 'A', async () => { dispatched(); return new Promise(() => {}); });
  const target = { profileId: first.id, tabId: 7 };
  const request = callService(config, 'chrome_evaluate', { ...target, expression: 'submit()' }, 'owner').catch(error => error);
  await sent;
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; await request;
  restarted = await startServer(config);
  let calls = 0;
  await fakeProfile(config, 'A', command => { if (command.operation === 'page.evaluate') calls++; return {}; }, first.id);
  const blocked = await restarted.service.invoke('chrome_evaluate', { ...target, expression: 'submit()' }, 'owner');
  assert.equal(blocked.error?.code, 'RESULT_UNKNOWN'); assert.equal(calls, 0);
  const records = restarted.service.state.list(first.id, 'unknown', 0, 10).items;
  assert.equal(records.length, 1); assert.equal(records[0]?.errorCode, 'SERVICE_RESTARTED');
  await restarted.service.invoke('chrome_recover_operation', { operationId: records[0]!.id, acknowledged: true }, 'owner');
  assert.equal((await restarted.service.invoke('chrome_evaluate', { ...target, expression: '1' }, 'owner')).ok, true);
  assert.equal(calls, 1);
});
