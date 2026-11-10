import test from 'node:test';
import assert from 'node:assert/strict';
import { interactionHarness } from './interaction-harness.js';
import { inputValue } from './dom-readers.js';

const html = '<!doctype html><input id="source" value="original"><input id="other"><textarea id="area">first line\nsecond line\nthird line</textarea>';

test('review regressions: input targeting, observation, keyboard, shadow events and identity', async t => {
  const h = await interactionHarness(t, html);

  await t.test('focus microtasks never redirect text, clear, press or composition to another field', async () => {
    for (const action of [
      { action: 'type', text: 'VALUE' }, { action: 'fill', text: 'VALUE' },
      { action: 'fill', text: '' }, { action: 'press', key: 'x' },
      { action: 'type', text: 'VALUE', inputMode: 'keySequence' },
      { action: 'type', text: '中文', inputMode: 'composition' },
    ]) {
      const { page, raw, call } = await h.open();
      try {
        await page.evaluate(() => document.querySelector('#source')!.addEventListener('focus', () => {
          queueMicrotask(() => (document.querySelector('#other') as HTMLElement).focus());
        }, { once: true }));
        const result = await raw('chrome_action', { ...action, selector: '#source', autoWait: false });
        const values = await page.evaluate(() => ['source', 'other'].map(id => (document.getElementById(id) as HTMLInputElement).value));
        assert.deepEqual(values, ['original', ''], JSON.stringify(action));
        assert.equal(result.ok, false, JSON.stringify(action));
        assert.equal(result.error?.code, 'FOCUS_CHANGED');
        if (result.error?.outcome === 'unknown') await call('chrome_recover_tab');
      } finally { await page.close(); }
    }
  });

  await t.test('keydown focus microtasks stop before characters and still release the key', async () => {
    const { page, raw, call } = await h.open();
    try {
        await page.evaluate(() => {
          (window as any).keyUps = 0; document.addEventListener('keyup', () => { (window as any).keyUps++; });
          document.querySelector('#source')!.addEventListener('keydown', () => {
          queueMicrotask(() => (document.querySelector('#other') as HTMLElement).focus());
          }, { once: true });
        });
        const result = await raw('chrome_action', { action: 'press', selector: '#source', key: 'x', autoWait: false });
        assert.deepEqual(await page.evaluate(() => ['source', 'other'].map(id => (document.getElementById(id) as HTMLInputElement).value)), ['original', '']);
        assert.equal(result.error?.code, 'FOCUS_CHANGED');
        assert.equal(await page.evaluate(() => (window as any).keyUps), 1);
        if (result.error?.outcome === 'unknown') await call('chrome_recover_tab');
    } finally { await page.close(); }
  });

  await t.test('type reports dispatch rather than claiming an accepted character count', async () => {
    for (const behavior of ['cancel', 'transform']) {
      const { page, call } = await h.open();
      try {
        await page.evaluate((behavior: string) => {
          const source = document.querySelector('#source') as HTMLInputElement;
          source.value = '';
          if (behavior === 'cancel') source.addEventListener('beforeinput', event => event.preventDefault());
          else source.addEventListener('input', () => { source.value = source.value.toUpperCase(); });
        }, behavior);
        const result = await call('chrome_action', { action: 'type', selector: '#source', text: 'lowercase' });
        assert.equal(result.dispatched, true); assert.equal(result.verification, 'not_checked');
        assert.equal(result.requestedCharacters, 9); assert.equal(Object.hasOwn(result, 'inserted'), false);
        assert.equal(await page.$eval('#source', inputValue), behavior === 'cancel' ? '' : 'LOWERCASE');
      } finally { await page.close(); }
    }
  });

  await t.test('read-only inspect/find do not grant user activation', async () => {
    const client = h.service.state.createClient('read-only observation', [h.profile.id], true);
    const principal = h.service.state.authenticate(client.token)!;
    for (const name of ['chrome_inspect', 'chrome_find']) {
      const { page, target } = await h.open();
      const cdp = await page.createCDPSession();
      const activation = async () => (await cdp.send('Runtime.evaluate', {
        expression: '({active:navigator.userActivation.isActive,ever:navigator.userActivation.hasBeenActive})', userGesture: false, returnByValue: true,
      })).result.value;
      try {
        assert.deepEqual(await activation(), { active: false, ever: false });
        const result = await h.service.invoke(name, { ...target, ...(name === 'chrome_find' ? { locator: { role: 'textbox' } } : {}) }, 'readonly-regression', principal);
        assert.equal(result.ok, true, JSON.stringify(result.error));
        assert.deepEqual(await activation(), { active: false, ever: false }, name);
      } finally { await cdp.detach(); await page.close(); }
    }
  });

  await t.test('press matches native navigation and printable US keyboard fields', async () => {
    for (const key of ['Home', 'End', 'PageUp', 'PageDown', 'ArrowLeft', 'F2', '1', '!', '?', 'A', 'Shift', 'Control', 'Alt', 'Meta']) {
      const { page, call } = await h.open();
      const reset = async () => page.evaluate(`(() => {
        const area = document.querySelector('#area');
        area.value = 'first line\\nsecond line\\nthird line'; area.focus(); area.setSelectionRange(15, 15);
        window.keys = [];
        const capture = event => window.keys.push({ type: event.type, key: event.key, code: event.code, keyCode: event.keyCode, shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey, location: event.location });
        area.onkeydown = capture; area.onkeyup = capture;
      })()`);
      const state = () => page.evaluate(() => { const area = document.querySelector('#area') as HTMLTextAreaElement; return { value: area.value, cursor: area.selectionStart, keys: (window as any).keys }; });
      try {
        await reset(); await call('chrome_action', { action: 'press', selector: '#area', key, autoWait: false }); const actual = await state();
        await reset();
        const shifted = ['!', '?', 'A'].includes(key);
        // press 像真键盘一样先按下 Shift、主键松开后再松开（大写字母、!? 隐含 Shift），对照组也带上 Shift 自己的 keydown/keyup。
        if (shifted) await page.keyboard.down('Shift');
        await page.keyboard.press(key as any);
        if (shifted) await page.keyboard.up('Shift');
        const expected = await state();
        assert.deepEqual(actual, expected, key);
      } finally { await page.close(); }
    }
    const { page, raw } = await h.open();
    try {
      const result = await raw('chrome_action', { action: 'press', selector: '#source', key: 'DefinitelyNotAKey', autoWait: false });
      assert.equal(result.error?.code, 'UNSUPPORTED_KEY'); assert.equal(result.error?.outcome, 'not_dispatched');
      assert.equal(await page.$eval('#source', e => e === document.activeElement), false, 'invalid key must not even focus the field');
    } finally { await page.close(); }
  });

  await t.test('press preserves keydown cancellation instead of forcing text through', async () => {
    const { page, call } = await h.open();
    try {
      await page.evaluate(() => document.querySelector('#source')!.addEventListener('keydown', event => event.preventDefault()));
      await call('chrome_action', { action: 'press', selector: '#source', key: 'x' });
      assert.equal(await page.$eval('#source', inputValue), 'original');
    } finally { await page.close(); }
  });

  await t.test('existing uppercase Ctrl+A shortcuts keep their explicit modifier scope', async () => {
    const { page, call } = await h.open();
    try {
      await call('chrome_action', { action: 'press', selector: '#source', key: 'A', modifiers: 2 });
      assert.deepEqual(await page.$eval('#source', element => {
        if (!(element instanceof HTMLInputElement)) throw new Error('Expected input');
        return [element.selectionStart, element.selectionEnd];
      }), [0, 8]);
    } finally { await page.close(); }
  });

  await t.test('select and explicit setValue input reach shadow host, change stays inside', async () => {
    const { page, call } = await h.open();
    try {
      await page.evaluate(() => {
        const host = document.createElement('div'); host.id = 'host'; document.body.append(host);
        host.attachShadow({ mode: 'open' }).innerHTML = '<select id="shadow-select"><option value="a">A</option><option value="b">B</option></select><input id="shadow-input">';
        (window as any).outside = []; (window as any).inside = [];
        for (const type of ['input', 'change']) {
          host.addEventListener(type, event => { (window as any).outside.push({ type, composed: event.composed, trusted: event.isTrusted }); (window as any).model = (event.composedPath()[0] as HTMLInputElement).value; });
          host.shadowRoot!.addEventListener(type, event => (window as any).inside.push({ type, composed: event.composed, trusted: event.isTrusted }));
        }
      });
      await call('chrome_action', { action: 'select', selector: '#shadow-select', values: ['b'] });
      assert.deepEqual(await page.evaluate(() => ({ model: (window as any).model, outside: (window as any).outside, inside: (window as any).inside })), {
        model: 'b', outside: [{ type: 'input', composed: true, trusted: false }],
        inside: [{ type: 'input', composed: true, trusted: false }, { type: 'change', composed: false, trusted: false }],
      });
      await call('chrome_action', { action: 'fill', selector: '#shadow-input', text: 'model', fillMode: 'setValue' });
      assert.equal(await page.evaluate(() => (window as any).model), 'model');
    } finally { await page.close(); }
  });

  await t.test('rebuilding identity requires confirmation and preserves old authorization scope', async () => {
    const old = h.profile.id, client = h.service.state.createClient('bound profile', [old], false);
    const principal = h.service.state.authenticate(client.token)!;
    const worker = await h.browser.waitForTarget(target => target.type() === 'service_worker');
    const page = await h.browser.newPage();
    const readIdentity = () => page.evaluate(async () => {
      const settings = (await chrome.storage.local.get('settings')).settings;
      if (!settings || typeof settings !== 'object' || !('profileId' in settings) || typeof settings.profileId !== 'string') throw new Error('Missing profile identity');
      return settings.profileId;
    });
    try {
      await page.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
      await page.waitForFunction(() => document.querySelector('#identity')?.textContent?.includes('配置 ID'));
      const target = await h.open();
      const running = target.call('chrome_evaluate', { expression: 'new Promise(resolve => setTimeout(() => resolve(true), 500))' });
      try {
        await page.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: 'settings.get' })).activities.length > 0);
        const busy = await page.evaluate((id: string) => chrome.runtime.sendMessage({ type: 'settings.save', resetIdentity: true, expectedProfileId: id }), old);
        assert.match(busy.error, /操作进行中/);
      } finally { await running; await target.page.close(); }
      await page.evaluate(() => { document.querySelector('#identity-reset')!.closest('details')?.setAttribute('open', ''); });
      const cancelled = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Missing identity confirmation')), 3000);
        page.once('dialog', dialog => { clearTimeout(timer); const message = dialog.message(); void dialog.dismiss().then(() => resolve(message), reject); });
      });
      await page.click('#identity-reset');
      const message = await cancelled;
      assert.match(message, /授权/); assert.match(message, /流程/); assert.match(message, /重新配对服务/);
      assert.equal(await readIdentity(), old);
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#identity-reset')!.disabled);
      page.once('dialog', dialog => { void dialog.accept(); });
      await page.click('#identity-reset');
      await page.waitForFunction(async (oldId: string) => {
        const settings = (await chrome.storage.local.get('settings')).settings;
        return !!settings && typeof settings === 'object' && 'profileId' in settings && settings.profileId !== oldId;
      }, {}, old);
      const next = await readIdentity();
      for (let i = 0; i < 60 && !h.service.broker.listProfiles().some(profile => profile.id === next); i++) await new Promise(resolve => setTimeout(resolve, 50));
      assert.deepEqual(h.service.listProfiles(principal).map(profile => profile.id), [old], 'no automatic permission transfer');
      assert.ok(h.service.broker.listProfiles().some(profile => profile.id === next));
      const stale = await page.evaluate((oldId: string) => chrome.runtime.sendMessage({ type: 'settings.save', resetIdentity: true, expectedProfileId: oldId }), old);
      assert.match(stale.error, /身份已变化/);
      const unconfirmed = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'settings.save', resetIdentity: true }));
      assert.match(unconfirmed.error, /尚未确认/);
      assert.equal(await readIdentity(), next);
    } finally { await page.close(); }
  });
});
