import {randomUUID} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {isInitializeRequest} from '@modelcontextprotocol/sdk/types.js';
import {createBrowserMcp} from './mcp.js';
import type {BrowserService} from './service.js';
import type {Principal} from './auth.js';
import {BrowserError,NOT_DISPATCHED} from './shared.js';
import {parseRemoteMachineReport,normalizePeerAddress,REMOTE_MACHINE_HEADER,type RemoteAgentSourceValue} from './remote-protocol.js';

type Session={transport:StreamableHTTPServerTransport;mcp:ReturnType<typeof createBrowserMcp>;principal:Principal;owner:string;id:string;initialized:boolean;clientInfo?:{name:string;version?:string};source:RemoteAgentSourceValue;local:boolean;touched:number;active:number;streams:number;streamClosedAt?:number};
// 会话什么时候算结束：客户端开过 GET 推送流，流断了又过了 streamGraceMs 没有新请求，就是客户端退出了；从没开过流的客户端只能按空闲 idleMs 算。
// 宽限期留给网络抖动和客户端重连推送流；电脑睡眠更久的，醒来按原会话 ID 接上，标签组要重新接管。
export interface HttpMcpTiming {sweepMs:number;idleMs:number;streamGraceMs:number}
const TIMING:HttpMcpTiming={sweepMs:10000,idleMs:30*60*1000,streamGraceMs:2*60*1000};
const SESSION_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const json=(response:ServerResponse,status:number,error:string)=>{response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify({error}));};
const signature=(p:Principal)=>JSON.stringify([p.id,p.profiles,p.readOnly,p.submissionScope]);
async function body(request:IncomingMessage){const parts:Buffer[]=[];let bytes=0;const timer=setTimeout(()=>request.destroy(new Error('Request body timeout')),10000);timer.unref();try{for await(const chunk of request){bytes+=chunk.length;if(bytes>4*1024*1024)throw new Error('Request too large');parts.push(chunk);}return JSON.parse(Buffer.concat(parts).toString('utf8'));}finally{clearTimeout(timer);}}
// Agent 只能从服务所在的电脑连：连接两端地址相同（回环或本机网卡）才放行，别的电脑连 /mcp 和 /rpc 一律拒绝（/rpc 只限非管理员，管理页会话不受影响）。
// 文件读写交给 Agent 自己的 harness 决定（upload-policy.ts），前提就是 Agent 和服务在同一台电脑上。浏览器扩展（/bridge）和管理页不受这条限制。
export function fromThisMachine(remoteAddress:string|undefined,localAddress:string|undefined){
  const peer=normalizePeerAddress(remoteAddress),here=normalizePeerAddress(localAddress);
  return !!peer&&(peer===here||peer==='::1'||/^127\./.test(peer));
}
/** 不是本机来的连接：回 403 MCP_LOCAL_ONLY 并返回 true。/mcp 和 /rpc 共用。 */
export function refuseOtherMachine(request:IncomingMessage,response:ServerResponse){
  if(fromThisMachine(request.socket.remoteAddress,request.socket.localAddress))return false;
  response.writeHead(403,{'content-type':'application/json','cache-control':'no-store'});
  response.end(JSON.stringify({error:'MCP_LOCAL_ONLY',message:'SaltedFish 只接受和服务在同一台电脑上的 Agent。请把 Agent 装在服务所在的电脑上，或在 Agent 那台电脑上装 SaltedFish 服务。'}));
  return true;
}
// 同一台电脑连自己的地址时，连接两端的 IP 相同；带机器登记头的按它报告的显示。
const sameMachine=(request:IncomingMessage)=>!request.headers[REMOTE_MACHINE_HEADER]&&fromThisMachine(request.socket.remoteAddress,request.socket.localAddress);
// SDK 没有恢复会话的接口。版本锁在 package-lock 里，内部字段变了 unified-service 的测试会失败。
function resumeTransport(transport:StreamableHTTPServerTransport,id:string){const inner=(transport as unknown as {_webStandardTransport:{sessionId?:string;_initialized:boolean}})._webStandardTransport;inner.sessionId=id;inner._initialized=true;}
function source(request:IncomingMessage,previous?:RemoteAgentSourceValue):RemoteAgentSourceValue{return{id:previous?.id??randomUUID(),reportedAddresses:[],...previous,...parseRemoteMachineReport(request.headers[REMOTE_MACHINE_HEADER]),peerAddress:normalizePeerAddress(request.socket.remoteAddress),observedAt:new Date().toISOString(),connected:true};}

/** HTTP与stdio调用同一个BrowserService；每条MCP会话独立owner，没有第二个调度层。 */
export class HttpMcp {
  private sessions=new Map<string,Session>();private creating=new Set<Session>();private active=0;private closed=false;
  private requestsByPrincipal=new Map<string,number>();
  private timer:NodeJS.Timeout;
  constructor(private service:BrowserService,private timing:HttpMcpTiming=TIMING){this.timer=setInterval(()=>{for(const session of this.sessions.values()){const current=this.service.state.principal(session.principal.id);if(!current||signature(current)!==signature(session.principal)||!session.active&&(Date.now()-session.touched>this.timing.idleMs||this.streamGone(session)))void session.mcp.close();else this.heartbeat(session);}},this.timing.sweepMs);this.timer.unref();}
  private streamGone(entry:Session){const now=Date.now();return entry.streamClosedAt!==undefined&&!entry.streams&&now-entry.streamClosedAt>this.timing.streamGraceMs&&now-entry.touched>this.timing.streamGraceMs;}
  private watchStream(entry:Session,request:IncomingMessage,response:ServerResponse){if(request.method!=='GET')return;entry.streams++;response.once('close',()=>{entry.streams--;entry.streamClosedAt=Date.now();});}
  private heartbeat(entry:Session){if(!entry.initialized||this.closed)return;try{this.service.presence.heartbeat(entry.principal,{sessionId:entry.id,owner:entry.principal.id+':'+entry.owner,clientInfo:entry.clientInfo},entry.local?{transport:'http',local:true}:{transport:'http',source:entry.source});}catch{void entry.mcp.close();}}
  private forget(entry:Session){this.creating.delete(entry);if(entry.transport.sessionId)this.sessions.delete(entry.transport.sessionId);this.service.presence.remove(entry.principal,{sessionId:entry.id,owner:entry.principal.id+':'+entry.owner});}
  async handle(request:IncomingMessage,response:ServerResponse){
    try{
      if(this.closed)return json(response,503,'SERVICE_STOPPING');
      if(refuseOtherMachine(request,response))return;
      if(!['POST','GET','DELETE'].includes(request.method||''))return json(response,405,'METHOD_NOT_ALLOWED');
      const token=(request.headers.authorization||'').replace(/^Bearer /,'');const principal=this.service.state.authenticate(token);
      if(!principal)return json(response,401,'UNAUTHORIZED');
      const own=this.requestsByPrincipal.get(principal.id)||0;if(this.active>=128||own>=32)return json(response,429,'MCP_BUSY');this.active++;this.requestsByPrincipal.set(principal.id,own+1);response.once('close',()=>{this.active--;const left=(this.requestsByPrincipal.get(principal.id)||1)-1;if(left)this.requestsByPrincipal.set(principal.id,left);else this.requestsByPrincipal.delete(principal.id);});
      const parsed=request.method==='POST'?await body(request):undefined;
      const fresh=this.service.state.authenticate(token);if(!fresh||signature(fresh)!==signature(principal))return json(response,401,'UNAUTHORIZED');
      const sessionId=request.headers['mcp-session-id'];let entry=typeof sessionId==='string'?this.sessions.get(sessionId):undefined;
      if(entry&&signature(entry.principal)!==signature(principal))return json(response,404,'SESSION_NOT_FOUND');
      if(!entry){
        // 服务重启后客户端还拿着原来的会话，不是每个客户端都会重新初始化。按原 ID 接上，owner 不变，标签组和占用都还在；owner 带着令牌的身份，换个令牌接不到别人的会话。
        const resumed=typeof sessionId==='string'&&request.method!=='DELETE'&&SESSION_ID.test(sessionId)?sessionId:undefined;
        if(sessionId&&!resumed)return json(response,404,'SESSION_NOT_FOUND');
        if(!resumed&&(request.method!=='POST'||!isInitializeRequest(parsed)))return json(response,400,'INITIALIZE_REQUIRED');
        if(this.sessions.size+this.creating.size>=64||[...this.sessions.values(),...this.creating].filter(s=>s.principal.id===principal.id).length>=16)return json(response,429,'SESSION_CAPACITY');
        const id=resumed??randomUUID(),owner='mcp-http:'+id;let created:Session;
        const transport=new StreamableHTTPServerTransport({sessionIdGenerator:()=>id,enableJsonResponse:true,onsessioninitialized:id=>{this.creating.delete(created);this.sessions.set(id,created);}});
        const mcp=createBrowserMcp(async(name,args)=>{const current=this.service.state.authenticate(token);if(!current||signature(current)!==signature(principal))throw new BrowserError('CLIENT_REVOKED','Agent授权已撤销或变化，指令未派发。',NOT_DISPATCHED);created.active++;try{return await this.service.invoke(name,args,principal.id+':'+owner,current);}finally{created.active--;created.touched=Date.now();this.heartbeat(created);}},{initialized:client=>{created.initialized=true;created.clientInfo=client;this.heartbeat(created);},closed:()=>this.forget(created)},{advancedTools:principal.advancedTools});
        created={transport,mcp,principal,owner,id,initialized:!!resumed,source:source(request),local:sameMachine(request),touched:Date.now(),active:0,streams:0};this.creating.add(created);entry=created;this.watchStream(created,request,response);
        try{await mcp.connect(transport);const previous=transport.onclose;transport.onclose=()=>{previous?.();this.forget(created);};if(resumed){resumeTransport(transport,id);this.creating.delete(created);this.sessions.set(id,created);this.heartbeat(created);}await transport.handleRequest(request,response,parsed);}finally{if(this.creating.delete(created))await mcp.close();}return;
      }
      entry.touched=Date.now();entry.source=source(request,entry.source);this.heartbeat(entry);this.watchStream(entry,request,response);await entry.transport.handleRequest(request,response,parsed);
    }catch{if(!response.headersSent)json(response,400,'INVALID_REQUEST');else response.end();}
  }
  async close(){this.closed=true;clearInterval(this.timer);await Promise.allSettled([...this.sessions.values(),...this.creating].map(s=>s.mcp.close()));this.sessions.clear();this.creating.clear();}
}
