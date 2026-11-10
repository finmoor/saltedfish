import {BrowserError,isScriptUrl,SCRIPT_URL_MESSAGE,type JsonObject} from '../src/shared';

interface NavigationOptions {
 url?:string;action?:'goto'|'back'|'forward'|'reload';wait:boolean;deadline:number;
 send:(method:string,params?:JsonObject)=>Promise<JsonObject>;
 tab:()=>Promise<JsonObject>;
 subscribe:(listener:(method:string,params:JsonObject)=>void)=>()=>void;
 assertActive:()=>void;
 validateUrl?:(url:string)=>void;
 // 派发前最后一步（登记 initScript）。抛错时导航还没发出。
 prepare?:()=>Promise<void>;
}

// 这些错误发生在请求发出之前（解析、连接、证书、被拦截），目标服务器什么都没收到，是确定的失败。其他错误不能证明请求没有到达。
// 但这只在“失败的就是我们请求的那个地址”时成立：先请求了有副作用的地址、再重定向到连不上的地址，最终错误同样是这些，不能据此说什么都没发出。
// 所以只有能证明没有经过重定向（失败页的历史条目网址就是请求的网址）才标未派发，证明不了一律保留结果不明。
const NEVER_SENT=/^net::ERR_(NAME_NOT_RESOLVED|INVALID_URL|ADDRESS_INVALID|ADDRESS_UNREACHABLE|CONNECTION_REFUSED|INTERNET_DISCONNECTED|UNSAFE_PORT|BLOCKED_BY_CLIENT|BLOCKED_BY_ADMINISTRATOR|UNKNOWN_URL_SCHEME|CERT_[A-Z_]+)$/;
export async function navigationFailed(text:unknown,requested:string|undefined,send:(method:string,params?:JsonObject)=>Promise<JsonObject>):Promise<BrowserError>{
 let direct=false;
 if(requested&&NEVER_SENT.test(String(text))){
  // 失败后 Chrome 要把标签页换到错误页的进程，紧接着的 20–40ms 里调试命令会报“Not attached to an active page”，稍等再查（2026-11-06 实测）。
  // 第一次拿到的历史若还是旧页面，照样判不出来，按结果不明处理。
  for(const stop=Date.now()+1500;;){
   try{
    const history=await send('Page.getNavigationHistory'),entries=history.entries as {url?:string}[],current=entries[Number(history.currentIndex)];
    direct=!!current?.url&&new URL(current.url).href===new URL(requested).href;break;
   }catch(error){if(error instanceof BrowserError&&['CANCELLED','DEADLINE_EXCEEDED','NAVIGATION_TIMEOUT','CONNECTION_CHANGED'].includes(error.code)||Date.now()>=stop){direct=false;break;}await new Promise(resolve=>setTimeout(resolve,25));}
  }
 }
 return new BrowserError('NAVIGATION_FAILED',String(text)+(direct?'':'。导航可能经过重定向，不能证明没有请求发出；先检查页面，不要直接重放。'),direct?{phase:'precondition',outcome:'not_dispatched'}:{phase:'execution',outcome:'unknown'});
}

// load 必须属于这次 Page.navigate 的 loader；tabs.complete 可能仍描述旧文档。
export async function navigatePage(options:NavigationOptions):Promise<JsonObject>{
 const {send,tab,subscribe,assertActive,deadline}=options,action=options.action??'goto';
 let dispatched=false,remove=()=>{},wake:(()=>void)|undefined,revision=0;
 const check=()=>{
  assertActive();
  if(Date.now()>=deadline)throw new BrowserError(dispatched?'NAVIGATION_TIMEOUT':'DEADLINE_EXCEEDED',dispatched?'导航已发出，尚未确认本次文档加载完成。先检查页面，不要重放导航。':'导航准备超时，尚未发送导航。',dispatched?{phase:'execution',outcome:'unknown'}:{phase:'precondition',outcome:'not_dispatched'});
 };
 check();
 let reject!:(error:unknown)=>void;
 const interrupted=new Promise<never>((_resolve,r)=>{reject=r;});
 const timer=setInterval(()=>{try{check();}catch(error){reject(error);}},25);
 const guarded=<T>(promise:Promise<T>):Promise<T>=>Promise.race([promise,interrupted]);
 try{
  let url=options.url,method='Page.navigate',params:JsonObject={},historyId:number|undefined;
  if(action==='back'||action==='forward'){
   const history=await guarded(send('Page.getNavigationHistory')),entries=history.entries as {id:number;url:string}[];
   const entry=entries[Number(history.currentIndex)+(action==='back'?-1:1)];
   if(!entry)throw new BrowserError('HISTORY_ENTRY_NOT_FOUND',action==='back'?'没有上一页历史记录，未派发导航。':'没有下一页历史记录，未派发导航。',{phase:'precondition',outcome:'not_dispatched'});
   historyId=entry.id;url=entry.url;method='Page.navigateToHistoryEntry';params={entryId:historyId};
  }else if(action==='reload'){
   url=String((await guarded(tab())).url||'');method='Page.reload';
  }else{
   if(!url)throw new BrowserError('INVALID_URL','goto 需要 url。',{phase:'precondition',outcome:'not_dispatched'});
   if(isScriptUrl(url))throw new BrowserError('INVALID_URL',SCRIPT_URL_MESSAGE,{phase:'precondition',outcome:'not_dispatched'});
   params={url};
  }
  options.validateUrl?.(String(url));check();
  if(!options.wait){if(options.prepare){await guarded(options.prepare());check();}dispatched=true;const result=await guarded(send(method,params));if(result.errorText)throw await navigationFailed(result.errorText,action==='goto'?url:undefined,(m,p)=>guarded(send(m,p)));return action==='goto'?result:{action,dispatched:true,...result};}
  await guarded(send('Page.setLifecycleEventsEnabled',{enabled:true}));
  const initial=(await guarded(send('Page.getFrameTree'))).frameTree as {frame:JsonObject};
  const frameId=String(initial.frame.id),loaded=new Set<string>(),restored=new Set<string>();let committedLoader:string|undefined,sameDocument=false;
  remove=subscribe((method,params)=>{
   if(method==='connection.closed'){reject(new BrowserError('CONNECTION_CHANGED','导航等待时调试连接已关闭；导航可能已经生效。'));return;}
   if(!dispatched)return;
   // 导航途中只会弹 beforeunload。答了“留下”就不会再有加载，别一直等到期限、占着标签页。
   if(method==='Page.javascriptDialogClosed'&&params.result===false){reject(new BrowserError('NAVIGATION_CANCELLED','页面问“确定离开吗”时选了留下，没有离开。',{phase:'execution',outcome:'not_dispatched'}));return;}
   if(method==='Page.lifecycleEvent'&&params.frameId===frameId&&params.name==='load'){
    loaded.add(String(params.loaderId));if(loaded.size>32)loaded.delete(loaded.values().next().value!);
   }
   if(method==='Page.frameNavigated'&&(params.frame as JsonObject)?.id===frameId){committedLoader=String((params.frame as JsonObject).loaderId);if(params.type==='BackForwardCacheRestore')restored.add(committedLoader);}
   if(method==='Page.navigatedWithinDocument'&&params.frameId===frameId)sameDocument=true;
   if(['Page.lifecycleEvent','Page.frameNavigated','Page.navigatedWithinDocument','tabs.updated'].includes(method)){revision++;wake?.();}
  });
  if(options.prepare)await guarded(options.prepare());
  check();dispatched=true;
  const result=await guarded(send(method,params));
  if(result.errorText)throw await navigationFailed(result.errorText,action==='goto'?url:undefined,(m,p)=>guarded(send(m,p)));
  if(result.isDownload)throw new BrowserError('NAVIGATION_DOWNLOAD','本次导航转为下载；请检查下载记录，不重放导航。');
  if(action==='goto'&&result.frameId!==frameId)throw new BrowserError('NAVIGATION_CHANGED','导航目标frame已改变，不能确认原目标完成。');
  let loader=typeof result.loaderId==='string'?result.loaderId:undefined;
  while(true){
   check();const observedRevision=revision;
   if(action!=='goto'&&!loader&&committedLoader)loader=committedLoader;
   if(loader&&committedLoader&&committedLoader!==loader)throw new BrowserError('NAVIGATION_CHANGED','另一次导航替换了本次文档；先检查当前页面。');
   // 没有 loaderId 表示同文档导航：核对原 loader 和目标 URL，不等待不存在的新 load。
   const ready=action==='goto'?(!loader||loaded.has(loader)):loader?(loaded.has(loader)||restored.has(loader)):sameDocument&&action!=='reload';
   if(ready){
    const frame=((await guarded(send('Page.getFrameTree'))).frameTree as {frame:JsonObject}).frame;
    const expectedLoader=loader||initial.frame.loaderId;
    if(frame.id!==frameId||frame.loaderId!==expectedLoader)throw new BrowserError('NAVIGATION_CHANGED','当前文档与本次导航不一致；先检查实际页面。');
    const current=await guarded(tab());check();
    const documentUrl=String(frame.url||'')+String(frame.urlFragment||'');
    if(committedLoader&&committedLoader!==expectedLoader)throw new BrowserError('NAVIGATION_CHANGED','读取完成状态时文档又发生变化；先检查实际页面。');
    if(historyId!==undefined){const history=await guarded(send('Page.getNavigationHistory')),entries=history.entries as {id:number}[];if(entries[Number(history.currentIndex)]?.id!==historyId)throw new BrowserError('NAVIGATION_CHANGED','历史位置已被另一导航改变；先检查实际页面。');}
    if(current.status==='complete'&&current.url===documentUrl&&(loader||documentUrl===new URL(String(url)).href))return action==='goto'?current:{...current,action};
   }
   if(revision===observedRevision)await guarded(new Promise<void>(resolve=>{wake=resolve;}));
   wake=undefined;
  }
 }finally{clearInterval(timer);remove();wake=undefined;}
}
