import {computeAccessibleName,getRole} from 'dom-accessibility-api';
import {SENSITIVE_FIELD} from '../src/shared';

interface Snapshot { id:string;key:string;time:number;size:number;items:Map<string,string>;text?:string;title?:string;url?:string;structure:string }
// removed：这个文档里发过、元素后来被移除的 ref（最多记 512 个），按 ref 等元素消失时认它。
interface PageState { id:string;nextId:number;elements:Map<string,Element>;refs:WeakMap<Element,string>;snapshots:Map<string,Snapshot>;removed:Set<string> }
const normalize=(value:unknown)=>String(value??'').replace(/\s+/g,' ').trim();
// 比较文字用：全角半角、兼容字符按 NFKC 归一（“（65）”和“(65)”算一样），空白合并。只用来比，不改返回给调用方的文字。
const fold=(value:unknown)=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim();
const makeId=()=>crypto.randomUUID?.()||`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
// 文档标识进每个 ref，要短；http 页面没有 randomUUID，用 getRandomValues，只需在同一标签页的文档之间不重复。
const shortId=()=>crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36).padStart(7,'0');
let ownedDocument:Document|undefined;
let ownedState:PageState|undefined;
export function fail(code:string,message=code,detail?:unknown):never { const error=new Error(message);error.name='FengPrecondition';Object.assign(error,{code,...(detail?{detail}:{})});throw error; }
// 扩展内部调用（executor 的 evaluateInternal）出错时交回的结果：fail 抛的带错误码和说明；输入开始之后的、页面自己抛的都按结果不明。
export function caught(error:any,started:boolean){
  const known=error?.name==='FengPrecondition'&&typeof error.code==='string';
  return {ok:false,error:{code:known?error.code:'JAVASCRIPT_ERROR',message:String(error?.message||error),phase:started?'execution':'precondition',outcome:started||!known?'unknown':'not_dispatched',...(known&&error.detail?{detail:error.detail}:{})}};
}
function pageState():PageState {
  if(ownedDocument!==document){ownedDocument=document;ownedState=undefined;}
  const state=ownedState??={id:shortId(),nextId:0,elements:new Map<string,Element>(),refs:new WeakMap<Element,string>(),snapshots:new Map<string,Snapshot>(),removed:new Set<string>()};
  for(const [ref,element] of state.elements)if(!element.isConnected||element.ownerDocument!==document){state.elements.delete(ref);state.removed.add(ref);if(state.removed.size>512)state.removed.delete(state.removed.values().next().value!);}
  for(const [id,snapshot] of state.snapshots)if(Date.now()-snapshot.time>300000)state.snapshots.delete(id);
  return state;
}
export const documentId=()=>pageState().id;
export const elementRef=(element:Element)=>remember(element,pageState());
export function assertFocused(element:Element) {let active:Element|null=document.activeElement;while(active?.shadowRoot?.activeElement)active=active.shadowRoot.activeElement;if(active!==element||!element.isConnected)fail('FOCUS_CHANGED','焦点或目标在聚焦后变化，未继续输入。');}
function editorText(element:HTMLElement):string {
 const lines:string[]=[];let inline='',hasInline=false,inlineTail:Node|undefined;
 const tail=(node:Node):Node=>node.lastChild?tail(node.lastChild):node;
 const flush=()=>{if(!hasInline)return;if(inlineTail&&tail(inlineTail) instanceof HTMLBRElement&&inline.endsWith('\n'))inline=inline.slice(0,-1);lines.push(inline);inline='';hasInline=false;inlineTail=undefined;};
 for(const node of element.childNodes){
  if(node.nodeType===Node.TEXT_NODE){inline+=node.textContent||'';hasInline=true;inlineTail=node;continue;}
  if(!(node instanceof HTMLElement))continue;
  const css=getComputedStyle(node);if(css.display==='none'||css.visibility==='hidden')continue;
  if(node instanceof HTMLBRElement){inline+='\n';hasInline=true;inlineTail=node;continue;}
  if(['block','list-item','flex','grid','table','flow-root'].includes(css.display)){flush();lines.push(editorText(node));}
  else{inline+=node.innerText;hasInline=true;inlineTail=node;}
 }
 flush();return lines.join('\n').replace(/\u00a0/g,' ');
}
export function editableValue(element:Element):string {
 if(element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement||element instanceof HTMLSelectElement)return element.value;
 if(element instanceof HTMLElement&&element.isContentEditable)return editorText(element);
 return element instanceof HTMLElement?element.innerText:element.textContent||'';
}
export const textOffsetLength=(element:Element)=>((element as HTMLElement).isContentEditable?element.textContent||'':editableValue(element)).length;
export function browserEditable(element:Element):boolean {return element instanceof HTMLTextAreaElement||(element as HTMLElement).isContentEditable||element instanceof HTMLInputElement&&['text','search','url','tel','password','email','number'].includes(element.type);}
export function selectText(element:Element,selection?:{start:number;end:number},replace=false){
 if(!selection&&!replace)return;
 const length=textOffsetLength(element),start=selection?.start??0,end=selection?.end??length;
 if(end>length||start>end)fail('SELECTION_OUT_OF_RANGE','选择区超出字段当前内容。');
 if(element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement){
  if(replace&&!selection)element.select();
  else {try{element.setSelectionRange(start,end);}catch{fail('SELECTION_UNSUPPORTED','此控件不支持指定选择区。');}}
 }else if((element as HTMLElement).isContentEditable){
  const range=document.createRange();range.selectNodeContents(element);
  if(selection){
   const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);let node:Node|null,offset=0,started=false,ended=false;
   while(node=walker.nextNode()){const next=offset+(node.textContent?.length||0);if(!started&&start<=next){range.setStart(node,start-offset);started=true;}if(end<=next){range.setEnd(node,end-offset);ended=true;break;}offset=next;}
   if(!started||!ended){if(length===0&&start===0&&end===0)range.collapse(true);else fail('SELECTION_OUT_OF_RANGE');}
  }
  const selected=getSelection();if(!selected)fail('SELECTION_UNAVAILABLE');selected.removeAllRanges();selected.addRange(range);
 }else fail('NOT_TEXT_INPUT');
}
export function pasteEvent(element:Element,text:string):boolean {const clipboardData=new DataTransfer();clipboardData.setData('text/plain',text);return element.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,composed:true,clipboardData}));}
// textMatches：调用方给的正则源码，不带标志。空白合并后试一次，再按 NFKC 归一（全角数字、括号）试一次；正则本身不归一，免得全角括号变成分组。
const patterns=new Map<string,RegExp>();
function textMatches(value:unknown,source:string):boolean {
 let pattern=patterns.get(source);
 if(!pattern){try{pattern=new RegExp(source);}catch{fail('INVALID_PATTERN','textMatches 不是有效的正则。');}patterns.set(source,pattern);if(patterns.size>32)patterns.delete(patterns.keys().next().value!);}
 const text=String(value??'');return pattern.test(normalize(text))||pattern.test(fold(text));
}
// 只等元素消失的条件：没有文字、值、文件、属性要求。
const onlyHidden=(options:any)=>options.state==='hidden'&&options.valueEquals===undefined&&options.fileCount===undefined&&!options.attribute&&!options.textContains&&!options.textMatches;
export function matchesCondition(options:any):boolean {
 if(options.urlContains&&!location.href.includes(options.urlContains))return false;
 if(!options.selector&&!options.ref&&!options.locator){const text=document.body?.innerText;return (!options.textContains||fold(text).includes(fold(options.textContains)))&&(!options.textMatches||textMatches(text,options.textMatches));}
 // checked/unchecked 是业务状态，attached 只要在 DOM 里：都不要求元素看得见，隐藏的也找。
 const semanticState=options.state==='checked'||options.state==='unchecked'||options.state==='attached';
 // match:any/all 看所有匹配的元素，隐藏的也算进来：等“所有对话框都关了”时，本来就隐藏的那个不能让条件提前成立，也不能被当成歧义。
 if(options.match==='any'||options.match==='all'){
  const elements=pageDom({...options,mode:'all',allowHidden:true}) as Element[],results=elements.map(element=>elementMatches(element,options,semanticState));
  if(!elements.length)return onlyHidden(options);
  return options.match==='any'?results.some(Boolean):results.every(Boolean);
 }
 const gone=onlyHidden(options);
 // 按 ref 等它消失：这个文档里认识的元素被移除了就算已隐藏。不认识的 ref（别的文档、别的 frame、写错了）照旧报失效，不当成已隐藏。
 if(gone&&options.ref&&pageState().removed.has(options.ref))return true;
 let element:Element;try{element=pageDom({...options,mode:'resolve',allowHidden:semanticState});}catch(error){if((error as Error).name==='FengPrecondition'&&(error as any).code==='ELEMENT_NOT_FOUND')return gone;throw error;}
 return elementMatches(element,options,semanticState);
}
// 等待超时时的现场：停在哪个页面、是不是还在加载、最接近要等的文字、要等的元素有几个。调用方不用再截图才知道是登录过期、文字不一样还是元素没出来。
export function waitContext(options:any):any {
 const result:any={url:location.href.slice(0,300),title:document.title.slice(0,120),loading:document.readyState!=='complete'};
 if(options.textContains){
  const target=fold(options.textContains),grams=bigrams(target),scored=new Map<string,number>();
  for(const line of textLines()){const text=fold(line);if(!scored.has(text))scored.set(text,overlap(grams,text));}
  const closest=[...scored].filter(([,score])=>score>=0.5).sort((a,b)=>b[1]-a[1]||a[0].length-b[0].length).slice(0,3).map(([text])=>text.slice(0,LINE_CHARS));
  if(closest.length)result.closestText=closest;
 }
 if(options.selector||options.ref||options.locator){
  try{const all=pageDom({...options,mode:'all',allowHidden:true}) as Element[],shown=all.filter(element=>visibility(element).visible);result.matches=all.length;result.visible=shown.length;
   // 等隐藏却超时：列出还看得见的是哪几个，调用方好换成按其中一个的 ref 等。
   if(options.state==='hidden'&&shown.length)result.stillVisible=candidateList(shown).listed.slice(0,3).map(({ref,role,name}:any)=>({ref,...(role?{role}:{}),...(name?{name}:{})}));
   // 等属性等到超时：报出这些元素这个属性现在是什么（没有就是 null），调用方不用另读 DOM 就知道差在哪，比如 data-mention 是 activity 不是 #。
   if(options.attribute?.name&&all.length)result.attribute={name:String(options.attribute.name).slice(0,200),values:[...new Set(all.map(element=>{const value=element.getAttribute(options.attribute.name);return value===null?null:value.slice(0,100);}))].slice(0,3)};}
  catch(error){result.lookup=(error as {code?:string}).code||(error as Error).name;}
 }
 return result;
}
// 要等的文字里有多少个相邻两字出现在这一行里（0–1）。文字节点一般很短（表格一格一个），不用再按长度惩罚。
function bigrams(text:string){const grams=new Set<string>();for(let i=0;i<text.length-1;i++)grams.add(text.slice(i,i+2));if(text.length===1)grams.add(text);return grams;}
function overlap(grams:Set<string>,line:string){if(!grams.size)return 0;let hit=0;for(const gram of grams)if(line.includes(gram))hit++;return hit/grams.size;}
function elementMatches(element:Element,options:any,semanticState:boolean):boolean {
 const state=elementState(element),expected=options.state||'visible';
 if(['checked','unchecked'].includes(expected)&&!(element instanceof HTMLInputElement&&['checkbox','radio'].includes(element.type))&&!element.hasAttribute('aria-checked'))return false;
 const ariaChecked=element.getAttribute('aria-checked');
 const checked=element instanceof HTMLInputElement&&['checkbox','radio'].includes(element.type)?element.checked:ariaChecked==='true'?true:ariaChecked==='false'?false:undefined;
 // checked 是业务状态，不要求控件正在绘制；ARIA mixed/缺省不等于 unchecked。
 if(!semanticState&&(expected==='hidden'?state.visible:!state.visible))return false;
 if(expected==='enabled'&&state.disabled||expected==='disabled'&&!state.disabled||expected==='editable'&&(state.disabled||state.readOnly||!browserEditable(element))||expected==='checked'&&checked!==true||expected==='unchecked'&&checked!==false)return false;
 if(options.textContains&&!fold(element.textContent).includes(fold(options.textContains)))return false;
 if(options.textMatches&&!textMatches(element.textContent,options.textMatches))return false;
 if(options.valueEquals!==undefined){let expected=String(options.valueEquals);if(element instanceof HTMLTextAreaElement||(element as HTMLElement).isContentEditable)expected=expected.replace(/\r\n?/g,'\n');if((element as HTMLElement).isContentEditable)expected=expected.replace(/\u00a0/g,' ');if(editableValue(element)!==expected)return false;}
 if(options.fileCount!==undefined&&(!(element instanceof HTMLInputElement)||element.type!=='file'||element.files?.length!==options.fileCount))return false;
 if(options.attribute&&element.getAttribute(options.attribute.name)!==options.attribute.value)return false;
 return true;
}
function remember(element:Element,state:PageState) { let ref=state.refs.get(element);if(!ref){ref=`${state.id}:${++state.nextId}`;state.refs.set(element,ref);}state.elements.set(ref,element);while(state.elements.size>5000)state.elements.delete(state.elements.keys().next().value!);return ref; }
const parent=(element:Element)=>element.parentElement||(element.getRootNode() instanceof ShadowRoot?(element.getRootNode() as ShadowRoot).host:null);

// 只为自身透明、有尺寸的原生选择控件识别可见皮肤。读取有界、不改样式，点击仍命中 input。
function hasControlSkin(element:Element):boolean {
  if(!(element instanceof HTMLInputElement)||!['checkbox','radio'].includes(element.type))return false;
  const box=element.getBoundingClientRect();if(box.width<=0||box.height<=0)return false;
  const x=box.left+box.width/2,y=box.top+box.height/2;
  const labels=[...element.labels||[]].slice(0,4),next=element.nextElementSibling;
  // TodoMVC 使用未绑定 for 的相邻 label 承载背景图；不认领属于其他控件的 label。
  if(next instanceof HTMLLabelElement&&!next.control&&!next.htmlFor)labels.push(next);
  const colored=(color:string)=>color!=='transparent'&&color!=='rgba(0, 0, 0, 0)';
  let budget=32;
  for(const label of new Set(labels)){
    const walker=document.createTreeWalker(label,NodeFilter.SHOW_ELEMENT);let node:Element|null=label;
    while(node&&budget-->0){
      const owner=node.closest('label');
      if(node!==element&&(!owner?.htmlFor||owner.control===element)&&node.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})){
        const rect=node.getBoundingClientRect(),css=getComputedStyle(node);
        if(css.visibility==='visible'&&rect.left<=x&&rect.right>=x&&rect.top<=y&&rect.bottom>=y&&rect.width>0&&rect.height>0){
          const border=['Top','Right','Bottom','Left'].some(side=>parseFloat(css.getPropertyValue(`border-${side.toLowerCase()}-width`))>0&&colored(css.getPropertyValue(`border-${side.toLowerCase()}-color`)));
          if(css.backgroundImage!=='none'||colored(css.backgroundColor)||border)return true;
        }
      }
      node=walker.nextNode() as Element|null;
    }
  }
  return false;
}
// “看得见”只有一套标准，find、inspect、wait、后置条件、pageChange 和动作都用它：渲染出来了（没有 display:none、没在收起的 details 里、
// 没有 content-visibility:hidden），visibility 不是 hidden，自己和祖先都不透明，框的宽高都大于 0。
// 透明度和 visibility 按正在跑的动画、过渡结束时的值算：后台标签页、窗口被挡住或锁屏时 Chrome 不出帧，动画一直停在第一帧，
// 淡入的下拉框在页面里一直是 opacity:0，截图（会临时出帧）里却开着；正在淡出的也就按已经消失算。
const SHOWN={checkOpacity:true,checkVisibilityCSS:true} as const;
function animatedEnd(node:Element,property:'opacity'|'visibility'):string|undefined{
  let end:string|undefined;
  for(const animation of node.getAnimations?.()??[]){
    if(animation.playState!=='running')continue;
    const effect=animation.effect as KeyframeEffect|null;if(!effect?.getKeyframes)continue;
    const frames=effect.getKeyframes().filter(frame=>frame[property]!==undefined&&frame[property]!==null);if(!frames.length)continue;
    const timing=effect.getComputedTiming(),values=frames.map(frame=>String(frame[property]));
    if(timing.iterations===Infinity){end=property==='opacity'?String(Math.max(...values.map(Number))):values.includes('visible')?'visible':values.at(-1);continue;}
    const turns=Math.max(1,Math.ceil(Number(timing.iterations)||1)),direction=timing.direction||'normal';
    let reverse=direction==='reverse'||direction==='alternate'&&turns%2===0||direction==='alternate-reverse'&&turns%2===1;
    if(animation.playbackRate<0)reverse=!reverse;
    end=reverse?values[0]:values.at(-1);
  }
  return end;
}
const fadesIn=(node:Element)=>{const end=animatedEnd(node,'opacity');return end!==undefined&&Number.parseFloat(end)>0;};
// visibility 会继承：从元素往上找到设成 hidden 的那一层，看它是不是正在过渡到 visible。
function appearing(element:Element){
  for(let node:Element|null=element;node&&getComputedStyle(node).visibility!=='visible';node=parent(node))if(animatedEnd(node,'visibility')==='visible')return true;
  return false;
}
const boxed=(element:Element)=>{const rect=element.getBoundingClientRect();return rect.width>0&&rect.height>0;};
// 收起的 details 里只有 summary 看得见。
function collapsedBy(element:Element):Element|undefined{
  for(let details=element.parentElement?.closest('details:not([open])');details;details=details.parentElement?.closest('details:not([open])')){
    const summary=[...details.children].find(child=>child.tagName==='SUMMARY');
    if(!summary?.contains(element))return details;
  }
  return undefined;
}
interface Seen {visible:boolean;painted?:false;visualProxy?:'label-skin';animating?:true}
// 绝大多数元素走浏览器自带的 checkVisibility；它说看不见时才逐级看是不是正在显示出来的动画，或带皮肤的透明勾选框。
export function visibility(element:Element):Seen{
  const native=typeof element.checkVisibility==='function';
  if(native&&element.checkVisibility(SHOWN))return {visible:boxed(element)&&!collapsedBy(element)};
  if(!element.getClientRects().length)return {visible:false};
  let animating=false,selfTransparent=false;
  if(getComputedStyle(element).visibility!=='visible'){if(!appearing(element))return {visible:false};animating=true;}
  for(let node:Element|null=element;node;node=parent(node)){
    const css=getComputedStyle(node);
    if(!native&&css.display==='none')return {visible:false};
    if(node!==element&&css.contentVisibility==='hidden')return {visible:false};
    if(css.opacity!=='0')continue;
    if(fadesIn(node)){animating=true;continue;}
    if(node!==element)return {visible:false};
    selfTransparent=true;
  }
  if(!boxed(element)||collapsedBy(element))return {visible:false};
  if(selfTransparent)return hasControlSkin(element)?{visible:true,painted:false,visualProxy:'label-skin'}:{visible:false};
  return {visible:true,...(animating?{animating:true as const}:{})};
}
export function elementState(element:Element) {
  const {animating:_,...seen}=visibility(element);
  let disabled=element.matches(':disabled'),readOnly=!!(element as HTMLInputElement).readOnly;
  for(let node:Element|null=element;node;node=parent(node)){
    if(node.hasAttribute('inert')||node.getAttribute('aria-disabled')==='true')disabled=true;
    if(node.getAttribute('aria-readonly')==='true')readOnly=true;
  }
  return {...seen,disabled,readOnly};
}
// 看不见的原因和最近一个看得见的祖先，只在报错时算。
const REASONS:Record<string,string>={display_none:'display:none',collapsed:'在收起的 <details> 里',content_hidden:'content-visibility:hidden',not_rendered:'没有渲染出来（如 display:contents）',visibility_hidden:'visibility:hidden',transparent:'透明度为 0',empty_box:'尺寸为 0',outside_viewport:'滚到视口里也看不到（在视口外）',clipped:'被祖先的 overflow 裁掉了'};
export function describe(element:Element){
  const id=element.id?`#${element.id.slice(0,40)}`:'',classes=typeof element.className==='string'?element.className.trim().split(/\s+/).filter(Boolean).slice(0,2).map(name=>`.${name.slice(0,40)}`).join(''):'';
  const rect=element.getBoundingClientRect(),roleName=getRole(element),label=normalize(computeAccessibleName(element)).slice(0,40);
  return {ref:remember(element,pageState()),selector:`${element.tagName.toLowerCase()}${id}${classes}`,...(roleName?{role:roleName}:{}),...(label?{name:label}:{}),box:[Math.round(rect.x),Math.round(rect.y),Math.round(rect.width),Math.round(rect.height)]};
}
function hiddenCause(element:Element):{reason:string;node:Element}{
  const chain:Element[]=[];for(let node:Element|null=element;node;node=parent(node))chain.push(node);
  const blocked=chain.find(node=>getComputedStyle(node).display==='none');if(blocked)return {reason:'display_none',node:blocked};
  const details=collapsedBy(element);if(details)return {reason:'collapsed',node:details};
  const hidden=chain.slice(1).find(node=>getComputedStyle(node).contentVisibility==='hidden');if(hidden)return {reason:'content_hidden',node:hidden};
  if(!element.getClientRects().length)return {reason:'not_rendered',node:element};
  if(getComputedStyle(element).visibility!=='visible'&&!appearing(element)){let node=element;for(let up=parent(node);up&&getComputedStyle(up).visibility!=='visible';up=parent(up))node=up;return {reason:'visibility_hidden',node};}
  const clear=chain.slice().reverse().find(node=>getComputedStyle(node).opacity==='0'&&!fadesIn(node));if(clear)return {reason:'transparent',node:clear};
  return {reason:'empty_box',node:element};
}
export function explainHidden(element:Element,reason?:string){
  const cause=reason?{reason,node:element}:hiddenCause(element);
  let nearest:Element|null=parent(element);while(nearest&&!visibility(nearest).visible)nearest=parent(nearest);
  const node=describe(cause.node),around=nearest&&nearest!==document.body&&nearest!==document.documentElement?describe(nearest):undefined;
  const who=cause.node===element?'目标':`祖先 ${node.selector}`;
  const message=`目标看不见：${who}${REASONS[cause.reason]??cause.reason}。${around?`最近一个看得见的祖先是 ${around.selector}（ref ${around.ref}，${around.box[2]}×${around.box[3]}）。`:''}`;
  return {message,detail:{reason:cause.reason,...(cause.node===element?{}:{node}),...(around?{nearestVisible:around}:{})}};
}
// 说明本身算不出来（页面改了内置原型之类）也照样报这个错，只是少了说明。
function explained(code:string,build:()=>{message:string;detail?:unknown}):never{
  let info:{message:string;detail?:unknown}|undefined;try{info=build();}catch{/* 只少说明。 */}
  fail(code,info?.message??code,info?.detail);
}
/** 已经知道看不见（elementState 判过）时报错，带原因和最近一个看得见的祖先。 */
export function notVisible(element:Element,code='ELEMENT_NOT_VISIBLE',reason?:string):never{explained(code,()=>explainHidden(element,reason));}
export function assertShown(element:Element,code='ELEMENT_NOT_VISIBLE',reason?:string):void{
  if(!reason&&visibility(element).visible)return;
  notVisible(element,code,reason);
}
function sensitive(element:Element,accessibleName:string) {
  const input=element as HTMLInputElement;
  for(let node:Element|null=element;node;node=parent(node))if(node.hasAttribute('data-mcp-sensitive'))return true;
  return input.type==='password'||/^(?:current-password|new-password|one-time-code|cc-)/i.test(element.getAttribute('autocomplete')||'')||SENSITIVE_FIELD.test([input.name,input.id,element.getAttribute('aria-label'),accessibleName].filter(Boolean).join(' '));
}
// type 之后读回字段现在的内容：富文本编辑器会改写输入（比如把“#话题”变成正式话题），调用方看这个就知道写成了什么。截到 256 字，密码类不回。
export function fieldValue(element:Element):any {
 if(sensitive(element,normalize(computeAccessibleName(element))))return {valueRedacted:true};
 const value=editableValue(element);
 return value.length>256?{value:value.slice(0,256),valueTruncated:true,valueLength:value.length}:{value};
}
// 可操作的控件。contenteditable 写 "" 和 plaintext-only 也是可编辑的。
// find 结果里标成 within 的弹层角色。textbox 是富文本编辑器（contenteditable 的编辑根）：编辑器里已有的文字和浮层里的候选同名时，
// 不靠浮层规则也分得开（有的浮层不在浮层规则认得出的结构里）。
const LAYER_ROLES=new Set(['dialog','alertdialog','listbox','menu','textbox']);
export const CONTROL_SELECTOR='a,button,input,textarea,select,summary,[role],[contenteditable]:not([contenteditable="false"]),[tabindex]';
// 富文本编辑器（contenteditable 的编辑根）多数不写 role，按无障碍树的口径当作 textbox。
const editingHost=(element:Element)=>(element as HTMLElement).isContentEditable&&!(element.parentElement as HTMLElement|null)?.isContentEditable;
export function roleOf(element:Element){const role=getRole(element);return (!role||role==='generic')&&editingHost(element)?'textbox':role;}
// 一句话列出候选，报错时调用方直接拿 ref 用，不用再查一遍。
function candidateList(found:Element[]){
  const listed=found.slice(0,5).map(element=>({...describe(element),...(visibility(element).visible?{}:{visible:false})}));
  return {listed,text:listed.map((item,index)=>`${index}) ${item.selector}${item.role?`[${item.role}]`:''}${item.name?`「${item.name}」`:''}${item.visible===false?'（看不见）':''} ref ${item.ref}`).join('；')+(found.length>5?`；还有 ${found.length-5} 个`:'')};
}
// 按文字找到多个时，每个带上旁边的文字：最近一个比它多出文字的祖先（往上最多 4 层），40 字以内，太长就取它前后一段。
// 分得清两个“选择封面”哪个挨着“竖封面 3:4”，不用靠宽度猜。
const CONTEXT_CHARS=40;
function contextText(element:Element):string|undefined {
 const own=normalize((element as HTMLElement).innerText??element.textContent);let node=parent(element);
 for(let depth=0;node&&depth<4&&node!==document.body&&node!==document.documentElement;depth++,node=parent(node)){
  const text=normalize((node as HTMLElement).innerText??node.textContent);
  if(text.length<=own.length)continue;
  if(text.length<=CONTEXT_CHARS)return text;
  const start=Math.max(0,Math.min(text.indexOf(own)-15,text.length-CONTEXT_CHARS));
  return (start>0?'…':'')+text.slice(start,start+CONTEXT_CHARS)+(start+CONTEXT_CHARS<text.length?'…':'');
 }
 return undefined;
}
// 容器里可操作的子元素（只数看得见的，最多数到 100）。
function innerControls(element:Element){let count=0;for(const child of element.querySelectorAll(CONTROL_SELECTOR)){if(visibility(child).visible&&++count>=100)break;}return count;}
export function pageDom(options:any):any {
  const state=pageState(),all:Element[]=[];
  if(options.mode==='resolve'&&options.ref){const element=state.elements.get(options.ref);if(!element||!element.isConnected||element.ownerDocument!==document)fail('STALE_ELEMENT_REF','元素引用已失效，请重新 inspect。');return element;}
  function visit(root:Document|ShadowRoot){for(const element of root.querySelectorAll('*')){all.push(element);if(element.shadowRoot)visit(element.shadowRoot);}}
  visit(document);
  const names=new WeakMap<Element,string>(),roles=new WeakMap<Element,string|null>();
  const name=(e:Element)=>{if(!names.has(e))names.set(e,normalize(computeAccessibleName(e,{hidden:options.allowHidden===true})));return names.get(e)!;};
  const role=(e:Element)=>{if(!roles.has(e))roles.set(e,roleOf(e));return roles.get(e)!;};
  const label=(e:Element)=>((e as HTMLInputElement).labels?.length||e.hasAttribute('aria-label')||e.hasAttribute('aria-labelledby'))?name(e):'';
  const valueLimit=Number(options.valueLimit??256);
  // find 的结果标出元素在哪个弹层里：最近的对话框、列表框、菜单（within），没有角色时 fixed 或设了 z-index、相对整个页面定位的浮层（layer:'overlay'，
  // 盖住大半个视口的不算，那多半是页面本身的布局）。分得清下拉里的候选和编辑器里已有的同名文字、弹窗里的按钮。同一个祖先只算一次。
  const layers=new Map<Element,any>(),viewArea=innerWidth*innerHeight;
  function layerOf(element:Element):any {
   const chain:Element[]=[];let found:any=null;
   for(let node=parent(element);node&&node!==document.body&&node!==document.documentElement;node=parent(node)){
    if(layers.has(node)){found=layers.get(node);break;}
    chain.push(node);
    const kind=role(node);
    if(kind&&LAYER_ROLES.has(kind)){const label=name(node).slice(0,80);found={within:{role:kind,...(label?{name:label}:{}),ref:remember(node,state)}};break;}
    const css=getComputedStyle(node);
    if(css.position==='fixed'||css.position==='absolute'&&css.zIndex!=='auto'&&(node as HTMLElement).offsetParent===document.body){const rect=node.getBoundingClientRect();if(rect.width*rect.height<viewArea*0.9){found={layer:'overlay'};break;}}
   }
   for(const node of chain)layers.set(node,found);
   return found;
  }
  function metadata(element:Element):any {
    // 默认值不输出：一次任务要读十几次页面，每个元素都带 visible:true、disabled:false 很贵。没写就是可见、可用、可写。
    const fullName=name(element),{visible,disabled,readOnly,...look}=elementState(element),roleName=role(element),typeName=element.getAttribute('type');
    const result:any={ref:remember(element,state),tag:element.tagName.toLowerCase(),...(roleName?{role:roleName}:{}),name:fullName.slice(0,180),...(fullName.length>180?{nameTruncated:true}:{}),...(typeName?{type:typeName}:{}),...(visible?{}:{visible:false}),...(disabled?{disabled:true}:{}),...(readOnly?{readOnly:true}:{}),...look};
    const limited=(value:string)=>value.slice(0,valueLimit),hidden=sensitive(element,fullName);
    if(hidden)result.valueRedacted=true;
    else if(element instanceof HTMLInputElement&&element.type==='file'){const files=[...(element.files||[])].slice(0,10);result.fileCount=element.files?.length||0;result.fileNames=files.map(file=>limited(file.name));result.fileSizes=files.map(file=>file.size);}
    else if(element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement){result.value=limited(element.value);if(element.value.length>valueLimit){result.valueTruncated=true;result.valueLength=element.value.length;}}
    else if(element instanceof HTMLSelectElement){result.value=limited(element.value);result.selectedIndex=element.selectedIndex;if(element.multiple)result.multiple=true;result.selectedOptions=[...element.selectedOptions].slice(0,20).map(o=>({value:limited(o.value),label:limited(o.label),selected:true,disabled:o.disabled||o.parentElement instanceof HTMLOptGroupElement&&o.parentElement.disabled}));result.totalSelected=element.selectedOptions.length;}
    else if((element as HTMLElement).isContentEditable){const value=editableValue(element);result.value=limited(value);if(value.length>valueLimit)result.valueTruncated=true;}
    if(element instanceof HTMLInputElement&&['checkbox','radio'].includes(element.type)){result.checked=element.checked;if(element.indeterminate)result.indeterminate=true;}
    if(element instanceof HTMLOptionElement)result.selected=element.selected;
    for(const attribute of ['checked','selected','expanded','pressed']){const value=element.getAttribute(`aria-${attribute}`);if(value!==null&&!Object.hasOwn(result,attribute))result[attribute]=value==='true'?true:value==='false'?false:value;}
    if(element.hasAttribute('aria-valuenow')&&!hidden)result.valueNow=element.getAttribute('aria-valuenow');
    // 外层容器的文字包含里面每一项：按文字找到它时，box 和 controls 让调用方看得出这是个容器，点它中心会落到中间那一项上。
    const controls=innerControls(element);
    if(options.mode==='find'){const rect=element.getBoundingClientRect();result.box=[Math.round(rect.x),Math.round(rect.y),Math.round(rect.width),Math.round(rect.height)];if(controls)result.controls=controls;const layer=layerOf(element);if(layer)Object.assign(result,layer);
      if(options.locator?.text!==undefined&&found.length>1){const around=contextText(element);if(around)result.context=around;}}
    else if(controls>=2)result.controls=controls;
    return result;
  }
  let scope:Element|undefined;
  if(options.scopeRef){scope=state.elements.get(options.scopeRef);if(!scope||!scope.isConnected||scope.ownerDocument!==document)fail('STALE_ELEMENT_REF','范围 ref 已失效，请重新 find 或 inspect。');}
  else if(options.scopeSelector){let matches:Element[];try{matches=all.filter(e=>e.matches(options.scopeSelector));}catch{fail('INVALID_SELECTOR','范围 CSS 选择器无效。');}
    if(matches.length>1){const {listed,text}=candidateList(matches);fail('AMBIGUOUS_SCOPE',`范围匹配 ${matches.length} 个元素：${text}。用其中一个 ref 作 scopeRef。`,{candidates:listed,total:matches.length});}
    if(!matches.length)fail('SCOPE_NOT_FOUND','未找到观察范围。');scope=matches[0];}
  const candidates=scope?all.filter(e=>{for(let node:Element|null=e;node;node=parent(node))if(node===scope)return true;return false;}):all;
  let found:Element[],nthOf:number|undefined,insideRoots:Set<Element>|undefined;
  if(options.ref){const element=state.elements.get(options.ref);if(!element||!element.isConnected||element.ownerDocument!==document)fail('STALE_ELEMENT_REF','元素引用已失效，请重新 inspect。');found=[element];}
  else if(options.selector){try{found=candidates.filter(e=>e.matches(options.selector));}catch{fail('INVALID_SELECTOR','CSS 选择器无效。');}}
  else if(options.locator){const q=options.locator,matches=(value:unknown,expected:unknown)=>expected===undefined||(q.exact===false?fold(value).toLowerCase().includes(fold(expected).toLowerCase()):fold(value)===fold(expected));
    // inside：只找在这些元素里面（含它们本身）的，可以匹配多个，比如每个候选各一个容器。先按它筛，后面算可见、名称的元素就少了。
    if(q.inside!==undefined){try{insideRoots=new Set(all.filter(e=>e.matches(q.inside)));}catch{fail('INVALID_SELECTOR','locator.inside 的 CSS 选择器无效。');}}
    const roots=insideRoots,within=(e:Element)=>{if(!roots)return true;for(let node:Element|null=e;node;node=parent(node))if(roots.has(node))return true;return false;};
    found=candidates.filter(e=>within(e)&&(options.allowHidden===true||visibility(e).visible)&&(q.role===undefined||matches(role(e),q.role))&&(q.name===undefined||matches(name(e),q.name))&&(q.label===undefined||matches(label(e),q.label))&&matches(e.getAttribute('placeholder'),q.placeholder)&&matches(e.getAttribute('data-testid'),q.testId)&&matches(e.textContent,q.text));
    // 按文字找时外层容器也“包含”这段文字：只留最贴近文字的那一层。
    if(q.text!==undefined)found=found.filter(e=>!found.some(child=>child!==e&&e.contains(child)));
    if(q.nth!==undefined){
      if(q.nth>=found.length){if(options.mode==='resolve'||options.mode==='all')fail('ELEMENT_NOT_FOUND',`只找到 ${found.length} 个匹配，没有第 ${q.nth} 个（nth 从 0 起）。`);}
      nthOf=found.length;found=found.slice(q.nth,q.nth+1);
    }
  }else found=candidates.filter(e=>e.matches(CONTROL_SELECTOR)&&(e===scope||visibility(e).visible));
  if(options.mode==='all')return found;
  if(options.mode==='resolve'){
    if(!options.ref&&!options.selector&&!options.locator)fail('ELEMENT_TARGET_REQUIRED');
    if(found.length>1){
      const {listed,text}=candidateList(found),q=options.locator;
      // 调用方传了 exact:false（包含匹配）才撞上这么多个，而其中正好只有一个和条件一字不差：提示去掉它，不替调用方挑。
      let loose='';
      if(q?.exact===false&&(q.text!==undefined||q.name!==undefined||q.label!==undefined)){
        const same=(value:unknown,expected:unknown)=>expected===undefined||fold(value)===fold(expected);
        const exact=found.filter(e=>same(e.textContent,q.text)&&same(name(e),q.name)&&same(label(e),q.label));
        if(exact.length===1)loose=`其中只有 ref ${remember(exact[0]!,state)} 和条件一字不差：去掉 exact:false（默认就是精确匹配）就只剩它。`;
      }
      fail('AMBIGUOUS_SELECTOR',`匹配 ${found.length} 个元素，没有执行：${text}。用其中一个 ref${options.locator?'，或在 locator 里加 nth（0 起）':''}，或收窄条件。${loose}`,{candidates:listed,total:found.length});
    }
    if(!found.length)fail('ELEMENT_NOT_FOUND',insideRoots?.size===0?'未找到目标元素：locator.inside 没匹配到任何元素。':'未找到目标元素。');remember(found[0]!,state);return found[0];
  }
  const offset=Number(options.offset||0),limit=Number(options.limit||50),elements=found.slice(offset,offset+limit).map(metadata);
  const result:any={documentId:state.id,elements,totalElements:found.length,nextOffset:offset+limit<found.length?offset+limit:null,...(nthOf!==undefined?{matchedBeforeNth:nthOf}:{}),...(insideRoots?.size===0?{insideMatched:0}:{})};
  if(options.mode==='find')return result;
  const text=scope?(scope instanceof HTMLElement?scope.innerText:scope.textContent||''):document.body?.innerText||'',textLimit=Number(options.textLimit??12000);
  Object.assign(result,{title:document.title,url:location.href,text:text.slice(0,textLimit),textLength:text.length,textTruncated:text.length>textLimit,frames:candidates.filter(e=>e instanceof HTMLIFrameElement).map(e=>({src:(e as HTMLIFrameElement).src,name:(e as HTMLIFrameElement).name,title:(e as HTMLIFrameElement).title}))});
  const key=JSON.stringify({scopeSelector:options.scopeSelector,scopeRef:scope?remember(scope,state):undefined,offset,limit,textLimit,valueLimit});
  const items=new Map<string,string>(elements.map((e:any)=>[e.ref,JSON.stringify(e)])),previous:Snapshot|undefined=options.sinceSnapshot?state.snapshots.get(options.sinceSnapshot):undefined;
  const structure=JSON.stringify({totalElements:result.totalElements,nextOffset:result.nextOffset,frames:result.frames,textLength:result.textLength,textTruncated:result.textTruncated});
  const snapshot:Snapshot={id:makeId(),key,time:Date.now(),items,text:result.text,title:result.title,url:result.url,structure,size:structure.length+result.text.length+[...items.values()].reduce((n,s)=>n+s.length,0)};
  if(snapshot.size<=2*1024*1024){state.snapshots.set(snapshot.id,snapshot);while(state.snapshots.size>8||[...state.snapshots.values()].reduce((n,s)=>n+s.size,0)>2*1024*1024)state.snapshots.delete(state.snapshots.keys().next().value!);result.snapshotId=snapshot.id;}
  if(previous?.key===key){result.mode='delta';result.baseSnapshotId=previous.id;result.elements=elements.filter((e:any)=>previous.items.get(e.ref)!==items.get(e.ref));result.removedRefs=[...previous.items.keys()].filter(ref=>!items.has(ref));if(previous.text===result.text)delete result.text;result.unchanged=!result.elements.length&&!result.removedRefs.length&&previous.text===snapshot.text&&previous.title===snapshot.title&&previous.url===snapshot.url&&previous.structure===structure;}
  else {result.mode='full';if(options.sinceSnapshot)result.baselineStatus=previous?'scope_changed':'expired_or_different_document';}
  return result;
}

// 动作前后的页面差异：动作前记下可见文字和可见控件的状态，动作后比对。只读，结果限长，放进动作结果，模型少读一次页面。
const CONTROLS=`${CONTROL_SELECTOR},iframe`;
const CHANGE_BYTES=600,TEXT_BYTES=200,LINE_CHARS=100,VALUE_CHARS=60,MAX_LINES=5000,MAX_CONTROLS=6;
type ControlState=Record<string,unknown>;
interface PageWatch {url:string;title:string;lines:Set<string>;controls:WeakMap<Element,ControlState>;observer:MutationObserver;touched:number}
let watching:PageWatch|undefined;
// 按文字节点比，不按 innerText 的行：行内元素共用一行，新增一个词会让整行都算新文字。
function textLines() {
  const lines:string[]=[],root=document.body;if(!root)return lines;
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),shown=new Map<Element,boolean>();let node:Node|null;
  while(lines.length<MAX_LINES&&(node=walker.nextNode())){
    const text=normalize(node.nodeValue),parent=node.parentElement;
    if(!text||!parent||['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(parent.tagName))continue;
    if(!shown.has(parent))shown.set(parent,visibility(parent).visible);
    if(shown.get(parent))lines.push(text);
  }
  return lines;
}
const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).length;
// 只算当时可见的控件：展开的菜单、弹层里的按钮往往早就在 DOM 里，对模型来说是新的。
const visibleControls=()=>[...document.querySelectorAll(CONTROLS)].filter(element=>visibility(element).visible);
// 填的值、勾选、展开、按钮上的字：这些变了文字比对看不出来，模型只好再读一遍页面。内容多的容器不取文字，那是页面正文。
function controlState(element:Element):ControlState {
  const state:ControlState={};
  if(element instanceof HTMLInputElement&&['checkbox','radio'].includes(element.type))state.checked=element.checked;
  else if(element instanceof HTMLInputElement&&element.type==='file')state.fileCount=element.files?.length||0;
  else if(element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement||element instanceof HTMLSelectElement)state.value=element.value;
  else if(element.childElementCount<=4)state.text=normalize(element.textContent).slice(0,VALUE_CHARS);
  for(const attribute of ['checked','selected','expanded','pressed']){const value=element.getAttribute(`aria-${attribute}`);if(value!==null)state[attribute]=value;}
  if(element.matches(':disabled')||element.getAttribute('aria-disabled')==='true')state.disabled=true;
  return state;
}
export function watchPage() {
  watching?.observer.disconnect();
  const controls=new WeakMap<Element,ControlState>();for(const element of visibleControls())controls.set(element,controlState(element));
  const current:PageWatch={url:location.href,title:document.title,lines:new Set(textLines()),controls,touched:0,observer:new MutationObserver(()=>{current.touched=Date.now();})};
  current.observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true});
  watching=current;return true;
}
// 页面已经安静了多久。-1 表示动作之后还没有任何变化；null 表示这个文档没有在观察（已经换了文档）。
export const pageQuietFor=()=>watching?(watching.touched?Date.now()-watching.touched:-1):null;
export function pageChanges() {
  const before=watching;if(!before)return null;
  before.observer.disconnect();watching=undefined;
  const state=pageState(),now=textLines(),after=new Set(now),controls=visibleControls();
  const fresh=controls.filter(element=>!before.controls.has(element));
  const label=(element:Element)=>normalize(computeAccessibleName(element));
  const updated:any[]=[];let moreUpdated=0;
  for(const element of controls){
    const previous=before.controls.get(element);if(!previous)continue;
    const current=controlState(element),changes=Object.keys({...previous,...current}).filter(key=>previous[key]!==current[key]);if(!changes.length)continue;
    if(updated.length>=MAX_CONTROLS){moreUpdated++;continue;}
    const fullName=label(element),item:any={ref:remember(element,state),name:fullName.slice(0,VALUE_CHARS)};
    for(const key of changes){
      if(key==='value'&&sensitive(element,fullName))item.valueRedacted=true;
      else if(key==='value')item.value=String(current.value??'').slice(0,VALUE_CHARS);
      else if(key!=='text'||current.text!==item.name)item[key]=current[key]??null;
    }
    updated.push(item);
  }
  const names=fresh.slice(0,MAX_CONTROLS).map(element=>label(element).slice(0,VALUE_CHARS)),seen=new Set([...names,...updated.flatMap(item=>[item.name,item.text])]);
  const lines=[...new Set(now.filter(line=>!before.lines.has(line)&&!seen.has(line)))],removed=[...before.lines].filter(line=>!after.has(line)).length;
  const result:any={changed:location.href!==before.url||document.title!==before.title||lines.length>0||fresh.length>0||updated.length>0||removed>0};
  if(location.href!==before.url)result.url=location.href.slice(0,200);
  if(document.title!==before.title)result.title=document.title.slice(0,80);
  if(removed)result.removedText=removed;
  const added:string[]=[];
  for(const line of lines){const text=line.slice(0,LINE_CHARS);if(bytes(added)+bytes(text)>TEXT_BYTES)break;added.push(text);}
  if(added.length)result.added=added;
  if(lines.length>added.length)result.moreText=lines.length-added.length;
  // 预算先给状态变化：它回答“我刚才做的生效了没有”，新控件下一步才用得上。
  const fit=(key:string,items:any[])=>{const kept:any[]=[];for(const item of items){if(bytes({...result,[key]:[...kept,item]})>CHANGE_BYTES)break;kept.push(item);}if(kept.length)result[key]=kept;return kept.length;};
  const shown=fit('updated',updated);if(updated.length-shown+moreUpdated)result.moreUpdated=updated.length-shown+moreUpdated;
  const items=fresh.slice(0,MAX_CONTROLS).map((element,index)=>({ref:remember(element,state),role:roleOf(element)||element.tagName.toLowerCase(),name:names[index]}));
  const listed=fit('elements',items);if(fresh.length>listed)result.moreElements=fresh.length-listed;
  return result;
}

// ---- 指针动作的落点 ----
const CHOICE='[role=option],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=tab],[role=treeitem],[role=radio],option,input[type=radio]';
// 逐层（open Shadow DOM）命中测试。拖动源可能随指针盖住落点，只排除这个源节点。
function hitAt(target:Element,x:number,y:number,ignored?:Element):Element|undefined{
  let node:Element=target;
  for(;;){
    const root=node.getRootNode() as Document|ShadowRoot;
    const hit=ignored&&ignored!==target&&root.elementsFromPoint?root.elementsFromPoint(x,y).find(item=>item!==ignored&&!ignored.contains(item)):root.elementFromPoint(x,y);
    if(!hit||hit!==node&&!node.contains(hit)){
      if(hit&&node===target&&sameControl(target,hit))return undefined;
      return hit||document.documentElement;
    }
    if(root instanceof ShadowRoot)node=root.host;else return undefined;
  }
}
// 点 label 里的文字（不是控件本身）时，落点上常是铺满整个 label 的透明 input：点下去触发的就是这个 label 的控件，放行。
// 落点是 label 里的链接、按钮这类别的控件时不算，点它们不会触发 label 的控件；目标就是控件本身时仍要命中它（样式化选择控件的约定）。
const INTERACTIVE='a[href],button,input,select,textarea,[tabindex],[contenteditable]:not([contenteditable="false"])';
function sameControl(target:Element,hit:Element){
  const label=target.closest('label'),control=label?.control;
  if(!label||!control||control===target||control.contains(target))return false;
  if(hit===control||control.contains(hit))return true;
  const other=hit.closest(INTERACTIVE);
  return label.contains(hit)&&!(other&&other!==label&&label.contains(other));
}
function deepHit(x:number,y:number){let hit=document.elementFromPoint(x,y);while(hit?.shadowRoot){const inner=hit.shadowRoot.elementFromPoint(x,y);if(!inner||inner===hit)break;hit=inner;}return hit;}
// 按坐标点击时点中的是什么：点到空白处、弹窗外，结果里一眼看得出，不用再截图。在隔离世界里查，页面看不到。
// 没有名称时带文字，只带 40 字以内的：大容器的文字是一整片内容，带上反而像点中了字。
export function pointTarget(x:number,y:number){
 const hit=deepHit(x,y);if(!hit)return null;
 const {ref,selector,role,name}=describe(hit),text=name?'':normalize((hit as HTMLElement).innerText??hit.textContent);
 return {ref,selector,...(role?{role}:{}),...(name?{name}:{}),...(text&&text.length<=40?{text}:{})};
}
// 截图超出视口时（整页、长元素、clip），固定在屏幕上的元素是按截图时的位置画进图里的：页面滚过以后，整页图的顶栏出现在中间。
// 在视口里按 7×7 的网格取点，看最上面那个元素往上有没有固定定位或已经粘住的粘性元素，算出它们在图片里的位置，最多 3 个。
// 占满大半个视口的不算，那是整个应用套在固定层里，不是顶栏。只读样式和位置，页面看不到。
export function fixedElements(area:{x:number;y:number;width:number;height:number},scale:number){
 const checked=new Map<Element,boolean>(),found:Element[]=[],viewArea=innerWidth*innerHeight;
 const pinned=(element:Element)=>{
  let result=checked.get(element);if(result!==undefined)return result;
  const css=getComputedStyle(element);result=css.position==='fixed';
  if(!result&&css.position==='sticky'){const rect=element.getBoundingClientRect(),top=parseFloat(css.top),bottom=parseFloat(css.bottom);result=Math.abs(rect.top-top)<1||Math.abs(innerHeight-rect.bottom-bottom)<1;}
  checked.set(element,result);return result;
 };
 for(let column=0;column<7;column++)for(let row=0;row<7;row++){
  for(let node=deepHit((column+0.5)*innerWidth/7,(row+0.5)*innerHeight/7);node&&node!==document.body&&node!==document.documentElement;node=parent(node)){
   if(!pinned(node))continue;
   const rect=node.getBoundingClientRect();if(!found.includes(node)&&rect.width*rect.height<viewArea*0.9)found.push(node);break;
  }
 }
 const boxes=[];
 for(const element of found){
  const rect=element.getBoundingClientRect(),x=(rect.left+scrollX-area.x)*scale,y=(rect.top+scrollY-area.y)*scale,width=rect.width*scale,height=rect.height*scale;
  if(x+width<=0||y+height<=0||x>=area.width*scale||y>=area.height*scale)continue;
  boxes.push({selector:describe(element).selector,box:[Math.round(x),Math.round(y),Math.round(width),Math.round(height)]});
 }
 return boxes.sort((a,b)=>b.box[2]!*b.box[3]!-a.box[2]!*a.box[3]!).slice(0,3);
}
// 上传的目标不是文件框时，用它对应的那个：label 指向的控件，它里面的，再逐层往上，停在第一层含有文件框的祖先（到 body 为止）。
// 最多往上 4 层：上传控件里文字和文件框一般挨着，走得太远会把别处的文件框当成它的。那一层有多个就报出来，不猜。例如一个封面弹窗里“上传封面”和“生成参考图”各有一个隐藏的文件框，从“点击上传文件或拖拽文件到这里”往上最先碰到的是前一个。
const UPLOAD_LEVELS=4;
const isFileInput=(element:unknown):element is HTMLInputElement=>element instanceof HTMLInputElement&&element.type==='file';
function fileInputsIn(root:Element){
 const found:HTMLInputElement[]=[],visit=(node:Element|ShadowRoot)=>{for(const element of node.querySelectorAll('*')){if(isFileInput(element))found.push(element);if(element.shadowRoot)visit(element.shadowRoot);}};
 if(isFileInput(root))found.push(root);visit(root);if(root.shadowRoot)visit(root.shadowRoot);return found;
}
// 往上碰到的那层有几个文件框、分不出用哪个时（比如 Semi Design 的 Upload 自带主框和替换框，同在一层），chooser 为 true 就交给扩展：
// 像用户一样点一下目标，看页面自己打开哪个文件框的选择框（见 executor 的 uploadByChooser）。只在目标看得见、自己里面没有文件框时这么做：
// 目标本身就装着几个文件框，说明定位的是个大容器，点它中心是瞎点，照旧报出来。
export function uploadTarget(element:Element,count:number,chooser=false){
 let input:HTMLInputElement|undefined,near:Element|undefined;
 if(isFileInput(element))input=element;
 else{
  const label=element instanceof HTMLLabelElement?element:element.closest('label');
  if(label&&isFileInput(label.control)){input=label.control;near=label;}
  for(let node:Element|null=element,depth=0;!input&&node&&depth<=UPLOAD_LEVELS&&node!==document.body&&node!==document.documentElement;node=parent(node),depth++){
   const inputs=fileInputsIn(node);
   if(inputs.length>1){
    const {listed,text}=candidateList(inputs);
    if(chooser&&node!==element&&visibility(element).visible){
     const usable=inputs.filter(item=>!item.disabled);
     if(!usable.length)fail('ELEMENT_DISABLED','附近的文件框都被禁用了，没有上传。');
     if(count>1&&!usable.some(item=>item.multiple))fail('MULTIPLE_FILES_NOT_ALLOWED');
     return {chooser:{target:remember(element,pageState()),candidates:listed,total:inputs.length,text}};
    }
    fail('AMBIGUOUS_FILE_INPUT',`${node===element?'目标里面':'目标附近'}有 ${inputs.length} 个文件框，没有上传：${text}。定位到离要用的那个更近的按钮或区域，或用其中一个 ref。`,{candidates:listed,total:inputs.length});
   }
   if(inputs.length===1){input=inputs[0];near=node;}
  }
  if(!input)fail('NOT_FILE_INPUT',`目标不是文件框，它里面和往上 ${UPLOAD_LEVELS} 层都没有文件框。定位上传按钮、上传区域里的字，或直接定位 input[type=file]。`);
 }
 if(input.disabled)fail('ELEMENT_DISABLED','文件框被禁用了，没有上传。');
 if(!input.multiple&&count>1)fail('MULTIPLE_FILES_NOT_ALLOWED');
 const ref=remember(input,pageState());
 if(!near)return {ref};
 const area=normalize((near as HTMLElement).innerText??near.textContent).slice(0,40),accept=input.getAttribute('accept');
 return {ref,input:{ref,selector:describe(input).selector,...(accept?{accept:accept.slice(0,100)}:{}),...(input.multiple?{multiple:true}:{}),...(area?{area}:{})}};
}
// 点了目标以后页面打开的选择框属于哪个文件框（扩展从 Page.fileChooserOpened 拿到，在隔离世界里解析成元素传进来）。不抛错，出错的情况带 error 返回：
// 这时点击已经发出，扩展要把它报成“已派发”。area 用点的那个目标的文字。
export function chosenUpload(input:unknown,count:number,targetRef:string){
 if(!isFileInput(input))return {error:{code:'NOT_FILE_INPUT',message:'页面打开的选择框不属于文件框，没有上传。'}};
 if(input.disabled)return {error:{code:'ELEMENT_DISABLED',message:'页面打开的选择框属于一个被禁用的文件框，没有上传。'}};
 if(!input.multiple&&count>1)return {error:{code:'MULTIPLE_FILES_NOT_ALLOWED',message:'页面打开的文件框只接受一个文件，没有上传。'}};
 const state=pageState(),ref=remember(input,state),target=state.elements.get(targetRef);
 const area=target?normalize((target as HTMLElement).innerText??target.textContent).slice(0,40):'',accept=input.getAttribute('accept');
 return {ref,input:{ref,selector:describe(input).selector,...(accept?{accept:accept.slice(0,100)}:{}),...(input.multiple?{multiple:true}:{}),...(area?{area}:{}),via:'fileChooser'}};
}
const shortName=(element:Element)=>{const value=normalize(computeAccessibleName(element)||element.textContent).slice(0,40);return value?`「${value}」`:'';};
// 目标已经完整在视口里、中心点得到，就不滚动：真人不会先把看得见的东西滚到正中再点；滚动还会让页面收到 scroll 事件、触发懒加载，
// 调用方刚从 find 拿到的 box 也跟着失效。看不全、比视口大且中心不在视口里、中心被裁掉或被挡住（比如压在固定顶栏下）才照旧滚到正中。
// iframe 里照旧每次滚到正中：这里只看得到本 frame 的视口，iframe 自己可能在外层页面的视口外（跨源时也读不到外层），scrollIntoView 会连外层一起滚。
function needsScroll(element:Element){
  if(typeof top!=='undefined'&&(top as unknown)!==globalThis)return true;
  const box=element.getBoundingClientRect(),cx=(box.left+box.right)/2,cy=(box.top+box.bottom)/2;
  const inside=box.left>=0&&box.top>=0&&box.right<=innerWidth&&box.bottom<=innerHeight;
  const big=box.width>innerWidth||box.height>innerHeight,centred=cx>=0&&cx<innerWidth&&cy>=0&&cy<innerHeight;
  if(!inside&&!(big&&centred))return true;
  return !!hitAt(element,cx,cy);
}
export function actionPoint(element:Element,state:{visible:boolean;disabled:boolean},options:{action:string;scroll:boolean;ignoredRef?:string;aim?:[number,number]}){
  if(state.disabled&&['click','doubleClick','drag','setChecked'].includes(options.action))fail('ELEMENT_DISABLED');
  if(!state.visible)notVisible(element);
  // 滚了就在结果里带 scrolled：目标在视口里移动了多少（页面或它所在的滚动容器往下滚了多少），之前拿到的 box、截图坐标都要按它换算或重新取。
  let scrolled:{x:number;y:number}|undefined;
  if(options.scroll&&needsScroll(element)){
    const before=element.getBoundingClientRect();element.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
    const after=element.getBoundingClientRect(),dx=Math.round(before.left-after.left),dy=Math.round(before.top-after.top);
    if(dx||dy)scrolled={x:dx,y:dy};
  }
  const box=element.getBoundingClientRect();
  const left=Math.max(0,box.left),right=Math.min(innerWidth,box.right),top=Math.max(0,box.top),bottom=Math.min(innerHeight,box.bottom);
  if(right<=left||bottom<=top)notVisible(element,'ELEMENT_NOT_VISIBLE','outside_viewport');
  const ignored=options.ignoredRef?pageDom({ref:options.ignoredRef,mode:'resolve'}):undefined;
  let x=(left+right)/2,y=(top+bottom)/2;const cx=x,cy=y;
  // 像真人一样操作时，落点在可见部分里偏离中心（比例由扩展给，一次动作内不变）并对齐设备像素；
  // 偏过去之后点到的不是中心点到的那个控件或选项（容器里的另一项、被挡住），就退回中心。
  if(options.aim){
    const grid=devicePixelRatio||1,snap=(value:number)=>Math.round(value*grid)/grid,centre={x:snap(x),y:snap(y)};
    const offset={x:snap(x+options.aim[0]*Math.max(0,(right-left)/2-2)*.6),y:snap(y+options.aim[1]*Math.max(0,(bottom-top)/2-2)*.6)};
    const owner=(point:{x:number;y:number})=>{const hit=deepHit(point.x,point.y);return hit&&[hit.closest(CHOICE),hit.closest(CONTROL_SELECTOR)];};
    const here=owner(offset),there=owner(centre);
    ({x,y}=!hitAt(element,offset.x,offset.y,ignored)&&here&&there&&here[0]===there[0]&&here[1]===there[1]?offset:centre);
  }
  const blocker=hitAt(element,x,y,ignored);
  if(blocker){
    // 落点上显示的是目标的祖先：目标在这里被 overflow 裁掉了，或者它不接收指针事件。
    if(blocker.contains(element)){if(getComputedStyle(element).pointerEvents==='none')fail('ELEMENT_OBSCURED','目标设了 pointer-events:none，点不到它，没有点击。点它外面那层接收点击的元素。',{reason:'pointer_events_none'});notVisible(element,'ELEMENT_NOT_VISIBLE','clipped');}
    explained('ELEMENT_OBSCURED',()=>{
      const cover=describe(blocker),control=element.closest('label')?.control;
      // 点的是单选、复选框的文字：setChecked 直接点那个 input，不经过文字。点的就是 input 本身时这条建议没用。
      const hint=control instanceof HTMLInputElement&&control!==element&&['checkbox','radio'].includes(control.type)?`它属于${control.type==='radio'?'单选框':'复选框'}，改用 setChecked 定位那个 input（ref ${remember(control,pageState())}）。`:'先关掉挡住它的弹层或提示，或者点挡住它的那个元素（如果那才是要点的）。';
      return {message:`目标被 ${cover.selector}${shortName(blocker)} 挡住了，没有点击。${hint}`,detail:{cover}};
    });
  }
  // 偏离中心时另带中心：核对“目标没动”比的是中心，悬停放大一类效果不会被当成移动。
  const result:any={x,y,...(options.aim?{cx,cy}:{}),width:innerWidth,height:innerHeight,documentId:documentId(),ref:remember(element,pageState()),...(scrolled?{scrolled}:{})};
  // 按 ref、locator 点击也带落点上的元素，和按坐标点击一样：调用方不用再截图就能确认点中的是什么。和取点在同一次执行里读，不多一次调用。
  if(['click','doubleClick'].includes(options.action)){try{const hit=pointTarget(x,y);if(hit)result.hit=hit;}catch{/* 只是说明，读不到就不带，不影响点击。 */}}
  // 点容器的中心会落到里面某一项上：一组选项里落到某一项时不点，其他容器在结果里写明落到了哪里。
  if(['click','doubleClick'].includes(options.action)&&!element.matches(CHOICE)){
    const hit=deepHit(x,y),inside=hit&&hit!==element&&element.contains(hit)?hit:undefined;
    const item=inside?.closest(CHOICE);
    if(item&&element.contains(item)&&item!==element){
      const choices=[...element.querySelectorAll(CHOICE)].filter(choice=>visibility(choice).visible).length;
      if(choices>=2)fail('CONTAINER_TARGET',`目标 ${describe(element).selector} 是一组选项（${choices} 项）的容器，点它中心会选中${shortName(item)}，没有点击。要点哪一项，用 chrome_find 按那一项的文字拿它的 ref；选下拉项用 choose。`,{item:describe(item),choices});
    }
    if(inside&&innerControls(element)>=2){const landed=inside.closest(CONTROL_SELECTOR);if(landed&&landed!==element&&element.contains(landed))result.landedOn={selector:describe(landed).selector,...(roleOf(landed)?{role:roleOf(landed)}:{}),...(shortName(landed)?{name:shortName(landed).slice(1,-1)}:{})};}
  }
  return result;
}

// ---- 选下拉项（choose） ----
// 触发器点开前记下看得见的元素：点开后才出现的就是下拉里的东西。
let choiceBaseline:WeakSet<Element>|undefined;
function everyElement(){const all:Element[]=[];const visit=(root:Document|ShadowRoot)=>{for(const element of root.querySelectorAll('*')){all.push(element);if(element.shadowRoot)visit(element.shadowRoot);}};visit(document);return all;}
export function markChoices(){const seen=new WeakSet<Element>();for(const element of everyElement())if(visibility(element).visible)seen.add(element);choiceBaseline=seen;return true;}
const OPTIONISH='[role=option],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=treeitem],option';
export function choiceExpanded(element:Element){
  // 原生 select 的 option 没有渲染框，choose 永远选不到；这里在点开触发器之前拒绝（executor 在点击前先调本函数），不点开原生下拉。
  if(element instanceof HTMLSelectElement)fail('NOT_CUSTOM_DROPDOWN',`目标 ${describe(element).selector} 是原生 <select>，choose 只用于自定义下拉；用 action:"select" 按选项文字或值选择。没有点击。`);
  const holder=element.matches('[aria-expanded]')?element:element.querySelector('[aria-expanded]')??element.closest('[aria-expanded]');return holder?.getAttribute('aria-expanded')==='true';}
export function choiceCandidates(trigger:Element,option:string,opened:boolean){
  const want=normalize(option).toLowerCase(),fresh=(element:Element)=>!!choiceBaseline&&!choiceBaseline.has(element);
  // 候选必须能证明属于这个触发器：先看 aria-controls / aria-owns 指到的弹层；没有就只认点开后才出现的元素，
  // 页面上本来就看得见的别的下拉里的同名选项不算。已经开着的下拉（opened=false）没有“新出现”，没有 aria 指向时不收窄。
  const holders=[trigger,...trigger.querySelectorAll('[aria-controls],[aria-owns]')],scope=trigger.getRootNode() as Document|ShadowRoot;
  const roots=holders.flatMap(holder=>`${holder.getAttribute('aria-controls')??''} ${holder.getAttribute('aria-owns')??''}`.split(/\s+/).filter(Boolean)).map(id=>scope.getElementById?.(id)??document.getElementById(id)).filter((root):root is HTMLElement=>!!root);
  const belongs=(element:Element)=>roots.length?roots.some(root=>root.contains(element)):opened?fresh(element):true;
  const visible=everyElement().filter(element=>!trigger.contains(element)&&visibility(element).visible&&belongs(element));
  // 在选项里的优先；触发器点开后才出现的其次。
  const score=(element:Element)=>(element.closest(OPTIONISH)?2:0)+(fresh(element)?1:0);
  const usable=opened?visible.filter(element=>score(element)>0):visible;
  const pick=(test:(text:string)=>boolean)=>{const hits=usable.filter(element=>test(normalize(element.textContent).toLowerCase())||test(normalize(element.getAttribute('aria-label')).toLowerCase()));return hits.filter(element=>!hits.some(child=>child!==element&&element.contains(child)));};
  let matches=pick(text=>text===want);if(!matches.length)matches=pick(text=>text.includes(want));
  const best=Math.max(0,...matches.map(score)),top=matches.filter(element=>score(element)===best);
  const options=[...new Set(visible.filter(element=>element.matches(OPTIONISH)||opened&&fresh(element)&&!element.querySelector('*')).map(element=>normalize(element.textContent).slice(0,40)).filter(Boolean))].slice(0,12);
  return {matches:top.slice(0,5).map(describe),total:top.length,options};
}
export function choiceShown(element:Element,option:string){
  const parts=[normalize((element as HTMLElement).innerText??element.textContent)];
  for(const input of element instanceof HTMLInputElement?[element]:element.querySelectorAll('input'))parts.push((input as HTMLInputElement).value);
  const text=normalize(parts.join(' '));
  return {text:text.slice(0,120),shown:text.toLowerCase().includes(normalize(option).toLowerCase())};
}
