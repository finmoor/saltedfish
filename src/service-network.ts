import type {Config} from './config.js';
import {createHmac} from 'node:crypto';
import {serviceAddress,loopbackAddress,privateAddress} from './service-address.js';
export function servicePublicUrl(config:Pick<Config,'port'|'network'>){return serviceAddress(config.network?.publicUrl??`http://127.0.0.1:${config.port}`);}
export function serviceInternalUrl(config:Pick<Config,'port'|'network'>){return config.network?.localPort?`http://127.0.0.1:${config.network.localPort}`:servicePublicUrl(config);}
export function serviceIdentity(config:Config){return createHmac('sha256',config.token).update('saltedfish/service-id/v1').digest('hex').slice(0,32);}
export function serviceNetwork(config:Config){
  if(config.network&&!config.network.tls&&!loopbackAddress(config.network.host)&&(!config.network.allowInsecureLan||!privateAddress(config.network.host)||new URL(servicePublicUrl(config)).hostname.replace(/^\[|\]$/g,'')!==config.network.host))throw new Error('跨机器HTTP需明确启用可信内网模式，并监听服务地址对应的私网IP；其他情况需要TLS证书。');
  if(!!config.network?.tls!==(new URL(servicePublicUrl(config)).protocol==='https:'))throw new Error('服务地址与TLS配置不一致。');
  if(config.network?.localPort===config.port)throw new Error('内部兼容端口不能与主端口相同。');
  const publicUrl=servicePublicUrl(config),scheme=config.network?.tls?'https':'http';
  const origins=new Set([publicUrl,`${scheme}://127.0.0.1:${config.port}`,`${scheme}://localhost:${config.port}`]);
  if(config.network?.localPort){origins.add(`http://127.0.0.1:${config.network.localPort}`);origins.add(`http://localhost:${config.network.localPort}`);}
  return{publicUrl,origins,hosts:new Set([...origins].map(origin=>new URL(origin).host)),host:config.network?.host??'127.0.0.1',legacyBridge:!config.network&&config.directConnections!==true};
}
