import { createEditor } from './editor.js';
import { profileLabel } from './identity.js';
import { returnFocusOnClose } from './workspace.js';
import {randomId} from './random-id.js';
import {clientReloadHint} from './client-hints.js';
export function initializeProduct({ call, request, el, button, run, status, getProfiles, onReview, isActive, onClients }) {
  const $ = selector => document.querySelector(selector);
  // 用过浏览器的 Agent 已经有了，概览就不再摆试用卡片，这里也不再指向它。
  const trialHint = () => $('.usage-panel')?.hidden ? '在聊天里让它列出某个浏览器的标签页试试' : '发送概览中的试用指令';
  let updating = false, taskRequest = 0, taskOffset = 0, taskNext = null, detailState, detailRequest = 0, workflowOffset = 0, workflowNext = null, workflowRequest = 0;
  let tabRequest = 0, tabProfile, profilesReady = false;
  let pendingTask;
  let clientsReady = false, historyReady = false, detecting, clientGeneration=0, loadedWorkflowProfile;
  let detailView, detailLoading = false;
  const editor = createEditor({ el, status, profileId: () => $('#task-profile').value });
  const stateLabels = { queued: '排队中', running: '进行中', pausing: '将在本步结束后暂停', paused: '已暂停', cancelling: '将在本步结束后取消', cancelled: '已取消', succeeded: '已完成', failed: '未完成', needs_review: '请核查结果', interrupted: '服务中断，请核查' };
  const stepLabels = { 'page.action': '页面操作', 'page.wait': '核验页面', 'page.navigate': '页面导航', 'page.upload': '上传文件', 'page.dialog': '处理弹窗', 'tabs.wait': '跟随新标签页', 'page.evaluate': '页面脚本',
    'page.screenshot':'页面截图','page.inspect':'读取页面','page.cdp':'浏览器协议命令',
    'network.start':'开始捕获网络','network.stop':'停止捕获网络','network.body':'读取响应正文','network.wait':'等待网络响应',
    'downloads.start':'开始下载','downloads.wait':'等待下载完成',
    'flow.if':'判断条件','flow.else':'否则分支','flow.repeat':'循环','flow.end':'结束控制块','flow.set':'设置任务变量' };
  const actionLabels={fill:'填写',click:'点击',doubleClick:'双击',drag:'拖拽',setChecked:'设置勾选状态',type:'输入文字',hover:'悬停',press:'按键',scroll:'滚动',select:'选择选项',goto:'打开网址',back:'后退',forward:'前进',reload:'刷新页面'};
  const stepName=step=>actionLabels[step.action??step.args?.action]||stepLabels[step.operation]||step.operation;
  function choose(options, value) { const select = el('select'); for (const [id, label] of options) { const item = el('option', label); item.value = id; select.append(item); } select.value = value; return select; }
  function field(label, input) { const wrap = el('label', label); wrap.append(input); return wrap; }
  function input(placeholder = '') { const node = el('input'); node.placeholder = placeholder; return node; }
  // 对话框开着时列表可能被重画（任务行被后台轮询更新、流程列表被“恢复为新版本”重建），打开它的按钮随之脱离页面：关闭时按稳定标识找回同一个入口。
  // 整行/整张卡片都不在了（例如任务被挤到下一页）就退回到所在列表上方的控件，不让焦点丢到页面顶部。
  const detailEntry = (profileId, taskId) => [...document.querySelectorAll('#task-list .task-row')].find(row => row.dataset.taskKey === `${profileId}/${taskId}`)?.querySelector('[data-detail]') ?? $('#task-search');
  const historyEntry = workflowId => [...document.querySelectorAll('#workflow-list .workflow')].find(card => card.dataset.workflowId === workflowId)?.querySelector('[data-history]') ?? $('#load-workflows');
  function addStep() { editor.addStep(); }
  function collectPlan() { return editor.plan(); }
  function downloadJson(value, name) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const link = el('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  function currentTarget() {
    const profileId = $('#task-profile').value, selected = $('#task-tab').value;
    if (!profileId || !selected) throw new Error('先选择已连接的账号和目标标签页。');
    return { profileId, tabId: Number(selected) };
  }
  async function refreshTabs() {
    const select = $('#task-tab'), profileId = $('#task-profile').value, previous = tabProfile === profileId ? select.value : '', sequence = ++tabRequest;
    tabProfile = profileId;
    const placeholder = text => { const option = el('option', text); option.value = ''; select.replaceChildren(option); };
    placeholder('正在读取标签页…'); select.disabled = true;
    if (!profileId) { placeholder('先选择浏览器'); return; }
    if (!getProfiles().find(profile => profile.id === profileId)?.online) { placeholder('此浏览器未连接，请打开原 Chrome 后继续'); return; }
    try {
      const tabs = await call('chrome_tabs', { profileId, limit: 1000 });
      if (sequence !== tabRequest || profileId !== $('#task-profile').value) return;
      placeholder('请选择目标标签页');
      for (const tab of tabs.items) { const option = el('option', `${tab.title || '无标题'} · ${tab.tabId}`); option.value = String(tab.tabId); select.append(option); }
      if (previous && [...select.options].some(option => option.value === previous)) select.value = previous;
      else { select.value = ''; if (previous) status.textContent = '原目标标签页已不可用，请重新明确选择。'; }
    } catch (error) { if (sequence === tabRequest) placeholder('读取失败，请刷新标签页'); throw error; }
    finally { if (sequence === tabRequest) select.disabled = false; }
  }
  // force：用户主动触发（例如切换账号）的刷新不能因为后台轮询正在读取就被跳过；较早发出的读取返回后按序号丢弃。
  async function refreshTasks(force = false) {
    if (updating && !force) return;
    if (!$('#task-profile').value) { $('#task-list').replaceChildren(el('p','先选择浏览器，再查看或编排任务。','empty')); $('#task-page-label').textContent=''; $('#task-prev').disabled=$('#task-next').disabled=true; return; }
    updating = true; const sequence = ++taskRequest;
    try {
      const profileId = $('#task-profile').value, offset = taskOffset, query = $('#task-search').value, filter = $('#task-filter').value, data = await call('chrome_tasks', { profileId, offset, limit: 10, query, ...(filter ? { status: filter } : {}) });
      if (sequence !== taskRequest || profileId !== $('#task-profile').value || offset !== taskOffset || query !== $('#task-search').value || filter !== $('#task-filter').value) return;
      const root = $('#task-list'); root.className = '';
      taskNext = data.nextOffset; $('#task-page-label').textContent = `${data.total} 项 · 第 ${Math.floor(taskOffset / 10) + 1} 页`; $('#task-prev').disabled = taskOffset === 0; $('#task-next').disabled = taskNext === null;
      if (!data.items.length) root.replaceChildren(el('p', '这个账号还没有任务。新建一次，或运行已保存的流程。', 'empty'));
      const existing=new Map([...root.querySelectorAll('.task-row')].map(row=>[row.dataset.taskKey,row])),retained=new Set();let position=0;
      for (const task of data.items) {
        const key=profileId+'/'+task.id;let row=existing.get(key);
        if(!row){
          row=el('div',undefined,'task-row');row.dataset.taskKey=key;const name=el('div'),progress=el('div'),actions=el('div',undefined,'row-actions');
          const title=el('h3'),target=el('small'),state=el('span'),count=el('small'),bar=el('progress');bar.setAttribute('aria-label','当前步骤位置');const track=el('div',undefined,'progress-track');track.append(bar);name.append(title,target);progress.append(state,count,track);
          const detail=button('详情',opener=>showTask(profileId,task.id,false,opener));detail.dataset.detail='';actions.append(detail);const controls={};
          for(const[action,label]of[['pause','暂停'],['resume','继续'],['cancel','取消任务']]){const control=button(label,async()=>{await call('chrome_task_control',{profileId,taskId:task.id,action});await refreshTasks();},action==='cancel'?'danger':'secondary');controls[action]=control;actions.append(control);}
          row.append(name,progress,actions);row.taskUI={title,target,state,count,bar,controls};
        }
        const ui=row.taskUI;ui.title.textContent=task.name;ui.target.textContent=`标签 ${task.tabId} · ${new Date(task.createdAt).toLocaleTimeString()}`;ui.state.textContent=stateLabels[task.status]||task.status;ui.state.className=`state ${task.status}`;ui.count.textContent=`${task.nextStep} / ${task.totalSteps} 步`;ui.bar.max=task.totalSteps;ui.bar.value=task.nextStep;
        ui.controls.pause.hidden=!['queued','running'].includes(task.status);ui.controls.resume.hidden=task.status!=='paused';ui.controls.cancel.hidden=!['queued','running','paused','pausing'].includes(task.status);
        retained.add(row);if(root.children[position]!==row)root.insertBefore(row,root.children[position]||null);position++;
      }
      if(data.items.length)for(const node of [...root.childNodes])if(!retained.has(node))node.remove();
      $('#task-live').textContent = `每个账号独立排队 · ${new Date().toLocaleTimeString()} 已更新`;
    } finally { if (sequence === taskRequest) updating = false; }
  }
  function renderTaskStep(step) {
    const states = { pending: '未开始', running: '执行中', succeeded: '已完成', failed: '失败', unknown: '结果待确认', skipped:'已跳过' };
    const verification = { pending: '页面结果检查尚未完成', matched: '页面结果已核验', unconfirmed: '页面结果未确认，禁止重复提交' };
    const row = el('li', `${stepName(step)} · ${states[step.state]||step.state}`);
    if(Number.isInteger(step.executions)&&step.executions>0)row.append(el('div',`已执行 ${step.executions} 次`,'muted'));
    if (step.verification) row.append(el('div', verification[step.verification], 'muted'));
    if (step.outcome) {
      const explanation = step.outcome === 'not_dispatched'
        ? '本步目标输入未派发；此前完成步骤保留。'
        : '本步可能已产生影响，请先核查页面。';
      row.append(el('div', explanation, 'muted'));
    }
    if (step.operationId) row.append(el('br'), el('code', step.operationId));
    if (step.artifactId) {
      const result=el('div',undefined,'step-result');result.append(el('span','结果文件：','muted'),el('code',step.artifactId));
      if(['png','json'].includes(step.artifactType))result.append(button(step.artifactType==='png'?'查看步骤截图':'下载步骤结果',async()=>{
        const url=await request(`/results/${encodeURIComponent(step.artifactId)}`,'GET',undefined,true);
        if(!row.isConnected||!$('#task-detail').open){URL.revokeObjectURL(url);return;}
        if(step.artifactType==='png'){
          const image=el('img');image.alt='此步骤完成时的页面截图';image.onload=image.onerror=()=>URL.revokeObjectURL(url);image.src=url;
          result.querySelector('img')?.remove();result.append(image);
        }else{
          const link=el('a');link.href=url;link.download=`task-result-${step.artifactId}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
        }
      }));
      row.append(result);
    }
    if (step.code) row.append(el('div', step.code, `state ${step.state === 'unknown' ? 'unknown' : 'failed'}`));
    return row;
  }
  // opener：打开详情的那个按钮（button 的 action 会收到它），关闭对话框后把焦点还给它。
  async function showTask(profileId, taskId, refresh = false, opener) {
    if (refresh && detailLoading) return;
    if (!refresh && detailState?.editing) {
      $('#task-detail-body .recovery-editor')?.remove();
      detailState.editing = false;
    }
    if (!refresh && (detailState?.profileId !== profileId || detailState?.taskId !== taskId)) detailState = { profileId, taskId, editing: false };
    const sequence = ++detailRequest;
    detailLoading = true;
    let diagnostic;
    try { diagnostic = await call('chrome_task_diagnostics', { profileId, taskId }); }
    finally { if (sequence === detailRequest) detailLoading = false; }
    const task = diagnostic.task, root = $('#task-detail-body');
    if (sequence !== detailRequest) return;
    if (refresh && (detailState?.editing || detailState?.updatedAt === task.updatedAt || !$('#task-detail').open)) return;
    detailState = { profileId, taskId, updatedAt: task.updatedAt, editing: detailState?.editing || false };
    const key = `${profileId}/${taskId}`;
    if (detailView?.key !== key) {
      const title = el('h3'), progress = el('p'), actions = el('div', undefined, 'row-actions');
      const advice = el('div'), steps = el('ol'), attachments = el('div');
      const view = { key, title, progress, advice, steps, attachments, diagnostic, screenshot: undefined, recoveryButton: undefined };
      actions.append(button('刷新详情', () => showTask(profileId, taskId)), button('显示目标窗口', () => call('chrome_focus_tab', { profileId, tabId: view.diagnostic.task.tabId })));
      actions.append(button('查看操作记录', async () => {
        $('#task-detail').close();
        // 走操作记录页自己的 open()：回到“待核查”第 1 页，不沿用上次的筛选和页码。对话框已关闭，失败只能报告在页面状态栏。
        try { await onReview(profileId); } catch (error) { if (error.code !== 'STALE_SESSION') { status.dataset.error = 'true'; status.textContent = error.message; } }
      }));
      actions.append(button('导出诊断', () => downloadJson(view.diagnostic, `chrome-task-${taskId}.json`)));
      view.screenshot = button('查看故障截图', async () => {
        const artifact = view.diagnostic.task.screenshotArtifactId;
        if (!artifact) return;
        const url = await request(`/results/${artifact}`, 'GET', undefined, true);
        if (detailView !== view || !$('#task-detail').open) { URL.revokeObjectURL(url); return; }
        const image = el('img'); image.alt = '此任务停止后的页面截图';
        image.onload = image.onerror = () => URL.revokeObjectURL(url); image.src = url;
        attachments.replaceChildren(image);
      });
      view.recoveryButton = button('核查后编辑剩余步骤', async () => {
        if (detailView !== view || detailState?.profileId !== profileId || detailState?.taskId !== taskId || !$('#task-detail').open) return;
        const generation = detailRequest;
        detailState.editing = true;
        try { await recoveryEditor(profileId, view.diagnostic.task, root); }
        catch (error) {
          if (detailView !== view || detailRequest !== generation) return;
          detailState.editing = false;
          throw error;
        }
      });
      root.replaceChildren(title, progress, actions, advice, steps, view.screenshot, attachments, view.recoveryButton);
      detailView = view;
    }
    const view = detailView;
    view.diagnostic = diagnostic; view.title.textContent = task.name;
    view.progress.textContent = `${stateLabels[task.status]} · ${task.nextStep} / ${task.steps.length} 步`;
    const executions=task.steps.reduce((total,step)=>total+(Number.isInteger(step.executions)?step.executions:0),0);
    if(executions)view.progress.textContent+=` · 累计执行 ${executions} 次（含循环与控制步骤）`;
    view.advice.replaceChildren();
    if (task.reason) view.advice.append(el('h3', diagnostic.advice.title), el('p', diagnostic.advice.next, 'muted'), el('code', task.reason));
    view.steps.replaceChildren(...task.steps.map(renderTaskStep));
    view.screenshot.hidden = !task.screenshotArtifactId;
    view.recoveryButton.hidden = !['failed','needs_review','interrupted','cancelled'].includes(task.status) || !task.steps.length;
    if (!$('#task-detail').open) { returnFocusOnClose($('#task-detail'), opener, () => detailEntry(profileId, taskId)); $('#task-detail').showModal(); }
  }
  async function recoveryEditor(profileId, task, root) {
    if (root.querySelector('.recovery-editor')) return;
    const generation = detailRequest, view = detailView;
    const current = () => generation === detailRequest && detailView === view
      && detailState?.profileId === profileId && detailState?.taskId === task.id
      && $('#task-detail').open && root.isConnected;
    const guardedAction = action => async () => {
      if (!current()) return;
      try { await action(); }
      catch (error) { if (current()) throw error; }
    };
    if (!current()) return;
    let draft;
    try { draft = await call('chrome_task_recovery', { profileId, taskId: task.id, fromStep: Math.min(task.nextStep, task.steps.length - 1) }); }
    catch (error) { if (!current()) return; throw error; }
    if (!current() || root.querySelector('.recovery-editor')) return;
    const area = el('div', undefined, 'recovery-editor'), start = choose([['','请选择起始步骤'], ...task.steps.map((step, index) => [String(index), `${index + 1}. ${stepName(step)} · ${step.state === 'succeeded' ? '已完成' : step.state === 'skipped' ? '已跳过' : step.state === 'unknown' ? '结果待核查' : '未确认完成'}`])], '');
    const checked = input(); checked.type = 'checkbox'; const acknowledgement = field('我已核对页面与已完成步骤', checked); acknowledgement.className = 'check';
    area.append(el('p', '这会载入新的编辑草稿。原任务不会重跑，未知操作需要逐条核查后解除保护。', 'muted'), field('从哪一步重新编辑', start), acknowledgement);
    for (const operation of draft.operationsToCheck) {
      let released = false;
      const release = button(`解除已核查操作 ${operation.id.slice(0, 8)} 的保护`, guardedAction(async () => {
        if (!checked.checked) throw new Error('请先核查页面并勾选确认。');
        await call('chrome_recover_operation', { operationId: operation.id, acknowledged: true });
        if (!current()) return;
        // 成功提示写进对话框：此时全局状态栏在 modal 之外（inert，且被遮罩压暗），读屏和用户都看不到。已解除的操作不再提供可点的按钮。
        released = true; release.textContent = `已解除操作 ${operation.id.slice(0, 8)} 的保护`;
        const feedback = $('#task-detail [data-feedback]'); feedback.dataset.error = 'false'; feedback.textContent = '已解除这条操作的保护；尚未执行任何剩余步骤。';
      }), 'secondary', () => current() && !released);
      area.append(release);
    }
    const parameters = el('div', undefined, 'parameter-fields');
    for (const item of draft.source?.parameters || []) { const control = input(item.description || item.name); control.dataset.parameter = item.name; parameters.append(field(item.name, control)); } area.append(parameters);
    area.append(button('载入待编辑草稿', guardedAction(async () => {
      if (!checked.checked || start.value === '') throw new Error('先核查页面并明确选择起始步骤。');
      const fromStep = Number(start.value); let plan;
      if (draft.source) {
        const values = Object.fromEntries([...parameters.querySelectorAll('input')].map(control => [control.dataset.parameter, control.value]));
        const expanded = await call('chrome_workflow_preview', { profileId, workflowId: draft.source.workflowId, revision: draft.source.revision, parameters: values });
        if (!current()) return;
        plan = { ...expanded.plan, steps: expanded.plan.steps.slice(fromStep) };
      } else {
        const skeleton = step => ({ operation: step.operation, args: step.operation === 'page.action' ? { action: step.action || 'click', selector: '', ...(['fill','type'].includes(step.action) ? { text: '' } : step.action === 'press' ? { key: '' } : {}) } : step.operation === 'page.wait' ? { selector: '', state: 'visible' } : step.operation === 'page.navigate' ? { url: '' } : step.operation === 'page.upload' ? { selector: '', paths: [] } : step.operation === 'page.evaluate' ? { expression: '' } : step.operation === 'page.dialog' ? { accept: false } : {} });
        plan = { name: task.name, visible: task.visible, captureOnFailure: true, steps: task.steps.slice(fromStep).map(skeleton) };
      }
      if (!current()) return;
      plan.name = `${task.name} · 剩余步骤`.slice(0, 100);
      if (!editor.load(plan, null, profileId)) return;
      $('#task-profile').value = profileId;
      await refreshTabs();
      if (!current()) return;
      const option = el('option', '请选择核查后的目标标签页'); option.value = ''; $('#task-tab').prepend(option); $('#task-tab').value = '';
      $('#task-detail').close(); detailState = undefined; location.hash = 'tasks'; status.textContent = '草稿已载入，请核对目标、补齐内容后再提交。';
    }), 'secondary', current));
    if (current()) root.append(area);
  }
  function describeStep(step, index) {
    const args = step.args||{}, target = args.selector || args.locator?.name || args.locator?.label || args.locator?.text || '';
    const detail=step.operation==='flow.repeat'?`最多 ${args.count} 次${args.while?'，满足条件时继续':''}`:step.operation==='flow.if'?`${args.variable} ${args.operator}${args.value!==undefined?' '+JSON.stringify(args.value):''}`:step.operation==='flow.set'?args.name||'':'';
    const bindings=step.bindings?Object.keys(step.bindings).length:0;
    return `${index + 1}. ${stepName(step)} ${detail||target}${args.text !== undefined ? ` → ${args.text}` : ''}${args.url ? ` → ${args.url}` : ''}${args.textContains ? `包含「${args.textContains}」` : ''}${args.urlContains ? `网址包含「${args.urlContains}」` : ''}${step.saveAs?` · 保存结果为 ${step.saveAs}`:''}${bindings?` · ${bindings} 个结果绑定`:''}`;
  }
  async function refreshWorkflows() {
    const sequence = ++workflowRequest, profileId = $('#task-profile').value, root = $('#workflow-list'); root.className = ''; root.replaceChildren();
    if (!profileId) { root.append(el('p','选择浏览器后查看属于它的流程。','empty')); $('#workflow-page-label').textContent=''; $('#workflow-prev').disabled=$('#workflow-next').disabled=true; return; }
    const archived = $('#workflow-view').value === 'archived';
    const data = await call('chrome_workflows', { profileId, offset: workflowOffset, limit: 10, archived, summary: true });
    if (sequence !== workflowRequest || profileId !== $('#task-profile').value) return;
    loadedWorkflowProfile = profileId;
    if (!data.items.length && workflowOffset > 0) { workflowOffset = Math.max(0, workflowOffset - 10); return refreshWorkflows(); }
    workflowNext = data.nextOffset; $('#workflow-page-label').textContent = `${data.total} 项 · 第 ${Math.floor(workflowOffset / 10) + 1} 页`; $('#workflow-prev').disabled = workflowOffset === 0; $('#workflow-next').disabled = workflowNext === null;
    if (!data.items.length) { root.append(el('p', '保存一个成功流程，下次只填参数即可复用。', 'empty')); return; }
    for (const flow of data.items) {
      const card = el('article', undefined, 'workflow'), fields = el('div', undefined, 'parameter-fields'), preview = el('div', undefined, 'plan-preview'), actions = el('div', undefined, 'row-actions'); preview.hidden = true;
      let prepared, pendingRun, parameterRevision = 0;
      card.dataset.workflowId = flow.id;
      card.append(el('h3', flow.definition.name), el('small', `${flow.stepCount} 步 · 版本 ${flow.version} · ${archived ? '已归档' : '当前账号'}`));
      if (flow.definition.description) card.append(el('p', flow.definition.description, 'muted'));
      for (const parameter of flow.definition.parameters) { const control = input(parameter.description || parameter.name); control.dataset.parameter = parameter.name; fields.append(field(parameter.name, control)); }
      const execute = button('在选定标签页运行', async () => {
        if (!prepared) throw new Error('请先预览本次参数。');
        const target = currentTarget(); if (target.profileId !== profileId) throw new Error('账号已变化，请在当前账号重新选择流程。');
        const selected = prepared,requestRevision=parameterRevision; prepared = undefined;
        const payload={...target,workflowId:flow.id,revision:selected.revision,parameters:selected.parameters},key=JSON.stringify(payload);
        if(pendingRun?.key!==key)pendingRun={key,id:randomId()};
        try{await call('chrome_workflow_run',{...payload,submissionId:pendingRun.id});pendingRun=undefined;}
        catch(error){if(parameterRevision===requestRevision&&card.isConnected&&profileId===$('#task-profile').value)prepared=selected;throw error;}
        status.textContent = '流程已加入该账号的任务队列。'; await refreshTasks();
      }, 'secondary', () => !!prepared && profileId === $('#task-profile').value); execute.disabled = true;
      fields.addEventListener('input', () => { parameterRevision++; prepared = undefined; execute.disabled = true; preview.hidden = true; });
      actions.append(button('预览本次步骤', async () => {
        const requestedRevision = parameterRevision;
        const parameters = Object.fromEntries([...fields.querySelectorAll('input')].map(control => [control.dataset.parameter, control.value]));
        const data = await call('chrome_workflow_preview', { profileId, workflowId: flow.id, parameters });
        if (!card.isConnected || profileId !== $('#task-profile').value || requestedRevision !== parameterRevision) return;
        prepared = { revision: data.revision, parameters }; preview.replaceChildren(...data.plan.steps.map((step, index) => el('div', describeStep(step, index)))); preview.hidden = false; execute.disabled = false;
      }), execute);
      if (!archived) card.append(fields, actions, preview);
      const management = el('div', undefined, 'row-actions workflow-management');
      if (!archived) management.append(button('编辑', async () => { const full = await call('chrome_workflow_get', { profileId, workflowId: flow.id }); if (profileId !== $('#task-profile').value) return; if (editor.load(full.definition, full)) location.hash = 'tasks'; }));
      const history = button('版本历史', opener => workflowHistory(profileId, flow.id, opener)); history.dataset.history = '';
      management.append(history, button('导出定义', async () => { const full = await call('chrome_workflow_get', { profileId, workflowId: flow.id }); downloadJson(full.definition, `workflow-${flow.id}.json`); }));
      management.append(button(archived ? '恢复使用' : '归档', async () => { await call('chrome_workflow_archive', { profileId, workflowId: flow.id, expectedRevision: flow.revision, archived: !archived }); await refreshWorkflows(); }));
      if (archived) management.append(button('永久删除', async () => { if (!confirm(`永久删除「${flow.definition.name}」及其全部版本？此操作不能恢复。`)) return; await call('chrome_workflow_remove', { profileId, workflowId: flow.id, expectedRevision: flow.revision, confirmed: true }); await refreshWorkflows(); }, 'danger'));
      const copy = el('details'), name = input('副本名称'), destination = choose(getProfiles().map(profile => [profile.id, profileLabel(profile,getProfiles())]), profileId); name.value = `${flow.definition.name} · 副本`.slice(0, 100); name.maxLength = 100;
      const controls = el('div', undefined, 'copy-fields'); controls.append(field('复制到账号', destination), field('新名称', name), button('创建副本', async () => { await call('chrome_workflow_copy', { profileId, workflowId: flow.id, toProfileId: destination.value, name: name.value }); status.textContent = '副本已保存到明确选择的账号，尚未运行。'; await refreshWorkflows(); }));
      copy.append(el('summary', '复制流程'), controls); card.append(management, copy); root.append(card);
    }
  }
  async function workflowHistory(profileId, workflowId, opener) {
    const data = await call('chrome_workflow_history', { profileId, workflowId }), root = $('#workflow-history-body'); root.replaceChildren();
    root.append(el('h3', data.current.definition.name), el('p', '恢复会创建新版本；已提交任务仍使用提交时的计划。', 'muted'));
    for (const version of data.versions) {
      const row = el('div', undefined, 'history-row'), preview = el('pre'); preview.hidden = true;
      row.append(el('p', `版本 ${version.version} · ${new Date(version.updatedAt || version.createdAt).toLocaleString()}${version.revision === data.current.revision ? ' · 当前' : ''}`));
      const actions = el('div', undefined, 'row-actions'); actions.append(button('查看定义', async () => { const item = await call('chrome_workflow_get', { profileId, workflowId, revision: version.revision }); preview.textContent = JSON.stringify(item.definition, null, 2); preview.hidden = false; }));
      if (!data.current.archivedAt && version.revision !== data.current.revision) actions.append(button('恢复为新版本', async () => { if (!confirm(`将版本 ${version.version} 恢复为新版本？当前版本仍保留。`)) return; await call('chrome_workflow_restore', { profileId, workflowId, revision: version.revision, expectedRevision: data.current.revision }); await refreshWorkflows(); await workflowHistory(profileId, workflowId, opener); }));
      row.append(actions, preview); root.append(row);
    }
    if (!$('#workflow-history').open) { returnFocusOnClose($('#workflow-history'), opener, () => historyEntry(workflowId)); $('#workflow-history').showModal(); }
  }
  async function setupHistory() {
    const data = await request('/setup/history'), root = $('#setup-history'); root.replaceChildren();
    historyReady = true;
    if (!data.changes.length) root.append(el('p', '还没有接入记录。', 'empty'));
    for (const change of data.changes.slice(0, 10)) {
      const row = el('div', undefined, 'setup-history-row'); row.append(el('span', `${change.client}${change.createdAt ? ` · ${new Date(change.createdAt).toLocaleString()}` : ''}`));
      if (change.canRestore) row.append(button('恢复接入前配置', async () => {
        await request('/setup/restore', 'POST', { changeId: change.changeId });
        status.textContent = '已恢复接入前的配置，备份仍保留。';
        invalidateClients();
        await detectClients();
      }));
      else row.append(el('small', change.issue || '已恢复或配置另有变动')); root.append(row);
    }
  }
  async function detectClients(preserveDrafts = false) {
    if (detecting) return detecting;
    const pending=loadClients(clientGeneration, preserveDrafts);detecting=pending;
    try { await pending; } finally { if(detecting===pending)detecting = undefined; }
  }
  function invalidateClients() {
    clientGeneration++;
    clientsReady = false; historyReady = false; detecting = undefined;
    onClients(undefined);
  }
  async function loadClients(generation, preserveDrafts = false) {
    const root = $('#setup-clients');
    try {
      const data = await request('/setup/clients');if(generation!==clientGeneration)return;
      const drafts = new Map();
      if (preserveDrafts) for (const card of root.querySelectorAll('[data-client]')) {
        drafts.set(card.dataset.client, {
          scope: card.querySelector('.setup-scope')?.value,
          target: card.querySelector('.setup-target')?.value,
          format: card.querySelector('.setup-format')?.value,
          trust: card.querySelector('.setup-trust')?.value,
          expanded: card.querySelector('.setup-advanced')?.open,
        });
      }
      root.replaceChildren(); onClients(data.clients); clientsReady = true;
      for (const client of data.clients) {
        const card = el('div', undefined, 'setup-card'), output = el('div', undefined, 'setup-result'), summary = el('small');
        card.dataset.client = client.client;
        card.append(el('h3', client.label));
        const connectionLabels={configured:'已配置此安装',not_configured:'尚未接入',other_config:'已有其他连接',disabled:'已停用',invalid:'配置需要检查'};
        const badge=el('span',connectionLabels[client.connection]||'等待检查',`setup-badge${['invalid','other_config','disabled'].includes(client.connection)?' warning':''}`);card.append(badge);
        if (client.error) card.append(el('p', client.error, 'state unknown'));
        else {
          summary.textContent = client.note || (client.configExists ? '已有配置，接入前会保留备份。' : '确认接入后自动创建配置。');
          if (client.connection !== 'not_configured') card.append(summary);
        }
          const ownApprovals = client.ownApprovals ?? client.client === 'pi', userOnly = client.userOnly ?? client.client === 'agy';
          const scope = choose([['default','默认用户配置'],...userOnly ? [] : [['project','指定项目目录']],['custom','指定配置文件']], 'default'), target = input('本机绝对路径'), format = choose([['v2','OpenCode 2'],['v1','OpenCode 1']], client.format||'v2');
          scope.className = 'setup-scope'; target.className = 'setup-target'; format.className = 'setup-format';
          const trust = choose([['service','一次信任此浏览器 MCP（推荐）'],['preserve','保留现有审批'],['prompt','撤销一次信任，恢复审批']], 'service'); trust.className = 'setup-trust';
          const choices = el('div', undefined, 'setup-choices'), targetField = field('项目目录或配置文件路径', target); targetField.hidden = true;
          let selectionRevision = 0;
          const selectionKey = () => JSON.stringify([scope.value, target.value, format.value, trust.value]);
          let lastSelection = selectionKey();
          const selectionChanged = () => { const next = selectionKey(); if (next === lastSelection) return; lastSelection = next; selectionRevision++; output.replaceChildren(); };
          scope.onchange = () => { targetField.hidden = scope.value === 'default'; };
          choices.addEventListener('input', selectionChanged);
          choices.addEventListener('change', selectionChanged);
          choices.append(field('配置位置', scope), targetField); if (client.client === 'opencode') choices.append(field('配置格式', format));
          // pi 默认不逐次确认工具调用，SaltedFish 不改它的审批，没有选项。
          if (client.client === 'pi') choices.append(el('small', 'pi 默认不逐次确认工具调用，接入后就能在获准使用的 Chrome 配置里用已登录的身份操作网站。要立即阻止访问，请在“客户端授权”里撤销。点击“预览接入”查看完整说明。'));
          else if (ownApprovals) choices.append(el('small', clientReloadHint(client.client, client.label) + '。SaltedFish 不改应用内的审批设置。'));
          else choices.append(field('浏览器工具授权', trust));
          if (ownApprovals) trust.value = 'preserve';
          // 口径与“预览接入”里的一次信任说明（src/client-setup.ts）一致；这里只说最要紧的几句，完整边界请看预览。
          if (!ownApprovals) choices.append(el('small', '一次信任后，该 Agent 在它获准使用的 Chrome 配置里的操作（包括后续新增的工具）不再逐次确认；向导创建的凭据默认覆盖全部已配对配置。撤销只阻止之后的调用，已发出的操作不会撤回；要立即阻止访问，请在“客户端授权”里撤销。点击“预览接入”查看完整说明。'));
          format.onchange = () => { if (format.value === 'v1') trust.value = 'preserve'; trust.disabled = format.value === 'v1'; selectionChanged(); };
          if(format.value==='v1'){trust.value='preserve';trust.disabled=true;}
          const advanced=el('details',undefined,'setup-advanced');advanced.append(el('summary','配置位置与授权选项'),el('p',client.target||'','path'),el('p',`${client.cliDetected?'已在标准位置检测到客户端':'未在标准位置检测到客户端；请确认已安装对应 Agent'}。${client.scope||''}`,'muted'),choices);card.append(advanced);
          const draft = drafts.get(client.client);
          if (draft) {
            scope.value = draft.scope || 'default'; target.value = draft.target || '';
            if (draft.format) format.value = draft.format;
            if (draft.trust) trust.value = draft.trust;
            targetField.hidden = scope.value === 'default'; advanced.open = !!draft.expanded;
            if (client.client === 'opencode') { trust.disabled = format.value === 'v1'; if (trust.disabled) trust.value = 'preserve'; }
            lastSelection = selectionKey();
          }
          const selection = () => scope.value === 'project' ? { projectDirectory: target.value.trim() } : scope.value === 'custom' ? { configPath: target.value.trim() } : {};
          if(client.connection==='configured')card.append(button('检查连接',async()=>{
            const revision=selectionRevision,result=await request('/setup/check','POST',{client:client.client,...selection(),...(client.client==='opencode'?{format:format.value}:{})});
            if(revision!==selectionRevision||!card.isConnected)return;
            output.replaceChildren(el('p','连接检查通过','success-note'),el('p',`识别到 ${result.verification.profiles} 个浏览器配置。请${clientReloadHint(client.client, client.label)}，再${trialHint()}。`),el('small',`检查时间 ${new Date(result.checkedAt).toLocaleTimeString()} · 不代表 Agent 当前正在运行`));
          },'setup-check'));
          const previewButton=button('预览接入', async () => {
            const requestedRevision = selectionRevision;
            if (scope.value !== 'default' && !target.value.trim()) throw new Error('请填写明确的本机绝对路径。');
            const plan = await request('/setup/preview', 'POST', { client: client.client, ...selection(), trust: trust.value, ...(client.client === 'opencode' ? { format: format.value } : {}) });
            if (!card.isConnected || requestedRevision !== selectionRevision) return;
            output.replaceChildren(el('p', plan.target, 'path'), el('p', `${{'migrate-server':'把旧条目 feng-chrome 改名为','replace-server':'更新现有'}[plan.mode]||'添加'} saltedfish 条目。${plan.description}`));
            for (const note of plan.notices) output.append(el('p', note, 'muted'));
            output.append(button(plan.trust === 'service' ? '信任并接入' : plan.trust === 'prompt' ? '撤销信任并保存' : '备份并接入', async () => {
              if (requestedRevision !== selectionRevision) throw new Error('配置位置已变化，请重新预览。');
              choices.querySelectorAll('input,select').forEach(control => { control.disabled = true; });
              try {
                const result = await request('/setup/apply', 'POST', { planId: plan.planId });
                summary.textContent = result.trust === 'service' ? '已接入 · 已信任此浏览器 MCP' : result.trust === 'prompt' ? '已接入 · 后续工具由客户端审批' : '已接入 · 保留原审批规则';
                badge.textContent='接入已保存';badge.classList.remove('warning');
                const details=el('details');details.append(el('summary','查看连接检查详情'),el('p',result.target,'path'),el('p',`已验证 ${result.verification.tools} 个工具，${result.verification.profiles} 个配置。${result.note}`));
                output.replaceChildren(el('p','接入已保存，连接检查通过。','success-note'),el('p',`下一步：${clientReloadHint(client.client, client.label)}，然后${trialHint()}。`),details); await setupHistory();
                clientGeneration++;
                const generation=clientGeneration,current=await request('/setup/clients');
                if(generation===clientGeneration){onClients(current.clients);clientsReady=true;}
              } finally { choices.querySelectorAll('input,select').forEach(control => { control.disabled = false; }); if (client.client === 'opencode' && format.value === 'v1') trust.disabled = true; }
            }));
          },client.connection==='configured'?'secondary setup-preview':'setup-preview');card.append(previewButton);
        card.append(output); root.append(card);
      }
      if(isActive()==='setup')await setupHistory();
    } catch (error) { if(generation!==clientGeneration)return;root.replaceChildren(el('p', `暂时无法检测 Agent 配置。${error.message}`, 'muted')); throw error; }
  }
  $('#add-step').onclick = addStep; addStep(); editor.renderParameters();
  $('#task-tabs-refresh').onclick = event => void run(event.currentTarget, refreshTabs);
  // 换账号时立刻丢弃上一个账号的任务行和流程卡片：它们的按钮闭包绑定着旧 profileId，不能在新账号的页面上继续可点。
  function clearProfileLists() {
    workflowRequest++; loadedWorkflowProfile = undefined; taskNext = workflowNext = null;
    for (const [list, text] of [['#task-list', '正在读取任务…'], ['#workflow-list', '正在读取流程…']]) { $(list).className = ''; $(list).replaceChildren(el('p', text, 'empty')); }
    for (const label of ['#task-page-label', '#workflow-page-label']) $(label).textContent = '';
    $('#task-prev').disabled = $('#task-next').disabled = $('#workflow-prev').disabled = $('#workflow-next').disabled = true;
  }
  $('#task-profile').onchange = () => void run($('#task-tabs-refresh'), async () => {
    taskOffset = workflowOffset = 0; clearProfileLists();
    // 三项读取互不依赖：标签页读取失败（超时、浏览器刚断开）不能让新账号的任务和流程一直空着。
    let failure; for (const step of [refreshTabs, () => refreshTasks(true), refreshWorkflows]) { try { await step(); } catch (error) { failure ??= error; } }
    if (failure) throw failure;
  });
  $('#task-form').onsubmit = event => { event.preventDefault(); void run(event.currentTarget.querySelector('[type=submit]'), async () => {
    const plan = collectPlan(); if (JSON.stringify(plan).includes('{{')) throw new Error('包含参数的任务请先保存为流程，再填入本次参数预览。');
    const payload={...currentTarget(),...plan},key=JSON.stringify(payload);if(pendingTask?.key!==key)pendingTask={key,id:randomId()};
    await call('chrome_task_submit', { ...payload,submissionId:pendingTask.id });pendingTask=undefined; editor.markSubmitted(); status.textContent = '任务已加入队列，可在下方查看、暂停或取消。'; await refreshTasks();
  }); };
  $('#save-workflow').onclick = event => void run(event.currentTarget, async () => { const editing = editor.editing; const flow = await call('chrome_workflow_save', { profileId: $('#task-profile').value, definition: editor.definition(), ...(editing ? { workflowId: editing.id, expectedRevision: editing.revision } : {}) }); editor.saved(flow); status.textContent = `流程版本 ${flow.version} 已保存。`; $('#workflow-view').value = 'active'; await refreshWorkflows(); });
  $('#load-workflows').onclick = event => void run(event.currentTarget, refreshWorkflows);
  $('#workflow-view').onchange = () => void run($('#load-workflows'), async () => { workflowOffset = 0; await refreshWorkflows(); });
  $('#workflow-prev').onclick = () => { workflowOffset = Math.max(0, workflowOffset - 10); void refreshWorkflows().catch(error => { status.textContent = error.message; }); };
  $('#workflow-next').onclick = () => { if (workflowNext !== null) { workflowOffset = workflowNext; void refreshWorkflows().catch(error => { status.textContent = error.message; }); } };
  $('#task-filter').onchange = event => { taskOffset = 0; void run(event.currentTarget, refreshTasks); };
  let searchTimer; $('#task-search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { taskOffset = 0; void refreshTasks().catch(error=>{if(error.code!=='STALE_SESSION'){status.dataset.error='true';status.textContent=error.message;}}); }, 250); };
  $('#task-prev').onclick = event => { if (!updating) { taskOffset = Math.max(0, taskOffset - 10); void run(event.currentTarget, refreshTasks, ()=>taskOffset>0); } };
  $('#task-next').onclick = event => { if (!updating && taskNext !== null) { taskOffset = taskNext; void run(event.currentTarget, refreshTasks, ()=>taskNext!==null); } };
  $('#detect-clients').onclick = event => void run(event.currentTarget, ()=>detectClients(true));
  $('#close-task-detail').onclick = () => { $('#task-detail').close(); detailState = undefined; detailRequest++; };
  // 关闭时清掉对话框里的反馈：否则上一次的错误或成功提示会在下次打开时残留。
  $('#task-detail').addEventListener('close', () => {
    if ($('#task-detail').open) return; // Chrome 在下一帧才发 close，迟到时新对话框已经开着。
    detailState = detailView = undefined; detailLoading = false; detailRequest++;
    $('#task-detail-body .recovery-editor')?.remove();
    $('#task-detail [data-feedback]').textContent = '';
  });
  $('#workflow-history').addEventListener('close', () => { $('#workflow-history [data-feedback]').textContent = ''; });
  $('#close-workflow-history').onclick = () => $('#workflow-history').close();
  setInterval(() => { if (!document.hidden && ['tasks','workflows'].includes(isActive())) { void refreshTasks().catch(error => { $('#task-live').textContent = `暂未更新：${error.message}`; }); if ($('#task-detail').open && detailState && !detailState.editing) void showTask(detailState.profileId, detailState.taskId, true).catch(() => {}); } }, 2000);
  return {
    reset(){invalidateClients();profilesReady=false;tabRequest++;detailRequest++;workflowRequest++;detailState=detailView=undefined;detailLoading=false;clearTimeout(searchTimer);},
    async refreshProfiles() { const select = $('#task-profile'), previous = select.value; select.replaceChildren();const placeholder=el('option','选择浏览器');placeholder.value='';select.append(placeholder); for (const profile of getProfiles()) { const option = el('option', `${profileLabel(profile,getProfiles())}${profile.online ? '' : '（未连接）'}`); option.value = profile.id; select.append(option); } if ([...select.options].some(option => option.value === previous)) select.value = previous; if(['tasks','workflows'].includes(isActive())){await refreshTabs();await refreshTasks();if (!profilesReady || previous !== select.value) await refreshWorkflows();}profilesReady = true; },
    async activate(route){if(route==='setup'){if(!clientsReady)await detectClients();if(!historyReady)await setupHistory();return;}await refreshTabs();await refreshTasks();if(loadedWorkflowProfile!==$('#task-profile').value)await refreshWorkflows();},
    async ensureClients(force=false){if(force||!clientsReady)await detectClients(force&&clientsReady);},
    invalidateClients,
  };
}
