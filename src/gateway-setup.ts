import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {GatewayConfig} from './remote-gateway.js';
import {ClientSetup} from './client-setup.js';
import {BrowserError} from './shared.js';
import {z} from 'zod';
import {machineIdentityHeaders} from './machine-identity.js';

export async function gatewayClientSetup(directory:string,catalogRevision?:string,agentId?:string) {
  const config=GatewayConfig.parse(JSON.parse(await readFile(path.join(directory,'gateway.json'),'utf8')));
  if(!config.localPort)throw new Error('接入需要网关开启本机回环 MCP 端口。');
  const selected = agentId === undefined ? undefined : config.agents.find(agent => agent.id === agentId);
  if(agentId !== undefined && (!z.string().uuid().safeParse(agentId).success || !selected))throw new BrowserError('GATEWAY_AGENT_NOT_FOUND','没有这个 Agent ID；先运行 gateway agents list 核对。');
  const machineHeaders = machineIdentityHeaders();
  const entries=Object.fromEntries(['codex','opencode'].map(label=>{
    const matches=selected?[selected]:config.agents.filter(agent=>agent.label===label);
    if(matches.length!==1)throw new Error(`网关需要唯一的 ${label} 客户端凭据。`);
    return [label,{url:`http://127.0.0.1:${config.localPort}/mcp`,headers:{Authorization:`Bearer ${matches[0]!.token}`,...machineHeaders}}];
  }));
  return new ClientSetup({dataDir:directory},{entries,catalogRevision});
}
