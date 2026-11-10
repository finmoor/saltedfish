import {BrowserError,type JsonObject} from '../src/shared';
import type {PathPoint,Step} from './human-input';

// 真鼠标按住时 pointerdown、pointermove 的 pressure 是 0.5（没有压感的设备按规范报 0.5），CDP 不带 force 时是 0（Chrome 156 实测）。
export const PRESSED_FORCE=0.5;
export interface PointerPoint {x:number;y:number;cx?:number;cy?:number;documentId?:string;ref?:string}
interface DragOptions {
  from:PointerPoint;to:PointerPoint;steps:number;durationMs:number;button:string;modifiers?:number;
  send:(params:JsonObject)=>Promise<unknown>;
  assertActive:()=>void;
  mark:()=>void;
  verifySource:()=>Promise<void>;
  verifyTarget:()=>Promise<void>;
  verifyDocuments:()=>Promise<void>;
  // 像真人一样操作：沿轨迹移到起点，按下后、松开前各停一下，拖动走曲线、变速；不给就是匀速直线。
  human?:{approach:(point:PathPoint)=>Promise<void>;path:(from:PathPoint,to:PathPoint)=>Step[];settle:()=>number;wait:(ms:number)=>Promise<void>};
}

// 真实鼠标序列；按下后任何异常都归还按钮。这里没有重放、隐式滚动或脚本事件替代。
export async function dragPointer(options:DragOptions){
  const {from,to,steps,durationMs,button,send,assertActive,mark,human}=options;
  const buttons=button==='right'?2:button==='middle'?4:1,modifiers=options.modifiers?{modifiers:options.modifiers}:{};
  let pressed=false,released=false;
  assertActive();mark();
  if(human)await human.approach(from);else await send({type:'mouseMoved',x:from.x,y:from.y,...modifiers});
  await options.verifySource();await options.verifyTarget();assertActive();
  try{
    // 发送失败也可能已经按下，所以进入 send 之前标记。
    pressed=true;await send({type:'mousePressed',x:from.x,y:from.y,button,buttons,clickCount:1,force:PRESSED_FORCE,...modifiers});
    const move=async(x:number,y:number)=>{assertActive();await options.verifyDocuments();assertActive();await send({type:'mouseMoved',x,y,button,buttons,force:PRESSED_FORCE,...modifiers});};
    let count=steps;
    if(human){
      await human.wait(human.settle());
      const path=human.path(from,to);count=path.length;
      for(const step of path){await human.wait(step.delayMs);await move(step.x,step.y);}
      await human.wait(human.settle());
    }else{
      const start=Date.now();
      for(let index=1;index<=steps;index++){
        const until=start+durationMs*index/steps;
        while(Date.now()<until){assertActive();await new Promise(resolve=>setTimeout(resolve,Math.min(25,until-Date.now())));}
        await move(from.x+(to.x-from.x)*index/steps,from.y+(to.y-from.y)*index/steps);
      }
    }
    await options.verifyTarget();assertActive();
    await send({type:'mouseReleased',x:to.x,y:to.y,button,buttons:0,clickCount:1,...modifiers});released=true;
    return {dragged:true,from:{x:from.x,y:from.y},to:{x:to.x,y:to.y},steps:count};
  }finally{
    if(pressed&&!released){
      await send({type:'mouseMoved',x:-1,y:-1,button,buttons,...modifiers}).catch(()=>{});
      await send({type:'mouseReleased',x:-1,y:-1,button,buttons:0,clickCount:1,...modifiers}).catch(()=>{});
    }
  }
}

// 落点偏离中心时比中心：悬停放大、按下缩小这类效果会让偏离的落点挪一点，但元素没动。
// 按住期间的复核用：按下样式（:active 时下移一两像素）不算挪走，列表重排、弹层盖上这种才算。
export function nearPoint(expected:PointerPoint,current:PointerPoint,tolerance:number){
  const a=expected.cx!==undefined&&expected.cy!==undefined?{x:expected.cx,y:expected.cy}:expected,b=current.cx!==undefined&&current.cy!==undefined?{x:current.cx,y:current.cy}:current;
  return Math.abs(a.x-b.x)<=tolerance&&Math.abs(a.y-b.y)<=tolerance;
}
export function samePoint(expected:PointerPoint,current:PointerPoint){
  const a=expected.cx!==undefined&&expected.cy!==undefined?{x:expected.cx,y:expected.cy}:expected,b=current.cx!==undefined&&current.cy!==undefined?{x:current.cx,y:current.cy}:current;
  return Math.abs(a.x-b.x)<=1&&Math.abs(a.y-b.y)<=1;
}
export function assertPointUnchanged(expected:PointerPoint,current:PointerPoint,message:string){
  if(!samePoint(expected,current)||expected.documentId!==current.documentId||expected.ref!==current.ref)
    throw new BrowserError('ELEMENT_MOVED',message,{phase:'precondition',outcome:'not_dispatched'});
}
