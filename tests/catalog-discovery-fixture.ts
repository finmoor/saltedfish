// 真实模型的目录发现夹具。只校验模型自行构造的参数，不连接任何浏览器。
import {appendFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {createBrowserMcp} from '../src/mcp.js';

const audit=process.argv[2]!;let value='',clicks=0,claimed=false;
const server=createBrowserMcp(async(name,args)=>{
 let data:any;
 if(name==='chrome_profiles')data={profiles:[{id:'catalog-fixture',label:'catalog-fixture',online:true}]};
 else if(name==='chrome_tabs')data={items:[{tabId:7,title:'Synthetic catalog test',url:'https://fixture.invalid/'}]};
 else if(name==='chrome_claim_tab'){claimed=true;data={claimed:true};}
 else if(name==='chrome_release_tab'){claimed=false;data={released:true};}
 else if(name==='chrome_batch'||name==='chrome_task_submit'){
  if((name==='chrome_batch'&&!claimed)||(name==='chrome_task_submit'&&claimed))throw Error('Fixture lease protocol violated');
  const steps=args.steps as any[];
  const results=steps.map(step=>{if(step.operation!=='page.action')throw Error('Only requested synthetic actions are allowed');const input=step.args;if(input.selector==='#editor'&&input.action==='fill')value=input.text;else if(input.selector==='#editor'&&input.action==='type'){const selection=input.selection||{start:value.length,end:value.length};value=value.slice(0,selection.start)+input.text+value.slice(selection.end);}else if(input.selector==='#confirm'&&input.action==='click')clicks++;else throw Error('Unexpected synthetic target');return {result:{value,clicks},verification:step.postcondition?'matched':undefined};});
  data=name==='chrome_batch'?{completed:true,results}:{id:randomUUID(),status:'succeeded',steps:results};
 }else throw Error('Only catalog fixture tools may run');
 await appendFile(audit,JSON.stringify({name,args,value,clicks})+'\n');return {ok:true,data};
});
await server.connect(new StdioServerTransport());
