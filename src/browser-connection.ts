import {serviceAddress} from './service-address.js';
export interface BrowserConnection {version:1;serviceUrl:string;pairingId:string;token:string;managerToken?:string;profileId?:string;label?:string}
const uuid=(value:unknown)=>typeof value==='string'&&value.length===36&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const secret=(value:unknown)=>typeof value==='string'&&value.length===64&&/^[a-f0-9]{64}$/.test(value);
export function parseBrowserConnection(value:string):BrowserConnection {
  if(typeof value!=='string'||value.length>8192||!value.startsWith('sf-connect:'))throw new Error('请粘贴服务管理页生成的浏览器配对码。');
  let data:Record<string,unknown>;
  try{const encoded=value.slice(11);if(!/^[A-Za-z0-9_-]+$/.test(encoded))throw new Error();const bytes=Uint8Array.from(atob(encoded.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Error('浏览器配对码格式无效。');}
  if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!['version','serviceUrl','pairingId','token','managerToken','profileId','label'].includes(k))||data.version!==1||typeof data.serviceUrl!=='string'||!uuid(data.pairingId)||!secret(data.token)||data.managerToken!==undefined&&!secret(data.managerToken)||data.profileId!==undefined&&!uuid(data.profileId)||data.label!==undefined&&(typeof data.label!=='string'||data.label.length>100))throw new Error('浏览器配对码内容不完整或不受支持。');
  return{...data,serviceUrl:serviceAddress(data.serviceUrl)} as unknown as BrowserConnection;
}
