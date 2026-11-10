// 页面后台作业：job_start 先完整执行脚本（语句、分号、注释、顶层 const 都可以），拿到结果对象后在页面主环境挂一条作业记录就返回，
// 不等它结束；脚本的异常只记进作业，不让这次调用变成“结果不明”。job_status 用只读表达式读记录（Chrome 的副作用检查保证读状态不改页面）。
// 记录跟着页面走，导航或刷新就没了。
const STORE = 'globalThis.__saltedfishJobs';
const KEEP_FINISHED = 19;

/** 扩展用 Runtime.callFunctionOn 调这个函数登记作业：value 是脚本的结果（Promise、值，或接收 report 的函数）。 */
export const JOB_REGISTER_FUNCTION = `function(id,value){const store=${STORE}??(${STORE}={});
const finished=Object.keys(store).filter(key=>store[key].state!=='running').sort((a,b)=>store[a].startedAt-store[b].startedAt);
for(const key of finished.slice(0,Math.max(0,finished.length-${KEEP_FINISHED})))delete store[key];
const job={state:'running',startedAt:Date.now(),progress:null};store[id]=job;
const report=progress=>{job.progress=progress;job.updatedAt=Date.now();};
Promise.resolve().then(()=>typeof value==='function'?value(report):value).then(result=>{job.value=result;job.state='done';job.endedAt=Date.now();},error=>{job.error=String(error&&error.stack||error).slice(0,4000);job.state='failed';job.endedAt=Date.now();});
return id;}`;

export function jobFinishedExpression(jobId: string) {
  return `(${STORE}?.[${JSON.stringify(jobId)}]?.state??'missing')!=='running'`;
}

export function jobStatusExpression(jobId: string) {
  return `(()=>{const job=${STORE}?.[${JSON.stringify(jobId)}];if(!job)return {state:'missing',note:'页面里没有这个作业：页面导航或刷新过，或 jobId 不对。'};const status={state:job.state,progress:job.progress,startedAt:job.startedAt};if(job.updatedAt)status.updatedAt=job.updatedAt;if(job.endedAt)status.endedAt=job.endedAt;if(job.state==='done')status.value=job.value;if(job.state==='failed')status.error=job.error;return status;})()`;
}
