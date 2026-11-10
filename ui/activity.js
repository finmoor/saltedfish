import { profileLabel, canOfferAbandon, lastSeenText, errorCode, ABANDON_AFTER_HOURS } from './identity.js';

/**
 * Operation history owns its selection generation, pagination, recovery dialog,
 * and the dialog that abandons a profile which will never reconnect.
 * @param {import('./contracts.js').ActivityDependencies} dependencies
 */
export function initializeActivity({ call, request, el, button, run, status, getProfiles, getCheckedAt, onRecovered, onAbandoned }) {
  /** @template {Element} T @param {string} selector @param {new () => T} constructor @returns {T} */
  function required(selector, constructor) {
    const node = document.querySelector(selector);
    if (!(node instanceof constructor)) throw new Error(`管理页缺少控件：${selector}`);
    return node;
  }
  const root = required('#operations', HTMLElement), dialog = required('#operation-recovery', HTMLDialogElement);
  // Empty/error text owns its spacing; the reusable list container must not inherit it.
  root.classList.remove('empty');
  const profilePicker = required('#activity-profile', HTMLSelectElement), statePicker = required('#activity-state', HTMLSelectElement);
  const previousButton = required('#activity-prev', HTMLButtonElement), nextButton = required('#activity-next', HTMLButtonElement);
  const pageLabel = required('#activity-page', HTMLElement), loadButton = required('#load-activity', HTMLButtonElement);
  const reviewed = required('#operation-reviewed', HTMLInputElement), confirmButton = required('#confirm-operation-recovery', HTMLButtonElement);
  const cancelButton = required('#cancel-operation-recovery', HTMLButtonElement), context = required('#operation-recovery-context', HTMLElement);
  const feedback = required('#operation-recovery [data-feedback]', HTMLElement);
  // 逐条核查对话框里的离线说明，以及从这里放弃整个配置的出口。
  const offlineHint = required('#operation-recovery-offline', HTMLElement), offlineText = required('#operation-recovery-offline-text', HTMLElement);
  const abandonFromRecovery = required('#abandon-from-recovery', HTMLButtonElement);
  // 放弃永不再连接的配置的对话框。
  const abandonDialog = required('#profile-abandon', HTMLDialogElement), abandonContext = required('#profile-abandon-context', HTMLElement);
  const abandonList = required('#profile-abandon-operations', HTMLElement), abandonMore = required('#profile-abandon-more', HTMLElement);
  const abandonCount = required('#profile-abandon-count', HTMLInputElement), abandonCountText = required('#profile-abandon-count-text', HTMLElement);
  const abandonConfirm = required('#confirm-profile-abandon', HTMLButtonElement), abandonCancel = required('#cancel-profile-abandon', HTMLButtonElement);
  const abandonFeedback = required('#profile-abandon [data-feedback]', HTMLElement);
  // 放弃成功后触发按钮多半已经随页面刷新消失，焦点要有去处：提示区剩下的按钮、概览标题或操作记录页的账号选择框。
  const noticeRoot = required('#protection-notice', HTMLElement), overviewTitle = required('#overview-title', HTMLElement);
  const pageSize = 30;
  const stateLabels = { running: '进行中', succeeded: '已完成', failed: '失败', unknown: '结果待确认' };
  let generation = 0, offset = 0;
  /** @type {number | null} */ let nextOffset = null;
  /** @type {import('./contracts.js').RecoverySelection | undefined} */ let recovery;
  /** @type {HTMLElement | undefined} */ let returnFocus;
  /** @type {{ profileId: string; name: string; preview: import('./contracts.js').AbandonPreview; opener?: HTMLElement } | undefined} */ let abandoning;
  let abandonOpens = 0;

  /** @returns {import('./contracts.js').ActivitySelection} */
  function scope() {
    const value = statePicker.value;
    const filter = value === 'all' || value === 'running' || value === 'succeeded' || value === 'failed' || value === 'unknown' ? value : 'review';
    return { profileId: profilePicker.value, filter, offset };
  }
  /** @param {number} revision @param {import('./contracts.js').ActivitySelection} selection */
  function isCurrent(revision, selection) {
    const current = scope();
    return revision === generation && selection.profileId === current.profileId && selection.filter === current.filter && selection.offset === current.offset;
  }
  function invalidate(message = '正在读取操作记录…') {
    generation++;
    recovery = undefined;
    nextOffset = null; // 上一次读取留下的“下一页”指针在新的读取完成前不可信
    if (dialog.open) dialog.close();
    root.replaceChildren(el('p', message, 'empty'));
    previousButton.disabled = nextButton.disabled = true;
    pageLabel.textContent = '';
  }

  /** 账号名称：同名带短 ID；仪表盘里已经没有这个配置（只剩待核查记录）时用服务端给的名称加短 ID，再不行用完整 ID。 @param {string} profileId @param {string | null | undefined} label */
  function profileName(profileId, label) {
    const profile = getProfiles().find(value => value.id === profileId);
    return profile ? profileLabel(profile, getProfiles()) : label ? `${label} · ${profileId.slice(0, 8)}` : profileId;
  }
  /** 离线配置的说明：不能在原页面核查时现在能做什么。offer 为真时给出“放弃”的出路，否则说明要等多久。 @param {import('./contracts.js').ProfileState} profile @param {boolean} offer */
  function offlineExplanation(profile, offer) {
    const seen = lastSeenText(profile, getCheckedAt(), true);
    return offer
      ? `这个浏览器当前未连接，${seen}。解除保护要回到原页面核查，所以现在无法确认这些记录。如果这个配置已经不存在（重建了配置 ID、卸载重装了扩展，或删除了 Chrome 配置），可以放弃整个配置。`
      : `这个浏览器当前未连接，${seen}。解除保护要回到原页面核查：请先打开原来的 Chrome 继续连接。超过 ${ABANDON_AFTER_HOURS} 小时没有出现，才可以放弃这个配置。`;
  }
  /** @param {import('./contracts.js').ProfileState} profile */
  function offlineBanner(profile) {
    const offer = canOfferAbandon(profile, getCheckedAt()), banner = el('div', undefined, 'offline-note');
    banner.append(el('p', offlineExplanation(profile, offer)));
    if (offer) banner.append(button('放弃此配置…', opener => openAbandon(profile.id, opener), 'danger'));
    return banner;
  }

  async function load() {
    const selection = scope();
    invalidate(selection.profileId ? '正在读取操作记录…' : '选择浏览器后查看操作记录。');
    const revision = generation;
    if (!selection.profileId) return;
    /** @type {Pick<import('./contracts.js').OperationsQuery, 'state' | 'acknowledged'>} */
    const filters = selection.filter === 'review' ? { state: 'unknown', acknowledged: false } : selection.filter === 'all' ? {} : { state: selection.filter };
    try {
      const data = await call('chrome_operations', { profileId: selection.profileId, offset, limit: pageSize, ...filters });
      if (!isCurrent(revision, selection)) return;
      // 在末页核查完最后一条后，原偏移已越过列表末尾：回到最后一个有效页重读，而不是对仍有记录的列表误报“没有待核查操作”。
      const lastOffset = Math.max(0, Math.floor((data.total - 1) / pageSize) * pageSize);
      if (!data.items.length && offset > lastOffset) { offset = lastOffset; return load(); }
      nextOffset = data.nextOffset;
      previousButton.disabled = offset === 0;
      nextButton.disabled = nextOffset === null;
      pageLabel.textContent = `${data.total} 条 · 第 ${Math.floor(offset / pageSize) + 1} 页`;
      root.replaceChildren();
      if (!data.items.length) { root.append(el('p', selection.filter === 'review' ? '这个浏览器没有待核查操作。可切换到全部记录查看历史。' : '当前筛选没有操作记录。', 'empty')); return; }
      const table = el('table'), head = el('thead'), header = el('tr'), body = el('tbody');
      for (const label of ['状态', '操作与目标', '处理']) header.append(el('th', label));
      head.append(header); table.append(head, body);
      for (const item of data.items) {
        const row = el('tr'), description = el('td'), actions = el('td');
        row.dataset.operationId = item.id;
        description.append(el('div', item.tool), el('div', item.tabId === null ? '整个浏览器' : `标签 ${item.tabId}`, 'operation-target'), el('small', new Date(item.startedAt).toLocaleString()), el('code', item.id, 'operation-id'));
        if (item.errorCode) description.append(el('div', item.errorCode, 'url'));
        if (item.state === 'unknown' && !item.acknowledgedAt) {
          const control = button('核查并解除保护', () => openRecovery(item, selection, revision));
          control.dataset.recover = item.id; actions.append(control);
        } else if (item.acknowledgedAt) actions.append(el('small', '已确认结果'));
        row.append(el('td', stateLabels[item.state], `state ${item.state}`), description, actions); body.append(row);
      }
      // 离线的浏览器无法在原页面核查：列表上方说明原因，并在它长期不会再出现时给出放弃整个配置的出口。
      const profile = getProfiles().find(value => value.id === selection.profileId);
      if (profile?.online === false && data.items.some(item => item.state === 'unknown' && !item.acknowledgedAt)) root.append(offlineBanner(profile));
      root.append(table);
    } catch (error) {
      if (!isCurrent(revision, selection)) return;
      // 失败页之后没有可信的“下一页”，但仍可回到上一页，或用“刷新记录”重试同一页。
      previousButton.disabled = offset === 0;
      root.replaceChildren(el('p', `操作记录读取失败。${error instanceof Error ? error.message : String(error)} 点击“刷新记录”重试。`, 'empty'));
      throw error;
    }
  }
  /** @param {import('../src/state-store.js').OperationRecord} item @param {import('./contracts.js').ActivitySelection} selection @param {number} revision */
  function openRecovery(item, selection, revision) {
    if (!isCurrent(revision, selection)) return;
    const profile = getProfiles().find(value => value.id === selection.profileId);
    recovery = { item, selection, revision };
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    context.textContent = `${profile ? profileLabel(profile, getProfiles()) : selection.profileId} · ${item.tabId === null ? '整个浏览器' : `标签 ${item.tabId}`}\n${item.tool}\n操作 ID：${item.id}`;
    // 配置当前离线时服务端会拒绝解除：提前说明原因，并在它长期不会再出现时给出放弃整个配置的出口（在线配置不显示任何提示）。
    const offline = profile?.online === false ? profile : undefined, offer = !!offline && canOfferAbandon(offline, getCheckedAt());
    offlineHint.hidden = !offline; abandonFromRecovery.hidden = !offer;
    if (offline) offlineText.textContent = offlineExplanation(offline, offer);
    reviewed.checked = false;
    confirmButton.disabled = true;
    feedback.textContent = '';
    dialog.showModal();
    reviewed.focus();
  }
  async function recover() {
    const target = recovery;
    if (!target || !isCurrent(target.revision, target.selection) || !reviewed.checked) throw new Error('目标已经变化。请重新打开这条记录并核查。');
    try { await call('chrome_recover_operation', { operationId: target.item.id, acknowledged: true }); }
    catch (error) {
      // 核查途中配置离线：服务端的说明指向管理接口，对界面用户没有意义，换成能照着做的话。
      if (errorCode(error) === 'PROFILE_OFFLINE') throw new Error('这个浏览器刚刚断开连接，没法在原页面核查：请先打开原来的 Chrome 继续连接后再确认。如果这个配置已经不存在，请改用“放弃此配置…”。');
      throw error;
    }
    if (!isCurrent(target.revision, target.selection)) return;
    dialog.close();
    await load();
    await onRecovered();
    settleRecoveryFocus();
  }
  // 核查成功后列表整个重画，打开对话框的那一行已经不在：焦点留给仍存在的下一条核查按钮，一条都不剩就落到账号选择框，不丢到页面顶部。
  // 用户已经把焦点移到别处（页面里仍存在的控件）就不抢。
  function settleRecoveryFocus() {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && active.isConnected && !dialog.contains(active)) return;
    const next = root.querySelector('[data-recover]');
    (next instanceof HTMLElement ? next : profilePicker).focus({ preventScroll: true });
  }

  // ───────── 放弃永远不会再连接的配置 ─────────
  // 重建了配置 ID、卸载重装扩展、删除了 Chrome 配置之后，旧配置上的未知结果再也没法回到原页面核查。
  // 这里只做数据库层面的确认（服务端 POST /profiles/abandon）：先读预览、列出受影响的记录，输入记录总数二次确认后才提交；不连接浏览器，不重放任何操作。
  /** @param {HTMLElement | undefined} node */
  const usable = node => !!node && node.isConnected && !('disabled' in node && node.disabled);
  const typedCount = () => abandonCount.value.normalize('NFKC').trim();
  const abandonReady = () => !!abandoning && abandoning.preview.canAbandon && abandoning.preview.unknown > 0 && typedCount() === String(abandoning.preview.unknown);
  /** 不能放弃时的原因（能放弃则为空）。 @param {import('./contracts.js').AbandonPreview} preview */
  function blockedReason(preview) {
    if (preview.online) return '这个配置当前在线，不能放弃。请回到原页面核查，再用“解除保护”确认。';
    if (preview.running) return `这个配置还有 ${preview.running} 个操作仍在运行，不能放弃；等它们结束后再试。`;
    if (!preview.unknown) return '这个配置已经没有待核查的记录，不需要放弃。';
    return '';
  }
  /** 把预览画进对话框。每次重画都清空已输入的数量：数量必须针对眼前这份记录重新确认。 @param {import('./contracts.js').AbandonPreview} preview @param {string} name */
  function renderAbandon(preview, name) {
    abandonContext.textContent = [name, `配置 ID：${preview.profileId}`,
      `${preview.online ? '当前在线' : '当前未连接'} · ${lastSeenText({ lastSeen: preview.lastSeen }, getCheckedAt(), true)}`,
      `待核查的操作：${preview.unknown} 条${preview.running ? `；另有 ${preview.running} 个操作仍在运行` : ''}`].join('\n');
    abandonList.replaceChildren();
    for (const item of preview.operations) {
      const row = el('li'), heading = el('div');
      heading.append(el('strong', item.tool), ` · ${typeof item.tabId === 'number' ? `标签 ${item.tabId}` : '整个浏览器'} · ${stateLabels[item.state] ?? item.state}`);
      row.append(heading, el('small', [new Date(item.startedAt).toLocaleString(), item.errorCode, `操作 ${item.id.slice(0, 8)}`].filter(Boolean).join(' · ')));
      abandonList.append(row);
    }
    abandonList.setAttribute('aria-label', `${name} 的待核查操作，最新的在前`);
    const total = preview.unknown + preview.running;
    abandonMore.hidden = total <= preview.operations.length; abandonMore.textContent = `仅列出最近 ${preview.operations.length} 条，共 ${total} 条。`;
    abandonCountText.textContent = `请输入待核查记录的总数（${preview.unknown}）以确认放弃`;
    abandonCount.value = ''; abandonCount.disabled = !(preview.canAbandon && preview.unknown > 0); abandonConfirm.disabled = true;
    abandonFeedback.dataset.error = 'true'; abandonFeedback.textContent = blockedReason(preview);
  }
  /** @param {import('./contracts.js').AbandonPreview} preview @param {HTMLElement | undefined} opener */
  function showAbandon(preview, opener) {
    if (abandonDialog.open) return;
    const name = profileName(preview.profileId, preview.label);
    abandoning = { profileId: preview.profileId, name, preview, opener };
    renderAbandon(preview, name);
    abandonDialog.showModal();
    (abandonCount.disabled ? abandonCancel : abandonCount).focus();
  }
  /**
   * 读预览再打开对话框。opener 是触发它的按钮（button 的 action 会收到被点的节点）：
   * 执行器会立刻禁用被点的按钮，等 await 之后焦点已经丢了，所以关闭对话框时要明确把焦点还给它。
   * 连续点了两个配置时只认最后一次点击；会话变化时 request 自己会丢弃旧响应。
   * @param {string} profileId @param {HTMLElement | undefined} opener @param {() => void} [before] 预览读到之后、显示对话框之前执行（例如关掉逐条核查对话框）
   */
  async function openAbandon(profileId, opener, before) {
    const revision = ++abandonOpens;
    const preview = await request(`/profiles/abandon?profileId=${encodeURIComponent(profileId)}`);
    if (revision !== abandonOpens) return;
    before?.();
    showAbandon(preview, opener);
  }
  /** 提交被服务端拒绝后按最新状态重新预览（读不到就保守地禁用确认），让对话框显示的永远是眼前的事实。 @param {NonNullable<typeof abandoning>} target */
  async function refreshAbandon(target) {
    try {
      const latest = await request(`/profiles/abandon?profileId=${encodeURIComponent(target.profileId)}`);
      if (abandoning !== target) return undefined;
      target.preview = latest; renderAbandon(latest, target.name);
      return latest;
    } catch (error) {
      if (errorCode(error) === 'STALE_SESSION') throw error;
      if (abandoning === target) { target.preview = { ...target.preview, canAbandon: false }; renderAbandon(target.preview, target.name); }
      return undefined;
    }
  }
  /** 预览之后状态变了（数量、重新连接、有运行中的操作）：重新预览，并给出能照着做的说明；其他错误原样返回。 @param {unknown} error @param {NonNullable<typeof abandoning>} target */
  async function explainRejection(error, target) {
    const code = errorCode(error);
    if (code !== 'ABANDON_COUNT_CHANGED' && code !== 'PROFILE_ONLINE' && code !== 'OPERATION_RUNNING') return error;
    const latest = await refreshAbandon(target);
    if (code === 'PROFILE_ONLINE') return new Error('这个配置刚刚重新连接了，不能放弃。请回到原页面核查，再用“解除保护”确认。');
    if (code === 'ABANDON_COUNT_CHANGED') return new Error(`待核查记录在你查看之后发生了变化${latest ? `（现在是 ${latest.unknown} 条）。已按最新记录重新列出，请核对后再输入数量确认。` : '。请关闭这个窗口，重新打开后再试。'}`);
    return error;
  }
  function fallbackFocus() {
    const remaining = noticeRoot.hidden ? undefined : [...noticeRoot.querySelectorAll('button')].find(node => !node.disabled);
    (remaining ?? (location.hash === '#activity' ? profilePicker : overviewTitle)).focus({ preventScroll: true });
  }
  function settleFocus() {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active === document.body || !active.isConnected) fallbackFocus();
  }
  async function abandon() {
    const target = abandoning;
    if (!target || !abandonReady()) throw new Error('请先输入预览里的待核查记录数量。');
    const { profileId, name, preview } = target;
    const result = await request('/profiles/abandon', 'POST', { profileId, expectedUnknown: preview.unknown, confirm: true }).catch(async error => { throw await explainRejection(error, target); });
    abandonDialog.close();
    await onAbandoned();
    try { await load(); } catch { /* 列表自己会显示读取失败 */ }
    status.dataset.error = 'false';
    status.textContent = `已放弃「${name}」：确认了 ${result.acknowledged} 条待核查记录${result.forgotten ? '，并把它从列表移除' : ''}。没有连接浏览器，也没有重放任何操作。`;
    settleFocus();
  }
  abandonCount.oninput = () => { abandonConfirm.disabled = !abandonReady(); };
  abandonConfirm.onclick = () => void run(abandonConfirm, abandon, abandonReady);
  abandonCancel.onclick = () => abandonDialog.close();
  abandonDialog.addEventListener('close', () => {
    if (abandonDialog.open) return; // 迟到的 close，见核查对话框的说明。
    const opener = abandoning?.opener; abandoning = undefined;
    // 反馈和已输入的数量不能留到下一次打开。
    abandonCount.value = ''; abandonConfirm.disabled = true; abandonFeedback.textContent = '';
    if (usable(opener)) opener?.focus({ preventScroll: true }); else fallbackFocus();
  });
  abandonFromRecovery.onclick = () => void run(abandonFromRecovery, async () => {
    const target = recovery, opener = returnFocus;
    if (target) await openAbandon(target.selection.profileId, opener, () => dialog.close());
  });

  reviewed.onchange = () => { confirmButton.disabled = !recovery || !reviewed.checked; };
  confirmButton.onclick = () => void run(confirmButton, recover, () => !!recovery && reviewed.checked);
  cancelButton.onclick = () => dialog.close();
  // Chrome 在下一帧才发 close，页面慢时要等几百毫秒。核查完马上开下一条，事件到的时候新对话框已经开着，不能清掉它的状态。
  dialog.addEventListener('close', () => { if (dialog.open) return; recovery = undefined; if (returnFocus?.isConnected) returnFocus.focus(); returnFocus = undefined; });
  for (const picker of [profilePicker, statePicker]) picker.onchange = () => { offset = 0; void run(loadButton, load); };
  loadButton.onclick = () => void run(loadButton, load);
  previousButton.onclick = () => { offset = Math.max(0, offset - pageSize); void run(previousButton, load, () => offset > 0); };
  nextButton.onclick = () => { if (nextOffset !== null) offset = nextOffset; void run(nextButton, load, () => nextOffset !== null); };
  return {
    load,
    /** @param {string} profileId */
    open(profileId) {
      profilePicker.value = profileId; statePicker.value = 'review'; offset = 0;
      if (location.hash === '#activity') return load();
      location.hash = 'activity';
    },
    /** 概览上的“放弃此配置…”：读预览、打开对话框。 @param {string} profileId @param {HTMLElement} [opener] */
    abandon(profileId, opener) { return openAbandon(profileId, opener); },
    reset() { abandonOpens++; offset = 0; nextOffset = null; invalidate('选择浏览器后查看操作记录。'); },
  };
}
