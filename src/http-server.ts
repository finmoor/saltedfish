import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {createServer as createTlsServer} from 'node:https';
import os from 'node:os';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';
import { BrowserService } from './service.js';
import { projectDir, type Config } from './config.js';
import { errorInfo, clipMessage, BrowserError, BRIDGE_PROTOCOL, BRIDGE_NONCE, BRIDGE_PROOF, SERVER_CAPABILITIES, REQUIRED_EXTENSION_CAPABILITY, type JsonObject, type WireReply } from './shared.js';
import { adminPrincipal, bridgeToken, bridgeProof, extensionUpdateProof, equalToken, isShortCode, AdminSessions } from './auth.js';
import { VERSION, PROTOCOL_VERSION, STATE_VERSION } from './version.js';
import { ClientSetup, setupClients, type SetupOptions } from './client-setup.js';
import { RemoteConnector } from './remote-connector.js';
import { clientLaunch } from './client-launch.js';
import { AgentSessionInput, stdioSessionId } from './agent-presence.js';
import { desktopLaunchReady } from './desktop-registration.js';
import { nativeSettingsReady } from './native-settings-registration.js';
import {BrowserPairings,BrowserPairingInput} from './browser-pairings.js';
import {extensionArchive,extensionRelease,extensionVersion} from './extension-download.js';
import {serviceNetwork,serviceIdentity} from './service-network.js';
import {extensionOrigin} from './service-address.js';
import {HttpMcp,refuseOtherMachine,type HttpMcpTiming} from './mcp-http.js';
import {parseDesktopUrl} from './desktop-links.js';
import {validateGatewayTls} from './gateway-tls.js';
import {httpAgentConfigurations,MCP_NAME} from './client-config.js';
import { clientCredential, type CredentialStore } from './client-credentials.js';
import { browserOnServiceMachine } from './browser-upload.js';

// 桥接握手 v2：扩展先发随机 nonce（不带任何密钥和身份），服务用桥接令牌证明自己并回自己的 nonce，
// 扩展验证通过后才发出身份和自己的证明。令牌从不在线上明文传输，旧版（明文 token）握手被明确拒绝。
const BridgeProfile = z.object({
  id: z.string().uuid(), label: z.string().min(1).max(100), instanceId: z.string().uuid(), version: z.string().min(1).max(64), codeVersion: z.string().min(1).max(64).optional(), userAgent: z.string().max(1000), capabilities: z.array(z.string().max(100)).max(30).optional(), account: z.string().max(320).optional(),
});
// v2 保持忽略未认识字段的前向兼容；整条连接的16KiB原始字节预算独立执行。
const BridgeHello = z.object({ type: z.literal('hello'), protocol: z.literal(BRIDGE_PROTOCOL), nonce: z.string().regex(BRIDGE_NONCE),pairingId:z.string().uuid().optional() });
const BridgeAuth = z.object({ type: z.literal('auth'), proof: z.string().regex(BRIDGE_PROOF), profile: BridgeProfile });
const BRIDGE_PRE_AUTH_BYTES = 16 * 1024, BRIDGE_PRE_AUTH_CONNECTIONS = 16;
const LEGACY_EXTENSION = '这个扩展使用旧版握手（会把配对密钥明文发给本机端口），服务已拒绝并没有登记这个浏览器。请打开 chrome://extensions 刷新 SaltedFish 扩展（0.2.10 或更高）；目录、名称、配置 ID 和配对密钥都保持不变，刷新后会自动重连。';
const Invocation = z.object({ name: z.string(), args: z.record(z.string(), z.unknown()), owner: z.string().min(1).max(200) }).strict();
const ClientInput = z.object({ label: z.string().trim().min(1).max(100), profiles: z.union([z.literal('*'), z.array(z.string().uuid()).min(1)]).default('*'), readOnly: z.boolean().default(false), advancedTools: z.boolean().default(false) }).strict();
const ResultFrame = z.object({ type: z.literal('result'), id: z.string().uuid(), result: z.unknown().optional(), error: z.object({ code: z.string().max(100), message: z.string().max(100000),phase:z.enum(['precondition','execution','postcondition']).optional(),outcome:z.enum(['not_dispatched','unknown','dispatched']).optional(),detail:z.record(z.string(),z.unknown()).optional() }).optional() });
const EventFrame = z.object({ type: z.literal('event'), method: z.string().min(1).max(200), tabId: z.number().int().nonnegative().optional(), params: z.record(z.string(), z.unknown()).default({}) });

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) {
    length += (chunk as Buffer).length;
    if (length > 16000000) throw new Error('请求超过 16 MB，请拆分任务。');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(value));
}

export async function startServer(config: Config, options: { setup?: SetupOptions; sessions?: AdminSessions; mcpTiming?: HttpMcpTiming } = {}) {
  let service: BrowserService;
  let remote: RemoteConnector;
  let mcp:HttpMcp;
  const pairings=await BrowserPairings.open(config.dataDir),network=serviceNetwork(config);
  if(config.network?.tls)await validateGatewayTls(config.network.tls,new URL(network.publicUrl).hostname);
  const connectionPairings=new WeakMap<object,string>();
  // pi、agy 第一次接入时才建凭据，和命令行建出来的一样。
  const credentials: CredentialStore = { list: async () => service.state.listClients().map(client => ({ id: String(client.id), revoked: client.revoked })), create: async (label, profiles, readOnly) => service.state.createClient(label, profiles, readOnly), remove: async id => service.state.revokeClient(id) };
  const setup = new ClientSetup(config, { credential: async client => (await clientCredential(config.dataDir, credentials, client, '*', false, true)).tokenFile, ...options.setup });
  const sessions = options.sessions ?? new AdminSessions();
  sessions.setIssuerValidator(issuer=>issuer.startsWith('browser:')&&pairings.managerActive(issuer.slice(8)));
  const dropPairings=(ids:string[])=>{for(const id of ids)sessions.revokeIssuer('browser:'+id);for(const connection of service.broker.profiles.values()){const id=connectionPairings.get(connection.socket);if(id&&ids.includes(id))connection.socket.close(1008,'Pairing revoked');}};
  const {origins,hosts}=network;
  const extensionDirectory=path.join(projectDir,'dist/extension'),packagedExtension=await extensionVersion(extensionDirectory);
  const handler=async (request:IncomingMessage,response:ServerResponse) => {
    try {
      if (!hosts.has(request.headers.host || '')) return json(response, 403, { error: 'INVALID_HOST' });
      const url = new URL(request.url || '/', `http://127.0.0.1:${config.port}`);
      // 配对扩展只能读自己的连接状态，不能取得管理员凭据或修改全机远程设置。
      if (['/extension/remote-status','/extension/agents','/extension/session-code','/extension/update'].includes(url.pathname)) {
        const origin = request.headers.origin;
        if (origin && !extensionOrigin(origin)) return json(response, 403, { error: 'INVALID_ORIGIN' });
        const manager=url.pathname==='/extension/session-code',method=manager?'POST':'GET';
        if (request.method === 'OPTIONS' && origin && request.headers['access-control-request-method'] === method) {
          response.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-methods': method, 'access-control-allow-headers': 'Authorization,Content-Type', 'cache-control': 'no-store' }); return response.end();
        }
        const token = (request.headers.authorization || '').replace(/^Bearer /, '');
        if (request.method !== method) return json(response, 405, { error: 'METHOD_NOT_ALLOWED' });
        const input = z.object({ profileId: z.string().uuid(), instanceId: z.string().uuid(),pairingId:z.string().uuid().optional(),target:z.string().max(192).optional(),nonce:z.string().regex(BRIDGE_NONCE).optional() }).strict().parse(manager?await body(request):Object.fromEntries(url.searchParams));
        const paired=input.pairingId&&(manager?pairings.authorizeManager(input.pairingId,input.profileId,token):pairings.authorize(input.pairingId,input.profileId,token));
        if (!paired&&!(network.legacyBridge&&!manager&&equalToken(token,bridgeToken(config)))) return json(response, 401, { error: 'UNAUTHORIZED' });
        const connection = service.broker.profiles.get(input.profileId);
        if (!connection || connection.info.instanceId !== input.instanceId || connection.socket.readyState !== 1 || input.pairingId&&connectionPairings.get(connection.socket)!==input.pairingId) return json(response, 403, { error: 'PROFILE_NOT_CONNECTED' });
        if (origin) response.setHeader('access-control-allow-origin', origin);
        if(manager){
          const target=parseDesktopUrl(`saltedfish-${config.port}://settings/${input.target||'overview'}`,config.port).target;
          const code=sessions.issueCode('browser:'+input.pairingId),address=new URL(network.publicUrl);
          address.searchParams.set('target',target.route);if(target.profile)address.searchParams.set('profile',target.profile);if(target.add)address.searchParams.set('add',target.add);address.hash=code.code;
          return json(response,200,{url:address.href,expiresAt:new Date(code.expiresAt).toISOString()});
        }
        if(url.pathname==='/extension/update'){
          if(!input.nonce)return json(response,400,{error:'NONCE_REQUIRED'});
          const release=await extensionRelease(extensionDirectory,network.publicUrl);
          return json(response,200,{...release,proof:extensionUpdateProof(token,input.profileId,input.nonce,release.version,release.sha256)});
        }
        const value = remote.status();
        if(url.pathname==='/extension/agents')return json(response,200,{version:VERSION,profileId:input.profileId,unified:true,serviceUrl:network.publicUrl,serviceId:serviceIdentity(config),canManage:!!input.pairingId&&pairings.managerActive(input.pairingId),desktopLaunch:network.legacyBridge&&await desktopLaunchReady(config),nativeLaunch:network.legacyBridge&&await nativeSettingsReady(config),agents:service.agents(input.profileId),groups:await service.groups.list(input.profileId),remote:{enabled:value.enabled,state:value.state,url:value.url,readOnly:value.readOnly,allowed:value.profiles==='*'||value.profiles.includes(input.profileId),...(value.error?{error:value.error}:{})}});
        return json(response, 200, { version: VERSION, enabled: value.enabled, state: value.state, url: value.url, readOnly: value.readOnly,
          allowed: value.profiles === '*' || value.profiles.includes(input.profileId), ...(value.error ? { error: value.error } : {}) });
      }
      // 扩展自己下载更新包：包是公开文件，真假靠 /extension/update 的证明和哈希，所以这里放行扩展来源。
      const origin=request.headers.origin,packageDownload=url.pathname==='/download/extension.zip'&&request.method==='GET',extensionFetch=packageDownload&&extensionOrigin(origin);
      if (origin && !origins.has(origin) && !extensionFetch) return json(response, 403, { error: 'INVALID_ORIGIN' });
      if(packageDownload){const archive=await extensionArchive(extensionDirectory,network.publicUrl);response.writeHead(200,{'content-type':'application/zip','content-length':archive.length,'content-disposition':`attachment; filename="saltedfish-extension-${VERSION}.zip"`,'x-content-type-options':'nosniff','cache-control':'no-store',...(extensionFetch?{'access-control-allow-origin':origin}:{})});response.end(archive);return;}
      if(url.pathname==='/mcp')return await mcp.handle(request,response);
      if (url.pathname === '/health' && request.method === 'GET') return json(response, 200, { service: 'feng-chrome-mcp', version: VERSION, protocolVersion: PROTOCOL_VERSION, stateVersion: STATE_VERSION, profiles: service.broker.listProfiles().length,unified:true,serviceUrl:network.publicUrl,serviceId:serviceIdentity(config),desktopLaunch:network.legacyBridge&&await desktopLaunchReady(config) });
      const assets: Record<string, { file: string; type: string }> = {
        '/': { file: 'index.html', type: 'text/html' }, '/app.js': { file: 'app.js', type: 'text/javascript' }, '/style.css': { file: 'style.css', type: 'text/css' },
        '/product.js': { file: 'product.js', type: 'text/javascript' }, '/product.css': { file: 'product.css', type: 'text/css' },
        '/editor.js': { file: 'editor.js', type: 'text/javascript' },
        '/workspace.js': { file: 'workspace.js', type: 'text/javascript' },
        '/workspace.css': { file: 'workspace.css', type: 'text/css' },
        '/activity.js': { file: 'activity.js', type: 'text/javascript' },
        '/identity.js': { file: 'identity.js', type: 'text/javascript' },
        '/extension-version.js': { file: 'extension-version.js', type: 'text/javascript' },
        '/agents.js': { file: 'agents.js', type: 'text/javascript' },
        '/client-hints.js': { file: 'client-hints.js', type: 'text/javascript' },
        '/agent-view.js': { file: 'agent-view.js', type: 'text/javascript' },
        '/desktop-link.js': { file: 'desktop-link.js', type: 'text/javascript' },
        '/connections.js': {file:'connections.js',type:'text/javascript'},
        '/service-address.js': {file:'service-address.js',type:'text/javascript'},
        '/random-id.js': {file:'random-id.js',type:'text/javascript'},
      };
      if (assets[url.pathname] && request.method === 'GET') {
        const asset = assets[url.pathname]!;
        response.writeHead(200, { 'content-type': `${asset.type}; charset=utf-8`, 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'", 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return response.end(await readFile(path.join(projectDir, 'ui', asset.file)));
      }
      if (url.pathname === '/session' && request.method === 'POST') {
        const credential = (request.headers.authorization || '').replace(/^Bearer /, '');
        const redeemed=equalToken(credential,config.token)?{}:isShortCode(credential)?sessions.consumeShort(credential):sessions.consume(credential);
        if (!redeemed) return json(response, 401, { error: 'UNAUTHORIZED' });
        const session = sessions.open(redeemed.issuer);
        return json(response, 200, { token: session.token, expiresAt: new Date(session.expiresAt).toISOString(), idleSeconds: session.idleSeconds });
      }
      const token = (request.headers.authorization || '').replace(/^Bearer /, '');
      const principal = equalToken(token, config.token) || sessions.verify(token) ? adminPrincipal : service.state.authenticate(token);
      if (!principal) return json(response, 401, { error: 'UNAUTHORIZED' });
      if(principal.admin&&url.pathname==='/browser-pairings'){
        if(request.method==='GET')return json(response,200,{serviceUrl:network.publicUrl,pairings:pairings.list()});
        if(request.method==='POST'){
          const input=BrowserPairingInput.parse(await body(request));
          // 重新连接：原配对的令牌已经找不回来（扩展重装过），换发一个绑定原身份的配对码。在线的浏览器没有这个问题，不能被一个码顶掉。
          if(input.replace&&!input.profileId)throw new BrowserError('PROFILE_REQUIRED','重新连接要指定浏览器。');
          if(input.replace&&service.broker.profiles.has(input.profileId!))throw new BrowserError('PROFILE_ONLINE','这个浏览器在线，不用重新连接。');
          const replaced=input.replace?pairings.list().filter(p=>!p.revoked&&p.profileId===input.profileId).map(p=>p.id):[],pairing=await pairings.create(input);dropPairings(replaced);
          return json(response,201,{...pairing,serviceUrl:network.publicUrl,connectionCode:'sf-connect:'+Buffer.from(JSON.stringify({version:1,serviceUrl:network.publicUrl,...pairing})).toString('base64url')});
        }
      }
      if(principal.admin&&request.method==='DELETE'&&url.pathname.startsWith('/browser-pairings/')){
        const match=/^\/browser-pairings\/([a-f0-9-]{36})(\/management)?$/.exec(url.pathname);if(!match)return json(response,400,{error:'INVALID_PAIRING'});const id=z.string().uuid().parse(match[1]);
        const revoked=await pairings.revoke(id,!!match[2]);
        if(match[2])sessions.revokeIssuer('browser:'+id);else dropPairings([id]);
        return json(response,200,{revoked});
      }
      if(url.pathname==='/client-settings'&&request.method==='GET')return json(response,200,{advancedTools:principal.advancedTools===true});
      if(url.pathname==='/agent-sessions') {
        if(!['POST','DELETE'].includes(request.method||''))return json(response,405,{error:'METHOD_NOT_ALLOWED'});
        const input=AgentSessionInput.parse(await body(request));
        const scoped={...input,owner:`${principal.id}:${input.owner}`};
        return json(response,200,request.method==='POST'?service.presence.heartbeat(principal,scoped):service.presence.remove(principal,scoped));
      }
      if(url.pathname==='/agents'&&request.method==='GET') {
        if(!principal.admin)return json(response,403,{error:{message:'Agent目录仅供本机管理页读取。'}});
        const input=z.object({profileId:z.string().uuid().optional()}).strict().parse(Object.fromEntries(url.searchParams));
        return json(response,200,{version:VERSION,...input,agents:service.agents(input.profileId),groups:await service.groups.list(input.profileId),remote:remote.status()});
      }
      if(url.pathname==='/agent-groups/show'||url.pathname==='/agent-groups/release') {
        if(!principal.admin)return json(response,403,{error:{message:'标签组操作仅供本机管理页使用。'}});
        if(request.method!=='POST')return json(response,405,{error:'METHOD_NOT_ALLOWED'});
        const input=z.object({profileId:z.string().uuid(),groupId:z.number().int()}).strict().parse(await body(request));
        return json(response,200,url.pathname.endsWith('/show')?await service.groups.show(input.profileId,input.groupId):await service.groups.release(input.profileId,input.groupId));
      }
      // 登录码和“全部退出”只能由长期管理员密钥（本机 dashboard 命令）发起；会话令牌不能自我续期成长期凭据。
      if (url.pathname === '/session/code' && request.method === 'POST') {
        if (!equalToken(token, config.token)) return json(response, 403, { error: { message: '登录码只能由本机管理员命令（saltedfish dashboard）签发。' } });
        const issued = sessions.issueCode(undefined, url.searchParams.get('short') === '1');
        return json(response, 200, { code: issued.code, ...(issued.shortCode ? { shortCode: issued.shortCode } : {}), expiresAt: new Date(issued.expiresAt).toISOString() });
      }
      if (url.pathname === '/session' && request.method === 'DELETE') return json(response, 200, { revoked: sessions.revoke(token) });
      if (url.pathname === '/sessions' && request.method === 'DELETE') {
        if (!equalToken(token, config.token)) return json(response, 403, { error: { message: '只有长期管理员密钥可以撤销全部管理页会话。' } });
        return json(response, 200, { revoked: sessions.revokeAll() });
      }
      if (url.pathname === '/dashboard' && request.method === 'GET') {
        if (!principal.admin) return json(response, 403, { error: { message: '请从 SaltedFish 的 dashboard 命令打开管理页。' } });
        return json(response, 200, { version: VERSION, platform: process.platform,unified:true,serviceUrl:network.publicUrl,serviceId:serviceIdentity(config),serviceMachine:os.hostname(),systemSetupAvailable:true,agents:service.agents(),extensionDir: path.join(config.dataDir, 'extension'), requiredExtensionCapability: REQUIRED_EXTENSION_CAPABILITY, extensionRelease: packagedExtension, profiles: service.listProfiles(adminPrincipal), protection: service.protection(), remote: remote.status(), checkedAt: new Date().toISOString() });
      }
      // 放弃一个永远不会再连接的配置（见 BrowserService.abandonProfile）：GET 预览要放弃的记录，POST 带着预览看到的数量二次确认。
      if (principal.admin && url.pathname === '/profiles/abandon') {
        if (request.method === 'GET') return json(response, 200, service.abandonPreview(z.object({ profileId: z.string().min(1).max(200) }).strict().parse(Object.fromEntries(url.searchParams)).profileId));
        if (request.method === 'POST') {
          const input = z.object({ profileId: z.string().min(1).max(200), expectedUnknown: z.number().int().min(0), confirm: z.literal(true) }).strict().parse(await body(request));
          const result = service.abandonProfile(input.profileId, input.expectedUnknown);
          dropPairings(await pairings.revokeProfile(input.profileId));
          return json(response, 200, result);
        }
      }
      if (principal.admin && url.pathname === '/remote') {
        if(config.network)return json(response,410,{error:'LEGACY_RELAY_DISABLED',message:'浏览器直接连接此服务，不再配置中转网关。'});
        if (request.method === 'GET') return json(response, 200, remote.status());
        if (request.method === 'POST') return json(response, 200, await remote.configure(await body(request)));
      }
      if (principal.admin && url.pathname === '/setup/clients' && request.method === 'GET') return json(response, 200, { clients: await setup.detect() });
      if (principal.admin && url.pathname === '/setup/history' && request.method === 'GET') return json(response, 200, { changes: await setup.history() });
      if (principal.admin && request.method === 'POST' && url.pathname.startsWith('/setup/')) {
        if (url.pathname === '/setup/check') {
          const input = z.object({ client: z.enum(setupClients), configPath: z.string().min(1).max(32768).optional(), projectDirectory: z.string().min(1).max(32768).optional(), format: z.enum(['v1','v2']).optional() }).strict().parse(await body(request));
          const { client, ...selection } = input; return json(response, 200, await setup.check(client, selection));
        }
        if (url.pathname === '/setup/preview') {
          const input = z.object({ client: z.enum(setupClients), configPath: z.string().min(1).max(32768).optional(), projectDirectory: z.string().min(1).max(32768).optional(), format: z.enum(['v1','v2']).optional(), trust: z.enum(['preserve','service','prompt']).optional() }).strict().parse(await body(request));
          const { client, ...selection } = input; return json(response, 200, await setup.preview(client, selection));
        }
        if (url.pathname === '/setup/apply') return json(response, 200, await setup.apply(z.object({ planId: z.string().uuid() }).strict().parse(await body(request)).planId));
        if (url.pathname === '/setup/restore') return json(response, 200, await setup.restore(z.object({ changeId: z.string().uuid() }).strict().parse(await body(request)).changeId));
      }
      if (url.pathname.startsWith('/results/') && request.method === 'GET') {
        const id = z.string().uuid().parse(url.pathname.slice('/results/'.length));
        const artifact = service.state.artifact(id);
        if (!artifact || (!principal.admin && (typeof artifact.profileId !== 'string' || (principal.profiles !== '*' && !principal.profiles.includes(artifact.profileId))))) return json(response, 404, { error: 'RESULT_NOT_FOUND' });
        const extension = z.enum(['png', 'json']).parse(artifact.extension);
        response.writeHead(200, { 'content-type': extension === 'png' ? 'image/png' : 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-disposition': `inline; filename="${id}.${extension}"` });
        await pipeline(createReadStream(path.join(config.dataDir, 'results', `${id}.${extension}`)), response);
        return;
      }
      if (url.pathname === '/diagnostics' && request.method === 'GET' && principal.admin) {
        return json(response, 200, { version: VERSION, pid: process.pid, uptimeSeconds: process.uptime(), memory: process.memoryUsage(), resources: service.stats() });
      }
      if (url.pathname === '/admin/shutdown' && request.method === 'POST' && principal.admin) {
        json(response, 202, { stopping: true }); setTimeout(() => server.emit('adminShutdown'), 25); return;
      }
      if (url.pathname === '/clients' && principal.admin) {
        if (request.method === 'GET') return json(response, 200, { clients: service.state.listClients() });
        if (request.method === 'POST') {
          const input = ClientInput.parse(await body(request));
          const created = service.state.createClient(input.label, input.profiles, input.readOnly, input.advancedTools);
          const folder = path.join(config.dataDir, 'clients');
          const tokenFile = path.join(folder, `${created.id}.token`);
          try { await mkdir(folder, { recursive: true }); await writeFile(tokenFile, created.token, { mode: 0o600 }); }
          catch (error) { service.state.revokeClient(created.id); throw error; }
          const { command, args } = clientLaunch();
          return json(response, 201, { ...created, tokenFile,mcpUrl:network.publicUrl+'/mcp',configurations:httpAgentConfigurations(network.publicUrl+'/mcp',created.token),httpConfiguration:{mcpServers:{[MCP_NAME]:{type:'http',url:network.publicUrl+'/mcp',headers:{Authorization:'Bearer '+created.token}}}}, configuration: { mcpServers: { [MCP_NAME]: { command, args, env: { CHROME_MCP_DATA_DIR: config.dataDir, CHROME_MCP_TOKEN_FILE: tokenFile } } } } });
        }
      }
      if (url.pathname.startsWith('/clients/') && request.method === 'PATCH' && principal.admin) {
        const input = z.object({ advancedTools: z.boolean() }).strict().parse(await body(request));
        return json(response, 200, { updated: service.state.setClientTools(url.pathname.slice('/clients/'.length), input.advancedTools), ...input });
      }
      if (url.pathname.startsWith('/clients/') && request.method === 'DELETE' && principal.admin) return json(response, 200, { revoked: service.state.revokeClient(url.pathname.slice('/clients/'.length)) });
      if (url.pathname === '/results' && request.method === 'GET' && principal.admin) { const stats = service.stats(); return json(response, 200, { bytes: stats.resultBytes, untrackedBytes: stats.untrackedResultBytes, limit: config.resultByteLimit ?? 1024 * 1024 * 1024, items: service.state.listArtifacts() }); }
      if (url.pathname.startsWith('/results/') && request.method === 'DELETE' && principal.admin) {
        const id = z.string().uuid().parse(url.pathname.slice('/results/'.length));
        const artifact = service.state.artifact(id);
        if (!artifact) return json(response, 404, { error: 'RESULT_NOT_FOUND' });
        const extension = z.enum(['json', 'png']).parse(artifact.extension);
        await rm(path.join(config.dataDir, 'results', `${id}.${extension}`), { force: true });
        service.resultReader.forget(path.join(config.dataDir, 'results', `${id}.${extension}`));
        service.state.removeArtifact(id); return json(response, 200, { removed: id });
      }
      if (url.pathname === '/rpc' && request.method === 'POST') {
        // 和 /mcp 同一套工具：Agent 令牌只能从本机用（管理页会话是管理员，可以从内网打开）。
        if (!principal.admin && refuseOtherMachine(request, response)) return;
        const input = Invocation.parse(await body(request)), owner = `${principal.id}:${input.owner}`, sessionId = stdioSessionId(input.owner);
        // 达到会话上限就按没有会话处理，和登记失败时一样。
        if (sessionId) try { service.presence.touch(principal, { sessionId, owner }); } catch { /* 不影响调用。 */ }
        return json(response, 200, await service.invoke(input.name, input.args, owner, principal));
      }
      return json(response, 404, { error: 'NOT_FOUND' });
    } catch (error) { if (!response.headersSent) json(response, 400, { ok: false, error: errorInfo(error) }); else response.end(); }
  };
  const server=config.network?.tls?createTlsServer({cert:await readFile(config.network.tls.cert),key:await readFile(config.network.tls.key)},handler):createServer(handler);
  const local=config.network?.localPort?createServer(handler):undefined;
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 * 1024 });
  // 鉴权通过前整条连接最多接收 16 KiB（含帧头），同时最多 16 条未鉴权连接：无凭据的本机进程不能让服务缓冲大帧。
  // 鉴权通过后才放宽到正常业务所需（结果可达 128 MiB）。
  const preAuth = new Map<object, { received: number; stop: () => void }>();
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/bridge' || !hosts.has(request.headers.host || '') || !extensionOrigin(request.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
    }
    if (preAuth.size >= BRIDGE_PRE_AUTH_CONNECTIONS || head.length > BRIDGE_PRE_AUTH_BYTES) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    const entry = { received: head.length, stop: () => {} };
    const count = (chunk: Buffer) => { entry.received += chunk.length; if (entry.received > BRIDGE_PRE_AUTH_BYTES) socket.destroy(); };
    entry.stop = () => { socket.off('data', count); preAuth.delete(request); };
    preAuth.set(request, entry);
    websocket.handleUpgrade(request, socket, head, client => websocket.emit('connection', client, request));
    // 必须排在 ws 自己的解析监听之前：超限的数据块要在被解析、被当成握手帧处理之前就断开连接。
    socket.prependListener('data', count); socket.once('close', entry.stop);
  });
  websocket.on('connection', (socket, request) => {
    let profileId: string | undefined, stage: 'hello' | 'auth' | 'binding' | 'ready' = 'hello', clientNonce = '', serverNonce = '',pairingId:string|undefined;
    let alive = true;
    const timer = setTimeout(() => { socket.close(1008, 'Handshake timeout'); setTimeout(() => socket.terminate(), 1000).unref(); }, 5000);
    const ping = setInterval(() => { if (!alive) return socket.terminate(); alive = false; socket.ping(); }, 30000);
    socket.on('pong', () => { alive = true; });
    socket.on('error', () => {});
    let token = '';
    const refuse = (message: string, code?: string) => { socket.send(JSON.stringify({ type: 'rejected', ...(code ? { code } : {}), message })); socket.close(1008); };
    // 握手完成后，对端已经证明持有配对密钥，一帧不合格只处理这一帧：断开整条连接会让这个浏览器上所有在途命令都变成结果不明。
    const readyFrame = (raw: RawData) => {
      let message: JsonObject;
      try { message = JSON.parse(raw.toString()) as JsonObject; } catch { return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      if (message.type === 'result') {
        const error = message.error as JsonObject | undefined;
        // 旧扩展不截断错误消息（页面抛几百 KB 的错误也原样发来），这里先截短再校验。
        if (error && typeof error === 'object' && typeof error.message === 'string') error.message = clipMessage(error.message);
        const frame = ResultFrame.safeParse(message);
        if (frame.success) return service.broker.receive(socket, frame.data as WireReply);
        // 认得出是哪条命令就只让这一条失败；扩展那边做了什么不知道，按结果不明处理，不能让它干等到超时。
        if (typeof message.id === 'string') service.broker.receive(socket, { type: 'result', id: message.id, error: { code: 'INVALID_RESULT_FRAME', message: '扩展回传的结果格式不对，没法确认这一步做了什么。先检查页面，不要重复原操作。', phase: 'execution', outcome: 'unknown' } });
        return;
      }
      if (message.type === 'event') {
        const event = EventFrame.safeParse(message);
        if (event.success) service.broker.addEvent(profileId!, event.data.tabId, event.data.method, event.data.params);
        return;
      }
      if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
    };
    socket.on('message', async raw => {
      if (stage === 'ready') { try { readyFrame(raw); } catch { /* 只丢这一帧 */ } return; }
      try {
        const message = JSON.parse(raw.toString()) as JsonObject;
        if (stage === 'hello') {
          if (message.type === 'hello' && typeof message.token === 'string' && message.nonce === undefined) return refuse(LEGACY_EXTENSION, 'EXTENSION_UPDATE_REQUIRED');
          const hello=BridgeHello.parse(message);pairingId=hello.pairingId;
          if(pairingId){const record=pairings.get(pairingId);if(!record)return refuse('浏览器配对不存在或已撤销。','PAIRING_REVOKED');token=record.token;}
          else{if(!network.legacyBridge)return refuse('请使用此服务生成的浏览器配对信息。','PAIRING_REQUIRED');token=bridgeToken(config);}
          clientNonce = hello.nonce; serverNonce = randomBytes(16).toString('hex');
          socket.send(JSON.stringify({ type: 'challenge', nonce: serverNonce, proof: bridgeProof(token, 'server', clientNonce, serverNonce) })); stage = 'auth';
        } else if (stage === 'auth') {
          const auth = BridgeAuth.parse(message);
          if (!equalToken(auth.proof, bridgeProof(token, 'client', clientNonce, serverNonce, auth.profile.id, auth.profile.instanceId))) throw new Error('扩展配对密钥不匹配。请用当前版本 setup 生成的扩展配对文件，管理员密钥不能用于扩展连接。');
          stage='binding';
          if(pairingId){await pairings.bind(pairingId,auth.profile.id);if(!pairings.authorize(pairingId,auth.profile.id,token))throw new Error('配对已撤销。');connectionPairings.set(socket,pairingId);}
          if(socket.readyState!==1)return;
          service.broker.connect({...auth.profile,connectionType:pairingId?'direct':'legacy',sameMachine:!!pairingId&&browserOnServiceMachine(request.socket.remoteAddress,request.socket.localAddress,auth.profile.userAgent)}, socket); profileId = auth.profile.id; service.state.rememberProfile(auth.profile);
          preAuth.get(request)?.stop(); clearTimeout(timer); stage = 'ready';
          socket.send(JSON.stringify({ type: 'ready', capabilities: SERVER_CAPABILITIES,serviceUrl:network.publicUrl,serviceId:serviceIdentity(config),unified:true,adminOrigins:[...origins],canManage:!!pairingId&&pairings.managerActive(pairingId),...(packagedExtension?{extensionRelease:packagedExtension}:{}) }));
        } else throw new Error('握手尚未完成。');
      } catch (error) {
        refuse(errorInfo(error).message);
      }
    });
    socket.on('close', () => {
      clearTimeout(timer); clearInterval(ping); preAuth.get(request)?.stop(); service.broker.disconnect(socket);
      // 记下最后在线时间；服务正在关闭时数据库可能已经关了。
      if (profileId) try { service.state.touchProfile(profileId); } catch { /* 不影响断开处理 */ }
    });
  });
  try{
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, network.host, resolve); });
    if(local)await new Promise<void>((resolve,reject)=>{local.once('error',reject);local.listen(config.network!.localPort!,'127.0.0.1',resolve);});
    service = new BrowserService(config);mcp=new HttpMcp(service,options.mcpTiming);remote = new RemoteConnector(service);if(network.legacyBridge)await remote.start();
  }catch(error){server.close();local?.close();websocket.close();throw error;}
  const maintenance = setInterval(() => service.broker.pruneExpiredLeases(), 30000); maintenance.unref();
  let closing: Promise<void> | undefined;
  return { service, server, remote, sessions,pairings,async reloadTls(){
    if(!config.network?.tls||!('setSecureContext' in server))return{reloaded:false};
    if(closing)throw new Error('服务正在关闭。');
    await validateGatewayTls(config.network.tls,new URL(network.publicUrl).hostname);
    const[cert,key]=await Promise.all([readFile(config.network.tls.cert),readFile(config.network.tls.key)]);
    if(closing)throw new Error('服务正在关闭。');
    server.setSecureContext({cert,key});return{reloaded:true};
  }, close() {
    if (closing) return closing;
    closing = (async () => {
    clearInterval(maintenance);
    remote.close();
    await mcp.close();
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    const localClosed=local?new Promise<void>(resolve=>local.close(()=>resolve())):Promise.resolve();
    for (const client of websocket.clients) client.terminate();
    await service.close(); server.closeAllConnections();local?.closeAllConnections();await Promise.all([closed,localClosed]); websocket.close();
    })();
    return closing;
  } };
}
