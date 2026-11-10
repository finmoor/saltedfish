import { createServer } from 'node:http';
import { rm } from 'node:fs/promises';
import { startServer } from './http-server.js';
import { startGateway } from './remote-gateway.js';
import { loadConfig } from './config.js';
import { equalToken } from './auth.js';
import { active, atomicJson, dataPath, randomBytes, randomUUID, readJson, requireHome, retryFile, runPath, serviceStatus, VERSION, type Role } from './npm-runtime.js';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

async function main() {
  const role=process.argv[2] as Role;if(!['local','gateway'].includes(role))throw new Error('无效的后台服务类型。');
  const home=await requireHome(path.resolve(process.argv[3]!));
  if((await active(home)).version!==VERSION)throw new Error('后台启动版本已变化。');
  if(['running','unreachable'].includes((await serviceStatus(home,role)).state))throw new Error('已有运行服务或未核实的管理记录，未重复启动。');
  const app=role==='local'?await startServer(await loadConfig(dataPath(home,role))):await startGateway(await readJson(path.join(dataPath(home,role),'gateway.json')),{agentConfigFile:path.join(dataPath(home,role),'gateway.json'),onboarding:{platform:process.platform as 'win32'|'linux'|'darwin',command:[process.execPath,fileURLToPath(new URL('./npm-cli.js',import.meta.url)),'gateway'],suffix:['--home',home]}});
  const token=randomBytes(32).toString('hex'),instanceId=randomUUID(),startedAt=new Date().toISOString();let stopping=false;
  const snapshot=()=>{
    const resources='service' in app?app.service.stats():app.stats();
    const busy='service' in app ? ['inFlight','pendingCommands','queuedTasks','activeTaskProfiles'].some(k=>Number((resources as any)[k])>0) : Number((resources as any).pending)>0;
    return {product:'saltedfish-npm',role,home,instanceId,version:VERSION,pid:process.pid,startedAt,resources,busy};
  };
  const controller=createServer(async(req,res)=>{
    const send=(code:number,value:unknown)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
    const port=(controller.address() as {port:number}).port;
    if(req.headers.host!==`127.0.0.1:${port}`||req.headers.origin||!equalToken(token,req.headers.authorization?.replace(/^Bearer /,'')||'')){send(403,{error:'UNAUTHORIZED'});return;}
    if(req.method==='GET'&&req.url==='/status'){send(200,snapshot());return;}
    if(req.method!=='POST'||req.url!=='/stop'){send(404,{error:'NOT_FOUND'});return;}
    try{
      const chunks:Buffer[]=[];let bytes=0;for await(const c of req){bytes+=c.length;if(bytes>2048)throw new Error('请求过大。');chunks.push(c);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(body.instanceId!==instanceId)throw new Error('后台实例已变化。');
      if(snapshot().busy&&body.force!==true){send(409,{error:'服务仍有任务在执行；等待完成，或核查后使用 stop --force。'});return;}
      send(202,{...snapshot(),stopping:true});setTimeout(()=>void close(),25);
    }catch{send(400,{error:'INVALID_CONTROL_REQUEST'});}
  });
  controller.requestTimeout=5000;controller.headersTimeout=5000;controller.maxConnections=16;
  async function close(){
    if(stopping)return;stopping=true;
    try{await app.close();await new Promise<void>(resolve=>{controller.close(()=>resolve());controller.closeAllConnections();});const record=await readJson(runPath(home,role)).catch(()=>({}));if(record.instanceId===instanceId)await retryFile(()=>rm(runPath(home,role),{force:true}));}
    finally{process.exit(0);}
  }
  try {
    await new Promise<void>((resolve,reject)=>{controller.once('error',reject);controller.listen(0,'127.0.0.1',resolve);});
    await atomicJson(runPath(home,role),{role,home,token,instanceId,version:VERSION,pid:process.pid,startedAt,port:(controller.address() as {port:number}).port});
  }catch(e){await app.close();controller.close();throw e;}
  if('service' in app)app.server.once('adminShutdown',()=>void close());
  if('reloadTls' in app&&process.platform!=='win32')process.on('SIGHUP',()=>{void app.reloadTls().catch(()=>console.error('TLS证书未更新，保留当前证书。请检查证书同步日志。'));});
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>void close());
  console.error(`${new Date().toISOString()} SaltedFish ${role} ${VERSION} 已启动。`);
}
main().catch(error=>{console.error(`SaltedFish 后台未启动：${error instanceof Error?error.message:'未知错误'}`);process.exitCode=1;});
