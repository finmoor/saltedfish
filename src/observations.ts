import {SENSITIVE_FIELD,type BrowserEvent,type JsonObject} from './shared.js';

const short=(value:unknown,limit=180)=>typeof value==='string'?value.slice(0,limit):value;
function cleanUrl(value:string){try{const url=new URL(value);url.username='';url.password='';for(const key of url.searchParams.keys())if(/token|password|secret|credential|authorization|api.?key|^code$/i.test(key))url.searchParams.set(key,HIDDEN);return url.href;}catch{return value;}}
function safeUrl(value:unknown){return typeof value==='string'?cleanUrl(value).slice(0,500):undefined;}

// raw 保留完整结构，只隐藏凭据：结果可能落盘，真要原文用 chrome_cdp。
const HIDDEN='[redacted]',SECRET_HEADER=/authorization|cookie|token|secret|api[-_]?key|session|credential|password|csrf|xsrf/i,SECRET_NETWORK_FIELD=/^(?:postData|postDataEntries|associatedCookies|blockedCookies|cookies)$/;
function hideNetwork(value:any,depth=0):any{
 if(Array.isArray(value))return value.map(item=>hideNetwork(item,depth+1));
 if(!value||typeof value!=='object'||depth>8)return value;
 const result:JsonObject={};
 for(const [key,item] of Object.entries(value)){
  if(SECRET_NETWORK_FIELD.test(key))result[key]=HIDDEN;
  else if(/^(?:headers|requestHeaders|responseHeaders)$/.test(key)&&item&&typeof item==='object')result[key]=Object.fromEntries(Object.entries(item).map(([name,text])=>[name,SECRET_HEADER.test(name)?HIDDEN:text]));
  else if(/^(?:headersText|requestHeadersText)$/.test(key)&&typeof item==='string')result[key]=item.split('\r\n').map(line=>{const colon=line.indexOf(':');return colon>0&&SECRET_HEADER.test(line.slice(0,colon))?`${line.slice(0,colon)}: ${HIDDEN}`:line;}).join('\r\n');
  else if(/^(?:url|documentURL|redirectUrl)$/.test(key)&&typeof item==='string')result[key]=cleanUrl(item);
  else result[key]=hideNetwork(item,depth+1);
 }
 return result;
}
export const hideRawEvent=(event:BrowserEvent):BrowserEvent=>event.method.startsWith('Network.')?{...event,params:hideNetwork(event.params)}:event;

// 输入框的文字在 AX 树里出现多处：节点的 value、内部文本节点的 name，以及 name.sources 里的名称来源。
const INPUT_ROLES=new Set(['textbox','searchbox','combobox','spinbutton']);
export function hideRawAccessibility(raw:any){
 if(!Array.isArray(raw?.nodes))return raw;
 const byId=new Map(raw.nodes.map((node:any)=>[node.nodeId,node])),hidden=new Set<unknown>();
 const hide=(node:any)=>{if(!node||hidden.has(node.nodeId))return;hidden.add(node.nodeId);for(const id of node.childIds||[])hide(byId.get(id));};
 for(const node of raw.nodes)if(INPUT_ROLES.has(node.role?.value)&&SENSITIVE_FIELD.test(String(node.name?.value??'')))hide(node);
 return{...raw,nodes:raw.nodes.map((node:any)=>{
  if(!hidden.has(node.nodeId))return node;
  const input=INPUT_ROLES.has(node.role?.value);
  return{...node,...(node.value?{value:{type:node.value.type,value:HIDDEN}}:{}),...(node.name?{name:{type:node.name.type,value:input?node.name.value:HIDDEN}}:{})};
 })};
}

export function compactAccessibility(raw:any,offset:number,limit:number,budget:number){
 const all=Array.isArray(raw?.nodes)?raw.nodes:[];
 const meaningful=all.filter((n:any)=>!n.ignored&&!['none','generic','InlineTextBox'].includes(n.role?.value));
 const nodes:any[]=[],result:any={mode:'summary',nodes,totalNodes:meaningful.length,totalRawNodes:all.length,nextOffset:null,values:'Use chrome_inspect for redacted form values; raw for full AX.'};
 for(const node of meaningful.slice(offset,offset+limit)){
  const entry:any={nodeId:short(node.nodeId,80),role:{value:short(node.role?.value,60)},name:{value:short(node.name?.value??'',180)}};
  if(node.backendDOMNodeId)entry.backendDOMNodeId=node.backendDOMNodeId;if(node.parentId)entry.parentId=short(node.parentId,80);
  const props=(node.properties||[]).filter((p:any)=>['disabled','readonly','checked','selected','expanded','pressed','required','invalid','focusable','focused','multiselectable','level'].includes(p.name));
  if(props.length)entry.properties=props.map((p:any)=>({name:p.name,value:{value:short(p.value?.value,40)}}));
  nodes.push(entry);result.nextOffset=offset+nodes.length<meaningful.length?offset+nodes.length:null;
  if(JSON.stringify(result).length>budget){nodes.pop();if(!nodes.length){nodes.push({nodeId:short(node.nodeId,40),role:{value:short(node.role?.value,40)},name:{value:short(node.name?.value??'',20)},truncated:true});}break;}
 }
 result.nextOffset=offset+nodes.length<meaningful.length?offset+nodes.length:null;return result;
}

export function compactEvent(event:BrowserEvent):BrowserEvent {
 const p=event.params as any,result:JsonObject={};
 for(const key of ['requestId','frameId','dialogId','commandId','sessionId','type','result','hasBrowserHandler','messageTruncated','omitted','originalBytes','encodedDataLength','canceled'])if(p[key]!==undefined)result[key]=short(p[key],100);
 if(p.url)result.url=safeUrl(p.url);
 if(event.method.startsWith('Page.javascriptDialog')){for(const key of ['message','defaultPrompt','userInput'])if(typeof p[key]==='string'){result[key]=p[key].slice(0,2000);if(p[key].length>2000)result[`${key}Truncated`]=true;}}
 else if(typeof p.message==='string')result.message=short(p.message,256);
 if(p.request)result.request={url:safeUrl(p.request.url),method:short(p.request.method,20)};
 if(p.response)result.response={url:safeUrl(p.response.url),status:p.response.status,mimeType:short(p.response.mimeType,80),fromDiskCache:p.response.fromDiskCache};
 if(p.args)result.args=p.args.slice(0,5).map((arg:any)=>({type:arg.type,value:short(arg.value,180),description:short(arg.description,180)}));
 if(p.exceptionDetails)result.exceptionDetails={text:short(p.exceptionDetails.text,256),description:short(p.exceptionDetails.exception?.description,256)};
 if(p.errorText)result.errorText=short(p.errorText,256);
 if(p.title)result.title=short(p.title,180);
 for(const key of ['tabId','windowId','active','status','label','reason'])if(p[key]!==undefined)result[key]=short(p[key],180);
 return {...event,params:result};
}
// 按网址片段、资源类型筛事件。一个请求的几条事件（发出、响应、收数据、结束）只有前两条带网址和类型，按 requestId 认整组；
// 请求可能在 since 之前就发出了，所以从整个缓存（all）里认。不是网络请求的事件只按自己的 url 筛，资源类型筛掉它们。
export function filterRequests(events:BrowserEvent[],all:BrowserEvent[],filter:{urlContains?:string;resourceType?:string}){
 const key=(event:BrowserEvent)=>JSON.stringify([event.params.sessionId??'',event.params.requestId]),wanted=new Set<string>();
 const fits=(url:unknown,type:unknown)=>(!filter.urlContains||String(url??'').includes(filter.urlContains))&&(!filter.resourceType||String(type??'').toLowerCase()===filter.resourceType.toLowerCase());
 for(const event of all){const p=event.params as any;if(p.requestId===undefined||!p.request&&!p.response)continue;if(fits(p.request?.url??p.response?.url,p.type))wanted.add(key(event));}
 return events.filter(event=>event.params.requestId!==undefined?wanted.has(key(event)):!filter.resourceType&&fits(event.params.url,undefined));
}
export function compactEvents(events:BrowserEvent[],offset:number,limit:number,budget:number,since:number,headSequence:number,droppedBefore:number){
 const items:BrowserEvent[]=[],result={mode:'summary',items,total:events.length,nextOffset:null as number|null,latestSequence:since,headSequence,droppedBefore};
 for(const event of events.slice(offset,offset+limit)){
  items.push(compactEvent(event));result.latestSequence=event.sequence;result.nextOffset=offset+items.length<events.length?offset+items.length:null;
  if(JSON.stringify(result).length>budget){items.pop();if(!items.length)items.push({...event,params:{truncated:true,dialogId:short(event.params.dialogId,100),type:short(event.params.type,40),note:'Use mode=raw for this event.'}});break;}
 }
 result.nextOffset=offset+items.length<events.length?offset+items.length:null;result.latestSequence=items.at(-1)?.sequence??since;return result;
}
