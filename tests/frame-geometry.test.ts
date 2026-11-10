import test from 'node:test';
import assert from 'node:assert/strict';
import { project, rectangle } from '../extension/frame-geometry.js';

test('frame 四点投影覆盖旋转、透视和反向映射，退化区域拒绝',()=>{
  const source=rectangle(0,0,100,100), rotated=[210,30,210,230,10,230,10,30];
  const p=project({x:25,y:75},source,rotated);assert.ok(Math.abs(p.x-60)<1e-8&&Math.abs(p.y-80)<1e-8);
  const perspective=[10,20,190,40,160,170,30,210];
  for(const v of [{x:0,y:0},{x:100,y:100},{x:35,y:77}]){const mapped=project(v,source,perspective),back=project(mapped,perspective,source);assert.ok(Math.abs(back.x-v.x)<1e-7&&Math.abs(back.y-v.y)<1e-7);}
  assert.throws(()=>project({x:1,y:1},rectangle(0,0,0,100),perspective),{code:'FRAME_GEOMETRY'});
  assert.throws(()=>project({x:NaN,y:1},source,perspective),{code:'FRAME_GEOMETRY'});
});
