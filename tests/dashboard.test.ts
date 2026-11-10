import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {ClientSetup} from '../src/client-setup.js';
import {fixture,testDirectory,fakeProfile} from './helpers.js';
import {bridgeToken} from '../src/auth.js';

const entry={command:'node',args:['saltedfish.mjs','mcp'],env:{CHROME_MCP_DATA_DIR:'fixture-data',CHROME_MCP_TOKEN_FILE:'secret-location.token'}};
test('管理页摘要只允许管理员，状态来自服务且没有令牌',async()=>{
 const f=await fixture();try{
  const p=await fakeProfile(f.config,'个人',()=>({})),url=`http://127.0.0.1:${f.config.port}/dashboard`;
  for(const token of ['',bridgeToken(f.config),f.service.state.createClient('limited').token])assert.notEqual((await fetch(url,{headers:{authorization:'Bearer '+token}})).status,200);
  const response=await fetch(url,{headers:{authorization:'Bearer '+f.config.token}});assert.equal(response.status,200);const data=await response.json();assert.equal(data.profiles[0].id,p.id);assert.equal(data.profiles[0].online,true);assert.equal(data.extensionDir,path.join(f.config.dataDir,'extension'));assert.equal(data.remote.state,'disconnected');assert.ok(!JSON.stringify(data).includes(f.config.token));
  p.socket.close();for(let i=0;i<50&&f.service.broker.profiles.has(p.id);i++)await new Promise(r=>setTimeout(r,10));const offline=await(await fetch(url,{headers:{authorization:'Bearer '+f.config.token}})).json();assert.equal(offline.profiles[0].id,p.id);assert.equal(offline.profiles[0].online,false);
 }finally{await f.cleanup();}
});
test('Agent 检测区别空文件、此安装、其他连接和停用；检测不执行命令',async()=>{
 const f=await fixture(),temp=await testDirectory();try{
  let checks=0;const setup=new ClientSetup(f.config,{home:temp.directory,entries:{claude:entry,opencode:entry,codex:entry},verify:async()=>{checks++;return {tools:51,profiles:2};}});
  const file=path.join(temp.directory,'.claude.json');await writeFile(file,'{}');assert.equal((await setup.inspect('claude')).connection,'not_configured');assert.equal(checks,0);
  await setup.apply((await setup.preview('claude')).planId);assert.equal((await setup.inspect('claude')).connection,'configured');const before=await readFile(file,'utf8');
  const checked=await setup.check('claude');assert.equal(checked.verification.tools,51);assert.equal(await readFile(file,'utf8'),before);assert.equal(checks,2);
  await writeFile(file,JSON.stringify({mcpServers:{'saltedfish':{...entry,command:'unknown-program'}}}));assert.equal((await setup.inspect('claude')).connection,'other_config');await assert.rejects(setup.check('claude'),{code:'CLIENT_NOT_CONFIGURED'});assert.equal(checks,2);
  await writeFile(file,JSON.stringify({mcpServers:{'saltedfish':{...entry,enabled:false}}}));assert.equal((await setup.inspect('claude')).connection,'disabled');
  await writeFile(file,'{"mcpServers":');const detected=(await setup.detect()).find(c=>c.client==='claude');assert.ok(detected && 'connection' in detected);assert.equal(detected.connection,'invalid');assert.equal(checks,2);
  assert.ok(!JSON.stringify(await setup.detect()).includes('secret-location.token'));
 }finally{await f.cleanup();await temp.cleanup();}
});
test('Codex/OpenCode 已配置和信任按实际条目判断，目录版本不造成误报',async()=>{
 const f=await fixture(),temp=await testDirectory();try{
  const setup=new ClientSetup(f.config,{home:temp.directory,entries:{codex:entry,opencode:entry},verify:async()=>({tools:51,profiles:0})});
  for(const client of ['codex','opencode'] as const){await setup.apply((await setup.preview(client,{trust:'service'})).planId);const state=await setup.inspect(client);assert.equal(state.connection,'configured');assert.equal(state.trusted,true);assert.equal((await setup.check(client)).verification.profiles,0);}
 }finally{await f.cleanup();await temp.cleanup();}
});
test('检查中配置被修改则不报告成功，保留用户文件',async()=>{
 const f=await fixture(),temp=await testDirectory();try{
  const file=path.join(temp.directory,'.claude.json');let change=false;const setup=new ClientSetup(f.config,{home:temp.directory,entries:{claude:entry},verify:async()=>{if(change)await writeFile(file,'{"userChanged":true}');return {tools:51,profiles:1};}});
  await setup.apply((await setup.preview('claude')).planId);change=true;await assert.rejects(setup.check('claude'),{code:'CLIENT_CONFIG_CHANGED'});assert.equal(await readFile(file,'utf8'),' {"userChanged":true}'.trim());
 }finally{await f.cleanup();await temp.cleanup();}
});
