import {errorInfo,type JsonObject} from '../src/shared';
import {elementExpression} from './page-functions';
import {keyboardKey,modifierFlag,modifierKeys,type KeyboardKey} from './keyboard';
import {pause,keyGap,TYPE_LIMIT} from './human-input';
import {inputTargetExpression,inputSettledExpression} from './input-target';

interface Access {
 evaluate:(expression:string,args:JsonObject)=>Promise<unknown>;
 send:(method:string,params:JsonObject)=>Promise<unknown>;
 assertActive:()=>void;mark:()=>void;
 // 像真人一样输入：键盘全选或把光标移到末尾，短的 US 键盘文本逐键打，键之间停几十毫秒；deadline 用来判断逐键打不打得完。
 // clicked：执行器刚用鼠标点过这个字段。焦点要来自那次点击，页面把焦点挪到别处就按焦点变化处理，不再用脚本抢回来。
 human?:{wait:(ms:number)=>Promise<void>;deadline:number;clicked?:boolean};
}
const FILL_FOCUS_LEFT='输入值已核验通过，但页面随后把焦点移走或禁用/锁定了字段（常见于验证码、分段卡号）；这是页面自己的行为，无需重试。';
const TYPE_FOCUS_LEFT='输入已派发，但派发后目标不再持有焦点或已不可编辑（页面可能自行跳到下一格、禁用字段或重绘）；type 不核验页面值，先读取页面确认是否符合预期，不要重复输入。';
// 返回 undefined 只表示 auto 模式的特殊字段需要 setValue；此时尚未聚焦或编辑。
export async function textInput(args:JsonObject,access:Access):Promise<unknown>{
 const {evaluate,send,assertActive,mark,human}=access,fill=args.action==='fill',mode=String(args.inputMode||'insertText');let text=String(args.text??'');
 const body=`
  if(!state.visible||state.disabled||state.readOnly)FengPage.fail('NOT_EDITABLE');
  if(!FengPage.browserEditable(element)){${fill&&args.fillMode!=='input'?'return {native:false};':"FengPage.fail('EDIT_MODE_UNSUPPORTED','此字段不支持浏览器文本编辑；特殊字段可明确使用 fillMode=setValue。');"}}
  const selection=${JSON.stringify(args.selection??null)};
  if(selection&&selection.end>FengPage.textOffsetLength(element))FengPage.fail('SELECTION_OUT_OF_RANGE');
  __fengInputStarted=true;${human?.clicked?'if(!document.activeElement||document.activeElement===document.body)':''}element.focus();FengPage.assertFocused(element);
  const fresh=FengPage.elementState(element);if(!fresh.visible||fresh.disabled||fresh.readOnly)FengPage.fail('NOT_EDITABLE');
  ${human?'if(selection||element.isContentEditable)':''}FengPage.selectText(element,selection,${fill});
  return {native:true,ref:FengPage.elementRef(element),documentId:FengPage.documentId(),multiline:element instanceof HTMLTextAreaElement||element.isContentEditable,richText:!!element.isContentEditable${human?",length:FengPage.textOffsetLength(element),atEnd:element.isContentEditable||element.selectionStart===element.value.length&&element.selectionEnd===element.value.length":''}};`;
 const expression=args.ref||args.selector||args.locator?elementExpression(args,body):`(()=>{let element=document.activeElement;while(element?.shadowRoot?.activeElement)element=element.shadowRoot.activeElement;if(!element)FengPage.fail('NOT_EDITABLE');const state=FengPage.elementState(element);${body}})()`;
 assertActive();const prepared=await evaluate(expression,args) as any;
 if(!prepared.native)return undefined;
 if(prepared.multiline)text=text.replace(/\r\n?/g,'\n');
 mark();args={...args,selector:undefined,locator:undefined,ref:prepared.ref};
 const focused=async()=>{assertActive();await evaluate(inputTargetExpression(args,prepared),args);assertActive();};
 // 按一个键：修饰键（大写字母、!? 隐含的 Shift，Ctrl+A 的 Ctrl）先按下、主键松开后再松开；多行字段里的换行按 Enter。
 const stroke=async(name:string,flags=0)=>{
  const {text:typed,...params}=name==='\n'&&prepared.multiline?keyboardKey('Enter'):keyboardKey(name,flags),held:KeyboardKey[]=[];
  await focused();
  try{
   for(const modifier of modifierKeys(params.modifiers,params.key)){await send('Input.dispatchKeyEvent',{type:'rawKeyDown',...modifier});held.push(modifier);if(human)await human.wait(pause('modifierLeadMs'));}
   await send('Input.dispatchKeyEvent',{type:'rawKeyDown',...params});
   if(typed!==undefined){await focused();await send('Input.dispatchKeyEvent',{type:'char',text:typed,unmodifiedText:typed,...params});}
   if(human)await human.wait(pause('keyHoldMs'));
  }finally{
   let modifiers=params.modifiers&~modifierFlag(params.key);
   await send('Input.dispatchKeyEvent',{type:'keyUp',...params,modifiers});
   for(const modifier of held.reverse()){modifiers&=~modifierFlag(modifier.key);await send('Input.dispatchKeyEvent',{type:'keyUp',...modifier,modifiers});}
  }
 };
 const typeKeys=async()=>{for(const [index,char] of [...text].entries()){if(index&&human)await human.wait(keyGap());await stroke(char);}};
 // 像真人时，默认的 type、fill 也逐键打：只限 US 键盘打得出的字符（多行字段可以有换行，富文本里的换行会变成段落，不逐键），
 // 且不超过 TYPE_LIMIT 个、剩的时间够。中文等要输入法的文本、长文本照旧整段插入。
 const typeable=[...text].every(char=>{if(char==='\n')return prepared.multiline&&!prepared.richText;try{return keyboardKey(char).text===char;}catch{return false;}});
 const byKeys=!!human&&(fill||args.inputMode===undefined)&&text!==''&&text.length<=TYPE_LIMIT&&typeable&&Date.now()+text.length*300+2000<human.deadline;
 assertActive();
 // 像真人时不用脚本改选区：fill 用 Ctrl+A 全选，type 用 End（多行 Ctrl+End）把光标移到末尾；明确给了 selection 照旧按它设。
 // type 只在刚用鼠标点进字段时按 End，那时光标落在点击处；字段原来就有焦点时不动选区（先 press Ctrl+A 再 type 是替换），和关掉开关时一样。
 // 富文本仍用脚本全选：内容只剩空段落时 Ctrl+A 再插入会多出一个空段落（Chrome 156 实测），值核验不过。
 if(human&&!args.selection&&mode!=='composition'){
  const select:[string,number]|undefined=fill?(prepared.length>0&&!prepared.richText?['a',2]:undefined):human.clicked&&!prepared.atEnd?['End',prepared.multiline?2:0]:undefined;
  if(select){await stroke(select[0],select[1]);await human.wait(keyGap());}
 }
 if(!fill&&mode==='keySequence'||byKeys){
  await typeKeys();
 }else if(!fill&&mode==='composition'){
  let finished=false;
  try{
   for(const update of (args.compositionUpdates as string[]|undefined)||[text]){await focused();await send('Input.imeSetComposition',{text:update,selectionStart:update.length,selectionEnd:update.length});}
   await focused();
   if(args.compositionCommit===false)await send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});
   else await send('Input.insertText',{text});
   finished=true;
  }finally{if(!finished){try{await evaluate(elementExpression(args,'FengPage.assertFocused(element);return true;'),args);await send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});}catch{/* 原目标已失效时不改其他字段的组合状态。 */}}}
 }else{
  if(!fill&&mode==='paste'){
   const proceed=await evaluate(elementExpression(args,`FengPage.assertFocused(element);__fengInputStarted=true;return FengPage.pasteEvent(element,${JSON.stringify(text)});`),args);
   if(!proceed)return {mode:'paste',handledByPage:true,pasteEventTrusted:false};
  }
  await focused();
  if(fill&&text===''&&human)await stroke('Backspace');
  else if(fill&&text===''){
   try{await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});}
   finally{await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});}
  }else await send('Input.insertText',{text});
 }
 if(fill){
  // 值核验本身证明文字落在原字段；焦点/可编辑状态在派发后可以合法变化，只如实报告，不判失败。
  const settled=await evaluate(inputSettledExpression(args,prepared,`if(FengPage.editableValue(element)!==${JSON.stringify(prepared.richText?text.replace(/\u00a0/g,' '):text)})FengPage.fail('EDIT_NOT_APPLIED','浏览器编辑后的值与请求不同；可能被页面取消或转换。先检查，不重试。');let focused=true;try{FengPage.assertFocused(element);}catch{focused=false;}return {focused};`),args) as {focused:boolean};
  return {filled:true,mode:'input',verified:true,...(settled.focused?{}:{focusVerified:false,note:FILL_FOCUS_LEFT})};
 }
 // type 没有值核验：派发后只观察焦点并如实报告。无法区分“写对了随后页面跳走”和“写错了字段”，所以不整体判失败（那会隔离标签页）；
 // 派发之前，以及逐键/组合输入的每一步之间，仍严格复查焦点。
 // 同一次读取里再读回字段现在的内容，只如实报告：type 可能接在原有内容后面，编辑器也会改写输入，所以不和请求的文字比；读不到（字段被重绘、移除）就不带。
 // 两样合在一次 Runtime.evaluate 里，和 0.3.23 的 type 一样多的 CDP 调用（性能门禁不许多一次）。
 // 文档/ref 失效、焦点离开、字段不可编辑都算焦点已离开、不抛出：页面里是我们自己的检查失败（FengPrecondition），读取本身是未派发的错误（比如回车后页面跳走、上下文没了）；
 // 连接中断等无法判断的错误照常抛出。
 assertActive();
 let focusVerified=true,current:JsonObject|undefined;
 try{
  const settled=await evaluate(`(()=>{let focused=true,value;try{${inputTargetExpression(args,prepared)};}catch(error){if(error?.name!=='FengPrecondition')throw error;focused=false;}
   try{value=${elementExpression(args,'return FengPage.fieldValue(element);')};}catch{}return {focused,value};})()`,args) as {focused:boolean;value?:JsonObject};
  focusVerified=settled.focused;current=settled.value;
 }catch(error){if(errorInfo(error).outcome!=='not_dispatched')throw error;focusVerified=false;}
 assertActive();
 // 发送字符数量不能冒充页面实际接受的字符数量；应用可能取消或转换输入。
 return {mode:byKeys?'keySequence':mode,dispatched:true,requestedCharacters:text.length,verification:'not_checked',...(current||{}),focusVerified,...(focusVerified?{}:{note:TYPE_FOCUS_LEFT}),...(mode==='composition'?{committed:args.compositionCommit!==false}:{}),...(mode==='paste'?{pasteEventTrusted:false,insertion:'insertText'}:{})};
}
