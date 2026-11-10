import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureService, exists, pause, stopPath } from './npm-runtime.js';

const UNIT = 'saltedfish.service';
export interface AutostartHost { system: boolean; directory: string; userHome: string; node: string; supported(): Promise<boolean>; systemctl(...args: string[]): Promise<string>; linger(): Promise<void> }
function run(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => execFile(command, args, { timeout: 330000 }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout)));
}
// root 写系统服务；普通用户写用户服务，要 linger 才会在开机时启动。
export function autostartHost(): AutostartHost {
  const system = process.getuid?.() === 0, userHome = os.homedir();
  return {
    system, userHome, node: process.execPath,
    directory: system ? '/etc/systemd/system' : path.join(process.env.XDG_CONFIG_HOME || path.join(userHome, '.config'), 'systemd/user'),
    supported: async () => process.platform === 'linux' && await exists('/run/systemd/system'),
    systemctl: (...args) => run('systemctl', system ? args : ['--user', ...args]),
    linger: async () => { await run('loginctl', ['enable-linger', os.userInfo().username]); },
  };
}
const quote = (value: string) => `"${value.replace(/[\\"]/g, '\\$&').replace(/%/g, '%%')}"`;
const launcher = (home: string) => path.join(home, 'launcher.mjs');
// 这个单元只在开机时拉一次服务，启停和升级还是 saltedfish 命令管。KillMode=process：停单元不带走服务。
export function autostartUnit(home: string, host: Pick<AutostartHost, 'system' | 'node' | 'userHome'>) {
  return [
    '[Unit]', 'Description=SaltedFish', ...host.system ? ['Wants=network-online.target', 'After=network-online.target'] : [], '',
    '[Service]', 'Type=oneshot', 'RemainAfterExit=yes', 'KillMode=process', 'TimeoutStartSec=300', `Environment=${quote(`HOME=${host.userHome}`)}`,
    `ExecStart=${quote(host.node)} ${quote(launcher(home))} autostart run`, '',
    '[Install]', `WantedBy=${host.system ? 'multi-user.target' : 'default.target'}`, '',
  ].join('\n');
}
async function installedUnit(home: string, host: AutostartHost) {
  const file = path.join(host.directory, UNIT);
  const current = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (current !== undefined && !current.includes(quote(launcher(home)))) throw new Error(`${file} 属于另一个 SaltedFish 安装，未修改。`);
  return { file, current };
}
export async function autostartState(host = autostartHost()) {
  if (!await host.supported()) return 'unsupported' as const;
  return await host.systemctl('is-enabled', UNIT).then(output => output.trim() === 'enabled', () => false) ? 'on' as const : 'off' as const;
}
export async function enableAutostart(home: string, host = autostartHost()) {
  if (!await host.supported()) throw new Error('这台电脑没有 systemd，要开机启动就把 saltedfish start 加到自己的启动脚本里。');
  const { file, current } = await installedUnit(home, host), unit = autostartUnit(home, host);
  if (current !== unit) {
    await mkdir(host.directory, { recursive: true }); await writeFile(file, unit, { mode: 0o644 });
    await host.systemctl('daemon-reload');
  }
  await host.systemctl('enable', '--now', UNIT);
  if (host.system) return undefined;
  return host.linger().then(() => undefined, () => `要在不登录时也启动，运行 sudo loginctl enable-linger ${os.userInfo().username}。`);
}
export async function disableAutostart(home: string, host = autostartHost()) {
  if (!await host.supported()) return;
  const { file, current } = await installedUnit(home, host);
  if (current === undefined) return;
  await host.systemctl('disable', '--now', UNIT);
  await rm(file, { force: true });
  await host.systemctl('daemon-reload');
}
// 用户停过服务就不再自己起来。开机时网络可能还没好，监听地址不存在会启动失败，多试一会。
export async function runAutostart(home: string, start: typeof ensureService = ensureService, wait = 5000) {
  for (let attempt = 1; !await exists(stopPath(home, 'local')); attempt++) {
    try { await start(home, 'local', true); return; }
    catch (error) { if (attempt >= 12) throw error; await pause(wait); }
  }
}
