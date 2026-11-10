import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fixture, fakeProfile, FAKE_CAPABILITIES } from './helpers.js';
import { CAPABILITY, isLocalFileUrl, type WireCommand } from '../src/shared.js';
import { refuseOtherMachine } from '../src/mcp-http.js';

// 2026-11-06 全局评审里主持这组的回归用例：U42、U51、U52、U54、U55、U56、U57。

const fakeResponse = () => {
  let status = 0, body = '';
  let done!: () => void; const ended = new Promise<void>(resolve => { done = resolve; });
  const response: Record<string, unknown> = {
    headersSent: false,
    writeHead(code: number) { status = code; response.headersSent = true; return response; },
    setHeader() { return response; }, getHeader() { return undefined; },
    end(chunk?: string | Buffer) { if (chunk) body += String(chunk); done(); return response; },
    on() { return response; }, once() { return response; }, write() { return true; },
  };
  return { response: response as unknown as ServerResponse, ended, result: () => ({ status, body }) };
};

test('U42：/rpc 和 /mcp 一样只接本机的 Agent；管理员（管理页会话）不受这条限制', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const client = f.service.state.createClient('别的电脑', '*');
  const seen: string[] = [];
  const original = f.service.invoke.bind(f.service);
  (f.service as any).invoke = (name: string, ...rest: unknown[]) => { seen.push(name); return (original as any)(name, ...rest); };
  const post = async (token: string, remoteAddress: string, localAddress: string) => {
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({ name: 'chrome_profiles', args: {}, owner: 'o' }))]), {
      method: 'POST', url: '/rpc', headers: { host: `127.0.0.1:${f.config.port}`, authorization: 'Bearer ' + token, 'content-type': 'application/json' }, socket: { remoteAddress, localAddress },
    }) as unknown as IncomingMessage;
    const reply = fakeResponse();
    f.server.emit('request', request, reply.response);
    await reply.ended;
    return reply.result();
  };
  const remote = await post(client.token, '192.168.1.20', '192.168.1.10');
  assert.equal(remote.status, 403, remote.body); assert.equal(JSON.parse(remote.body).error, 'MCP_LOCAL_ONLY');
  assert.deepEqual(seen, [], '没有调用工具');
  const local = await post(client.token, '127.0.0.1', '127.0.0.1');
  assert.equal(local.status, 200, local.body); assert.deepEqual(seen, ['chrome_profiles']);
  const admin = await post(f.config.token, '192.168.1.20', '192.168.1.10');
  assert.equal(admin.status, 200, admin.body);
  // 辅助函数本身：本机放行、不写响应。
  const reply = fakeResponse();
  assert.equal(refuseOtherMachine({ socket: { remoteAddress: '::ffff:127.0.0.1', localAddress: '::ffff:127.0.0.1' } } as unknown as IncomingMessage, reply.response), false);
});

test('U55：非管理员不能让浏览器打开 file: 网址（导航、新标签页、下载、批次、原始 CDP），管理员可以', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const seen: WireCommand[] = [];
  const profile = await fakeProfile(f.config, 'A', command => { seen.push(command); return command.operation === 'tabs.create' ? { tabId: 9, url: '' } : {}; });
  const principal = f.service.state.authenticate(f.service.state.createClient('受限', [profile.id]).token)!;
  const target = { profileId: profile.id, tabId: 1 };
  const secret = 'file:///C:/Users/someone/AppData/Local/SaltedFish/data/config.json';
  for (const [name, args] of [
    ['chrome_navigate', { ...target, url: secret }],
    ['chrome_navigate', { ...target, url: 'view-source:' + secret }],
    ['chrome_new_tab', { profileId: profile.id, url: 'FILE:///etc/passwd' }],
    ['chrome_download', { profileId: profile.id, url: secret }],
    ['chrome_batch', { ...target, steps: [{ operation: 'page.navigate', args: { url: secret } }] }],
    ['chrome_cdp', { ...target, method: 'Page.navigate', params: { url: secret } }],
    ['chrome_cdp', { ...target, method: 'Network.loadNetworkResource', params: { frameId: 'x', url: secret, options: { disableCache: true, includeCredentials: false } } }],
    ['chrome_cdp', { ...target, method: 'Target.createTarget', params: { url: secret } }],
  ] as const) {
    const result = await f.service.invoke(name, args, 'o', principal);
    assert.equal(result.error?.code, 'FILE_URL_NOT_ALLOWED', `${name} ${JSON.stringify(result.error)}`);
    assert.equal(result.error?.outcome, 'not_dispatched');
  }
  assert.equal(seen.length, 0, '一条也没有派发');
  assert.equal(isLocalFileUrl('  file:///x'), true); assert.equal(isLocalFileUrl('https://example.com/file:x'), false); assert.equal(isLocalFileUrl('filesystem:file:///x'), true);
  const admin = await f.service.invoke('chrome_new_tab', { profileId: profile.id, url: 'file:///C:/x.txt' }, 'admin');
  assert.equal(admin.ok, true, JSON.stringify(admin.error));
});

test('U54：扩展缺 dialog-control 时 chrome_dialog 在派发前拒绝，不走通用派发', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const seen: WireCommand[] = [];
  const profile = await fakeProfile(f.config, 'A', command => { seen.push(command); return {}; });
  const result = await f.service.invoke('chrome_dialog', { profileId: profile.id, tabId: 1, accept: true }, 'o');
  assert.equal(result.error?.code, 'EXTENSION_UPDATE_REQUIRED', JSON.stringify(result.error));
  assert.equal(result.error?.outcome, 'not_dispatched');
  assert.equal(seen.filter(command => command.operation === 'page.dialog').length, 0);
});

test('U57：批次里 readOnly 的 evaluate、wait 也要求 read-only-eval-v1', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const seen: WireCommand[] = [];
  const profile = await fakeProfile(f.config, 'A', command => { seen.push(command); return {}; }, undefined, { capabilities: FAKE_CAPABILITIES.filter(name => name !== CAPABILITY.readOnlyEvalV1) });
  for (const operation of ['page.evaluate', 'page.wait']) {
    const result = await f.service.invoke('chrome_batch', { profileId: profile.id, tabId: 1, steps: [{ operation, args: { expression: 'document.title', readOnly: true } }] }, 'o');
    assert.equal(result.error?.code, 'EXTENSION_UPDATE_REQUIRED', `${operation} ${JSON.stringify(result.error)}`);
  }
  assert.equal(seen.filter(command => command.operation === 'page.batch' || command.operation.startsWith('page.')).length, 0);
});

test('U52：被“上一条结果未确认”挡下的调用是未派发；旧操作的保护还在', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const seen: WireCommand[] = [];
  const profile = await fakeProfile(f.config, 'A', command => { seen.push(command); return {}; });
  const previous = f.service.state.begin(profile.id, 1, 'earlier', 'chrome_action'); f.service.state.finish(previous, 'unknown', 'CONNECTION_LOST');
  const result = await f.service.invoke('chrome_action', { profileId: profile.id, tabId: 1, action: 'click', x: 1, y: 1 }, 'o');
  assert.equal(result.error?.code, 'RESULT_UNKNOWN', JSON.stringify(result.error));
  assert.equal(result.error?.outcome, 'not_dispatched'); assert.equal(result.error?.phase, 'precondition');
  assert.equal(seen.filter(command => command.operation === 'page.action').length, 0);
  assert.equal(f.service.state.hasOpenOperation(profile.id, 1), true, '旧的未知操作仍然挡着这个标签页');
});

test('U51：returnImage:false 时，原图存不下也不回图', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const profile = await fakeProfile(f.config, 'A', command => command.operation === 'page.screenshot' ? { mimeType: 'image/png', data: Buffer.from('png').toString('base64') } : {});
  f.service.config.resultByteLimit = 1;
  const result = await f.service.invoke('chrome_screenshot', { profileId: profile.id, tabId: 1, returnImage: false }, 'o') as any;
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.image, undefined, '不回图');
  assert.equal(result.data?.saved, false);
  assert.ok(result.warnings?.some((warning: any) => warning.code === 'RESULT_STORAGE_FAILED'));
  const withImage = await f.service.invoke('chrome_screenshot', { profileId: profile.id, tabId: 1 }, 'o') as any;
  assert.ok(withImage.image, '默认仍回图');
});

test('U56：上传预检期间同一配置重连，不把上传发给新连接', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const first: WireCommand[] = [], second: WireCommand[] = [];
  const profile = await fakeProfile(f.config, 'A', command => { first.push(command); return {}; });
  const file = path.join(f.config.dataDir, '..', path.basename(f.config.dataDir) + '-upload.txt'); await writeFile(file, 'x'); t.after(() => import('node:fs/promises').then(fs => fs.rm(file, { force: true })));
  const check = (f.service as any).checkFiles.bind(f.service);
  (f.service as any).checkFiles = async (...input: unknown[]) => {
    await check(...input);
    profile.socket.close();
    await new Promise(resolve => setTimeout(resolve, 100));
    await fakeProfile(f.config, 'A', command => { second.push(command); return {}; }, profile.id);
  };
  const result = await f.service.invoke('chrome_upload', { profileId: profile.id, tabId: 1, selector: '#f', paths: [file] }, 'o');
  assert.equal(result.error?.code, 'CONNECTION_CHANGED', JSON.stringify(result.error));
  assert.equal(result.error?.outcome, 'not_dispatched');
  assert.equal([...first, ...second].filter(command => command.operation === 'page.upload').length, 0);
});
