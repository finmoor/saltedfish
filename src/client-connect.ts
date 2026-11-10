import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ClientSetup, clientLabels, setupClients, type SetupClient, type SetupSelection } from './client-setup.js';
import { BrowserError } from './shared.js';

const clientNames: Record<string, string> = clientLabels;
const names = (items: { client: string }[]) => items.map(item => clientNames[item.client] ?? item.client).join('、');
interface ConnectPlan { client: string; trust: string; unchanged?: boolean; highlights?: string[] }
interface ConnectResult { client: string; unchanged?: boolean; verification?: { tools: number } | undefined }
interface SwitchedRole { role?: string; warning?: string; skipped?: { client: string; reason: string }[] }

// 终端里只说要做什么和信任意味着什么，完整范围说明留给 --preview；管道和脚本继续拿 JSON。
export function connectSummary(plans: ConnectPlan[]) {
  const changing = plans.filter(plan => !plan.unchanged), trusted = changing.filter(plan => plan.trust === 'service'), restored = changing.filter(plan => plan.trust === 'prompt');
  const lines = [`将接入 ${names(changing)}，写入前自动备份配置。`];
  if (trusted.length) lines.push(`信任后 ${names(trusted)} 调用浏览器工具不再逐次确认，可以用已登录的身份操作网站。`);
  if (restored.length) lines.push(`${names(restored)} 恢复逐次确认。`);
  lines.push(...changing.flatMap(plan => plan.highlights ?? []), '完整说明：saltedfish connect --preview');
  return lines.join('\n');
}
export function connectResult(results: ConnectResult[]) {
  const changed = results.filter(item => !item.unchanged), same = results.filter(item => item.unchanged), tools = results.find(item => item.verification)?.verification?.tools;
  return [changed.length ? `已接入：${names(changed)}${tools ? `（${tools} 个工具）` : ''}。已打开的会话要重连才生效。` : '', same.length ? `已是最新：${names(same)}。` : '', results.some(item => item.client === 'claude-desktop') ? 'Claude Desktop 需完全退出并重启，在应用内确认工具审批。' : '', results.some(item => item.client === 'workbuddy') ? 'WorkBuddy 需在 MCP 设置中刷新并批准配置，再新开会话。' : ''].filter(Boolean).join('\n');
}
export function switchResult(command: 'upgrade' | 'rollback', active: { version: string; previous?: string | undefined }, clients: unknown[] | undefined, launcher?: string) {
  if (!clients) return `SaltedFish 已经是 ${active.version}，不用升级。`;
  const roles = clients as SwitchedRole[], lines = [command === 'upgrade' ? `SaltedFish 已升级到 ${active.version}${active.previous ? `（原来是 ${active.previous}）` : ''}` : `SaltedFish 已回滚到 ${active.version}`];
  lines.push(roles.some(item => item.role) ? '已打开的 Agent 会话要重连才生效。' : '服务没有运行，运行 saltedfish start 启动。');
  for (const item of roles) {
    if (item.warning) lines.push(item.warning);
    for (const skip of item.skipped ?? []) lines.push(`没有更新 ${clientNames[skip.client] ?? skip.client}：${skip.reason}`);
  }
  if (launcher === 'kept') lines.push('launcher.mjs 被改过，保留没动。');
  if (command === 'upgrade') lines.push('扩展图标显示 NEW 时，点开它更新。');
  return lines.join('\n');
}

export const connectHelp = `connect [--clients ${setupClients.join(',')}] [--trust-browser | --keep-approvals | --revoke-trust] [--config FILE | --project DIR] [--preview] | connect --refresh | connect --history | connect --restore ID`;
export async function connectClients(setup: ClientSetup, args: string[], terminal = !!stdin.isTTY && !!stdout.isTTY) {
  const values = new Map<string, string>(), flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (['--trust-browser','--keep-approvals','--revoke-trust','--preview','--history','--refresh'].includes(arg)) flags.add(arg);
    else if (['--clients','--config','--project','--restore'].includes(arg) && args[i + 1] && !args[i + 1]!.startsWith('--')) values.set(arg, args[++i]!);
    else throw new BrowserError('INVALID_CONNECT_OPTIONS', connectHelp);
  }
  if (flags.has('--refresh')) {
    if (flags.size!==1 || values.size) throw new BrowserError('INVALID_CONNECT_OPTIONS','--refresh 不能与其他接入选项混用；它只保留原授权并更新已登记连接。');
    console.log(JSON.stringify(await setup.refreshCatalogs(),null,2));return;
  }
  if (flags.has('--history')) { console.log(JSON.stringify({ changes: await setup.history() }, null, 2)); return; }
  if (values.has('--restore')) { console.log(JSON.stringify(await setup.restore(values.get('--restore')!), null, 2)); return; }
  // 不指定 --clients 时只接入这台机器上已安装或已有配置的 Agent，不替没装的客户端创建配置。
  const requested = values.get('--clients');
  const detected = requested ? [] : await setup.detect() as { client: string; cliDetected?: boolean; configExists?: boolean }[];
  const clients = requested ? [...new Set(requested.split(','))] : detected.filter(item => item.cliDetected || item.configExists).map(item => item.client);
  const concise = terminal && !flags.has('--preview');
  if (!clients.length) {
    if (concise) { console.log('这台机器上没有检测到支持的 Agent；装好后运行 saltedfish connect。'); return; }
    throw new BrowserError('NO_CLIENT_DETECTED', '这台机器上没有检测到支持的 Agent；安装后重新运行，或用 --clients 指定。');
  }
  if (clients.some(client => !Object.hasOwn(clientLabels, client))) throw new BrowserError('UNKNOWN_CLIENT', `--clients 支持 ${setupClients.join('、')}。`);
  if (clients.length > 1 && (values.has('--config') || values.has('--project'))) throw new BrowserError('AMBIGUOUS_CONFIG', '选择项目或自定义文件时请一次指定一个客户端。');
  const modes = ['--trust-browser','--keep-approvals','--revoke-trust'].filter(mode => flags.has(mode));
  if (modes.length > 1) throw new BrowserError('INVALID_CONNECT_OPTIONS', '信任、保留审批和撤销信任只能选择一种。');
  const selection: SetupSelection = { trust: flags.has('--keep-approvals') ? 'preserve' : flags.has('--revoke-trust') ? 'prompt' : 'service', ...(values.has('--config') ? { configPath: values.get('--config')! } : {}), ...(values.has('--project') ? { projectDirectory: values.get('--project')! } : {}) };
  const plans = await Promise.all(clients.map(client => setup.preview(client as SetupClient, selection)));
  const pending = plans.some(plan => !plan.unchanged);
  if (!concise) console.log(JSON.stringify({ plans }, null, 2)); // 预览只有路径、范围和说明，不返回原文件或凭据。
  else if (pending) console.log(`\n${connectSummary(plans)}`);
  if (flags.has('--preview')) return;
  if (!modes.length) {
    if (!terminal) throw new BrowserError('TRUST_CONFIRMATION_REQUIRED', '未写入配置。交互运行后确认一次，或明确传入 --trust-browser（仅信任此 MCP）。');
    if (pending) {
      const prompt = createInterface({ input: stdin, output: stdout });
      try {
        const answer = await prompt.question(plans.some(plan => plan.trust === 'service') ? '信任并接入？[y/N] ' : '备份并接入？[y/N] ');
        if (!/^(y|yes)$/i.test(answer.trim())) { console.log('已取消，配置未修改。'); return; }
      } finally { prompt.close(); }
    }
  }
  const completed: ConnectResult[] = [];
  try {
    for (const plan of plans) completed.push(await setup.apply(plan.planId));
    console.log(concise ? connectResult(completed) : JSON.stringify({ completed }, null, 2));
  } catch (error) {
    const note = '已完成项保留备份；失败项未覆盖。可用 --history 查看或 --restore 恢复，不会回滚已被其他程序改动的配置。';
    console.log(concise ? [connectResult(completed), note].filter(Boolean).join('\n') : JSON.stringify({ completed, note }, null, 2));
    throw error;
  }
}
