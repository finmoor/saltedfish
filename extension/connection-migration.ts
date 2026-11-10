import {parseBrowserConnection} from '../src/browser-connection';
import {serviceAddress} from '../src/service-address';

export interface ConnectionSettings {
  profileId:string;label:string;port:number;token:string;enabled:boolean;
  serviceUrl?:string;pairingId?:string;managerToken?:string;protectedServices?:string[];migrationId?:string;
  // 为什么暂停：debugging-canceled 在 Chrome 提示条里点了取消，agent 被 chrome_pause_profile 暂停，user 在扩展里暂停。
  pausedReason?:PauseReason;autoResume?:boolean;resumeAt?:number;
  // Agent 操作时在页面上画它的光标；没设过算开着。
  showCursor?:boolean;
  humanInput?:boolean;
}
export type PauseReason='debugging-canceled'|'agent'|'user';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digest=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),n=>n.toString(16).padStart(2,'0')).join('');

/** 安装包携带的显式迁移：只匹配原浏览器及原连接，不覆盖用户手工选择的新服务。 */
export async function migratedConnection(current:ConnectionSettings,input:unknown):Promise<ConnectionSettings|undefined>{
  if(!input||typeof input!=='object'||Array.isArray(input)||JSON.stringify(input).length>65536)return;
  const value=input as Record<string,unknown>;
  if(Object.keys(value).some(key=>!['id','fromServiceUrl','fromTokenHash','connections'].includes(key))||typeof value.id!=='string'||!uuid.test(value.id)||typeof value.fromServiceUrl!=='string'||typeof value.fromTokenHash!=='string'||!/^[a-f0-9]{64}$/.test(value.fromTokenHash)||!Array.isArray(value.connections)||value.connections.length>64)return;
  if(current.pairingId||current.migrationId===value.id)return;
  let previous:string;
  try{previous=serviceAddress(current.serviceUrl||`http://127.0.0.1:${current.port}`);if(previous!==serviceAddress(value.fromServiceUrl))return;}catch{return;}
  if(await digest(current.token)!==value.fromTokenHash)return;
  const parsed=[];
  try{for(const code of value.connections){if(typeof code!=='string')return;const connection=parseBrowserConnection(code);if(!connection.profileId)return;parsed.push(connection);}}catch{return;}
  if(new Set(parsed.map(c=>c.profileId)).size!==parsed.length)return;
  const target=parsed.find(c=>c.profileId===current.profileId);if(!target)return;
  return {...current,serviceUrl:target.serviceUrl,pairingId:target.pairingId,token:target.token,managerToken:target.managerToken,migrationId:value.id,protectedServices:[...new Set([...(current.protectedServices||[]),previous])].slice(-32)};
}
