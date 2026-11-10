import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fixture } from './helpers.js';
import { VERSION } from '../src/version.js';

test('合法大结果、流程和历史规模的延迟及内存预算', async () => {
  const frozen=process.env.PRODUCT_SERVICE_ROOT ? await import(pathToFileURL(path.join(process.env.PRODUCT_SERVICE_ROOT,'dist/http-server.js')).href) : undefined;
  const f=await fixture({},frozen?.startServer); const runs:Record<string,unknown>={}; let passed=false;
  const measure=async(name:string,fn:()=>Promise<unknown>|unknown,count:number)=>{
    for(let i=0;i<3;i++)await fn(); (globalThis as any).gc?.();
    const before=process.memoryUsage(),cpu=process.cpuUsage(),times:number[]=[]; let peak=before.rss,maxDelay=0,last=performance.now();
    const timer=setInterval(()=>{const now=performance.now();maxDelay=Math.max(maxDelay,now-last-5);last=now;peak=Math.max(peak,process.memoryUsage().rss);},5);
    try{for(let i=0;i<count;i++){const start=performance.now();await fn();times.push(performance.now()-start);peak=Math.max(peak,process.memoryUsage().rss);await new Promise<void>(resolve=>setImmediate(resolve));}}
    finally{clearInterval(timer);}
    const sorted=[...times].sort((a,b)=>a-b),used=process.cpuUsage(cpu);
    const value={samples:count,p50Ms:sorted[Math.floor(count*.5)]!,p95Ms:sorted[Math.min(count-1,Math.floor(count*.95))]!,rssBefore:before.rss,rssPeak:peak,rssGrowth:Math.max(0,peak-before.rss),maxTimerDelayMs:maxDelay,cpuMs:(used.user+used.system)/1000,timesMs:times};runs[name]=value;return value;
  };
  try {
    const id=randomUUID(),profile=randomUUID(),file=path.join(f.config.dataDir,'results',id+'.json');
    await mkdir(path.dirname(file),{recursive:true}); const handle=await open(file,'wx');
    try{await handle.write('"');const block=Buffer.alloc(65536,120);for(let i=0;i<512;i++)await handle.write(block);await handle.write('"');}finally{await handle.close();}
    f.service.state.addArtifact(id,profile,'performance','json',32*1024*1024+2);
    const read=async()=>{const result=await f.service.invoke('chrome_read_result',{artifactId:id,offset:16000000,limit:2048},'performance');assert.equal(result.ok,true);assert.equal((result.data as any).text.length,2048);};
    const page=await measure('32MiB-page2048',read,30);
    const parallel=await measure('32MiB-page2048-concurrency8',()=>Promise.all(Array.from({length:8},read)),10);
    assert.ok(page.p95Ms<100,`warm page p95 ${page.p95Ms}`);
    assert.ok(parallel.rssGrowth<128*1024*1024,`page read RSS growth ${parallel.rssGrowth}`);
    assert.ok(parallel.p95Ms<250,`parallel page p95 ${parallel.p95Ms}`);
    for(let i=0;i<50;i++)f.service.tasks.saveWorkflow(profile,{name:`flow-${i}`,steps:[{operation:'page.action',args:{action:'fill',selector:'#fixture',text:'x'.repeat(1024*1024)}}]});
    const flows=await measure('50MiB-flow-summary10',async()=>{const r=await f.service.invoke('chrome_workflows',{profileId:profile,summary:true,limit:10},'performance');assert.equal(r.ok,true);assert.ok(JSON.stringify(r).length<16000);},30);
    assert.ok(flows.p95Ms<100,`flow summary p95 ${flows.p95Ms}`);
    const db=(f.service.state as any).db;db.exec('BEGIN IMMEDIATE');
    const insert=db.prepare("INSERT INTO operations(id,profile_id,tab_id,owner,tool,state,started_at) VALUES(?,?,1,'performance','chrome_action','succeeded',?)");
    for(let i=0;i<10000;i++)insert.run(randomUUID(),profile,new Date(Date.now()-10000+i).toISOString());db.exec('COMMIT');
    const journal=await measure('10000-operation-retention',()=>{const operation=f.service.state.begin(profile,1,'performance','chrome_action');f.service.state.finish(operation,'succeeded');},60);
    assert.ok(journal.p95Ms<50,`durable journal p95 ${journal.p95Ms}`);
    const plan=db.prepare("EXPLAIN QUERY PLAN DELETE FROM operations WHERE id IN (SELECT id FROM operations WHERE state IN ('succeeded','failed') OR acknowledged_at IS NOT NULL ORDER BY started_at DESC LIMIT -1 OFFSET 10000)").all();
    assert.ok(!plan.some((row:any)=>String(row.detail).includes('TEMP B-TREE')));
    runs.queryPlan=plan;passed=true;
  } finally {
    await mkdir('.local/verification',{recursive:true});
    await writeFile(`.local/verification/service-performance-${VERSION}.json`,JSON.stringify({version:VERSION,passed,runs,scope:'private current service or explicit candidate stage; warm SSD; bounded legal workloads; not an SLA or long soak'},null,2));
    await f.cleanup();
  }
});
