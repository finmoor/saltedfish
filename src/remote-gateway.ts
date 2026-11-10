import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createBrowserMcp, callTimeoutMs } from './mcp.js';
import { equalToken } from './auth.js';
import type { JsonObject } from './shared.js';
import type { ResultEnvelope } from './service.js';
import { VERSION } from './version.js';
import { REMOTE_PROTOCOL, REMOTE_FRAME_BYTES, RemoteAgent, RemoteHello, RemoteReply, RemoteOnboarding,type RemoteOnboardingValue, REMOTE_MACHINE_HEADER, parseRemoteMachineReport, normalizePeerAddress, type RemoteAgentSourceValue } from './remote-protocol.js';

const token = z.string().regex(/^[a-f0-9]{64}$/);
export const GatewayConfig = z.object({
  host: z.string().default('127.0.0.1'), port: z.number().int().min(1024).max(65535).default(18443),
  tls: z.object({ cert: z.string(), key: z.string() }).optional(), localPort: z.number().int().min(1024).max(65535).optional(),
  allowedHosts: z.array(z.string().min(1).max(255)).max(20).default([]),
  devices: z.array(z.object({ id: z.string().uuid(), label: z.string().min(1).max(100), token }).strict()).min(1).max(64),
  agents: z.array(RemoteAgent.extend({ token, deviceId: z.string().uuid() })).min(1).max(64),
}).strict().superRefine((config, ctx) => {
  const ids = new Set(config.devices.map(d => d.id));
  if (ids.size !== config.devices.length || new Set(config.agents.map(a => a.id)).size !== config.agents.length) ctx.addIssue({ code: 'custom', message: '身份 ID 不能重复' });
  const tokens = [...config.devices, ...config.agents].map(item => item.token);
  if (new Set(tokens).size !== tokens.length) ctx.addIssue({ code: 'custom', message: '设备接入与 agent 控制 Token 必须分别生成' });
  if (config.agents.some(agent => !ids.has(agent.deviceId))) ctx.addIssue({ code: 'custom', message: 'agent 指定的设备不存在' });
  if (!config.tls && !['127.0.0.1', '::1'].includes(config.host)) ctx.addIssue({ code: 'custom', message: '非回环监听需要 TLS 证书' });
  if (config.localPort === config.port) ctx.addIssue({ code: 'custom', message: '回环端口和 TLS 端口不能相同' });
});
type Settings = z.infer<typeof GatewayConfig>;
type Agent = Settings['agents'][number];
type Link = { socket: WebSocket; ready: boolean };
type Pending = { socket: WebSocket; resolve: (result: ResultEnvelope) => void; timer: NodeJS.Timeout };
type Session = { transport: StreamableHTTPServerTransport; mcp: ReturnType<typeof createBrowserMcp>; agentId: string; authorizationRevision: string; source:RemoteAgentSourceValue; touched: number; active: number };
const SOURCE_HISTORY_MS=24*60*60*1000;
const failure = (code: string, message: string): ResultEnvelope => ({ ok: false, error: { code, message } });
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage) {
  const parts: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) throw new Error('Request too large'); parts.push(chunk); }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
export async function startGateway(input: unknown, options:{agentConfigFile?:string;onboarding?:RemoteOnboardingValue}={}) {
  const config = GatewayConfig.parse(input);
  const onboarding=options.onboarding?RemoteOnboarding.parse(options.onboarding):undefined;
  const links = new Map<string, Link>(), pending = new Map<string, Pending>(), sessions = new Map<string, Session>();
  const creating = new Set<Session>(); let closing = false, httpActive = 0;
  const presenceTimers=new Map<string,NodeJS.Timeout>();
  const authorizationRevisions=new Map(config.agents.map(agent=>[agent.id,randomUUID()]));
  // 只在内存保留最近来源。公开来源 ID 不暴露 MCP session ID，不作为机器或权限凭据。
  const sourceHistory=new Map<string,RemoteAgentSourceValue[]>();
  const recentSources=(id:string)=>{
    const recent=(sourceHistory.get(id)||[]).filter(source=>Date.now()-Date.parse(source.observedAt)<SOURCE_HISTORY_MS).slice(0,8);
    if(recent.length)sourceHistory.set(id,recent);else sourceHistory.delete(id);
    return recent;
  };
  const rememberSource=(session:Session)=>{
    if(authorizationRevisions.get(session.agentId)!==session.authorizationRevision)return;
    sourceHistory.set(session.agentId,[{...session.source,connected:false},...recentSources(session.agentId).filter(source=>source.id!==session.source.id)].slice(0,8));
  };
  const observeSource=(request:IncomingMessage,source?:RemoteAgentSourceValue):RemoteAgentSourceValue=>{
    const report=parseRemoteMachineReport(request.headers[REMOTE_MACHINE_HEADER]),peerAddress=normalizePeerAddress(request.socket.remoteAddress);
    return {id:source?.id||randomUUID(),reportedAddresses:[],...source,...report,peerAddress,observedAt:new Date().toISOString(),connected:true};
  };
  let agentReloadError:string|undefined,reloading=false,agentFileBytes:string|undefined;
  const remoteAgentSnapshot=(deviceId:string)=>({type:'agents',agents:config.agents.filter(agent=>agent.deviceId===deviceId).map(agent=>{
    const active=[...sessions.values()].filter(session=>session.agentId===agent.id);
    const sources=[...active.map(session=>({...session.source,connected:true})),...recentSources(agent.id)].slice(0,8);
    return {id:agent.id,label:agent.label,profiles:agent.profiles,readOnly:agent.readOnly,authorizationRevision:authorizationRevisions.get(agent.id),sessionCount:active.length,activeOperations:active.reduce((n,s)=>n+s.active,0),sources,...(active.length?{lastSeenAt:new Date(Math.max(...active.map(s=>s.touched))).toISOString()}: {})};
  })});
  const publishPresence=(deviceId:string,immediate=false)=>{
    if(closing)return;
    const publish=()=>{presenceTimers.delete(deviceId);const link=links.get(deviceId);if(link?.ready&&link.socket.readyState===WebSocket.OPEN&&link.socket.bufferedAmount<REMOTE_FRAME_BYTES)link.socket.send(JSON.stringify(remoteAgentSnapshot(deviceId)));};
    if(immediate){const timer=presenceTimers.get(deviceId);if(timer)clearTimeout(timer);publish();}
    else if(!presenceTimers.has(deviceId)){const timer=setTimeout(publish,250);timer.unref();presenceTimers.set(deviceId,timer);}
  };
  const reloadAgents=async(inputAgents:unknown)=>{
    const next=GatewayConfig.parse({...config,agents:inputAgents}).agents;
    const changed=new Set(config.agents.filter(old=>!next.some(agent=>agent.id===old.id&&JSON.stringify(agent)===JSON.stringify(old))).map(agent=>agent.id));
    for(const id of authorizationRevisions.keys())if(!next.some(agent=>agent.id===id))authorizationRevisions.delete(id);
    for(const agent of next)if(changed.has(agent.id)||!authorizationRevisions.has(agent.id))authorizationRevisions.set(agent.id,randomUUID());
    for(const id of changed)sourceHistory.delete(id);
    config.agents=next;
    await Promise.all([...sessions.values(),...creating].filter(session=>changed.has(session.agentId)).map(session=>session.mcp.close()));
    for(const device of config.devices)publishPresence(device.id,true);
    agentReloadError=undefined;
    return {updated:true,agents:next.length,closedSessionsForChangedAgents:changed.size};
  };
  const refreshAgents=async()=>{
    if(!options.agentConfigFile||reloading||closing)return;reloading=true;
    try{
      const text=await readFile(options.agentConfigFile,'utf8');if(text===agentFileBytes)return;
      const next=GatewayConfig.parse(JSON.parse(text));
      if(JSON.stringify({...next,agents:[]})!==JSON.stringify({...config,agents:[]}))throw new Error('Configuration beyond agents changed');
      await reloadAgents(next.agents);agentFileBytes=text;
    }catch{agentReloadError='Agent配置未能热加载；保持上次有效授权。仅允许更新agents，设备、监听和TLS需要单独维护。';}
    finally{reloading=false;}
  };
  const allowedHosts = new Set([...config.allowedHosts, `${config.host}:${config.port}`, `localhost:${config.port}`, `127.0.0.1:${config.port}`,
    ...(config.localPort ? [`127.0.0.1:${config.localPort}`, `localhost:${config.localPort}`] : [])]);
  const authorized = (request: IncomingMessage) => {
    const value = request.headers.authorization;
    return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : '';
  };
  const invoke = async (agent: Agent, owner: string, name: string, args: JsonObject): Promise<ResultEnvelope> => {
    if(!config.agents.some(current=>current.id===agent.id&&JSON.stringify(current)===JSON.stringify(agent)))return failure('REMOTE_AGENT_REVOKED','Agent授权已撤销或变化；后续调用未派发。');
    const link = links.get(agent.deviceId);
    if (!link?.ready || link.socket.readyState !== WebSocket.OPEN) return failure('REMOTE_DEVICE_OFFLINE', '指定电脑未连接；不会切换到其他电脑或 Chrome。');
    if (pending.size >= 128 || [...pending.values()].filter(item => item.socket === link.socket).length >= 64) return failure('REMOTE_BUSY', '远程请求已达上限，此次操作未开始。');
    // 和 stdio 适配器同一个口径（job_status 按 waitMs 算）；上限 340 秒，够 waitMs 300 秒加余量（全局评审 U46）。
    const id = randomUUID(), timeout = Math.min(340000, Math.max(1000, callTimeoutMs(name, args)));
    const { token: _, deviceId: __, ...principal } = agent;
    const wire = JSON.stringify({ type: 'call', id, owner, agent: {...principal,authorizationRevision:authorizationRevisions.get(agent.id)}, name, args, deadline: Date.now() + timeout });
    if (Buffer.byteLength(wire) > 4 * 1024 * 1024 || link.socket.bufferedAmount > REMOTE_FRAME_BYTES) return failure('REMOTE_BUSY', '请求过大或连接拥塞，此次操作未开始。');
    return new Promise(resolve => {
      const timer = setTimeout(() => { pending.delete(id); resolve(failure('REMOTE_RESULT_UNKNOWN', '远程结果超时，操作可能已完成。先查询 chrome_operations 和实际页面，禁止自动重试。')); }, timeout);
      pending.set(id, { socket: link.socket, timer, resolve });
      link.socket.send(wire, error => { if (error) settle(id, failure('REMOTE_RESULT_UNKNOWN', '发送连接中断，结果待核查。禁止自动重试。')); });
    });
  };
  function settle(id: string, result: ResultEnvelope) { const item = pending.get(id); if (item) { pending.delete(id); clearTimeout(item.timer); item.resolve(result); } }
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (closing) return json(response, 503, { error: 'GATEWAY_STOPPING' });
      if (!allowedHosts.has(request.headers.host || '') || request.headers.origin) return json(response, 403, { error: 'INVALID_HOST_OR_ORIGIN' });
      if (request.url === '/health' && request.method === 'GET') return json(response, 200, { service: 'feng-chrome-gateway', version: VERSION,...(agentReloadError?{agentReloadError}:{}) });
      if (request.url !== '/mcp') return json(response, 404, { error: 'NOT_FOUND' });
      const agent = config.agents.find(item => equalToken(item.token, authorized(request)));
      if (!agent) return json(response, 401, { error: 'UNAUTHORIZED' });
      if (!['POST', 'GET', 'DELETE'].includes(request.method || '')) return json(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      if (httpActive >= 128) return json(response, 429, { error: 'REMOTE_BUSY' });
      httpActive++; response.once('close', () => httpActive--);
      const parsed = request.method === 'POST' ? await body(request) : undefined;
      if(!config.agents.some(current=>current.id===agent.id&&JSON.stringify(current)===JSON.stringify(agent)))return json(response,401,{error:'UNAUTHORIZED'});
      const sessionId = request.headers['mcp-session-id'];
      let session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
      if (sessionId && (!session || session.agentId !== agent.id)) return json(response, 404, { error: 'SESSION_NOT_FOUND' });
      if (!session) {
        if (sessionId || request.method !== 'POST' || !isInitializeRequest(parsed)) return json(response, 400, { error: 'INITIALIZE_REQUIRED' });
        if (sessions.size + creating.size >= 64 || [...sessions.values(), ...creating].filter(item => item.agentId === agent.id).length >= 8) return json(response, 429, { error: 'SESSION_CAPACITY' });
        const owner = randomUUID();
        let entry: Session;
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true,
          onsessioninitialized: id => { creating.delete(entry); sessions.set(id, entry); publishPresence(agent.deviceId); } });
        const mcp = createBrowserMcp(async (name, args) => { entry.active++; publishPresence(agent.deviceId); try { return await invoke(agent, owner, name, args); } finally { entry.active--; entry.touched = Date.now();publishPresence(agent.deviceId); } },undefined,{advancedTools:true}); // 旧网关的 Agent 没有目录开关，保持原有工具。
        entry = { transport, mcp, agentId: agent.id, authorizationRevision:authorizationRevisions.get(agent.id)!,source:observeSource(request),touched: Date.now(), active: 0 }; session = entry; creating.add(entry);
        try {
          await mcp.connect(transport);
          const previous = transport.onclose;
          transport.onclose = () => { previous?.(); creating.delete(entry); if (transport.sessionId&&sessions.delete(transport.sessionId))rememberSource(entry);publishPresence(agent.deviceId); };
          await transport.handleRequest(request, response, parsed);
        } finally { if (creating.delete(entry)) await mcp.close(); }
        return;
      }
      session.touched = Date.now();session.source=observeSource(request,session.source);publishPresence(agent.deviceId); await session.transport.handleRequest(request, response, parsed);
    } catch { if (!response.headersSent) json(response, 400, { error: 'INVALID_REQUEST' }); else response.end(); }
  };
  const server = config.tls ? createTlsServer({ cert: await readFile(config.tls.cert), key: await readFile(config.tls.key) }, handler) : createServer(handler);
  const local = config.localPort ? createServer(handler) : undefined;
  const websocket = new WebSocketServer({ noServer: true, maxPayload: REMOTE_FRAME_BYTES, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    const device = config.devices.find(item => equalToken(item.token, authorized(request)));
    const code = !device ? 401 : links.has(device.id) ? 409 : 403;
    if (closing || !device || links.has(device.id) || request.url !== '/connect' || request.headers.origin || !allowedHosts.has(request.headers.host || '')) { socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\n\r\n`); return; }
    websocket.handleUpgrade(request, socket, head, client => {
      const link: Link = { socket: client, ready: false }; links.set(device.id, link);
      let alive = true;
      const handshake = setTimeout(() => client.terminate(), 5000);
      const heartbeat = setInterval(() => { if (!alive) return client.terminate(); alive = false; client.ping(); }, 15000); heartbeat.unref();
      client.on('pong', () => { alive = true; }); client.on('error', () => {});
      client.on('message', raw => {
        try {
          const message = JSON.parse(raw.toString());
          if (!link.ready) {
            const hello = RemoteHello.parse(message);
            if (hello.version !== VERSION) throw new Error('Version mismatch');
            link.ready = true; clearTimeout(handshake);
            client.send(JSON.stringify({ type: 'ready', protocol: REMOTE_PROTOCOL, version: VERSION, deviceId: device.id, label: device.label,...(onboarding?{onboarding}:{}) }));publishPresence(device.id,true); return;
          }
          const reply = RemoteReply.parse(message);
          if (pending.get(reply.id)?.socket === client) settle(reply.id, reply.result as unknown as ResultEnvelope);
        } catch { client.close(1008, 'Protocol or version mismatch'); }
      });
      client.on('close', () => {
        clearTimeout(handshake); clearInterval(heartbeat); if (links.get(device.id) === link) links.delete(device.id);
        for (const [id, item] of pending) if (item.socket === client) settle(id, failure('REMOTE_RESULT_UNKNOWN', '电脑连接中断，已派发操作的结果待核查。重连不会重放请求。'));
      });
    });
  });
  const maintenance = setInterval(() => {
    for (const session of sessions.values()) if (!session.active && Date.now() - session.touched > 30 * 60 * 1000) void session.mcp.close();
    for(const [id,history] of sourceHistory)if(history.some(source=>Date.now()-Date.parse(source.observedAt)>=SOURCE_HISTORY_MS)) {
      recentSources(id);const agent=config.agents.find(item=>item.id===id);if(agent)publishPresence(agent.deviceId);
    }
  }, 60000); maintenance.unref();
  const agentReload=setInterval(()=>void refreshAgents(),2000);agentReload.unref();
  const listen = (target: typeof server | NonNullable<typeof local>, port: number, host: string) => new Promise<void>((resolve, reject) => { target.once('error', reject); target.listen(port, host, resolve); });
  try { await listen(server, config.port, config.host); if (local) await listen(local, config.localPort!, '127.0.0.1'); }
  catch (error) { clearInterval(maintenance);clearInterval(agentReload); server.close(); local?.close(); websocket.close(); throw error; }
  for (const target of [server, local].filter(Boolean) as typeof server[]) { target.requestTimeout = 15000; target.headersTimeout = 10000; target.maxConnections = 256; }
  return { server, config, reloadAgents,stats: () => ({ devices: [...links.values()].filter(link => link.ready).length, sessions: sessions.size, pending: pending.size,...(agentReloadError?{agentReloadError}:{}) }),
    async close() {
      if (closing) return; closing = true; clearInterval(maintenance);clearInterval(agentReload);for(const timer of presenceTimers.values())clearTimeout(timer);presenceTimers.clear();
      for (const link of links.values()) link.socket.terminate();
      for (const [id] of pending) settle(id, failure('REMOTE_RESULT_UNKNOWN', '网关停止，先核查操作结果，不自动重试。'));
      await Promise.all([...sessions.values(), ...creating].map(session => session.mcp.close()));
      await Promise.all([server, local].filter(Boolean).map(target => new Promise<void>(resolve => { target!.close(() => resolve()); target!.closeAllConnections(); })));
      sourceHistory.clear();websocket.close();
    } };
}
