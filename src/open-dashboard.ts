import { spawn } from 'node:child_process';
import { DesktopTarget } from './desktop-links.js';

export type DashboardLauncher = (command: string, args: string[], options: {windowsHide: boolean; timeout: number; env: NodeJS.ProcessEnv}) => Promise<unknown>;
const execute:DashboardLauncher=(command,args,options)=>new Promise<void>((resolve,reject)=>{const child=spawn(command,args,{...options,stdio:'ignore'});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error('系统未能打开管理页。')));});

/** 经 Windows 的默认 URI 关联打开；explorer.exe 并非可靠的带查询参数 URL 启动器。 */
export async function openDashboard(url: string, launch: DashboardLauncher = execute): Promise<void> {
  const parsed = new URL(url), keys = [...parsed.searchParams.keys()];
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password || parsed.pathname !== '/' || !/^#[a-f0-9]{64}$/.test(parsed.hash) || Number(parsed.port) < 1024 || Number(parsed.port) > 65535 || new Set(keys).size !== keys.length) throw new Error('管理页地址无效。');
  if (parsed.searchParams.has('target')) {
    if (keys.some(key=>!['target','profile','add'].includes(key))) throw new Error('管理页目标无效。');
    const input = Object.fromEntries(parsed.searchParams);input.route=input.target!;delete input.target;
    if (!DesktopTarget.safeParse(input).success) throw new Error('管理页目标无效。');
  } else if (keys.length && (keys.length !== 1 || parsed.searchParams.get('onboarding') !== '1')) throw new Error('管理页目标无效。');
  try {
    // 脚本固定，地址只作为环境数据，不能被 PowerShell 解释成额外命令；不把登录码放进命令行。
    await launch('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; Start-Process -FilePath $env:SALTEDFISH_DASHBOARD_URL"], {windowsHide:true,timeout:15000,env:{...process.env,SALTEDFISH_DASHBOARD_URL:url}});
  } catch { throw new Error('未能打开管理页，请确认 Windows 默认浏览器可用。'); }
}
