// 管理页整页夹具：假 DOM（真实 index.html）+ 假本机服务（fetch）+ 假 location/sessionStorage/剪贴板，
// 再导入真实的 ui/app.js 运行。用来在不启动浏览器的情况下回归管理页脚本之间的接线（app.js ↔ workspace/product/activity/remote）。
// 不替代真实浏览器：布局、颜色、真实焦点行为仍由 tests/ui*.integration.ts 在 Chrome 里验证。
import { mock, type TestContext } from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectDir } from '../src/config.js';
import { setupClients, clientLabels, clientOwnApprovals, clientUserOnly } from '../src/client-types.js';
import { installDom, readUi, flush, type FakeElement, type FakeDocument } from './fake-dom.js';

export interface FakeProfile { id: string; label: string; online: boolean; version?: string; capabilities?: string[]; /** 离线的已知配置的最后在线时间（ISO，服务端时钟） */ lastSeen?: string }
type RpcHandler = (args: any) => unknown | Promise<unknown>;
export interface ServerRequest { path: string; method: string; body: any; bearer: string }
/** /dashboard 的 protection.profiles[] 单项：online、label、lastSeen 是 beta.22 新增字段（旧测试直接写 server.protection 时可以不带）。 */
export interface FakeProtectionProfile { profileId: string; unknown: number; running: number; online?: boolean; label?: string; lastSeen?: string }
/** 某个配置名下未确认的 unknown/running 操作（放弃接口的预览与确认按它计算）。 */
export interface FakePending { id: string; tabId: number | null; tool: string; state: 'unknown' | 'running'; startedAt: string; errorCode: string | null }
export interface FakeServer {
  credential: string; session: string; sessions: number; profiles: FakeProfile[]; clients: any[];
  protection: { unknown: number; running: number; profiles: FakeProtectionProfile[] };
  /** 放弃接口的假状态：profileId -> 未确认记录。GET/POST /profiles/abandon 按它计算；成功放弃后同步更新 profiles 与 protection。 */
  pending: Record<string, FakePending[]>;
  /** /dashboard 的 checkedAt（服务端时钟）；默认取当前时间。用例可以让它与本机时钟不同，核对“长期未见”按服务端时钟判断。 */
  checkedAt?: () => string;
  /** /dashboard 的 agents（服务端的 Agent 摘要）；不设时和旧服务一样不带这个字段。 */
  agents?: any[];
  remote: any; rpc: Record<string, RpcHandler>; log: ServerRequest[];
  /** 拦截某个请求（"METHOD /path"，或 "RPC chrome_xxx"）；返回 undefined 则交给默认实现。可返回挂起的 promise 来模拟慢请求。 */
  hooks: Record<string, (request: ServerRequest) => unknown>;
  rpcCalls(name?: string): { name: string; args: any }[];
}
// 前 8 位随 n 变化：短 ID（profileLabel 取前缀）在用例里足以区分。
export const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
export const defer = <T = void>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

export function createServer(overrides: Partial<FakeServer> = {}): FakeServer {
  const server: FakeServer = {
    credential: 'c'.repeat(64), session: 'session-token-1', sessions: 1, profiles: [], clients: [], remote: { state: 'disconnected', enabled: false, url: '', profiles: [], readOnly: false, hasToken: false },
    protection: { unknown: 0, running: 0, profiles: [] }, pending: {}, log: [], hooks: {},
    rpc: {
      chrome_tabs: () => ({ items: [{ tabId: 7, windowId: 1, title: '示例页面', url: 'https://example.test/' }] }),
      chrome_tasks: () => ({ items: [], total: 0, nextOffset: null }), chrome_workflows: () => ({ items: [], total: 0, nextOffset: null }),
      chrome_operations: () => ({ items: [], total: 0, nextOffset: null }),
    },
    rpcCalls(name) { return this.log.filter(r => r.path === '/rpc' && (!name || r.body?.name === name)).map(r => ({ name: r.body.name, args: r.body.args })); },
    ...overrides,
  };
  return server;
}

const counts = (items: FakePending[]) => { const unknown = items.filter(item => item.state === 'unknown').length; return { unknown, running: items.length - unknown }; };
/** 按 server.pending 与 server.profiles 重算 server.protection，形状与真实 /dashboard 一致：online、label、lastSeen 由服务端补上。 */
export function syncProtection(server: FakeServer): void {
  const profiles: FakeProtectionProfile[] = [];
  for (const [profileId, items] of Object.entries(server.pending)) {
    const { unknown, running } = counts(items); if (!unknown && !running) continue;
    const known = server.profiles.find(profile => profile.id === profileId);
    profiles.push({ profileId, unknown, running, online: known?.online === true, ...(known ? { label: known.label, lastSeen: known.lastSeen ?? (known.online ? new Date().toISOString() : undefined) } : {}) });
  }
  server.protection = { unknown: profiles.reduce((sum, item) => sum + item.unknown, 0), running: profiles.reduce((sum, item) => sum + item.running, 0), profiles };
}
let pendingSequence = 0;
/** 给某个配置名下再造 count 条未确认记录（默认 unknown；开始时间依次递增，最后造出来的最新），并同步 server.protection。 */
export function addPending(server: FakeServer, profileId: string, count: number, overrides: Partial<FakePending> = {}): FakePending[] {
  const list = server.pending[profileId] ??= [], base = list.length;
  const created = Array.from({ length: count }, (_, index): FakePending => ({ id: uuid(0x10000 + ++pendingSequence), tabId: 7, tool: 'chrome_evaluate', state: 'unknown', startedAt: new Date(Date.UTC(2026, 9, 25, 0, 0, base + index)).toISOString(), errorCode: 'COMMAND_TIMEOUT', ...overrides }));
  list.push(...created); syncProtection(server); return created;
}
const failure = (code: string, message: string) => ({ status: 400, body: { ok: false, error: { code, message } } });
// 与 src/service.ts 的 abandonPreview / abandonProfile 同口径：预览带名称、在线状态、最后在线时间、至多 50 条记录；确认要求数量与预览一致，在线或仍有运行中的操作都拒绝。
function abandonPreview(server: FakeServer, profileId: string) {
  const profile = server.profiles.find(item => item.id === profileId), items = server.pending[profileId] ?? [], { unknown, running } = counts(items), online = profile?.online === true;
  if (!online && !profile && !items.length) return failure('PROFILE_NOT_FOUND', '没有这个配置，也没有它的待核查记录。');
  const lastSeen = profile ? profile.lastSeen ?? (online ? new Date().toISOString() : null) : null;
  return { status: 200, body: { profileId, label: profile?.label ?? null, online, lastSeen, unknown, running, canAbandon: !online && running === 0,
    operations: [...items].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 50).map(({ id, tabId, tool, state, startedAt, errorCode }) => ({ id, tabId, tool, state, startedAt, errorCode })),
    note: online ? '该配置当前在线，不能放弃；请在原页面核查后用“解除保护”确认。' : '放弃只在数据库里确认这些记录并把这个配置从列表移除：不连接浏览器，不重放任何操作。若配置只是暂时离线，请回到原 Chrome 配置核查页面，不要放弃。' } };
}
function abandonProfile(server: FakeServer, body: any) {
  if (Object.keys(body ?? {}).sort().join() !== 'confirm,expectedUnknown,profileId' || body.confirm !== true || !Number.isInteger(body.expectedUnknown) || body.expectedUnknown < 0 || typeof body.profileId !== 'string') return failure('INVALID_ARGUMENT', '请求参数不符合要求。');
  const profile = server.profiles.find(item => item.id === body.profileId), { unknown, running } = counts(server.pending[body.profileId] ?? []);
  if (profile?.online) return failure('PROFILE_ONLINE', '该配置当前在线，不能放弃。请在原页面核查后用“解除保护”确认。');
  if (running) return failure('OPERATION_RUNNING', `该配置还有 ${running} 个操作仍在运行，不能放弃；等它们结束后再试。`);
  if (unknown !== body.expectedUnknown) return failure('ABANDON_COUNT_CHANGED', `待核查记录从 ${body.expectedUnknown} 条变成了 ${unknown} 条；请重新预览，确认后再放弃。`);
  delete server.pending[body.profileId]; server.profiles = server.profiles.filter(item => item.id !== body.profileId); syncProtection(server);
  return { status: 200, body: { abandoned: true, profileId: body.profileId, acknowledged: unknown, forgotten: !!profile, replayed: false } };
}

async function respond(server: FakeServer, url: string, init: any): Promise<{ status: number; body: unknown }> {
  const method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined, bearer = String(init?.headers?.authorization ?? '').replace(/^Bearer /, '');
  const request: ServerRequest = { path: url, method, body, bearer }; server.log.push(request);
  const hook = server.hooks[`${method} ${url}`] ?? (url === '/rpc' ? server.hooks[`RPC ${body?.name}`] : undefined);
  if (hook) { const out = await hook(request); if (out !== undefined) return out as { status: number; body: unknown }; }
  if (url === '/health') return { status: 200, body: { service: 'feng-chrome-mcp', version: '0.2.0-beta.22' } };
  if (url === '/session' && method === 'POST') return bearer === server.credential ? { status: 200, body: { token: server.session = `session-token-${++server.sessions}`, expiresAt: new Date(Date.now() + 36e5).toISOString(), idleSeconds: 1800 } } : { status: 401, body: { error: 'UNAUTHORIZED' } };
  if (url === '/session' && method === 'DELETE') { if (bearer === server.session) server.session = ''; return { status: 200, body: {} }; }
  if (bearer !== server.session || !bearer) return { status: 401, body: { error: 'UNAUTHORIZED' } };
  if (url === '/dashboard') return { status: 200, body: { version: '0.2.0-beta.22', checkedAt: server.checkedAt?.() ?? new Date().toISOString(), extensionDir: 'C:/saltedfish/extension', profiles: server.profiles, remote: server.remote, requiredExtensionCapability: 'interaction-v5', protection: server.protection, ...(server.agents ? { agents: server.agents } : {}) } };
  if (url === '/clients' && method === 'GET') return { status: 200, body: { clients: server.clients } };
  if (url === '/setup/clients') return { status: 200, body: { clients: setupClients.map(client => ({ client, label: clientLabels[client], userOnly: clientUserOnly(client), ownApprovals: clientOwnApprovals(client), connection: 'not_configured', configExists: false, cliDetected: true, target: `C:/home/.${client}`, scope: '', note: '', format: 'v2' })) } };
  if (url === '/setup/history') return { status: 200, body: { changes: [] } };
  if (url === '/remote' && method === 'POST') return { status: 200, body: { ...server.remote, ...body } };
  if (url.startsWith('/profiles/abandon')) {
    if (method === 'GET') return abandonPreview(server, new URL(url, 'http://fake').searchParams.get('profileId') ?? '');
    if (method === 'POST') return abandonProfile(server, body);
  }
  if (url === '/rpc') {
    const handler = server.rpc[body.name]; if (!handler) return { status: 200, body: { ok: false, error: { code: 'UNKNOWN_TOOL', message: `假服务没有实现 ${body.name}` } } };
    try { return { status: 200, body: { ok: true, data: await handler(body.args) } }; }
    catch (error: any) { return { status: 200, body: { ok: false, error: { code: error.code ?? 'FIXTURE_FAILED', message: error.message } } }; }
  }
  return { status: 404, body: { error: 'NOT_FOUND' } };
}

export interface MountedApp {
  doc: FakeDocument; server: FakeServer; copied: string[]; confirms: string[];
  $(selector: string): FakeElement; $$(selector: string): FakeElement[]; text(selector: string): string;
  click(selector: string | FakeElement): void; /** 经过一帧：触发定时器并等待所有 promise 链结束 */ tick(ms?: number): Promise<void>;
  flush(): Promise<void>; frame(): Promise<void>; navigate(route: string): Promise<void>; clipboard: { fail: boolean };
  /** 当前会话令牌（页面 sessionStorage 里保存的值） */ storedSession(): string;
}
let instance = 0;
export async function mountApp(t: TestContext, options: { server?: FakeServer; login?: 'fragment' | 'session' | 'none'; hash?: string } = {}): Promise<MountedApp> {
  const server = options.server ?? createServer(), mode = options.login ?? 'fragment';
  const storage = new Map<string, string>(), copied: string[] = [], confirms: string[] = [], clipboard = { fail: false };
  if (mode === 'session') storage.set('chrome-mcp-session', server.session);
  let windowEvent: (type: string) => void = () => {};
  const location = {
    _hash: mode === 'fragment' ? `#${server.credential}` : options.hash ?? '', pathname: '/', origin:'http://127.0.0.1:17422',
    get hash() { return this._hash; }, set hash(value: string) { const next = value.startsWith('#') || value === '' ? value : `#${value}`; if (next !== this._hash) { this._hash = next; queueMicrotask(() => windowEvent('hashchange')); } },
  };
  const globals = {
    location, history: { replaceState: (_s: unknown, _t: string, url: string) => { location._hash = url.includes('#') ? url.slice(url.indexOf('#')) : ''; } },
    sessionStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } },
    navigator: { clipboard: { writeText: async (value: string) => { if (clipboard.fail) throw new Error('denied'); copied.push(value); } } },
    confirm: (message: string) => { confirms.push(message); return true; }, prompt: () => null,
    fetch: async (url: string, init: any) => { const out = await respond(server, url, init); return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => out.body, blob: async () => new Blob([JSON.stringify(out.body)]) }; },
  };
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const dom = installDom(readUi('index.html'), globals); windowEvent = dom.windowEvent;
  t.after(() => { dom.uninstall(); mock.timers.reset(); });
  const doc = dom.doc, $ = (selector: string) => { const node = doc.querySelector(selector); if (!node) throw new Error(`页面里没有 ${selector}`); return node; };
  const url = pathToFileURL(path.join(projectDir, 'ui', 'app.js')).href + `?instance=${++instance}`;
  await import(url);
  await flush();
  const app: MountedApp = {
    doc, server, copied, confirms, clipboard, $, $$: selector => doc.querySelectorAll(selector), text: selector => $(selector).textContent,
    click(target) { (typeof target === 'string' ? $(target) : target).click(); }, flush,
    async frame() { doc.updateRendering(); await flush(); },
    async tick(ms = 5000) { mock.timers.tick(ms); await flush(); },
    async navigate(route) { location.hash = route; await flush(); },
    storedSession: () => storage.get('chrome-mcp-session') ?? '',
  };
  return app;
}

/** 从 root 里找按文字匹配的按钮（对话框、表格行里的动态按钮没有稳定 id）。 */
export function buttonByText(root: FakeElement | FakeDocument, text: string, exact = true): FakeElement {
  const found = root.querySelectorAll('button').find(b => exact ? b.textContent === text : b.textContent.includes(text));
  if (!found) throw new Error(`没有按钮“${text}”`); return found;
}
