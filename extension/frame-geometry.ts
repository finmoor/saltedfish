import { BrowserError } from '../src/shared';
export interface Point { x: number; y: number }

// 四点投影：同时支持旋转、非等比缩放及透视。退化/不可逆区域不猜坐标。
export function project(point: Point, from: number[], to: number[]): Point {
  if (from.length!==8 || to.length!==8 || [...from,...to,point.x,point.y].some(n=>!Number.isFinite(n))) throw new BrowserError('FRAME_GEOMETRY','frame 几何信息无效。',{phase:'precondition',outcome:'not_dispatched'});
  const rows: number[][]=[];
  for(let i=0;i<8;i+=2){const x=from[i]!,y=from[i+1]!,u=to[i]!,v=to[i+1]!;rows.push([x,y,1,0,0,0,-u*x,-u*y,u],[0,0,0,x,y,1,-v*x,-v*y,v]);}
  for(let c=0;c<8;c++){
    let best=c;for(let r=c+1;r<8;r++)if(Math.abs(rows[r]![c]!)>Math.abs(rows[best]![c]!))best=r;
    if(Math.abs(rows[best]![c]!)<1e-9)throw new BrowserError('FRAME_GEOMETRY','frame 变换退化，未派发输入。',{phase:'precondition',outcome:'not_dispatched'});
    [rows[c],rows[best]]=[rows[best]!,rows[c]!];const scale=rows[c]![c]!;for(let k=c;k<=8;k++)rows[c]![k]!/=scale;
    for(let r=0;r<8;r++)if(r!==c){const factor=rows[r]![c]!;for(let k=c;k<=8;k++)rows[r]![k]!-=factor*rows[c]![k]!;}
  }
  const h=rows.map(row=>row[8]!);const d=h[6]!*point.x+h[7]!*point.y+1;
  if(Math.abs(d)<1e-9)throw new BrowserError('FRAME_GEOMETRY','目标位于不可投影区域。',{phase:'precondition',outcome:'not_dispatched'});
  return {x:(h[0]!*point.x+h[1]!*point.y+h[2]!)/d,y:(h[3]!*point.x+h[4]!*point.y+h[5]!)/d};
}
export const rectangle = (x: number,y: number,width: number,height: number) => [x,y,x+width,y,x+width,y+height,x,y+height];
