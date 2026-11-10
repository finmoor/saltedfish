import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {interactionHarness} from './interaction-harness.js';
import {projectDir} from '../src/config.js';
import {VERSION} from '../src/version.js';
import {comparePerformance,performanceThresholds} from './performance-compare.js';

const controls=Number(process.env.PERF_CONTROLS||100);assert.ok(Number.isInteger(controls)&&controls>=100&&controls<=5000);
// 这里度量产品开销，不度量帧节奏：默认 vsync 下，远程桌面断开时 mouseMoved 会断续等待 300ms 以上，结果取决于会话状态。
const chromeArgs=['--disable-gpu-vsync','--disable-frame-rate-limit'];
const html=`<!doctype html><meta charset="utf-8"><input id="text" aria-label="Editor"><button id="click" onclick="window.clicks=(window.clicks||0)+1">Count</button><div id="scope">${Array.from({length:controls},(_,i)=>`<button>Button ${i}</button>`).join('')}</div><section>${'<span>Large document text </span>'.repeat(1000)}</section>`;
test('interaction performance: cold/warm latency, CDP bytes and retained heap',async t=>{
 const h=await interactionHarness(t,html,{chromeArgs});
 // Agent 光标在动作之外另画，会多出 Overlay 命令：门禁先关掉它量动作本身，开着时的开销单独记在 clickCursor，不进比较。
 // 像真人一样操作会特意停顿几百毫秒，同样先关掉，开着时记在 clickHuman、fillHuman，不进比较。冻结的旧版本没有这个开关，本来就不拟人。
 await h.showCursor(false);await h.humanInput(false).catch(()=>{});
 const {page,call}=await h.open(),runs:any={};
 const samples=Number(process.env.PERF_SAMPLES||100);assert.ok(Number.isInteger(samples)&&samples>=25&&samples<=500);
 const measure=async(name:string,fn:()=>Promise<unknown>,count=samples)=>{
  const before=await h.metrics(),cpu=process.cpuUsage(),memory=await page.metrics(),times:number[]=[];
  for(let i=0;i<count;i++){const start=performance.now();await fn();times.push(performance.now()-start);}
  const after=await h.metrics(),end=await page.metrics(),used=process.cpuUsage(cpu);times.sort((a,b)=>a-b);
  runs[name]={samples:count,times,p50:times[Math.floor(count*.5)],p95:times[Math.min(count-1,Math.floor(count*.95))],cdpCalls:(after.calls-before.calls)/count,cdpBytes:(after.bytes-before.bytes)/count,serviceCpuMs:(used.user+used.system)/1000,rendererTaskSeconds:(end.TaskDuration||0)-(memory.TaskDuration||0),heapBefore:memory.JSHeapUsedSize,heapAfter:end.JSHeapUsedSize};
 };
 await measure('coldInspect',()=>call('chrome_inspect',{limit:20,textLimit:1000}),1);
 await measure('warmInspect',()=>call('chrome_inspect',{limit:20,textLimit:1000}));
 // 门禁比较的是动作本身的开销，所以关掉页面变化；默认路径多等的时间单独记在 clickObserved，不进比较，见 docs/testing.md。
 await measure('click',()=>call('chrome_action',{action:'click',selector:'#click',observe:false}));
 await measure('fill',()=>call('chrome_action',{action:'fill',selector:'#text',text:'性能🙂',observe:false}));
 await measure('insertText',()=>call('chrome_action',{action:'type',selector:'#text',text:'a',observe:false}));
 assert.equal(await page.evaluate(()=>(window as any).clicks),samples);
 await measure('clickObserved',()=>call('chrome_action',{action:'click',selector:'#click'}),Math.min(samples,25));
 await h.showCursor(true);
 await measure('clickCursor',()=>call('chrome_action',{action:'click',selector:'#click',observe:false}),Math.min(samples,25));
 if(await h.humanInput(true).then(()=>true,()=>false)){
  await measure('clickHuman',()=>call('chrome_action',{action:'click',selector:'#click',observe:false}),Math.min(samples,25));
  await measure('fillHuman',()=>call('chrome_action',{action:'fill',selector:'#text',text:'perf test',observe:false}),Math.min(samples,10));
 }
 const serviceVersion=JSON.parse(await readFile(path.join(process.env.INTERACTION_SERVICE_ROOT||projectDir,'package.json'),'utf8')).version;
 const report:any={version:serviceVersion,runnerVersion:VERSION,serviceRuntime:process.env.INTERACTION_SERVICE_ROOT?'frozen baseline':'current',extension:h.profile.version,chrome:await h.browser.version(),chromeArgs,time:new Date().toISOString(),controls,runs,slowCommands:(await h.metrics()).trace.filter((x:any)=>x.ms>50),scope:`isolated Chrome; ${controls} controls + 1000 text nodes; identical fixture; no artificial delay`};
 // 比较规则见 performance-compare.ts：四类操作都约束 p95、CDP 字节比例与每次操作多出的 CDP 调用数。
 // 没有 PERF_BASELINE 时只采集数据：报告明确写 compared:false、passed:false，并在终端警告；发行门禁（verify:release）会拒绝这样的结果。
 const thresholds=performanceThresholds(process.env),baselineFile=process.env.PERF_BASELINE;
 const result=comparePerformance(runs,baselineFile?JSON.parse(await readFile(baselineFile,'utf8')):undefined,controls,thresholds,chromeArgs);
 const failures=result.failures;
 Object.assign(report,{compared:result.compared,thresholds,...(baselineFile?{baselineFile:path.resolve(baselineFile),baselineVersion:result.baselineVersion,comparison:result.comparison,maxCdpRatio:thresholds.maxCdpRatio}:{})});
 if(!result.compared)console.warn('警告：没有设置 PERF_BASELINE，本次只采集了性能数据，没有与任何基线比较（报告 compared:false、passed:false）。发行门禁会拒绝这样的结果。');
 report.passed=result.compared&&failures.length===0;report.failures=failures;
 await mkdir(path.join(projectDir,'.local/verification'),{recursive:true});
 const label=process.env.PERF_LABEL||VERSION;assert.match(label,/^[\w.-]+$/);
 await writeFile(path.join(projectDir,`.local/verification/interaction-performance-${label}.json`),JSON.stringify(report,null,2));
 console.log(JSON.stringify({...report,runs:Object.fromEntries(Object.entries(runs).map(([key,value]:[string,any])=>{const {times,...summary}=value;return [key,summary];}))}));
 assert.deepEqual(failures,[]);
});
