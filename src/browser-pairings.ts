import {readFile,writeFile,mkdir,rename,rm} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import path from 'node:path';
import {z} from 'zod';
import {equalToken,tokenHash} from './auth.js';
import {BrowserError} from './shared.js';

const secret=z.string().length(64).regex(/^[a-f0-9]{64}$/);
const Pairing=z.object({id:z.string().uuid(),label:z.string().trim().min(1).max(100),token:secret,profileId:z.string().uuid().optional(),managerHash:secret.optional(),createdAt:z.string().datetime(),revoked:z.boolean().default(false)}).strict();
type PairingRecord=z.infer<typeof Pairing>;
const Records=z.object({version:z.literal(1),pairings:z.array(Pairing).max(256)}).strict();
export const BrowserPairingInput=z.object({label:z.string().trim().min(1).max(100),profileId:z.string().uuid().optional(),canManage:z.boolean().default(false),replace:z.boolean().default(false)}).strict();

/** 每个配对只绑定一个浏览器。连接凭据与可选的管理授权独立，可分别撤销。 */
export class BrowserPairings {
  private records:PairingRecord[]=[];
  private writes:Promise<unknown>=Promise.resolve();
  private constructor(private file:string){}
  static async open(dataDir:string){const store=new BrowserPairings(path.join(dataDir,'browser-pairings.json'));try{const bytes=await readFile(store.file);if(bytes.length>256*1024)throw new Error('浏览器配对文件过大。');store.records=Records.parse(JSON.parse(bytes.toString('utf8'))).pairings;if(new Set(store.records.map(p=>p.id)).size!==store.records.length)throw new Error('浏览器配对ID重复。');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}return store;}
  list(){return this.records.map(({token,managerHash,...item})=>({...item,canManage:!!managerHash}));}
  get(id:string){const record=this.records.find(p=>p.id===id&&!p.revoked);return record?{...record}:undefined;}
  async create(input:unknown){const value=BrowserPairingInput.parse(input);return this.change(async()=>{if(this.records.length>=256)throw new BrowserError('PAIRING_CAPACITY','浏览器配对记录已达上限。');const current=value.profileId?this.records.filter(p=>!p.revoked&&p.profileId===value.profileId):[];if(current.length&&!value.replace)throw new BrowserError('PROFILE_ALREADY_PAIRED','这个浏览器已经配对。要重新连接，到它那一行点“重新连接”。');const token=randomBytes(32).toString('hex'),managerToken=value.canManage||current.some(p=>p.managerHash)?randomBytes(32).toString('hex'):undefined;const item:PairingRecord={id:randomUUID(),label:value.label,token,...(value.profileId?{profileId:value.profileId}:{}),...(managerToken?{managerHash:tokenHash(managerToken)}:{}),createdAt:new Date().toISOString(),revoked:false};for(const old of current)old.revoked=true;this.records.push(item);return{pairingId:item.id,token,...(managerToken?{managerToken}:{}),profileId:value.profileId,label:item.label};});}
  async bind(id:string,profileId:string){z.string().uuid().parse(profileId);return this.change(async()=>{const item=this.records.find(p=>p.id===id&&!p.revoked);if(!item)throw new BrowserError('PAIRING_REVOKED','浏览器配对不存在或已撤销。');if(item.profileId&&item.profileId!==profileId)throw new BrowserError('PAIRING_PROFILE_MISMATCH','此配对已属于另一个浏览器，请生成独立配对。');if(this.records.some(p=>!p.revoked&&p.id!==id&&p.profileId===profileId))throw new BrowserError('PROFILE_ALREADY_PAIRED','此浏览器已有有效配对，请先核对原连接。');item.profileId=profileId;return{...item};});}
  async revoke(id:string,managementOnly=false){return this.change(async()=>{const item=this.records.find(p=>p.id===id);if(!item)return false;if(managementOnly)delete item.managerHash;else item.revoked=true;return true;});}
  async revokeProfile(profileId:string){return this.change(async()=>{const active=this.records.filter(p=>!p.revoked&&p.profileId===profileId);for(const item of active)item.revoked=true;return active.map(p=>p.id);});}
  authorize(id:string,profileId:string,token:string){const p=this.get(id);return!!p&&p.profileId===profileId&&equalToken(p.token,token);}
  authorizeManager(id:string,profileId:string,token:string){const p=this.get(id);return!!p&&p.profileId===profileId&&!!p.managerHash&&equalToken(p.managerHash,tokenHash(token));}
  managerActive(id:string){return!!this.get(id)?.managerHash;}
  private change<T>(work:()=>Promise<T>):Promise<T>{const pending=this.writes.then(async()=>{const before=structuredClone(this.records);const temporary=this.file+'.'+randomUUID()+'.tmp';try{const result=await work();await mkdir(path.dirname(this.file),{recursive:true});await writeFile(temporary,JSON.stringify({version:1,pairings:this.records},null,2),{mode:0o600,flag:'wx'});await rename(temporary,this.file);return result;}catch(error){this.records=before;throw error;}finally{await rm(temporary,{force:true});}});this.writes=pending.catch(()=>{});return pending;}
}
