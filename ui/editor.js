export function createEditor({ el, status, profileId }) {
  const $ = selector => document.querySelector(selector);
  let editing = null, boundProfile, dirty = false, descriptions = new Map();
  const actions = [['fill','填写内容'],['click','点击'],['type','输入文字'],['hover','悬停'],['press','按键'],['navigate','打开网址'],['wait_visible','等待元素出现'],['wait_hidden','等待元素消失'],['wait_text','等待文字'],['wait_url','等待网址'],['popup','跟随新标签页'],['upload','上传文件'],['advanced','高级步骤']];
  function choose(values, selected) { const input = el('select'); for (const [value, label] of values) { const option = el('option', label); option.value = value; input.append(option); } input.value = selected; return input; }
  function field(label, input) { const node = el('label', label); node.append(input); return node; }
  function targetFrom(args) {
    if (typeof args.selector === 'string') return ['css',args.selector];
    const locator = args.locator;
    if (!locator || locator.exact === false || Object.keys(locator).some(key => !['role','name','label','exact'].includes(key))) return undefined;
    if (locator.label && !locator.role && !locator.name) return ['label',locator.label];
    if (['textbox','button','link'].includes(locator.role) && locator.name && !locator.label) return [locator.role,locator.name];
    return undefined;
  }
  function simple(step) {
    if (!step) return { action: 'fill', strategy: 'textbox', target: '', value: '' };
    // 简单控件只能往返 operation/args；结果变量、绑定、后置条件及未来字段必须保留在完整 JSON 中。
    if(Object.keys(step).some(key=>!['operation','args'].includes(key)))return {action:'advanced',value:'',original:step};
    const args = step.args || {}, target = targetFrom(args);
    const only = allowed => Object.keys(args).every(key => allowed.includes(key));
    if (step.operation === 'page.action' && ['fill','click','type','hover','press'].includes(args.action) && target && (args.autoWait === undefined || args.autoWait === true) && only(['action','selector','locator','text','key','autoWait'])) return { action: args.action, strategy: target[0], target: target[1], value: args.text ?? args.key ?? '' };
    if (step.operation === 'page.navigate' && args.wait !== false && only(['url','wait'])) return { action: 'navigate', value: args.url };
    if (step.operation === 'tabs.wait' && only(['urlContains'])) return { action: 'popup', value: args.urlContains || '' };
    if (step.operation === 'page.upload' && target && Array.isArray(args.paths) && only(['selector','locator','paths'])) return { action: 'upload', strategy: target[0], target: target[1], value: args.paths.join('\n') };
    if (step.operation === 'page.wait') {
      if (target && ['visible','hidden',undefined].includes(args.state) && only(['selector','locator','state'])) return { action: args.state === 'hidden' ? 'wait_hidden' : 'wait_visible', strategy: target[0], target: target[1], value: '' };
      if (args.textContains && args.state !== 'hidden' && only(['textContains','state'])) return { action: 'wait_text', value: args.textContains };
      if (args.urlContains && args.state !== 'hidden' && only(['urlContains','state'])) return { action: 'wait_url', value: args.urlContains };
    }
    return { action: 'advanced', value: '', original: step };
  }
  function renumber() {
    const rows = [...$('#task-steps').children]; rows.forEach((row, index) => {
      row.querySelector('.number').textContent = String(index + 1).padStart(2, '0');
      row.querySelector('[data-move=up]').disabled = index === 0; row.querySelector('[data-move=down]').disabled = index === rows.length - 1;
    });
  }
  function readStep(row, allowIncomplete = false) {
    const action = row.querySelector('.step-action').value;
    if (action === 'advanced') { try { return JSON.parse(row.querySelector('.step-json').value); } catch { throw new Error('高级步骤不是有效 JSON，请检查后再保存。'); } }
    const strategy = row.querySelector('.step-strategy').value, target = row.querySelector('.step-target').value.trim(), value = row.querySelector('.step-value').value;
    const located = strategy === 'css' ? { selector: target } : { locator: strategy === 'label' ? { label: target } : { role: strategy, name: target } };
    if (!allowIncomplete && ['fill','click','type','hover','press','wait_visible','wait_hidden','upload'].includes(action) && !target) throw new Error('请填写每一步的目标元素。');
    if (action === 'navigate') return { operation: 'page.navigate', args: { url: value } };
    if (action === 'wait_text') return { operation: 'page.wait', args: { textContains: value } };
    if (action === 'wait_url') return { operation: 'page.wait', args: { urlContains: value } };
    if (['wait_visible','wait_hidden'].includes(action)) return { operation: 'page.wait', args: { ...located, state: action === 'wait_hidden' ? 'hidden' : 'visible' } };
    if (action === 'popup') return { operation: 'tabs.wait', args: value ? { urlContains: value } : {} };
    if (action === 'upload') return { operation: 'page.upload', args: { ...located, paths: value.split(/\r?\n/).filter(Boolean) } };
    return { operation: 'page.action', args: { action, ...located, ...(['fill','type'].includes(action) ? { text: value } : action === 'press' ? { key: value } : {}) } };
  }
  function parameters() {
    const text = [...$('#task-steps').children].map(row => row.querySelector('.step-action').value === 'advanced' ? row.querySelector('.step-json').value : [...row.querySelectorAll('.step-target,.step-value')].filter(input => !input.disabled).map(input => input.value).join('\n')).join('\n');
    const names = [...new Set([...text.matchAll(/\{\{([\p{L}_][\p{L}\p{N}_]*)\}\}/gu)].map(match => match[1]))];
    for (const input of $('#parameter-info').querySelectorAll('input')) descriptions.set(input.dataset.parameter, input.value);
    return names.map(name => ({ name, description: descriptions.get(name) || '' }));
  }
  function renderParameters() {
    const values = parameters(), root = $('#parameter-info'); root.replaceChildren();
    for (const parameter of values) { const input = el('input'); input.dataset.parameter = parameter.name; input.value = parameter.description; input.maxLength = 200; input.placeholder = '给使用者的填写提示（可选）'; root.append(field(parameter.name, input)); }
    if (!values.length) root.append(el('p', '步骤中写入 {{参数名}} 后，可在这里补充填写提示。', 'muted'));
  }
  function addStep(step) {
    const value = simple(step), row = el('div', undefined, 'step-editor');
    const action = choose(actions, value.action); action.className = 'step-action';
    const strategy = choose([['textbox','输入框名称'],['button','按钮名称'],['link','链接名称'],['label','字段标签'],['css','CSS 选择器']], value.strategy || 'textbox'); strategy.className = 'step-strategy';
    const target = el('input'); target.className = 'step-target'; target.value = value.target || ''; target.placeholder = '例如：客户名称';
    const content = el('textarea'); content.rows = 1; content.className = 'step-value'; content.value = value.value || ''; content.placeholder = '内容、网址，或 {{参数}}；多文件每行一个';
    const advanced = el('textarea'); advanced.rows = 6; advanced.className = 'step-json'; advanced.value = JSON.stringify(value.original || step || { operation: 'page.evaluate', args: { expression: '' } }, null, 2);
    const locateLabel = field('定位方式', strategy), targetLabel = field('目标', target), contentLabel = field('内容 / 网址 / 文件路径', content), advancedLabel = field('高级步骤（完整保留条件、循环、结果变量与 iframe 参数）', advanced); advancedLabel.className = 'advanced-step';
    function mode() { const complex = action.value === 'advanced'; locateLabel.hidden = targetLabel.hidden = contentLabel.hidden = complex; advancedLabel.hidden = !complex; target.disabled = ['navigate','wait_text','wait_url','popup'].includes(action.value); content.disabled = ['click','hover','wait_visible','wait_hidden'].includes(action.value); }
    let previousAction = action.value;
    action.onchange = () => {
      const selected = action.value;
      if (selected === 'advanced' && previousAction !== 'advanced') { action.value = previousAction; advanced.value = JSON.stringify(readStep(row, true), null, 2); action.value = selected; }
      if (previousAction === 'advanced' && selected !== 'advanced') {
        let value; try { value = simple(JSON.parse(advanced.value)); } catch { action.value = 'advanced'; status.textContent = '高级步骤 JSON 无效，请修正后再切换编辑方式。'; return; }
        if (value.action === selected) { strategy.value = value.strategy || 'textbox'; target.value = value.target || ''; content.value = value.value || ''; }
        else if (!confirm('切换将重新编辑这个动作，高级字段可能无法保留。确定继续？')) { action.value = 'advanced'; return; }
      }
      if (previousAction !== 'advanced' && (selected === 'click' || selected === 'hover')) strategy.value = 'button';
      previousAction = selected; mode(); dirty = true; renderParameters();
    };
    const controls = el('div', undefined, 'step-controls');
    for (const [key, label, title] of [['up','↑','上移步骤'],['down','↓','下移步骤'],['remove','×','移除此步骤']]) {
      const control = el('button', label, 'secondary'); control.type = 'button'; control.dataset.move = key; control.setAttribute('aria-label', title);
      control.onclick = () => { if (key === 'remove') row.remove(); else if (key === 'up' && row.previousElementSibling) row.previousElementSibling.before(row); else if (key === 'down' && row.nextElementSibling) row.nextElementSibling.after(row); dirty = true; renumber(); renderParameters(); }; controls.append(control);
    }
    row.append(el('span', '', 'number'), field('动作', action), locateLabel, targetLabel, contentLabel, controls, advancedLabel); $('#task-steps').append(row); mode(); renumber();
    let timer; row.addEventListener('input', () => { dirty = true; clearTimeout(timer); timer = setTimeout(renderParameters, 250); });
  }
  function plan() {
    if (boundProfile && boundProfile !== profileId()) throw new Error('此草稿属于另一个账号，请切回原账号，或明确复制流程后再执行。');
    const maxExecutedSteps=Number(executionLimit.value);
    if(!Number.isInteger(maxExecutedSteps)||maxExecutedSteps<1||maxExecutedSteps>10000)throw new Error('总步骤执行上限必须是 1 到 10000 的整数（包含循环与控制步骤）。');
    return { name: $('#task-name').value.trim(), steps: [...$('#task-steps').children].map(row => readStep(row)), visible: $('#task-visible').checked, captureOnFailure: $('#task-capture').checked, stepTimeoutMs: Math.round(Number($('#task-timeout').value) * 1000), maxExecutedSteps };
  }
  function load(value, context = null, sourceProfile = context?.profileId) {
    if (dirty && !confirm('当前编辑内容尚未保存，确定载入另一份流程或草稿？')) return false;
    editing = context; boundProfile = sourceProfile; descriptions = new Map((value.parameters || []).map(item => [item.name, item.description]));
    $('#parameter-info').replaceChildren(); $('#task-steps').replaceChildren();
    $('#task-name').value = value.name; $('#workflow-description').value = value.description || '';
    $('#task-visible').checked = value.visible ?? false; $('#task-capture').checked = value.captureOnFailure ?? true; $('#task-timeout').value = String((value.stepTimeoutMs || 30000) / 1000);
    executionLimit.value=String(value.maxExecutedSteps??1000);
    value.steps.forEach(addStep); renderParameters(); dirty = false;
    $('#editing-flow').hidden = !editing; $('#editing-flow').textContent = editing ? `正在编辑版本 ${editing.version} · 保存后创建新版本` : '';
    $('#save-workflow').textContent = editing ? '保存新版本' : '保存为常用流程'; $('#task-composer').open = true; return true;
  }
  const executionLimit=el('input');executionLimit.id='task-max-executed-steps';executionLimit.type='number';executionLimit.min='1';executionLimit.max='10000';executionLimit.step='1';executionLimit.value='1000';
  $('#task-form .task-options').append(field('总步骤执行上限（含循环）',executionLimit));
  $('#task-form').addEventListener('input', () => { dirty = true; });
  $('#new-task').onclick = () => { if (load({ name: '', steps: [undefined], visible: true, captureOnFailure: true })) status.textContent = '已开始新的任务草稿。'; };
  return { addStep, plan, load, renderParameters, get editing() { return editing; },
    definition() { if (editing && editing.profileId !== profileId()) throw new Error('此流程属于另一个账号，请先切回或明确复制到当前账号。'); return { ...plan(), description: $('#workflow-description').value, parameters: parameters() }; },
    saved(flow) { editing = flow; boundProfile = flow.profileId; dirty = false; $('#editing-flow').hidden = false; $('#editing-flow').textContent = `已保存版本 ${flow.version}`; $('#save-workflow').textContent = '保存新版本'; },
    markSubmitted() { dirty = false; },
  };
}
