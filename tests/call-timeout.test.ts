import test from 'node:test';
import assert from 'node:assert/strict';
import { callTimeoutMs } from '../src/mcp.js';

test('传输期限按工具实际耗时算：job_status 的 waitMs 不会被默认 40 秒截断', () => {
  assert.equal(callTimeoutMs('chrome_evaluate', {}), 40000);
  assert.equal(callTimeoutMs('chrome_wait', { timeoutMs: 60000 }), 70000);
  assert.equal(callTimeoutMs('chrome_job_status', {}), 40000);
  assert.ok(callTimeoutMs('chrome_job_status', { waitMs: 60000 }) >= 60000 + 30000);
  assert.ok(callTimeoutMs('chrome_job_status', { waitMs: 300000 }) > 300000);
});
