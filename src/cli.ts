import { spawn } from 'node:child_process';
import { open, mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, projectDir, type Config } from './config.js';
import { startServer } from './http-server.js';
import { callService, runMcp } from './mcp.js';
import { runMcpBridge } from './mcp-bridge.js';
import {copyExtensionFiles,extensionDefaults} from './extension-defaults.js';
import { VERSION, PROTOCOL_VERSION, STATE_VERSION } from './version.js';
import { codexConfig, openCodeConfig, MCP_NAME } from './client-config.js';
import { ClientSetup } from './client-setup.js';
import { clientCredential as sharedCredential, type CredentialStore } from './client-credentials.js';
import { connectClients, connectHelp } from './client-connect.js';
import { clientLaunch } from './client-launch.js';
import { parseDesktopUrl, serviceDashboardLoginUrl } from './desktop-links.js';
import {servicePublicUrl,serviceInternalUrl} from './service-network.js';
import {configureServer} from './service-config.js';
import { registerDesktopLaunch, unregisterDesktopLaunch } from './desktop-registration.js';
import { openDashboard } from './open-dashboard.js';
import { runNativeSettings } from './native-settings.js';
import { registerNativeSettings, unregisterNativeSettings,nativeSettingsReady } from './native-settings-registration.js';

interface Health { service: string; version: string; protocolVersion: number; profiles: number }
async function health(config: Config): Promise<Health | undefined> {
  try {
    const response = await fetch(`${serviceInternalUrl(config)}/health`, { redirect:'error',signal: AbortSignal.timeout(1000) });
    return response.ok ? await response.json() as Health : undefined;
  } catch { return undefined; }
}
async function adminRequest(config: Config, route: string, method = 'GET', value?: unknown) {
  const response = await fetch(`${serviceInternalUrl(config)}${route}`, {
    method, headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }), redirect:'error',signal: AbortSignal.timeout(5000),
  });
  if (response.status === 400) { const reply = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined; if (reply?.error?.message) throw new Error(reply.error.message); }
  if (!response.ok) throw new Error(`管理请求失败（HTTP ${response.status}）。端口可能属于其他安装，未改动其他服务。`);
  return await response.json() as Record<string, unknown>;
}
export async function ensureServer(config: Config) {
  if (!process.env.CHROME_MCP_INSTALLING) {
    try { await access(path.join(config.dataDir, 'maintenance')); throw new Error('正在安装或回滚，请稍后重新连接 MCP。'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const existing = await health(config);
  if (existing) {
    if (existing.service !== 'feng-chrome-mcp' || existing.version !== VERSION) throw new Error(`端口上运行 ${existing.service} ${existing.version}，当前客户端为 ${VERSION}。请从同一安装目录升级或停止旧服务，不会自动覆盖它。`);
    await adminRequest(config, '/clients'); return;
  }
  if (process.env.SALTEDFISH_MANAGED === '1') throw new Error('SaltedFish 托管服务离线，请先运行 saltedfish start；此次不会启动另一套服务。');
  await mkdir(config.dataDir, { recursive: true });
  const output = await open(path.join(config.dataDir, 'service.log'), 'a');
  try {
    const child = spawn(process.execPath, [path.join(projectDir, 'dist', 'cli.js'), 'serve'], {
      cwd: projectDir, env: { ...process.env, CHROME_MCP_DATA_DIR: config.dataDir },
      detached: true, windowsHide: true, stdio: ['ignore', output.fd, output.fd],
    });
    child.on('error', error => console.error(`无法启动后台服务：${error.message}`)); child.unref();
  } finally { await output.close(); }
  for (let i = 0; i < 40; i++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const current = await health(config);
    if (current?.version === VERSION) { await adminRequest(config, '/clients'); return; }
  }
  throw new Error(`本地服务未启动；查看 ${path.join(config.dataDir, 'service.log')}。可能端口被其他程序占用。`);
}
const adminStore = (config: Config): CredentialStore => ({
  list: async () => (await adminRequest(config, '/clients')).clients as { id: string; revoked: boolean }[],
  create: async (label, profiles, readOnly) => await adminRequest(config, '/clients', 'POST', { label, profiles, readOnly }) as { id: string; token: string },
  remove: id => adminRequest(config, `/clients/${id}`, 'DELETE'),
});
const clientCredential = (config: Config, label: string, profiles: '*' | string[] = '*', readOnly = false, reuseExisting = false) => sharedCredential(config.dataDir, adminStore(config), label, profiles, readOnly, reuseExisting);
async function setup(config: Config) {
  await ensureServer(config);
  const extensionDir = path.join(config.dataDir, 'extension');
  await copyExtensionFiles(path.join(projectDir, 'dist', 'extension'), extensionDir);
  await writeFile(path.join(extensionDir, 'pairing.json'), JSON.stringify(extensionDefaults(config)), { mode: 0o600 });
  const { command, args } = clientLaunch();
  const entries: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};
  for (const label of ['codex', 'claude', 'opencode']) {
    const credential = await clientCredential(config, label, '*', false, true);
    entries[label] = { command, args, env: { CHROME_MCP_DATA_DIR: config.dataDir, CHROME_MCP_TOKEN_FILE: credential.tokenFile } };
  }
  await writeFile(path.join(config.dataDir, 'mcp-config.json'), JSON.stringify({ mcpServers: { [MCP_NAME]: entries.claude } }, null, 2));
  await writeFile(path.join(config.dataDir, 'opencode-config.json'), JSON.stringify(openCodeConfig(entries.opencode!), null, 2));
  await writeFile(path.join(config.dataDir, 'opencode-v1-config.json'), JSON.stringify(openCodeConfig(entries.opencode!, 1), null, 2));
  await writeFile(path.join(config.dataDir, 'codex-config.toml'), codexConfig(entries.codex!));
  console.log(JSON.stringify({ version: VERSION, extensionDir, dashboard: servicePublicUrl(config)+'/', configDir: config.dataDir, instructions: '在管理页为每个 Chrome 创建浏览器配对码，加载扩展后粘贴配对。客户端分别使用独立授权配置。' }, null, 2));
}
async function stop(config: Config) {
  const current = await health(config);
  if (!current) return;
  if (current.service !== 'feng-chrome-mcp') throw new Error('此端口不是 SaltedFish，未停止。');
  await adminRequest(config, '/admin/shutdown', 'POST', {});
  for (let i = 0; i < 40; i++) { await new Promise(resolve => setTimeout(resolve, 100)); if (!await health(config)) return; }
  throw new Error('服务尚未停止，未强杀进程。请查看服务日志。');
}
const command = process.argv[2] || 'mcp';
try {
  if (['--help', '-h', 'help'].includes(command)) console.log(`SaltedFish: setup | serve | mcp | stop | doctor | diagnostics | configure-server --host IP --url URL [--allow-insecure-lan | --cert FILE --key FILE] [--local-port PORT] | helper install [--extension-dir DIR] / status / uninstall | dashboard [--onboarding | --logout-all] | desktop register [--extension-dir DIR] / unregister | desktop-open <settings-uri> | clients list/add/revoke | results list/remove | version | ${connectHelp}`);
  else if (command === 'version') console.log(JSON.stringify({ version: VERSION, protocolVersion: PROTOCOL_VERSION, stateVersion: STATE_VERSION }));
  else if (command === 'mcp-bridge') {
    if (process.argv.length !== 3) throw new Error('mcp-bridge 不接受命令行参数；请通过环境变量配置地址与令牌。');
    await runMcpBridge();
  }
  else if (command === 'native-settings') {
    // Chrome 的标准输入输出只允许 Native Messaging 帧，不初始化配置或启动服务。
    await runNativeSettings(process.env.CHROME_MCP_DATA_DIR || path.join(projectDir, '.local'), process.argv.slice(3));
    process.stdin.destroy();
  }
  else {
    // 系统协议参数完全不可信；非法参数在读取/初始化配置或启动服务前拒绝。
    const desktop = command === 'desktop-open' ? (() => {
      if (process.argv.length !== 4) throw new Error('设置入口只接受一个地址。');
      return parseDesktopUrl(process.argv[3]!);
    })() : undefined;
    const extensionDirs: string[] = [];
    if (command === 'desktop') {
      const operation = process.argv[3], args = process.argv.slice(4);
      if (!['register','unregister'].includes(operation!) || operation === 'unregister' && args.length) throw new Error('用法：desktop register [--extension-dir DIR] | unregister。');
      for (let i = 0; i < args.length; i += 2) {
        if (args[i] !== '--extension-dir' || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error('用法：desktop register [--extension-dir DIR] | unregister。');
        extensionDirs.push(path.resolve(args[i + 1]!));
      }
    }
    if (desktop || command === 'desktop') await access(path.join(process.env.CHROME_MCP_DATA_DIR || path.join(projectDir,'.local'),'config.json'));
    const config = await loadConfig();
    if (command === 'desktop') {
      const launch=clientLaunch();
      const entry = {command:launch.command,args:launch.args.slice(0,-1)};
      if (process.argv[3] === 'register') {
        const desktopResult = await registerDesktopLaunch(config, entry);
        const nativeResult = await registerNativeSettings(config, entry, {extensionDirs});
        console.log(JSON.stringify({ ...desktopResult, nativeSettings: nativeResult }));
      } else {
        await unregisterNativeSettings(config, {validateOnly: true});
        await unregisterDesktopLaunch(config, {validateOnly: true});
        const nativeResult = await unregisterNativeSettings(config);
        const desktopResult = await unregisterDesktopLaunch(config);
        console.log(JSON.stringify({ ...desktopResult, nativeSettings: nativeResult }));
      }
    } else if (desktop) {
      parseDesktopUrl(process.argv[3]!,config.port);
      if (process.platform !== 'win32' || process.env.SALTEDFISH_NO_BROWSER) throw new Error('本机应用未启用自动打开浏览器，请从管理页选择其他登录方式。');
      await ensureServer(config);
      const {code}=await adminRequest(config,'/session/code','POST',{}) as {code:string};
      const url=serviceDashboardLoginUrl(servicePublicUrl(config),code,desktop.target);
      // 只打开固定本机管理页；不向调用网页、扩展、stdout或日志返回码或密钥。
      await openDashboard(url);
    } else if (command === 'serve') {
      const app = await startServer(config);
      await writeFile(path.join(config.dataDir, 'service.pid'), String(process.pid));
      console.error(`SaltedFish ${VERSION} 服务：${servicePublicUrl(config)}，PID ${process.pid}`);
      let stopping = false;
      const shutdown = async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); };
      process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown); app.server.once('adminShutdown', shutdown);
      if(process.platform!=='win32')process.on('SIGHUP',()=>{void app.reloadTls().catch(()=>console.error('TLS证书未更新，保留当前证书。请检查证书同步日志。'));});
    } else if (command === 'configure-server') console.log(JSON.stringify(await configureServer(config,process.argv.slice(3))));
    else if(command==='helper') {
      const operation=process.argv[3],args=process.argv.slice(4),extensionDirs:string[]=[];
      if(!['install','status','uninstall'].includes(operation!))throw new Error('用法：helper install [--extension-dir DIR] | status | uninstall');
      for(let i=0;i<args.length;i+=2){if(operation!=='install'||args[i]!=='--extension-dir'||!args[i+1]||args[i+1]!.startsWith('--'))throw new Error('助手参数无效。');extensionDirs.push(path.resolve(args[i+1]!));}
      if(operation==='install'){
        await copyExtensionFiles(path.join(projectDir,'dist','extension'),path.join(config.dataDir,'extension'));
        await writeFile(path.join(config.dataDir,'extension','pairing.json'),JSON.stringify(extensionDefaults(config)),{mode:0o600});
        const launch=clientLaunch();console.log(JSON.stringify(await registerNativeSettings(config,{command:launch.command,args:launch.args.slice(0,-1)},{extensionDirs})));
      }else if(operation==='uninstall')console.log(JSON.stringify(await unregisterNativeSettings(config)));
      else console.log(JSON.stringify({installed:await nativeSettingsReady(config),helperOnly:true,serviceStarted:false}));
    } else if (command === 'setup') await setup(config);
    else if (command === 'connect') { await ensureServer(config); await connectClients(new ClientSetup(config, { credential: async client => (await clientCredential(config, client, '*', false, true)).tokenFile }), process.argv.slice(3)); }
    else if (command === 'mcp') { await ensureServer(config); await runMcp(config); }
    else if (command === 'stop') await stop(config);
    else if (command === 'doctor' || command === 'diagnostics') {
      const current = await health(config);
      const report = { version: VERSION, node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, dataDir: config.dataDir, service: current || null, versionMatches: current?.version === VERSION,
        ...(current?.version === VERSION ? { browsers: await callService(config, 'chrome_profiles', {}, 'doctor'), runtime: await adminRequest(config, '/diagnostics') } : {}) };
      if (command === 'diagnostics') {
        const file = path.join(config.dataDir, `diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        await writeFile(file, JSON.stringify(report, null, 2), { mode: 0o600 }); console.log(file);
      } else console.log(JSON.stringify(report, null, 2));
    } else if (command === 'clients') {
      await ensureServer(config);
      if (process.argv[3] === 'list') console.log(JSON.stringify(await adminRequest(config, '/clients'), null, 2));
      else if (process.argv[3] === 'revoke' && process.argv[4]) console.log(JSON.stringify(await adminRequest(config, `/clients/${process.argv[4]}`, 'DELETE')));
      else if (process.argv[3] === 'add' && process.argv[4]) {
        const flag = process.argv.indexOf('--profiles');
        const profiles = flag >= 0 ? (process.argv[flag + 1] || '').split(',') : '*';
        console.log(JSON.stringify(await clientCredential(config, process.argv[4], profiles, process.argv.includes('--read-only')), null, 2));
      } else throw new Error('用法：clients list | clients add <名称> [--profiles UUID,UUID] [--read-only] | clients revoke <客户端 ID>');
    } else if (command === 'results') {
      await ensureServer(config);
      if (process.argv[3] === 'list') console.log(JSON.stringify(await adminRequest(config, '/results'), null, 2));
      else if (process.argv[3] === 'remove' && process.argv[4]) console.log(JSON.stringify(await adminRequest(config, `/results/${process.argv[4]}`, 'DELETE')));
      else throw new Error('用法：results list | results remove <artifactId>（永久删除选定的结果文件）');
    } else if (command === 'dashboard') {
      await ensureServer(config);
      if (process.argv.includes('--logout-all')) console.log(JSON.stringify(await adminRequest(config, '/sessions', 'DELETE')));
      else {
        // URL 片段里只放 5 分钟内有效、只能用一次的登录码；长期管理员密钥不再出现在地址栏、命令行或终端输出里。
        // SALTEDFISH_NO_BROWSER=1 时只打印地址（脚本、无桌面环境和测试用）；登录码一次有效，打印出来也不是长期凭据。
        const printOnly = process.platform !== 'win32' || !!process.env.SALTEDFISH_NO_BROWSER;
        const { code, shortCode } = await adminRequest(config, printOnly ? '/session/code?short=1' : '/session/code', 'POST', {}) as { code: string; shortCode?: string };
        const url = serviceDashboardLoginUrl(servicePublicUrl(config), code, undefined, process.argv.includes('--onboarding'));
        if (!printOnly) await openDashboard(url);
        else {
          console.log(url);
          // 走 stderr：脚本读 stdout 拿到的还是一个地址。
          if (shortCode) console.error(`不方便打开链接时，到 ${servicePublicUrl(config)} 输入登录码 ${shortCode}。5 分钟内有效，只能用一次。`);
        }
      }
    } else throw new Error(`未知命令 ${command}`);
  }
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
