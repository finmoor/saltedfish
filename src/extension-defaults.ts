import {cp,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import type {Config} from './config.js';
import {bridgeToken} from './auth.js';
import {serviceNetwork,servicePublicUrl} from './service-network.js';

/** 扩展目录必须和发行文件完全一致。只覆盖不删的话，回滚后留下新版多出来的文件，目录指纹对不上，本机设置入口就登记不上。 */
export async function copyExtensionFiles(source:string,target:string){
  await cp(source,target,{recursive:true});
  const kept=new Set(await readdir(source));
  for(const name of await readdir(target))if(!kept.has(name))await rm(path.join(target,name),{recursive:true,force:true});
}

/** 安装、升级与助手共用模板；独立配对由Chrome保存，模板不能退回旧共享密钥。 */
export function extensionDefaults(config:Config){
  return serviceNetwork(config).legacyBridge?{port:config.port,token:bridgeToken(config)}:{port:config.port,serviceUrl:servicePublicUrl(config),token:''};
}
