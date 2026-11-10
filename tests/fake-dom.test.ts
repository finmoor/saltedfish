import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, readUi, readExtension, FakeEvent, same, describe, type FakeElement } from './fake-dom.js';

// 假 DOM 是其他界面用例的地基：这里先单独核对它和浏览器行为一致的关键点，避免“用例通过只是因为假 DOM 太宽松”。
function mount(t: { after(fn: () => void): void }, html = readUi('index.html')) {
  const dom = installDom(html); t.after(() => dom.uninstall()); return dom;
}

test('能解析真实 index.html / options.html，hidden、嵌套和属性选择器按预期工作', t => {
  const { doc } = mount(t);
  assert.equal(doc.querySelectorAll('dialog').length, 5);
  assert.ok(doc.querySelector('#agent-add-dialog #new-agent-client'));
  assert.equal(doc.querySelector('#workspace')!.hidden, true);
  assert.ok(doc.querySelector('#operation-recovery [data-feedback]'));
  assert.equal(doc.querySelector('#task-detail > [data-feedback]')?.id, '');
  assert.equal(doc.querySelector('#add-browser > summary')?.localName, 'summary');
  assert.equal(doc.querySelectorAll('[data-route]').length, 8);
  assert.ok(doc.querySelector('[data-route="agents"]'));
  assert.equal(doc.querySelector<any>('#task-timeout')?.value, '30', 'input 的初始 value 来自属性');
  assert.equal(doc.querySelector<any>('#task-visible')?.checked, true, 'checkbox 的初始 checked 来自属性');
  assert.throws(() => doc.querySelector('li:nth-child(2)'), /不支持伪类/);
  const options = installDom(readExtension('options.html')); t.after(() => options.uninstall());
  assert.ok(options.doc.querySelector('#settings')); assert.equal(options.doc.querySelector<any>('#settings')!.elements.namedItem('connectionCode')!.type, 'password');
});

test('select 的 value 在没有匹配项时为空，子节点变化后回到第一项', t => {
  const { doc } = mount(t); const select = doc.createElement('select');
  for (const [value, text] of [['a', 'A'], ['b', 'B']] as const) { const option = doc.createElement('option'); option.value = value; option.textContent = text; select.append(option); }
  assert.equal(select.value, 'a'); select.value = 'b'; assert.equal(select.value, 'b'); select.value = '不存在'; assert.equal(select.value, '');
  const extra = doc.createElement('option'); extra.value = 'c'; select.append(extra); assert.equal(select.value, 'a', '插入新选项后重新计算默认选中项');
  const plain = doc.createElement('option'); plain.textContent = '仅文本'; assert.equal(plain.value, '仅文本');
});

test('禁用当前焦点按钮不会立刻丢焦点，下一帧才修正；被禁用的元素不能重新获得焦点', t => {
  const { doc } = mount(t); const button = doc.createElement('button'); doc.body.append(button);
  button.focus(); same(doc.activeElement, button);
  button.disabled = true; same(doc.activeElement, button, '同一任务内焦点还在');
  doc.updateRendering(); same(doc.activeElement, doc.body, '渲染更新后焦点回到 body');
  button.focus(); same(doc.activeElement, doc.body, '禁用状态下 focus() 无效');
  button.disabled = false; button.focus(); same(doc.activeElement, button);
  button.hidden = true; doc.updateRendering(); same(doc.activeElement, doc.body, '隐藏同样会失去焦点');
});

test('dialog：showModal 记住打开前的焦点，close 后还原；modal 外的元素不能抢焦点', t => {
  const { doc } = mount(t); const opener = doc.createElement('button'), other = doc.createElement('button'), dialog = doc.querySelector<any>('#task-detail')!;
  doc.querySelector('#workspace')!.hidden = false; // 登录前工作区是 hidden，里面的元素本来就不能聚焦
  doc.body.append(opener, other); opener.focus(); dialog.showModal();
  assert.equal(doc.activeElement.id, 'close-task-detail', '焦点进入对话框里第一个可聚焦元素');
  other.focus(); assert.ok(doc.activeElement !== other, 'modal 之外是 inert');
  let closed = 0; dialog.addEventListener('close', () => { closed++; }); dialog.close();
  same(doc.activeElement, opener); assert.equal(closed, 1);
  assert.throws(() => { dialog.showModal(); dialog.showModal(); }, { name: 'InvalidStateError' });

  // 先让触发按钮因 disabled 丢焦点再 showModal：规范里“先前焦点”为空，close 后焦点不会回到按钮（这正是 ui:7 要避免的路径）。
  dialog.close(); opener.focus(); opener.disabled = true; doc.updateRendering(); dialog.showModal(); opener.disabled = false; dialog.close();
  doc.updateRendering(); same(doc.activeElement, doc.body);
});

test('事件按冒泡顺序触发 on* 属性和监听器；checkbox 点击先改状态再触发 input/change', t => {
  const { doc } = mount(t); const form = doc.createElement('form'), box = doc.createElement('input'); box.type = 'checkbox'; form.append(box); doc.body.append(form);
  const seen: string[] = []; form.addEventListener('input', () => seen.push('form:input')); form.addEventListener('change', () => seen.push('form:change'));
  box.onclick = () => { seen.push(`click:${box.checked}`); }; box.click();
  assert.deepEqual(seen, ['click:true', 'form:input', 'form:change']);
  box.disabled = true; box.click(); assert.equal(box.checked, true, '禁用控件不响应点击');
  const event = new FakeEvent('submit', true); form.onsubmit = (e: FakeEvent) => { e.preventDefault(); }; assert.equal(form.dispatchEvent(event), false);
});

test('replaceChildren/insertBefore/before/after 维护父子关系和 isConnected', t => {
  const { doc } = mount(t); const root = doc.createElement('div'), a = doc.createElement('p'), b = doc.createElement('p'), c = doc.createElement('p'); doc.body.append(root);
  a.id = 'a'; b.id = 'b'; c.id = 'c'; const order = () => root.children.map(describe).join('');
  root.append(a, b); b.before(c); assert.equal(order(), '<p#a><p#c><p#b>'); a.after(b); assert.equal(order(), '<p#a><p#b><p#c>');
  root.insertBefore(c, a); assert.equal(order(), '<p#c><p#a><p#b>'); assert.equal(c.isConnected, true);
  root.replaceChildren(b); assert.equal(a.isConnected, false); assert.equal(a.parentNode, null); assert.equal(order(), '<p#b>');
  b.textContent = '文本'; assert.equal(root.textContent, '文本'); b.textContent = ''; assert.equal(b.childNodes.length, 0);
  same((root as FakeElement).closest('body'), doc.body);
});
