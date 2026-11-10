import { BrowserError, type JsonObject } from '../src/shared';
import { elementExpression } from './page-functions';
import { project, rectangle, type Point } from './frame-geometry';

interface Access {
  send: (tabId:number,method:string,params?:JsonObject,sessionId?:string)=>Promise<JsonObject>;
  evaluate: (tabId:number,expression:string,args:JsonObject,deadline:number,returnByValue?:boolean)=>Promise<unknown>;
  contexts: ()=>JsonObject[]; sessions: ()=>string[];
  context:(args:JsonObject)=>Promise<number>;
}
// 父 frame 里核对 iframe 边框处没有被挡住：逐层 CSS 视口命中测试，跨 open Shadow DOM。
const hitFunction = function(this: Element, x: number, y: number, ignored?: Element) {
  let target: Element=this;
  while(true) {
    const root=target.getRootNode() as Document|ShadowRoot;
    // 拖动源可能随指针覆盖落点；只排除这个明确的源节点及子节点，其他遮挡照常拒绝。
    const hit=ignored&&ignored!==this&&root.elementsFromPoint?root.elementsFromPoint(x,y).find(node=>node!==ignored&&!ignored.contains(node)):root.elementFromPoint(x,y);
    if(!hit || (hit!==target && !target.contains(hit)))return false;
    if(root instanceof ShadowRoot)target=root.host;else return this.isConnected;
  }
};
export async function framePoint(tabId: number,args: JsonObject,deadline: number,access: Access) {
  const {send,evaluate}=access;let sessionId=args.sessionId as string|undefined;
  // 本 frame 里的检查和落点在页面运行时里做（FengPage.actionPoint），每次只传参数。
  const local=await evaluate(tabId,elementExpression(args,`return FengPage.actionPoint(element,state,${JSON.stringify({action:String(args.action),scroll:args.scrollIntoView!==false,...(typeof args.dragSourceRef==='string'?{ignoredRef:args.dragSourceRef}:{}),...(Array.isArray(args.aim)?{aim:args.aim}:{})})});`),args,deadline) as Point & {cx?:number;cy?:number;width:number;height:number;documentId:string;ref:string;landedOn?:JsonObject};
  const roots=new Map<string,{parentId?:string}>();
  const add=(tree:any,parentId?:string)=>{const old=roots.get(tree.frame.id);roots.set(tree.frame.id,{parentId:parentId||tree.frame.parentId||old?.parentId});for(const child of tree.childFrames||[])add(child,tree.frame.id);};
  const rootTree=await send(tabId,'Page.getFrameTree');add(rootTree.frameTree);const rootId=(rootTree.frameTree as any).frame.id;
  const inputSession=sessionId;
  const inputRoot=inputSession ? ((await send(tabId,'Page.getFrameTree',{},inputSession)).frameTree as any).frame.id : rootId;
  let context=args.contextId!==undefined ? access.contexts().find(c=>c.id===args.contextId && c.sessionId===sessionId) : undefined;
  if(args.contextId!==undefined&&!context)throw new BrowserError('UNKNOWN_FRAME','上下文已失效，请重新读取 chrome_contexts。',{phase:'precondition',outcome:'not_dispatched'});
  if(!context&&sessionId){const tree=await send(tabId,'Page.getFrameTree',{},sessionId);add(tree.frameTree);const id=(tree.frameTree as any).frame.id;context=access.contexts().find(c=>(c.auxData as any)?.isDefault&&(c.auxData as any).frameId===id);if(!context)throw new BrowserError('UNKNOWN_FRAME','iframe 默认上下文已失效。',{phase:'precondition',outcome:'not_dispatched'});}
  let frameId=String((context?.auxData as any)?.frameId||rootId),point:Point={x:local.x,y:local.y},width=local.width,height=local.height;
  // 落点偏离中心时（像真人一样操作），中心跟着落点一层层投影，核对“目标没动”用它。
  let center:Point|undefined=local.cx!==undefined&&local.cy!==undefined?{x:local.cx,y:local.cy}:undefined;
  let inputPoint:Point|undefined=frameId===inputRoot?{...point}:undefined,inputCenter=inputPoint&&center;
  const centred=()=>inputCenter?{cx:inputCenter.x,cy:inputCenter.y}:{};
  if(frameId===rootId)return {...point,...centred(),documentId:local.documentId,ref:local.ref,...(local.landedOn?{landedOn:local.landedOn}:{})};
  // 子会话里可能混有没有 Page 域的目标（dedicated worker 等）或刚刚分离的会话：读不出 frame 树就跳过，不让整次动作抛出未分类的原始错误。
  // 跳过不会掩盖缺失的父链：目标的祖先 frame 若因此不在 roots 里，下面的循环会按 UNKNOWN_FRAME 在派发前明确拒绝。
  for(const child of access.sessions()){try{const tree=await send(tabId,'Page.getFrameTree',{},child);add(tree.frameTree);}catch{/* 非页面类或已失效的会话。 */}}
  const seen=new Set<string>();
  while(frameId!==rootId){
    if(seen.has(frameId)||seen.size>=32)throw new BrowserError('FRAME_GEOMETRY','frame 链异常或超过 32 层，未派发输入。',{phase:'precondition',outcome:'not_dispatched'});seen.add(frameId);
    const parentId=roots.get(frameId)?.parentId;
    const parent=access.contexts().find(c=>(c.auxData as any)?.isDefault&&(c.auxData as any).frameId===parentId);
    if(!parentId||!parent)throw new BrowserError('UNKNOWN_FRAME','frame 父上下文已变化，未猜测或切换目标。',{phase:'precondition',outcome:'not_dispatched'});
    sessionId=parent.sessionId as string|undefined;const parentArgs={contextId:parent.id,sessionId};
    const owner=await send(tabId,'DOM.getFrameOwner',{frameId},sessionId);
    const resolved=await send(tabId,'DOM.resolveNode',{backendNodeId:owner.backendNodeId,executionContextId:await access.context(parentArgs)},sessionId);
    const objectId=(resolved.object as JsonObject).objectId;
    const doc=await evaluate(tabId,'document.documentElement',parentArgs,deadline,false) as JsonObject;
    try {
      const ownerModel=(await send(tabId,'DOM.getBoxModel',{objectId},sessionId)).model as any;
      const docModel=(await send(tabId,'DOM.getBoxModel',{objectId:doc.objectId},sessionId)).model as any;
      const viewport=await evaluate(tabId,`(()=>{const r=document.documentElement.getBoundingClientRect();const transform=getComputedStyle(document.documentElement).transform;let unsupported=false;if(transform!=='none'){const m=new DOMMatrix(transform);unsupported=!m.is2D||Math.abs(m.b)>1e-7||Math.abs(m.c)>1e-7;}return {x:r.x,y:r.y,w:r.width,h:r.height,width:innerWidth,height:innerHeight,unsupported}})()`,parentArgs,deadline) as any;
      if(viewport.unsupported)throw new BrowserError('FRAME_ROOT_TRANSFORM_UNSUPPORTED','根 html 旋转/3D 变换暂不支持，未派发输入。',{phase:'precondition',outcome:'not_dispatched'});
      // 先从 CDP 绝对 quad 反投影到父文档的 CSS 坐标，再逐层映射，处理 iframe 的继承缩放。
      const parentQuad:number[]=[];
      for(let i=0;i<8;i+=2){const p=project({x:ownerModel.content[i],y:ownerModel.content[i+1]},docModel.border,rectangle(viewport.x,viewport.y,viewport.w,viewport.h));parentQuad.push(p.x,p.y);}
      if(center)center=project(center,rectangle(0,0,width,height),parentQuad);
      point=project(point,rectangle(0,0,width,height),parentQuad);
      const hit=await send(tabId,'Runtime.callFunctionOn',{objectId,functionDeclaration:hitFunction.toString(),arguments:[{value:point.x},{value:point.y}],returnByValue:true},sessionId);
      if(!(hit.result as JsonObject)?.value)throw new BrowserError('ELEMENT_OBSCURED','frame 边界被遮挡或裁剪，未派发输入。',{phase:'precondition',outcome:'not_dispatched'});
      width=viewport.width;height=viewport.height;frameId=parentId;
      if(frameId===inputRoot){inputPoint={...point};inputCenter=center&&{...center};}
    } finally {await send(tabId,'Runtime.releaseObject',{objectId},sessionId).catch(()=>{});await send(tabId,'Runtime.releaseObject',{objectId:doc.objectId},sessionId).catch(()=>{});}
  }
  if(!inputPoint)throw new BrowserError('FRAME_GEOMETRY','输入目标与 frame 链不一致，未派发输入。',{phase:'precondition',outcome:'not_dispatched'});
  return {...inputPoint,...centred(),documentId:local.documentId,ref:local.ref,...(local.landedOn?{landedOn:local.landedOn}:{})};
}
