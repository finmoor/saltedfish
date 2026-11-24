// 终端里给人看的 status、doctor、start、stop、restart、desktop 输出。管道和脚本照旧拿 JSON，这里只管人读的几行。

interface ServiceState {
  role: string; state: string; version?: string; pid?: number; startedAt?: string; busy?: boolean; stoppedExplicitly?: boolean; hint?: string;
  resources?: { profiles?: number; agentSessions?: number };
}
interface StatusReport { packageVersion: string; active?: { version?: string } | null; services: ServiceState[]; hints: string[] }

function since(startedAt: string | undefined, now: number) {
  const started = Date.parse(startedAt ?? '');
  if (!Number.isFinite(started)) return '';
  const minutes = Math.max(0, Math.floor((now - started) / 60_000));
  return minutes < 1 ? '刚启动' : minutes < 60 ? `${minutes} 分钟前启动` : minutes < 48 * 60 ? `${Math.floor(minutes / 60)} 小时前启动` : `${Math.floor(minutes / 1440)} 天前启动`;
}

/** 一个服务的状态，一到两行。地址只对本机服务有意义。 */
export function serviceLines(service: ServiceState, address?: string, now = Date.now()): string[] {
  const name = service.role === 'gateway' ? '旧网关服务' : 'SaltedFish 服务';
  if (service.state === 'running') {
    const when = since(service.startedAt, now);
    const lines = [`${name} ${service.version ?? ''} 运行中（PID ${service.pid}${when ? `，${when}` : ''}）`.replace('  ', ' ')];
    if (address) lines.push(`地址：${address}`);
    const browsers = service.resources?.profiles, agents = service.resources?.agentSessions;
    if (browsers !== undefined) lines.push(`浏览器：${browsers} 个连着 · Agent：${agents ?? 0} 个会话${service.busy ? ' · 有操作正在进行' : ''}`);
    return lines;
  }
  if (service.state === 'stopped') return [`${name}没在运行${service.stoppedExplicitly ? '（上次是手动停的）' : ''}。要用时运行 saltedfish start。`];
  if (service.state === 'crashed') return [`${name}意外退出了。运行 saltedfish start 重新启动；反复出现就看 saltedfish logs。`];
  return [`${name}的状态读不到（PID ${service.pid ?? '未知'}）。`];
}

/** status 和 doctor 共用：先说服务，再列问题。doctor 多查浏览器和 Agent 有没有连上，并给出下一步。 */
export function statusText(report: StatusReport, options: { address?: string; doctor?: boolean; now?: number } = {}) {
  const local = report.services.find(service => service.role === 'local');
  // 旧网关只有装过才提：停着的不显示。
  const others = report.services.filter(service => service.role !== 'local' && service.state !== 'stopped');
  const lines = [...(local ? serviceLines(local, options.address, options.now) : []), ...others.flatMap(service => serviceLines(service, undefined, options.now))];
  const running = report.active?.version;
  if (running && running !== report.packageVersion) lines.push(`命令行是 ${report.packageVersion}，服务运行的是 ${running}。要换成 ${report.packageVersion}，运行 saltedfish upgrade --no-fetch。`);
  const problems = [...report.hints];
  if (options.doctor && local) {
    if (local.state === 'running') {
      if (!local.resources?.profiles) problems.push('没有浏览器连着：打开装了 SaltedFish 扩展的 Chrome；暂停着的在扩展里点“继续连接”；还没配对的，运行 saltedfish dashboard，在“浏览器”里配对。');
      if (!local.resources?.agentSessions) problems.push('现在没有 Agent 连着：在 Agent 里新开会话（开着的要重连 MCP）；还没接入的运行 saltedfish connect。');
    } else if (local.state !== 'stopped' || !local.stoppedExplicitly) problems.push('服务没在运行：运行 saltedfish start；起不来就看 saltedfish logs。');
  }
  if (problems.length) lines.push('', options.doctor ? '要处理的：' : '提示：', ...problems.map(problem => `· ${problem}`));
  else if (options.doctor) lines.push('', '没发现问题。');
  lines.push('', `完整数据（JSON）：saltedfish ${options.doctor ? 'doctor' : 'status'} > saltedfish-status.json`);
  return lines.join('\n');
}

/** start、stop、restart 之后的一两行。 */
export function controlText(command: 'start' | 'stop' | 'restart', service: ServiceState, address?: string, now = Date.now()) {
  if (command === 'stop' && service.state === 'stopped') return 'SaltedFish 已停止。Agent 不会自动把它拉起来，要用时运行 saltedfish start。';
  if (command !== 'stop' && service.state === 'running') return [`SaltedFish ${service.version ?? ''} 已${command === 'start' ? '启动' : '重启'}（PID ${service.pid}）。`.replace('  ', ' '), ...(address ? [`地址：${address}`] : []), ...(command === 'restart' ? ['管理页的登录随重启失效，要用时重新运行 saltedfish dashboard。'] : [])].join('\n');
  return serviceLines(service, address, now).join('\n');
}

/** desktop register / unregister 的结果。 */
export function desktopText(operation: 'register' | 'unregister', result: { supported?: boolean; registered?: boolean; removed?: boolean; nativeSettings?: { supported?: boolean; registered?: boolean; removed?: boolean } }, extensionDirs = 0) {
  if (!result.supported) return '这台电脑不支持桌面设置入口（只有 Windows 有），没有改动。';
  if (operation === 'register') return `已登记：从这台电脑的扩展点“打开管理页”，可以直接进入已登录的管理页${extensionDirs ? `（包括你指定的 ${extensionDirs} 个扩展目录）` : ''}。`;
  return result.removed || result.nativeSettings?.removed ? '已移除桌面设置入口。之后从扩展点“打开管理页”会先进登录页。' : '这台电脑上没有登记过桌面设置入口，不用移除。';
}
