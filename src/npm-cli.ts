#!/usr/bin/env node
import { open, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { defaultRouteAddress, resolveInstallNetwork } from './install-network.js';
import { repairGatewayTls } from './gateway-tls.js';
import { registerMachineCommand } from './machine-registration.js';
import {unregisterDesktopLaunch} from './desktop-registration.js';
import {unregisterNativeSettings} from './native-settings-registration.js';
import {parseDesktopUrl} from './desktop-links.js';
import { switchResult } from './client-connect.js';
import { setupClients } from './client-types.js';
import { runMcpBridge } from './mcp-bridge.js';
import { autostartState, disableAutostart, enableAutostart, runAutostart } from './autostart.js';
import { fetchNewerRelease } from './npm-update.js';
import { withManagementMutex } from './management-lock.js';
import { active, dataPath, defaultHome, diagnose, ensureHome, ensureService, exists, maintenanceNotice, readJson, recoverLock, releasePath, removeFile, renameFile, requireHome, retryFile, roles, runCore, saveActive, serviceStatus, stageRelease, startService, stopService, switchVersion, withLock, writeLauncher, VERSION, type Role } from './npm-runtime.js';

const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const help=`SaltedFish ${VERSION}
  install [--home DIR] [--port PORT] [--no-start] [--no-connect] [--local] [--autostart]
          [--host IP [--url URL]] [--allow-insecure-lan | --cert PEM --key PEM] [--local-port PORT]
          [--clients ${setupClients.join(',')}] [--trust-browser | --keep-approvals]
          [--config FILE | --project DIR]
                                 Linux 首次安装默认监听默认路由的内网 IP，端口 18445，HTTP 不加密；Windows、macOS 默认只监听本机
                                 --local 只监听本机；--host 给私网 IP 时自动生成地址；公网地址需要证书
                                 --no-connect 跳过接入本机 Agent；不指定 --clients 时只接入检测到的 Agent
                                 --autostart 开启开机自动启动；不写时终端里会问
  start | stop [--force] | restart [--force] | status | logs [--lines 100]
  autostart on | off | status    Linux 开机自动启动服务（systemd）；其他系统打开 Agent 时自动启动，不用设置
  upgrade [--no-fetch] [--registry URL]
                                 下载最新版并切换运行版本，失败回退；--no-fetch 只切换到已装好的 npm 包
  rollback                       切回上一兼容版本
  recover-lock [--forget-run local|gateway]
                                 核查遗留锁与未完成的升级事务，绝不杀进程；--forget-run 只丢弃该服务陈旧的运行记录
  connect [--clients ${setupClients.join(',')}] [--trust-browser | --keep-approvals | --revoke-trust]
          [--config FILE | --project DIR] [--preview | --history | --restore ID | --refresh]
                                 --refresh 只更新已登记连接的目录版本，保留原授权与信任
  dashboard [--onboarding | --logout-all]
                                 打开管理页（非 Windows 或设置 SALTEDFISH_NO_BROWSER=1 时只打印一次性登录地址）
                                 --onboarding 直达接入页；--logout-all 注销全部管理页登录，不打开页面
  desktop register [--extension-dir DIR] | unregister
                                 注册或移除本安装的 Windows 设置入口；--extension-dir 可重复指定受信的原扩展目录，不启动服务
  desktop-open SETTINGS_URI       供已注册的桌面入口打开受限设置地址
  configure-server --host IP --url URL [--allow-insecure-lan | --cert PEM --key PEM] [--local-port PORT]
                                 停止服务后设置地址；可信内网HTTP需明确启用，其他地址使用HTTPS
  helper install [--port PORT] [--extension-dir DIR] | status | uninstall
                                 可选 Windows 文件助手；安装助手不启动浏览器服务
  clients list | add NAME [--profiles UUID,UUID] [--read-only] | revoke ID
  results list | remove ARTIFACT_ID
  mcp | doctor | diagnostics | version | --version
  mcp-bridge                     stdio 连接远端；环境变量 SALTEDFISH_MCP_URL、SALTEDFISH_MCP_TOKEN，无需 install
  extension                      输出本机已配对的扩展目录
旧安装兼容命令（新服务使用上面的 install / start / serve）：
  gateway init [--host HOST --port PORT --local-port PORT --cert PEM --key PEM --url URL]
               [--device-name NAME] [--no-start]
  gateway start | stop [--force] | restart [--force] | status | logs | serve | connect ...
  gateway agents list
  gateway agents add --name NAME --device UUID (--profiles UUID,UUID | --all-profiles)
                     [--read-only] [--url https://HOST:PORT]
  gateway connect --agent UUID --clients codex,opencode [--keep-approvals | --trust-browser]
  gateway register-machine --client codex|opencode|claude --config ABS_FILE [--preview]
                                 只登记本机信息到已有 HTTP 连接，不需要网关配置或启动服务
  gateway repair [--cert PEM] [--key PEM]  更正已有 TLS 路径，保留原配对与所有凭据
所有命令支持 --home DIR；默认 ${defaultHome()}。
npm 安装不会启停服务或写客户端配置。用户数据与运行版本独立保存。
新安装统一使用 install/start/serve；gateway 子命令仅用于旧安装兼容。
`;
function option(args:string[],name:string){const index=args.indexOf(name);if(index<0)return undefined;const value=args[index+1];if(!value||value.startsWith('--'))throw new Error(`${name} 需要值。`);args.splice(index,2);return value;}
function flag(args:string[],name:string){const i=args.indexOf(name);if(i<0)return false;args.splice(i,1);return true;}
function noArgs(args:string[]){if(args.length)throw new Error(`无法识别参数：${args.join(' ')}。运行 saltedfish --help 查看用法。`);}
function validateOptions(args:string[],values:string[],flags:string[]=[]){const seen=new Set<string>();for(let i=0;i<args.length;i++){const a=args[i]!;if(seen.has(a))throw new Error(`参数不能重复：${a}`);seen.add(a);if(flags.includes(a))continue;if(values.includes(a)&&args[i+1]&&!args[i+1]!.startsWith('--')){i++;continue;}throw new Error(`无效参数：${a}`);}}
function connectWanted(args:string[]){return args.some(a=>['--clients','--trust-browser','--keep-approvals','--revoke-trust','--config','--project'].includes(a))||!!process.stdin.isTTY;}
async function logTail(home:string,role:Role,args:string[]){const lines=Number(option(args,'--lines')||100);noArgs(args);if(!Number.isInteger(lines)||lines<1||lines>1000)throw new Error('--lines 应为 1–1000。');const file=path.join(home,'logs',`${role}.log`);if(!await exists(file)){console.log('尚无运行日志。');return;}const f=await open(file,'r');try{const size=(await f.stat()).size,b=Buffer.alloc(Math.min(size,128*1024));await f.read(b,0,b.length,Math.max(0,size-b.length));console.log(b.toString('utf8').split(/\r?\n/).slice(-lines).join('\n').replace(/Bearer\s+\S+/g,'Bearer [redacted]'));}finally{await f.close();}}
async function initialize(home:string){
  const manifest=await stageRelease(home,packageRoot);await writeLauncher(home);
  if(await exists(path.join(home,'active.json'))){if((await active(home)).version!==manifest.version)throw new Error('已有其他活动版本。npm 更新不会切换服务，请运行 saltedfish upgrade。');}
  else await saveActive(home,{product:'saltedfish-npm',version:manifest.version,stateVersion:manifest.stateVersion});
}
async function setupLocal(home:string,port?:string,noStart=false,networkArgs:string[]=[]){
  const file=path.join(dataPath(home,'local'),'config.json');
  if(port){const n=Number(port);if(!Number.isInteger(n)||n<1024||n>65535)throw new Error('端口需要 1024–65535。');if(await exists(file)&&(await readJson(file)).port!==n)throw new Error('已有安装使用不同端口，未修改配置。');}
  let chosen=Number(port||17422);
  if(!await exists(file)){
    const available=async(n:number)=>{const server=createServer();try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(n,'127.0.0.1',resolve);});return true;}catch{return false;}finally{await new Promise<void>(r=>server.close(()=>r()));}};
    while(!await available(chosen)){if(port||chosen>=17522)throw new Error('本机端口被占用，请用 --port 指定空闲端口。');chosen++;}
  }
  const previous=process.env.CHROME_MCP_PORT;try{process.env.CHROME_MCP_PORT=String(chosen);await loadConfig(dataPath(home,'local'));}finally{if(previous===undefined)delete process.env.CHROME_MCP_PORT;else process.env.CHROME_MCP_PORT=previous;}
  if(networkArgs.length){
    // 服务在运行时 configure-server 会拒绝；install 是用户明确要求的改动，先正常停掉（有在途命令时 stop 自己会拒绝）。
    if(['running','unreachable'].includes((await serviceStatus(home,'local')).state))await stopService(home,'local');
    await runCore(home,'local',['configure-server',...networkArgs],true);
  }
  await startService(home,'local');
  try{await runCore(home,'local',['setup'],true);}finally{if(noStart)await stopService(home,'local');}
  await synchronizeDesktop(home);
}
async function desktopConfig(home:string){const directory=dataPath(home,'local');if(!await exists(path.join(directory,'config.json')))return undefined;return loadConfig(directory);}
async function synchronizeDesktop(home:string){
  if(process.platform!=='win32')return;
  const config=await desktopConfig(home);if(!config)return;
  const version=(await active(home)).version;
  try{
    if(await exists(path.join(releasePath(home,version),'dist/desktop-registration.js')))await runCore(home,'local',['desktop','register'],true);
    else { await unregisterNativeSettings(config); await unregisterDesktopLaunch(config); }
    if (!await exists(path.join(releasePath(home,version),'dist/native-settings-registration.js'))) await unregisterNativeSettings(config);
  }catch{console.error('桌面设置入口未更新；原管理页登录方式仍可使用。请核查同端口的其他安装或被修改的注册项。');}
}
async function initializeGateway(home: string, args: string[], noStart: boolean) {
  await initialize(home);
  const directory = dataPath(home, 'gateway');
  if (await exists(directory)) throw new Error('网关已初始化或目录非空，未覆盖凭据。使用 gateway start / connect；TLS 路径错误可在停止后使用 gateway repair。');
  const staging = path.join(home, 'data', `.gateway-init-${randomUUID()}`);
  try {
    // 子命令先检查完整 TLS 配置；成功生成全部私有文件后才提交正式目录。
    const result = JSON.parse(await runCore(home, 'gateway', ['init', ...args], true, staging));
    await renameFile(staging, directory);
    console.log(JSON.stringify({ ...result, directory, pairingFile: path.join(directory, 'device-pairing.token') }));
  } finally { await retryFile(() => rm(staging, { recursive: true, force: true })); }
  // 端口等运行环境失败保留已生成凭据；修正环境后 start，不再次 init。
  if (!noStart) await startService(home, 'gateway');
}
async function askAutostart(){
  const prompt=createInterface({input:process.stdin,output:process.stdout});
  try{return !/^n/i.test((await prompt.question('开机自动启动？[Y/n] ')).trim());}finally{prompt.close();}
}
async function main(){
  if(Number(process.versions.node.split('.')[0])<24)throw new Error('SaltedFish 需要 Node.js 24 或更新版本。');
  const args=process.argv.slice(2),homeArgument=option(args,'--home')||defaultHome();
  if(args.includes('--home'))throw new Error('--home 不能重复。');
  const first=args.shift()||'help';if(['help','-h','--help'].includes(first)){console.log(help);return;}
  if(first==='version'||first==='--version'){noArgs(args);console.log(VERSION);return;}
  if(first==='mcp-bridge'){noArgs(args);await runMcpBridge();return;}
  const role:Role=first==='gateway'?'gateway':'local',command=first==='gateway'?(args.shift()||'help'):first;
  if(command==='help'||command==='--help'){console.log(help);return;}
  if(command==='register-machine'&&role==='gateway'){
    console.log(JSON.stringify(await registerMachineCommand(path.join(path.resolve(homeArgument),'data','machine-registration'),args),null,2));return;
  }
  const initializing=command==='install'||command==='helper'&&args[0]==='install'||role==='gateway'&&command==='init';
  const home=initializing?await ensureHome(homeArgument):await requireHome(path.resolve(homeArgument)).catch(e=>{if((e as NodeJS.ErrnoException).code==='ENOENT')throw new Error('尚未安装。先运行 saltedfish install。');throw e;});
  if(command==='install'){
    if(role!=='local')throw new Error('统一服务请使用 saltedfish install。');
    const port=option(args,'--port'),noStart=flag(args,'--no-start'),noConnect=flag(args,'--no-connect'),local=flag(args,'--local'),autostart=flag(args,'--autostart');
    const host=option(args,'--host'),url=option(args,'--url'),cert=option(args,'--cert'),key=option(args,'--key'),localPort=option(args,'--local-port'),allowInsecureLan=flag(args,'--allow-insecure-lan');
    validateOptions(args,['--clients','--config','--project'],['--trust-browser','--keep-approvals']);
    if(noStart&&(args.length||autostart))throw new Error('--no-start 不能同时自动接入客户端或开启开机自动启动。');
    if(noConnect&&args.length)throw new Error('--no-connect 不能同时传入接入选项。');
    const network=await withLock(home,async()=>{const configFile=path.join(dataPath(home,'local'),'config.json'),firstInstall=!await exists(configFile);const existing=firstInstall?undefined:await readJson(configFile).catch(()=>undefined);const resolved=await resolveInstallNetwork({platform:process.platform,firstInstall,local,allowInsecureLan,port,host,url,cert,key,localPort,detect:()=>defaultRouteAddress(),current:{host:existing?.network?.host,port:existing?.port}});await initialize(home);await setupLocal(home,resolved.port,noStart,resolved.networkArgs);return resolved;});
    // 终端里给人看，管道和脚本继续拿 JSON。
    const terminal=!!process.stdin.isTTY&&!!process.stdout.isTTY,extensionDir=path.join(dataPath(home,'local'),'extension');
    console.log(terminal?`SaltedFish ${VERSION} ${noStart?'已安装，服务未启动':'已启动'}\nChrome 扩展目录：${extensionDir}`:JSON.stringify({product:'SaltedFish',version:VERSION,home,extensionDir,state:noStart?'stopped':'running',entry:path.join(home,'launcher.mjs'),...(network.serviceUrl?{serviceUrl:network.serviceUrl}:{})}));
    if(network.note)console.error(network.note);
    if(network.serviceUrl)console.log(`服务地址：${network.serviceUrl}（内网 HTTP，未加密，只在可信内网使用）`);
    const connecting=!noStart&&!noConnect&&connectWanted(args);
    if(connecting)await runCore(home,'local',['connect',...args]);else noArgs(args);
    if(!noStart&&await autostartState()==='off'&&(autostart||terminal&&await askAutostart())){const warning=await enableAutostart(home);if(warning)console.error(warning);}
    if(!connecting||terminal)console.log(`${terminal?'\n':''}运行 saltedfish dashboard，在管理页配对浏览器并生成 Agent 的 HTTP 配置。`);return;
  }
  if(command==='init'&&role==='gateway'){
    const noStart=flag(args,'--no-start');
    validateOptions(args,['--host','--port','--local-port','--cert','--key','--url','--device-name']);
    await withLock(home, () => initializeGateway(home, args, noStart));return;
  }
  if(command==='agents'&&role==='gateway'){
    const pending=await maintenanceNotice(home);if(pending)throw new Error(pending);
    if(args[0]==='list')await runCore(home,role,[command,...args]);
    else await withLock(home,()=>runCore(home,role,[command,...args]));
    return;
  }
  if(command==='recover-lock'){
    const forget=option(args,'--forget-run');noArgs(args);
    if(forget!==undefined&&!(roles as string[]).includes(forget))throw new Error('--forget-run 需要 local 或 gateway。');
    const result=await recoverLock(home,forget===undefined?{}:{forgetRun:forget as Role});await synchronizeDesktop(home);console.log(JSON.stringify(result));return;
  }
  if(command==='repair'&&role==='gateway'){
    const cert=option(args,'--cert'),key=option(args,'--key');noArgs(args);
    const result=await withLock(home,async()=>{
      const state=await serviceStatus(home,role);
      if(state.state==='running'||state.state==='unreachable')throw new Error(`请先核查并停止 gateway，再修复 TLS 路径；不会打断运行服务。${state.hint??''}`);
      return repairGatewayTls(dataPath(home,role),{cert,key});
    });
    console.log(JSON.stringify(result));return;
  }
  if(command==='status'||command==='doctor') {noArgs(args);console.log(JSON.stringify({product:'SaltedFish',packageVersion:VERSION,active:await active(home),home,autostart:await autostartState(),...await diagnose(home)},null,2));return;}
  if(command==='logs'){await logTail(home,role,args);return;}
  if(command==='extension'){noArgs(args);const directory=path.join(dataPath(home,'local'),'extension');if(!await exists(path.join(directory,'manifest.json')))throw new Error('尚未初始化本机扩展，先运行 saltedfish install。');console.log(directory);return;}
  if(command==='upgrade'||command==='rollback'){
    const noFetch=flag(args,'--no-fetch'),registry=option(args,'--registry');
    if(command==='rollback'&&(noFetch||registry))throw new Error('rollback 不下载，不接受 --no-fetch 和 --registry。');
    noArgs(args);
    // 下载会改写全局 npm 目录，两个 upgrade 不能同时进行；用单独的下载锁，不占管理锁（下面新包接着切换时要取管理锁）。
    if(command==='upgrade'&&!noFetch&&await withManagementMutex(home,()=>fetchNewerRelease(packageRoot,VERSION,{registry,log:message=>console.error(message)}),'download-lock.sqlite','另一个 upgrade 正在下载新版本，请等它结束后再试；没有改动任何文件。')){
      // 这个进程里还是旧代码，由新包接着切换。
      const child=spawn(process.execPath,[path.join(packageRoot,'dist/npm-cli.js'),'upgrade','--no-fetch','--home',home],{stdio:'inherit',windowsHide:true});
      process.exitCode=await new Promise<number>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code??1));});return;
    }
    // 固定 launcher 的文案随版本改进：升级时只替换历史上发布过的已知内容，用户改过的保持不动并在输出里说明。
    const outcome:{launcher?:string}={};
    const clients=await withLock(home,async()=>{const old=await active(home);if(command==='upgrade'){await stageRelease(home,packageRoot);outcome.launcher=await writeLauncher(home).catch(()=>'kept');}else if(!old.previous)throw new Error('没有可回滚的上一版本。');
      const config=await desktopConfig(home);
      try{if(config){await unregisterDesktopLaunch(config,{validateOnly:true});await unregisterNativeSettings(config,{validateOnly:true});await unregisterNativeSettings(config);await unregisterDesktopLaunch(config);}return await switchVersion(home,command==='upgrade'?VERSION:old.previous!);}finally{await synchronizeDesktop(home);}});
    // 终端里给人看，管道和脚本继续拿 JSON。
    const current=await active(home),terminal=!!process.stdin.isTTY&&!!process.stdout.isTTY,boot=await autostartState();
    console.log(terminal?switchResult(command,current,clients,outcome.launcher):JSON.stringify({home,active:current,clients,...(outcome.launcher&&outcome.launcher!=='current'?{launcher:outcome.launcher}:{})}));
    // 换过 Node 时开机入口要跟着改。
    if(boot==='on')await enableAutostart(home).catch(error=>console.error(error instanceof Error?error.message:'开机自动启动的配置没有更新。'));
    if(boot!=='on'&&process.platform==='linux'&&terminal&&command==='upgrade'&&clients)console.log(boot==='off'?'服务器重启后服务不会自动启动，要开启就运行 saltedfish autostart on。':'服务器重启后服务不会自动启动，要运行 saltedfish start。');
    return;
  }
  if(command==='autostart'){
    if(role!=='local')throw new Error('开机自动启动只用于统一服务。');
    const action=args.shift();noArgs(args);
    if(action==='run'){await runAutostart(home);return;}
    if(!['on','off','status'].includes(action!))throw new Error('用法：saltedfish autostart on | off | status');
    const state=await autostartState();
    if(state==='unsupported'&&process.platform!=='linux'){console.log('这台电脑打开 Agent 时会自动启动服务，不用设置。');return;}
    if(action==='status'){console.log(`开机自动启动：${state==='on'?'开启':state==='off'?'关闭':'这台电脑没有 systemd'}`);return;}
    if(action==='off'){await disableAutostart(home);console.log('已关闭开机自动启动，服务继续运行。');return;}
    const warning=await enableAutostart(home);console.log(`已开启开机自动启动。${warning??''}`);return;
  }
  if(['start','stop','restart'].includes(command)){
    const force=flag(args,'--force');noArgs(args);if(command==='start'&&force)throw new Error('start 不使用 --force。');
    await withLock(home,async()=>{if(command!=='start')await stopService(home,role,force);if(command!=='stop')await startService(home,role);});console.log(JSON.stringify(await serviceStatus(home,role)));return;
  }
  if(command==='serve'){
    noArgs(args);const pending=await maintenanceNotice(home);if(pending)throw new Error(pending);
    const current=await active(home);await removeFile(path.join(home,'run',`${role}.stopped`));
    const child=spawn(process.execPath,[path.join(releasePath(home,current.version),'dist/npm-worker.js'),role,home],{stdio:'inherit',windowsHide:true,env:{...process.env,SALTEDFISH_HOME:home,SALTEDFISH_MANAGED:'1',SALTEDFISH_ENTRY:path.join(home,'launcher.mjs'),CHROME_MCP_DATA_DIR:dataPath(home,role)}});
    for(const sig of ['SIGTERM','SIGINT'] as const)process.once(sig,()=>child.kill(sig));
    const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});if(code)throw new Error(`前台服务已退出 (${code})。`);return;
  }
  if(command==='native-settings'){
    if(role!=='local')throw new Error('设置入口只适用于本机安装。');
    // 固定 launcher 仅转发帧；真实请求、来源与现有配置由 core 核验。
    await runCore(home,'local',[command,...args]);return;
  }
  if(command==='helper'){
    if(role!=='local')throw new Error('助手请使用 saltedfish helper。');
    const port=option(args,'--port');
    if(port!==undefined&&args[0]!=='install')throw new Error('--port 仅用于首次安装助手。');
    if(!['install','status','uninstall'].includes(args[0]!))throw new Error('用法：saltedfish helper install [--port PORT] [--extension-dir DIR] | status | uninstall');
    await withLock(home,async()=>{
      if(args[0]==='install'){
        await initialize(home);
        const previous=process.env.CHROME_MCP_PORT;try{if(port)process.env.CHROME_MCP_PORT=port;const config=await loadConfig(dataPath(home,'local'));if(port&&config.port!==Number(port))throw new Error('已有安装端口不同，未修改。');}finally{if(previous===undefined)delete process.env.CHROME_MCP_PORT;else process.env.CHROME_MCP_PORT=previous;}
      }
      await runCore(home,'local',['helper',...args]);
    });return;
  }
  if(command==='configure-server'){
    if(role!=='local')throw new Error('统一服务配置请使用顶层命令。');
    await withLock(home,async()=>{const state=await serviceStatus(home,role);if(['running','unreachable'].includes(state.state))throw new Error('请先停止此安装的服务，再更改连接配置。');await runCore(home,role,[command,...args]);});return;
  }
  if(command==='desktop'||command==='desktop-open'){
    if(role!=='local')throw new Error('桌面设置入口只适用于本机安装。');
    const pending=await maintenanceNotice(home);if(pending)throw new Error(pending);
    if(command==='desktop'){
      if(!['register','unregister'].includes(args[0]!)||args[0]==='unregister'&&args.length!==1)throw new Error('用法：saltedfish desktop register [--extension-dir DIR] | unregister');
      for(let i=1;i<args.length;i+=2)if(args[i]!=='--extension-dir'||!args[i+1]||args[i+1]!.startsWith('--'))throw new Error('--extension-dir 需要扩展目录。');
      if(!await exists(path.join(dataPath(home,'local'),'config.json')))throw new Error('尚未初始化本机配置，未创建或修改桌面入口。');
      await runCore(home,'local',[command,...args]);return;
    }
    if(args.length!==1||process.platform!=='win32'||process.env.SALTEDFISH_NO_BROWSER)throw new Error('无法打开设置入口，请从 SaltedFish 页面重新打开。');
    parseDesktopUrl(args[0]!);
    const config=await desktopConfig(home);if(!config)throw new Error('本机安装配置不存在，未启动服务。');
    parseDesktopUrl(args[0]!,config.port);
    await ensureService(home,'local',false);await runCore(home,'local',[command,...args]);return;
  }
  if(['mcp','connect','dashboard','diagnostics','clients','results'].includes(command)){
    if(role==='gateway'&&command!=='connect')throw new Error('远程 Agent 使用 gateway 的 HTTP MCP 地址；此命令只适用于本机。');
    const pending=await maintenanceNotice(home);if(pending)throw new Error(pending);
    // 几个客户端同时拉起时，后到者有界等待先到者启动完成，而不是立即失败。
    await ensureService(home,role,command==='mcp');
    await runCore(home,role,[command,...args]);return;
  }
  throw new Error('未知命令。运行 saltedfish --help 查看用法。');
}
main().catch(error=>{console.error(error instanceof Error?error.message:'SaltedFish 命令失败。');process.exitCode=1;});
