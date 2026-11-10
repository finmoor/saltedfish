import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import path from 'node:path';
import {ClientSetup,verifyClientEntry} from '../src/client-setup.js';
import {withCatalogRevision,CODEX_TOOL_SCHEMA_MAX_BYTES} from '../src/client-config.js';
import {parseCodex,mergeCodex} from '../src/codex-config.js';
import {fixture,testDirectory,freePort} from './helpers.js';
import {VERSION} from '../src/version.js';
import {startGateway} from '../src/remote-gateway.js';

test('目录修订标记区分 stdio/HTTP，保留凭据且不修改原 entry',()=>{
 const local={command:'node',args:['fixture'],env:{TOKEN_FILE:'private'}};
 assert.deepEqual(withCatalogRevision(local,'new'),{...local,env:{TOKEN_FILE:'private',SALTEDFISH_CATALOG_VERSION:'new'}});assert.deepEqual(local.env,{TOKEN_FILE:'private'});
 const remote={url:'http://127.0.0.1:54321/mcp',headers:{Authorization:'fixture-token'}};
 assert.deepEqual(withCatalogRevision(remote,'new'),{...remote,headers:{Authorization:'fixture-token','X-SaltedFish-Catalog-Version':'new'}});assert.deepEqual(remote.headers,{Authorization:'fixture-token'});
});

test('反复更新目录修订不移动 TOML 服务表或增长外部空白',()=>{
 const prefix='\ufeff# user\r\napproval_policy="on-request"\r\n\r\n',suffix='\r\n\r\n# unrelated\r\n[mcp_servers.other]\r\ncommand="untouched"\r\n';
 let source=prefix+'[mcp_servers.saltedfish]\r\ncommand="old"'+suffix;
 for(let i=0;i<10;i++){
  source=mergeCodex(source,{command:'node',env:{SALTEDFISH_CATALOG_VERSION:String(i)}});
  assert.ok(source.startsWith(prefix+'[mcp_servers.saltedfish]'));assert.ok(source.endsWith(suffix));
  assert.equal(source.split('[mcp_servers.saltedfish]').length,2);assert.equal(parseCodex(source).mcp_servers.other.command,'untouched');
 }
});

test('连续接入预检释放 HTTP 会话，不耗尽每客户端的会话容量',async()=>{
 const device={id:randomUUID(),label:'fixture',token:randomBytes(32).toString('hex')};
 const agent={id:randomUUID(),label:'codex',deviceId:device.id,token:randomBytes(32).toString('hex'),profiles:'*' as const,readOnly:false};
 const port=await freePort(),gateway=await startGateway({host:'127.0.0.1',port,devices:[device],agents:[agent]});
 try{
  for(let i=0;i<10;i++){
   const check=await verifyClientEntry({url:`http://127.0.0.1:${port}/mcp`,headers:{Authorization:`Bearer ${agent.token}`}});
   assert.equal(check.tools,64);assert.equal(check.browserOnline,false);assert.equal(gateway.stats().sessions,0);
  }
 }finally{await gateway.close();}
});

test('升级刷新已登记目录保留信任/禁用与例外，跳过用户改动和已恢复配置',async()=>{
 const f=await fixture(),temp=await testDirectory();
 try{
  const codex=path.join(temp.directory,'config.toml'),opencode=path.join(temp.directory,'opencode.json');
  await writeFile(codex,'approval_policy="on-request"\n[mcp_servers.saltedfish]\ncommand="old"\nenabled=false\n[mcp_servers.saltedfish.tools.chrome_evaluate]\napproval_mode="prompt"\n');
  await writeFile(opencode,'{"permissions":[{"action":"shell","resource":"*","effect":"deny"}]}');
  const entry={command:'fixture',args:['mcp'],env:{CHROME_MCP_TOKEN_FILE:'private'}};
  const setup=new ClientSetup(f.config,{home:temp.directory,entries:{codex:entry,opencode:entry},verify:async()=>({tools:51,profiles:0})});
  const first=await setup.apply((await setup.preview('codex',{configPath:codex,trust:'service'})).planId);
  await setup.apply((await setup.preview('opencode',{configPath:opencode,trust:'service'})).planId);
  // 模拟旧发行版写入的配置与对应备份指纹，后续走真实自动更新路径。
  const source=await readFile(codex,'utf8'),server=parseCodex(source).mcp_servers['saltedfish'];server.env.SALTEDFISH_CATALOG_VERSION='previous';delete server.tool_input_schema_max_bytes;
  const oldText=mergeCodex(source,server);await writeFile(codex,oldText);
  const recordPath=path.join(f.config.dataDir,'setup-backups',`${first.changeId}.json`),record=JSON.parse(await readFile(recordPath,'utf8'));
  record.afterHash=createHash('sha256').update(oldText).digest('hex');await writeFile(recordPath,JSON.stringify(record));
  const edited=(await readFile(opencode,'utf8'))+'\n// user edit\n';await writeFile(opencode,edited);
  const result=await setup.refreshCatalogs();assert.equal(result.completed.length,1);assert.equal(result.skipped.length,1);
  const after=parseCodex(await readFile(codex,'utf8'));assert.equal(after.approval_policy,'on-request');
  assert.equal(after.mcp_servers['saltedfish'].env.SALTEDFISH_CATALOG_VERSION,VERSION);
  assert.equal(after.mcp_servers['saltedfish'].tool_input_schema_max_bytes,CODEX_TOOL_SCHEMA_MAX_BYTES);
  assert.equal(after.mcp_servers['saltedfish'].default_tools_approval_mode,'approve');assert.equal(after.mcp_servers['saltedfish'].enabled,false);
  assert.equal(after.mcp_servers['saltedfish'].tools.chrome_evaluate.approval_mode,'prompt');assert.equal(await readFile(opencode,'utf8'),edited);
  const count=(await setup.history()).length;assert.equal((await setup.refreshCatalogs()).completed.length,1);assert.equal((await setup.history()).length,count);
  await setup.restore((result.completed[0] as any).changeId);assert.equal(await readFile(codex,'utf8'),oldText);
  assert.equal((await setup.refreshCatalogs()).completed.length,0,'恢复旧配置后不能自动重新接入');
 }finally{await f.cleanup();await temp.cleanup();}
});

test('Codex 自己重写过 config.toml 时升级照样刷新；恢复过或用户改了连接条目就跳过',async()=>{
 const f=await fixture(),temp=await testDirectory();
 try{
  const codex=path.join(temp.directory,'config.toml');
  await writeFile(codex,'approval_policy="on-request"\n');
  const entry={command:'fixture',args:['mcp'],env:{CHROME_MCP_TOKEN_FILE:'private'}};
  const setup=new ClientSetup(f.config,{home:temp.directory,entries:{codex:entry},verify:async()=>({tools:46,profiles:0})});
  await setup.apply((await setup.preview('codex',{configPath:codex,trust:'service'})).planId);
  // Codex 打开新项目时记一条信任、并把整个文件按它自己的格式重排（2026-11-07 本机 0.3.24 升级时因此被跳过）；同时模拟上一版写的目录修订号。
  const server=parseCodex(await readFile(codex,'utf8')).mcp_servers['saltedfish'];server.env.SALTEDFISH_CATALOG_VERSION='previous';
  const rewritten=mergeCodex(await readFile(codex,'utf8'),server).replace(/^(\w+) = /gm,'"$1" = ')+'\n[projects.\'C:\\work\']\ntrust_level = "trusted"\n';
  await writeFile(codex,rewritten);assert.equal(parseCodex(rewritten).mcp_servers['saltedfish'].env.SALTEDFISH_CATALOG_VERSION,'previous');
  const result=await setup.refreshCatalogs();assert.equal(result.completed.length,1,JSON.stringify(result.skipped));
  const after=parseCodex(await readFile(codex,'utf8'));
  assert.equal(after.mcp_servers['saltedfish'].env.SALTEDFISH_CATALOG_VERSION,VERSION);assert.equal(after.mcp_servers['saltedfish'].default_tools_approval_mode,'approve');
  assert.equal(after.projects['C:\\work'].trust_level,'trusted');assert.equal(after.approval_policy,'on-request');
  // 用户恢复了这次刷新：文件回到刷新前，即使连接条目还是本安装的也不自动再刷。
  await setup.restore((result.completed[0] as any).changeId);assert.equal(await readFile(codex,'utf8'),rewritten);
  assert.equal((await setup.refreshCatalogs()).completed.length,0);
  // 用户自己改了连接条目的启动命令：不是本安装写的了，跳过。
  const custom=parseCodex(rewritten).mcp_servers['saltedfish'];custom.command='custom';
  await writeFile(codex,mergeCodex(rewritten,custom)+'\n# 再被 Codex 动过一次\n');
  const skipped=await setup.refreshCatalogs();assert.equal(skipped.completed.length,0);assert.ok(skipped.skipped.some(item=>item.client==='codex'));
  assert.equal(parseCodex(await readFile(codex,'utf8')).mcp_servers['saltedfish'].command,'custom');
 }finally{await f.cleanup();await temp.cleanup();}
});

test('Codex本机和远程接入保留更高目录额度，仅提升本服务不足的额度',async()=>{
 const temp=await testDirectory();
 try{
  const file=path.join(temp.directory,'config.toml');
  for(const remote of [false,true])for(const limit of [undefined,5000,65536]){
   const prefix='approval_policy="on-request"\n',other='\n[mcp_servers.other]\ncommand="unrelated"\ntool_input_schema_max_bytes=4096\n';
   const source=prefix+'[mcp_servers.saltedfish]\ncommand="old"\ndefault_tools_approval_mode="prompt"\n'+(limit===undefined?'':`tool_input_schema_max_bytes=${limit}\n`)+other;await writeFile(file,source);
   const entry=remote?{url:'http://127.0.0.1:54321/mcp',headers:{Authorization:'fixture'}}:{command:'node',args:['fixture'],env:{}};
   const setup=new ClientSetup({dataDir:temp.directory},{entries:{codex:entry},verify:async()=>({tools:51,profiles:0})});
   const applied=await setup.apply((await setup.preview('codex',{configPath:file,trust:'preserve'})).planId);
   const text=await readFile(file,'utf8'),parsed=parseCodex(text);assert.equal(parsed.mcp_servers['saltedfish'].tool_input_schema_max_bytes,Math.max(limit||0,CODEX_TOOL_SCHEMA_MAX_BYTES));assert.equal(parsed.mcp_servers['saltedfish'].default_tools_approval_mode,'prompt');assert.ok(text.startsWith(prefix));assert.ok(text.endsWith(other));
   assert.ok(applied.changeId); await setup.restore(applied.changeId);assert.equal(await readFile(file,'utf8'),source);
  }
 }finally{await temp.cleanup();}
});
