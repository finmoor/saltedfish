import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultRouteAddress, LAN_PORT, resolveInstallNetwork, type InstallNetworkOptions } from '../src/install-network.js';

const options = (patch: Partial<InstallNetworkOptions> = {}): InstallNetworkOptions => ({ platform: 'linux', firstInstall: true, local: false, allowInsecureLan: false, detect: async () => '192.168.1.10', ...patch });
const lanArgs = (host: string, port: string) => ['--host', host, '--url', `http://${host}:${port}`, '--allow-insecure-lan'];

test('Linux 首次安装不带参数：监听默认路由的内网 IP，端口 18445，生成服务地址', async () => {
  assert.deepEqual(await resolveInstallNetwork(options()), { port: LAN_PORT, serviceUrl: 'http://192.168.1.10:18445', networkArgs: lanArgs('192.168.1.10', '18445') });
  assert.equal(LAN_PORT, '18445');
});

test('只给 --port 时沿用自动探测的内网 IP', async () => {
  const result = await resolveInstallNetwork(options({ port: '19000' }));
  assert.equal(result.serviceUrl, 'http://192.168.1.10:19000'); assert.deepEqual(result.networkArgs, lanArgs('192.168.1.10', '19000'));
});

test('--host 给私网 IP 时，地址和明文开关由 host 推出', async () => {
  const detect = async () => { throw new Error('给了 --host 不应再探测'); };
  assert.deepEqual((await resolveInstallNetwork(options({ platform: 'win32', host: '10.0.0.8', detect }))).networkArgs, lanArgs('10.0.0.8', '18445'));
  assert.deepEqual((await resolveInstallNetwork(options({ host: '10.0.0.8', url: 'http://10.0.0.8:18445', allowInsecureLan: true, port: '18445', detect }))).networkArgs, lanArgs('10.0.0.8', '18445'));
});

test('探测到公网地址或探测失败时拒绝，不回退到明文', async () => {
  await assert.rejects(resolveInstallNetwork(options({ detect: async () => '203.0.113.10' })), /不是私网 IP.*--cert/);
  await assert.rejects(resolveInstallNetwork(options({ detect: async () => '100.111.98.75' })), /不是私网 IP/);
  await assert.rejects(resolveInstallNetwork(options({ detect: async () => undefined })), /没有找到默认路由.*--local/);
});

test('显式公网 host 不会被自动开启明文，交给服务端校验', async () => {
  assert.deepEqual(await resolveInstallNetwork(options({ host: '1.1.1.1', url: 'http://1.1.1.1:18445' })), { port: undefined, networkArgs: ['--host', '1.1.1.1', '--url', 'http://1.1.1.1:18445'] });
  for (const host of ['0.0.0.0', '1.1.1.1']) await assert.rejects(resolveInstallNetwork(options({ host })), /不是私网 IP.*--cert/);
});

test('--local、已有安装以及 Windows、macOS 默认保持本机模式，不探测', async () => {
  const detect = async () => { throw new Error('不应探测'); };
  assert.deepEqual(await resolveInstallNetwork(options({ local: true, port: '17500', detect })), { port: '17500', networkArgs: [] });
  assert.deepEqual(await resolveInstallNetwork(options({ firstInstall: false, detect })), { port: undefined, networkArgs: [] });
  for (const platform of ['win32', 'darwin'] as const) assert.deepEqual(await resolveInstallNetwork(options({ platform, detect })), { port: undefined, networkArgs: [] });
});

test('--local 与网络选项互斥', async () => {
  for (const patch of [{ host: '10.0.0.8' }, { url: 'http://10.0.0.8:1' }, { cert: 'a.pem' }, { localPort: '19000' }, { allowInsecureLan: true }]) await assert.rejects(resolveInstallNetwork(options({ local: true, ...patch })), /--local 不能和/);
});

test('TLS 参数原样交给服务端校验，不推导地址', async () => {
  const result = await resolveInstallNetwork(options({ host: '10.0.0.8', url: 'https://browser.example.com:18445', cert: 'a.pem', key: 'b.pem', port: '18445' }));
  assert.deepEqual(result, { port: '18445', networkArgs: ['--host', '10.0.0.8', '--url', 'https://browser.example.com:18445', '--cert', 'a.pem', '--key', 'b.pem'] });
});

test('默认路由探测不发包也不抛错', async () => {
  const address = await defaultRouteAddress();
  assert.ok(address === undefined || /^\d+\.\d+\.\d+\.\d+$/.test(address));
});

test('已有内网监听的安装上 --local 显式改成只监听本机，不再静默无效', async () => {
  const detect = async () => { throw new Error('不应探测'); };
  const result = await resolveInstallNetwork(options({ local: true, firstInstall: false, detect, current: { host: '192.168.1.10', port: 18445 } }));
  assert.deepEqual(result.networkArgs, ['--host', '127.0.0.1', '--url', 'http://127.0.0.1:18445']);
  assert.equal(result.serviceUrl, undefined); assert.match(result.note ?? '', /只监听本机/);
  for (const host of ['127.0.0.1', 'localhost', undefined]) assert.deepEqual((await resolveInstallNetwork(options({ local: true, firstInstall: false, detect, current: { host, port: 17422 } }))).networkArgs, [], '已经是本机就不动');
  await assert.rejects(resolveInstallNetwork(options({ local: true, firstInstall: false, detect, current: { host: '192.168.1.10' } })), /读不到它的端口/);
});

test('--local 生成的参数是 configure-server 接受的回环配置（服务端校验与 configureServer 相同）', async () => {
  const { serverOptions } = await import('../src/service-config.js'), { ConfigSchema } = await import('../src/config.js'), { serviceNetwork } = await import('../src/service-network.js');
  const port = 18490, base = { port, token: 'x'.repeat(64), directConnections: true };
  const result = await resolveInstallNetwork(options({ local: true, firstInstall: false, current: { host: '192.168.1.10', port } }));
  const values = serverOptions(result.networkArgs), parsed = ConfigSchema.safeParse({ ...base, network: { host: values['--host']!, publicUrl: values['--url']! } });
  assert.ok(parsed.success, parsed.error?.issues[0]?.message);
  assert.equal(parsed.data.network?.host, '127.0.0.1'); assert.equal(parsed.data.network?.allowInsecureLan, undefined);
  assert.doesNotThrow(() => serviceNetwork({ ...parsed.data, dataDir: '.' }));
});
