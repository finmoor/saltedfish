import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { RequestId } from '@modelcontextprotocol/sdk/types.js';
import { serviceAddress } from './service-address.js';
import { VERSION } from './version.js';

// 服务在鉴权前就拒绝不在同一台电脑上的 Agent（403 MCP_LOCAL_ONLY），请求没到工具层，可以明确说“未执行”。
const LOCAL_ONLY_MESSAGE = 'SaltedFish 拒绝了这次连接：/mcp 只接受和服务在同一台电脑上的 Agent，请求没有执行。请把桥接和 Desktop 放在服务所在的电脑上，或在 Desktop 这台电脑上另装服务。';
export const localOnlyRejection = (error: unknown) => (error as { code?: unknown })?.code === 403 && /MCP_LOCAL_ONLY/.test(String((error as { message?: unknown })?.message));

// 面向 Desktop 的 stdio 配置（只读 stdio 的客户端用它连同一台电脑上的服务）。直接转发 MCP 帧，目录、审批标注、客户端身份和会话均由远端提供。
// 独立入口无需 saltedfish install，不读取本机管理员凭据，也不启动本机服务。
export async function runMcpBridge(env: NodeJS.ProcessEnv = process.env) {
  let url: URL;
  try {
    url = new URL(env.SALTEDFISH_MCP_URL || '');
    if (url.pathname !== '/mcp' || url.search || url.hash || url.username || url.password) throw new Error();
    serviceAddress(url.origin);
  } catch { throw new Error('SALTEDFISH_MCP_URL 需要 SaltedFish 的完整 /mcp 地址（HTTPS 或可信内网 HTTP）。'); }
  const token = env.SALTEDFISH_MCP_TOKEN?.trim();
  if (!token || /[\r\n]/.test(token)) throw new Error('缺少有效的 SALTEDFISH_MCP_TOKEN；请在服务管理页创建独立 Agent 授权。');
  const remote = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}`, 'X-SaltedFish-Catalog-Version': env.SALTEDFISH_CATALOG_VERSION || VERSION } },
    // 不跟随重定向转交凭据，也不因连接失败重发 POST。
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }),
  });
  const local = new StdioServerTransport();
  let closing: Promise<void> | undefined, initializeId: RequestId | undefined;
  let initialized = Promise.resolve();
  const shutdown = () => closing ??= (async () => {
    process.stdin.off('end', ended); process.off('SIGINT', ended); process.off('SIGTERM', ended);
    const deadline = setTimeout(() => { void remote.close(); }, 2000); deadline.unref();
    try { await remote.terminateSession().catch(() => {}); }
    finally { clearTimeout(deadline); await remote.close(); await local.close(); process.stdin.pause(); }
  })();
  const ended = () => { void shutdown(); };
  // SDK 的错误可能含服务器响应正文，终端只输出固定提示，防止意外泄漏凭据。
  remote.onerror = error => { if (!closing) console.error(localOnlyRejection(error) ? LOCAL_ONLY_MESSAGE : 'SaltedFish 远程连接异常；请检查地址、网络及 Agent 授权。业务操作不要自动重试。'); };
  local.onerror = () => { console.error('SaltedFish 收到无效 MCP 输入。'); };
  local.onclose = ended;
  remote.onmessage = message => {
    if (closing) return;
    if ('id' in message && message.id === initializeId && 'result' in message && typeof message.result.protocolVersion === 'string') remote.setProtocolVersion(message.result.protocolVersion);
    void local.send(message).catch(ended);
  };
  local.onmessage = message => {
    if (closing) return;
    if ('method' in message && message.method === 'initialize' && 'id' in message) initializeId = message.id;
    const sending = 'method' in message && message.method === 'notifications/initialized' ? initialized = remote.send(message) : initialized.then(() => remote.send(message));
    void sending.catch(async error => {
      if (closing) return;
      if ('method' in message && 'id' in message) await local.send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: localOnlyRejection(error) ? LOCAL_ONLY_MESSAGE : '远程连接失败，结果可能不明。先核对 chrome_operations 和实际页面，不要重复业务操作；检查网络及授权后重连。' } }).catch(() => {});
    });
  };
  process.stdin.once('end', ended); process.once('SIGINT', ended); process.once('SIGTERM', ended);
  await remote.start();
  await local.start();
  return { close: shutdown };
}
