import {readFile,writeFile,rename,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {createServer,isIP} from 'node:net';
import {ConfigSchema,type Config} from './config.js';
import {serviceNetwork} from './service-network.js';
import {validateGatewayTls} from './gateway-tls.js';
import {withManagementMutex} from './management-lock.js';

export function serverOptions(args:string[]){const allowed=new Set(['--host','--url','--cert','--key','--local-port','--allow-insecure-lan']),values:Record<string,string>={};for(let i=0;i<args.length;i++){const key=args[i]!;if(!allowed.has(key)||values[key]!==undefined)throw new Error('用法：configure-server --host IP --url URL [--cert FILE --key FILE] [--allow-insecure-lan] [--local-port PORT]');if(key==='--allow-insecure-lan'){values[key]='true';continue;}if(!args[i+1]||args[i+1]!.startsWith('--'))throw new Error(key+'需要参数。');values[key]=args[++i]!;}if(!values['--host']||!values['--url'])throw new Error('需要明确--host与--url。');if(!isIP(values['--host'])&&values['--host']!=='localhost')throw new Error('--host必须是监听IP或localhost。');if(!!values['--cert']!==!!values['--key'])throw new Error('证书与私钥必须一起提供。');if(values['--cert']&&values['--allow-insecure-lan'])throw new Error('TLS与可信内网HTTP模式只能选择一种。');return values;}

// 不依赖 TLS 信任或健康接口；端口被占用时拒绝改写运行配置。
export async function assertServiceStopped(config:Config){
 const endpoints=[{host:config.network?.host||'127.0.0.1',port:config.port}];
 if(config.network?.localPort)endpoints.push({host:'127.0.0.1',port:config.network.localPort});
 for(const endpoint of endpoints){
  const server=createServer();
  try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(endpoint.port,endpoint.host,resolve);});}
  catch{throw new Error('服务端口仍在使用或无法核实，请先停止此安装的服务，再更改配置。');}
  finally{if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));}
 }
}
export async function configureServer(config:Config,args:string[]){
 const values=serverOptions(args),network:NonNullable<Config['network']>={host:values['--host']!,publicUrl:values['--url']!,...(values['--allow-insecure-lan']?{allowInsecureLan:true}:{}),...(values['--cert']?{tls:{cert:path.resolve(values['--cert']),key:path.resolve(values['--key']!)},localPort:Number(values['--local-port']||config.port+1)}:values['--local-port']?{localPort:Number(values['--local-port'])}:{})};
 const parsed=ConfigSchema.safeParse({...config,directConnections:true,network});if(!parsed.success)throw new Error(parsed.error.issues[0]!.message);
 const next=parsed.data;serviceNetwork({...next,dataDir:config.dataDir});if(network.tls)await validateGatewayTls(network.tls,new URL(network.publicUrl).hostname);
 return withManagementMutex(config.dataDir,async()=>{await assertServiceStopped(config);const file=path.join(config.dataDir,'config.json'),before=await readFile(file,'utf8'),temporary=file+'.'+randomUUID()+'.tmp';const updated={...JSON.parse(before),directConnections:true,network:next.network};try{await writeFile(temporary,JSON.stringify(updated,null,2),{flag:'wx',mode:0o600});if(await readFile(file,'utf8')!==before)throw new Error('服务配置已被其他进程修改。');await rename(temporary,file);}finally{await rm(temporary,{force:true});}return{configured:true,host:network.host,serviceUrl:next.network!.publicUrl,port:config.port,localPort:network.localPort};});
}
