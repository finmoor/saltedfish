import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';

// 可复用于隔离浏览器和已配对 Chrome；只增删本次唯一名称的待办，不用清空存储/全部清理。
export async function verifyTodoMvc(call:(name:string,args?:any)=>Promise<any>){
 const marker=`SaltedFish-${randomUUID()}`,titles=[`${marker}-A`,`${marker}-B`];
 const list=()=>call('chrome_evaluate',{expression:`[...document.querySelectorAll('.todo-list li')].map(e=>({title:e.querySelector('label').textContent,checked:e.querySelector('.toggle').checked,visible:getComputedStyle(e).display!=='none'}))`});
 const selector=async(title:string)=>{const rows=await list(),index=rows.findIndex((e:any)=>e.title===title);assert.ok(index>=0,'owned item is present');return `.todo-list li:nth-child(${index+1})`;};
 const filter=(name:string)=>call('chrome_batch',{steps:[{operation:'page.action',args:{action:'click',selector:`.filters a[href="#/${name}"]`},postcondition:{selector:`.filters a[href="#/${name}"]`,attribute:{name:'class',value:'selected'},timeoutMs:3000}}]});
 await call('chrome_navigate',{url:'https://demo.playwright.dev/todomvc/#/',timeoutMs:30000});
 await call('chrome_wait',{selector:'.new-todo',timeoutMs:10000});const before=await list();
 try{
  for(const text of titles)await call('chrome_batch',{steps:[{operation:'page.action',args:{action:'fill',selector:'.new-todo',text}},{operation:'page.action',args:{action:'press',selector:'.new-todo',key:'Enter'},postcondition:{selector:'.todo-list',textContains:text,timeoutMs:3000}}]});
  const row=await selector(titles[0]!);const found=await call('chrome_find',{scopeSelector:row,locator:{role:'checkbox',name:'Toggle Todo',exact:true}});assert.equal(found.totalElements,1);assert.equal(found.elements[0].visible,true);assert.equal(found.elements[0].visualProxy,'label-skin');
  const inspected=await call('chrome_inspect',{scopeSelector:row});assert.ok(inspected.elements.some((e:any)=>e.role==='checkbox'));
  await call('chrome_batch',{steps:[{operation:'page.action',args:{action:'click',ref:found.elements[0].ref},postcondition:{selector:row+' .toggle',state:'checked',timeoutMs:1000}}]});
  await filter('active');let rows=await list();assert.ok(rows.some((e:any)=>e.title===titles[1]&&e.visible));assert.ok(!rows.some((e:any)=>e.title===titles[0]&&e.visible));
  await filter('completed');rows=await list();assert.ok(rows.some((e:any)=>e.title===titles[0]&&e.visible&&e.checked));assert.ok(!rows.some((e:any)=>e.title===titles[1]&&e.visible));
 }finally{
  // 先重新观察再删除仍存在的自有项；不会重复执行之前的 toggle。
  await call('chrome_inspect',{scopeSelector:'.todoapp',limit:100});await call('chrome_recover_tab');await call('chrome_navigate',{url:'https://demo.playwright.dev/todomvc/#/',timeoutMs:30000});
  if((await list()).length)await call('chrome_wait',{selector:'.filters a[href="#/"]',attribute:{name:'class',value:'selected'},timeoutMs:3000});
  for(const title of titles){if(!(await list()).some((e:any)=>e.title===title))continue;const row=await selector(title);await call('chrome_action',{action:'hover',selector:row});await call('chrome_action',{action:'click',selector:row+' .destroy'});}
  const after=await list();assert.deepEqual(after,before,'pre-existing TodoMVC items preserved');
 }
 return {passed:true,added:2,toggled:1,filters:['Active','Completed'],deleted:2,coordinatesUsed:false,existingItemsPreserved:true,existingItems:before.length,baselineHash:createHash('sha256').update(JSON.stringify(before)).digest('hex')};
}
