import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, readUi, choose } from './fake-dom.js';
import { mountApp, createServer, uuid, buttonByText } from './fake-app.js';

const { createEditor } = await import(new URL('../ui/editor.js', import.meta.url).href);
const online = { id: uuid(1), label: '个人', online: true, version: 'test', capabilities: ['interaction-v5', 'pause-control'] };
const advancedSteps = [
  { operation: 'page.action', args: { action: 'fill', selector: '#name', text: '' }, saveAs: 'filled', bindings: { text: 'customer.name' } },
  { operation: 'page.wait', args: { selector: '#done', state: 'visible' }, saveAs: 'checked' },
  { operation: 'page.navigate', args: { action: 'back', wait: true } },
  { operation: 'page.upload', args: { selector: '#file', transferIds: [uuid(8)] } },
  { operation: 'page.screenshot', args: { fullPage: true }, saveAs: 'image' },
  { operation: 'page.inspect', args: { textLimit: 1000 }, saveAs: 'page' },
  { operation: 'page.cdp', args: { method: 'Page.getLayoutMetrics', params: {} }, saveAs: 'metrics' },
  { operation: 'network.start', args: {}, saveAs: 'capture' },
  { operation: 'network.wait', args: { urlContains: '/save', since: 0, waitFor: 'finished' }, saveAs: 'response', bindings: { since: 'capture.since' } },
  { operation: 'network.body', args: { requestId: '' }, bindings: { requestId: 'response.requestId' } },
  { operation: 'network.stop', args: {} },
  { operation: 'downloads.start', args: { url: 'https://example.test/report.csv' }, saveAs: 'download' },
  { operation: 'downloads.wait', args: { downloadId: 0 }, bindings: { downloadId: 'download.downloadId' } },
  { operation: 'flow.set', args: { name: 'allowed', value: true } },
  { operation: 'flow.if', args: { variable: 'allowed', operator: 'truthy' } },
  { operation: 'flow.repeat', args: { count: 3, while: { variable: 'allowed', operator: 'truthy' } } },
  { operation: 'page.action', args: { action: 'doubleClick', selector: '#edit' } },
  { operation: 'flow.end', args: {} },
  { operation: 'flow.else', args: {} },
  { operation: 'page.action', args: { action: 'setChecked', selector: '#agreed', checked: false } },
  { operation: 'flow.end', args: {} },
];
const plan = { name: '高级任务', steps: advancedSteps, visible: false, captureOnFailure: true, stepTimeoutMs: 15000, maxExecutedSteps: 77 };

function mountEditor(t: TestContext, confirm = () => false) {
  const dom = installDom(readUi('index.html'), { confirm }); t.after(() => dom.uninstall());
  const $ = (selector: string) => dom.doc.querySelector(selector)!;
  const el = (tag: string, text?: string, className?: string) => { const node = dom.doc.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const editor = createEditor({ el, status: $('#status'), profileId: () => online.id });
  return { $, editor, dom };
}

test('任务编辑器：高级步骤、结果绑定、变量和总执行上限无损载入并保存', t => {
  const h = mountEditor(t); assert.equal(h.editor.load(structuredClone(plan), null, online.id), true);
  assert.deepEqual(h.editor.plan(), plan);
  assert.equal(h.$('#task-max-executed-steps').value, '77');
  assert.equal(h.$('#task-steps').children.length, advancedSteps.length);
  assert.ok(h.$('#task-steps').querySelectorAll('.step-action').every(row => row.value === 'advanced'));
  assert.deepEqual(h.editor.definition(), { ...plan, description: '', parameters: [] });
});

test('任务编辑器：上移/下移步骤只改变顺序，不丢 saveAs/bindings 或扩展字段', t => {
  const h = mountEditor(t), source = { ...plan, steps: advancedSteps.slice(0, 3) };
  h.editor.load(structuredClone(source), null, online.id);
  h.$('#task-steps').children[1]!.querySelector('[data-move=up]')!.click();
  assert.deepEqual(h.editor.plan().steps, [source.steps[1], source.steps[0], source.steps[2]]);
  h.$('#task-steps').children[0]!.querySelector('[data-move=down]')!.click();
  assert.deepEqual(h.editor.plan(), source);
});

test('任务编辑器：带高级元数据的普通动作不能静默降为简单动作，拒绝切换时原 JSON 保留', t => {
  let prompts = 0; const h = mountEditor(t, () => { prompts++; return false; });
  const step = { operation: 'page.action', args: { action: 'fill', selector: '#name', text: 'Finn' }, saveAs: 'result', bindings: { text: 'input.name' }, extraFutureField: { retained: true } };
  h.editor.load({ ...plan, steps: [step] }, null, online.id);
  const action = h.$('#task-steps .step-action'); action.value = 'fill'; action.onchange();
  assert.equal(prompts, 1); assert.equal(action.value, 'advanced'); assert.deepEqual(h.editor.plan().steps, [step]);
});

test('任务编辑器：新草稿重置执行上限，非法上限不提交；转入文件不被当成本机路径', t => {
  const h = mountEditor(t); h.editor.load(structuredClone(plan), null, online.id);
  for (const value of ['', '0', '10001', '2.5']) { h.$('#task-max-executed-steps').value = value; assert.throws(() => h.editor.plan(), /1 到 10000/); }
  h.editor.load({ ...plan, maxExecutedSteps: 3, steps: [{ operation: 'page.upload', args: { selector: '#file', transferIds: [uuid(8)] } }] }, null, online.id);
  assert.equal(h.$('#task-steps .step-action').value, 'advanced'); assert.deepEqual(h.editor.plan().steps[0]!.args.transferIds, [uuid(8)]);
  h.$('#new-task').click(); assert.equal(h.$('#task-max-executed-steps').value, '1000');
});

test('管理页详情：新步骤均显示中文，跳过状态和循环累计次数明确可见', async t => {
  const server = createServer({ profiles: [online] });
  const task = { id: uuid(20), name: '条件流程', status: 'succeeded', tabId: 7, createdAt: '2026-10-27T00:00:00Z', updatedAt: 'now', nextStep: advancedSteps.length, totalSteps: advancedSteps.length,
    steps: advancedSteps.map((step, index) => ({ operation: step.operation, ...('action' in step.args ? { action: step.args.action } : {}), state: index === 19 ? 'skipped' : 'succeeded', executions: index === 19 ? 0 : index === 16 ? 3 : 1 })) };
  server.rpc.chrome_tasks = () => ({ items: [task], total: 1, nextOffset: null });
  server.rpc.chrome_task_diagnostics = () => ({ task, advice: {} });
  const app = await mountApp(t, { server }); await app.navigate('tasks'); choose(app.$('#task-profile'), online.id); await app.flush();
  buttonByText(app.$('#task-list'), '详情').click(); await app.flush();
  const body = app.text('#task-detail-body');
  for (const label of ['页面截图', '读取页面', '浏览器协议命令', '开始捕获网络', '停止捕获网络', '读取响应正文', '等待网络响应', '开始下载', '等待下载完成', '判断条件', '否则分支', '循环', '结束控制块', '设置任务变量', '双击', '后退', '已跳过', '已执行 3 次', '累计执行 22 次']) assert.ok(body.includes(label), label);
  assert.ok(!body.includes('undefined'));
});

test('管理页流程编辑保存与参数预览保留执行上限和高级数据，预览展示控制流与结果绑定', async t => {
  const server = createServer({ profiles: [online] }), flow = { id: uuid(40), profileId: online.id, version: 1, revision: 'r1', definition: { ...plan, description: '说明', parameters: [] }, stepCount: plan.steps.length };
  let saved: unknown;
  server.rpc.chrome_workflows = () => ({ items: [flow], total: 1, nextOffset: null });
  server.rpc.chrome_workflow_get = () => flow;
  server.rpc.chrome_workflow_preview = () => ({ revision: 'r1', plan });
  server.rpc.chrome_workflow_save = (args: any) => { saved = args.definition; return { ...flow, version: 2, revision: 'r2', definition: args.definition }; };
  const app = await mountApp(t, { server }); await app.navigate('tasks'); choose(app.$('#task-profile'), online.id); await app.flush();
  buttonByText(app.$('#workflow-list'), '预览本次步骤').click(); await app.flush();
  const preview = app.text('.plan-preview');
  for (const text of ['循环 最多 3 次', '判断条件 allowed truthy', '保存结果为 capture', '1 个结果绑定', '等待下载完成']) assert.ok(preview.includes(text), text);
  assert.ok(!preview.includes('undefined'));
  buttonByText(app.$('#workflow-list'), '编辑').click(); await app.flush();
  assert.equal(app.$('#task-max-executed-steps').value, '77'); app.click('#save-workflow'); await app.flush();
  assert.deepEqual(saved, flow.definition);
});

test('管理页成功步骤结果：显示artifact引用，沿用已认证结果端点查看截图或下载JSON', async t => {
  const png = uuid(71), json = uuid(72), server = createServer({ profiles: [online] });
  const task = { id: uuid(73), name: '保留结果', status: 'succeeded', tabId: 7, createdAt: '2026-10-27T00:00:00Z', updatedAt: 'ready', nextStep: 2, totalSteps: 2,
    steps: [{ operation: 'page.screenshot', state: 'succeeded', executions: 1, artifactId: png, artifactType: 'png' }, { operation: 'page.inspect', state: 'succeeded', executions: 1, artifactId: json, artifactType: 'json' }] };
  server.rpc.chrome_tasks = () => ({ items: [task], total: 1, nextOffset: null }); server.rpc.chrome_task_diagnostics = () => ({ task, advice: {} });
  for (const id of [png, json]) server.hooks[`GET /results/${id}`] = () => ({ status: 200, body: { fixture: id } });
  const app = await mountApp(t, { server }); await app.navigate('tasks'); choose(app.$('#task-profile'), online.id); await app.flush();
  buttonByText(app.$('#task-list'), '详情').click(); await app.flush();
  assert.ok(app.text('#task-detail-body').includes(png)); assert.ok(app.text('#task-detail-body').includes(json));
  buttonByText(app.$('#task-detail-body'), '查看步骤截图').click(); await app.flush();
  const image = app.$('#task-detail-body .step-result img'); assert.equal(image.alt, '此步骤完成时的页面截图'); image.onload();
  buttonByText(app.$('#task-detail-body'), '下载步骤结果').click(); await app.flush(); await app.tick(1000);
  assert.deepEqual(server.log.filter(entry => entry.path.startsWith('/results/')).map(entry => [entry.path, entry.bearer]), [[`/results/${png}`, server.session], [`/results/${json}`, server.session]]);
});
