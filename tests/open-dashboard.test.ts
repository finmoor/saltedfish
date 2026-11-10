import test from 'node:test';
import assert from 'node:assert/strict';
import { openDashboard } from '../src/open-dashboard.js';
import { dashboardLoginUrl } from '../src/desktop-links.js';

test('Windows管理页采用默认URI关联，固定脚本不拼接地址且命令行不包含一次码',async()=>{
  for(const target of [undefined,{route:'remote' as const},{route:'agents' as const,profile:'00000000-0000-4000-8000-000000000001',add:'1' as const}]){
    const code='a'.repeat(64),url=dashboardLoginUrl(17423,code,target,!target);let called=0;
    await openDashboard(url,async(command,args,options)=>{called++;assert.equal(command,'powershell.exe');assert.deepEqual(args,['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; Start-Process -FilePath $env:SALTEDFISH_DASHBOARD_URL"]);assert.ok(!args.join(' ').includes(code));assert.equal(options.env.SALTEDFISH_DASHBOARD_URL,url);assert.equal(options.windowsHide,true);});assert.equal(called,1);
  }
});

test('管理页打开器拒绝外部或不明确目标，系统错误不回显一次码',async()=>{
  let called=0;const launch=async()=>{called++;},code='b'.repeat(64);
  for(const url of [`https://other.test/#${code}`,`http://127.0.0.1:17423/other#${code}`,`http://127.0.0.1:17423/?target=remote&target=agents#${code}`,`http://127.0.0.1:17423/?target=remote&command=anything#${code}`,`http://127.0.0.1:17423/?callback=other#${code}`])await assert.rejects(openDashboard(url,launch));
  assert.equal(called,0);await assert.rejects(openDashboard(dashboardLoginUrl(17423,code,{route:'remote'}),async()=>{throw Error('failure '+code);}),error=>error instanceof Error&&error.message==='未能打开管理页，请确认 Windows 默认浏览器可用。');
});
