import { z } from 'zod';

export const DesktopTarget = z.object({
  route: z.enum(['overview', 'setup', 'remote', 'agents']),
  profile: z.string().uuid().optional(),
  add: z.literal('1').optional(),
}).strict().superRefine((value, context) => {
  if (value.route !== 'agents' && (value.profile !== undefined || value.add !== undefined)) {
    context.addIssue({ code: 'custom', message: '只有 Agent 管理页接受浏览器筛选与新增参数。' });
  }
});
export type DesktopTarget = z.infer<typeof DesktopTarget>;
const validPort = (port: number) => Number.isInteger(port) && port >= 1024 && port <= 65535;

/** 桌面协议只允许打开固定管理页，不能把任何URL、命令或文件路径交给系统执行。 */
export function parseDesktopUrl(value: string, expectedPort?: number): { port: number; target: DesktopTarget } {
  const invalid = () => new Error('设置入口无效，请从 SaltedFish 页面重新打开。');
  if (value.length > 256 || /[^\x21-\x7e]|["'\\%#]/.test(value)) throw invalid();
  const match = /^saltedfish-([1-9][0-9]{3,4}):\/\/settings\/(overview|setup|remote|agents)(?:\?([^?]+))?$/.exec(value);
  if (!match) throw invalid();
  const port = Number(match[1]);
  if (!validPort(port) || expectedPort !== undefined && port !== expectedPort) throw invalid();
  const params = new URLSearchParams(match[3] || ''), input: Record<string, string> = { route: match[2]! };
  for (const [key, item] of params) {
    if (!['profile', 'add'].includes(key) || Object.hasOwn(input, key)) throw invalid();
    input[key] = item;
  }
  const parsed = DesktopTarget.safeParse(input);
  if (!parsed.success) throw invalid();
  // URLSearchParams会容忍末尾 &、缺少 = 等写法；仅接受我们产生的普通 ASCII 参数。
  if (params.toString() !== (match[3] || '')) throw invalid();
  return { port, target: parsed.data };
}

export function dashboardLoginUrl(port: number, code: string, target?: DesktopTarget, onboarding = false): string {
  if (!validPort(port) || !/^[a-f0-9]{64}$/.test(code)) throw new Error('管理页登录信息无效。');
  return serviceDashboardLoginUrl(`http://127.0.0.1:${port}`, code, target, onboarding);
}

export function serviceDashboardLoginUrl(origin: string, code: string, target?: DesktopTarget, onboarding = false): string {
  if (!/^[a-f0-9]{64}$/.test(code)) throw new Error('管理页登录信息无效。');
  const url = new URL(origin);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new Error('管理页服务地址无效。');
  if (target) {
    const checked = DesktopTarget.parse(target);
    url.searchParams.set('target', checked.route);
    if (checked.profile) url.searchParams.set('profile', checked.profile);
    if (checked.add) url.searchParams.set('add', checked.add);
  } else if (onboarding) url.searchParams.set('onboarding', '1');
  url.hash = code;
  return url.toString();
}

/** 这是显式导航的附加护栏，不把协议唤起来源当成身份认证。 */
export function isDesktopSettingsUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  // 浏览器会移除scheme中的tab/CR/LF；护栏使用同样的URL解析，不能只匹配原字符串。
  try { return /^saltedfish-[0-9]+:$/i.test(new URL(value).protocol); }
  catch { return /^\s*saltedfish-[0-9]+:/i.test(value); }
}
