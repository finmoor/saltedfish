import source from 'virtual:page-runtime';
import {BrowserError,type JsonObject} from '../src/shared';

export const WORLD_NAME='SaltedFish internal runtime';
type Send=(tabId:number,method:string,params?:JsonObject,sessionId?:string)=>Promise<JsonObject>;
interface Entry {frameId:string;sessionId?:string;contextId?:number;ready:Promise<number>}
// 仅缓存执行上下文标识和初始化 promise，DOM 引用留在各自隔离世界的闭包中。
export class IsolatedRuntime {
 private worlds=new Map<number,Map<string,Entry>>();
 private roots=new Map<number,Map<string,string>>();
 constructor(private send:Send,private contexts:(tabId:number)=>JsonObject[]){}
 forget(tabId:number,sessionId?:string,contextId?:number){
  const worlds=this.worlds.get(tabId);
  if(sessionId===undefined&&contextId===undefined){this.worlds.delete(tabId);this.roots.delete(tabId);return;}
  for(const [key,entry]of worlds||[])if(entry.sessionId===(sessionId||undefined)&&(contextId===undefined||entry.contextId===contextId))worlds!.delete(key);
  if(contextId===undefined)this.roots.get(tabId)?.delete(sessionId||'');
 }
 clear(){this.worlds.clear();this.roots.clear();}
 navigated(tabId:number,frameId:string,sessionId?:string){this.worlds.get(tabId)?.delete(`${sessionId||''}:${frameId}`);this.roots.get(tabId)?.delete(sessionId||'');}
 async get(tabId:number,args:JsonObject,deadline:number):Promise<number>{
  const sessionId=args.sessionId as string|undefined,entries=this.contexts(tabId);
  const specified=args.contextId===undefined?undefined:entries.find(x=>x.id===args.contextId&&x.sessionId===sessionId);
  if(args.contextId!==undefined&&!specified)throw new BrowserError('STALE_CONTEXT','执行上下文已失效，请重新读取 chrome_contexts。',{phase:'precondition',outcome:'not_dispatched'});
  let frameId=(specified?.auxData as JsonObject)?.frameId as string|undefined;
  if(!frameId){
   let roots=this.roots.get(tabId);if(!roots){roots=new Map();this.roots.set(tabId,roots);}
   frameId=roots.get(sessionId||'');
   if(!frameId){const tree=await this.send(tabId,'Page.getFrameTree',{},sessionId);frameId=(tree.frameTree as any).frame.id;roots.set(sessionId||'',frameId!);}
  }
  const original=entries.find(x=>x.sessionId===sessionId&&(x.auxData as any)?.isDefault&&(x.auxData as any)?.frameId===frameId);
  if(!original)throw new BrowserError('STALE_CONTEXT','文档上下文尚未就绪或已变化，未切换目标。',{phase:'precondition',outcome:'not_dispatched'});
  let worlds=this.worlds.get(tabId);if(!worlds){worlds=new Map();this.worlds.set(tabId,worlds);}
  const key=`${sessionId||''}:${frameId}`;let entry=worlds.get(key);
  if(!entry){
   if(worlds.size>=256)throw new BrowserError('CONTEXT_CAPACITY','单标签隔离上下文超过 256 个，请减少 iframe 或分批处理。',{phase:'precondition',outcome:'not_dispatched'});
   entry={frameId:frameId!,sessionId,ready:Promise.resolve(0)};
   const current=entry;worlds.set(key,current);
   current.ready=(async()=>{
    const created=await this.send(tabId,'Page.createIsolatedWorld',{frameId,worldName:WORLD_NAME,grantUniveralAccess:false},sessionId);
    current.contextId=Number(created.executionContextId);
    const result=await this.send(tabId,'Runtime.evaluate',{contextId:current.contextId,expression:source,returnByValue:true,timeout:Math.max(1,deadline-Date.now())},sessionId);
    if(result.exceptionDetails)throw new BrowserError('RUNTIME_INITIALIZATION_FAILED','隔离运行时初始化失败。',{phase:'precondition',outcome:'not_dispatched'});
    if(worlds!.get(key)!==current||!this.contexts(tabId).includes(original))throw new BrowserError('STALE_CONTEXT','初始化期间文档已变化，未执行页面操作。',{phase:'precondition',outcome:'not_dispatched'});
    return current.contextId;
   })().catch(error=>{if(worlds!.get(key)===current)worlds!.delete(key);throw error;});
  }
  return entry.ready;
 }
}
