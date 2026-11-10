import type { JsonObject } from '../src/shared';

// 一个 MCP 会话在一个窗口里最多一个标签组，组是 Agent 工作范围的可见边界：写操作只能落在这里。
// Chrome 是组的事实来源，这里只记组属于哪个会话。记录放 storage.local：扩展重载后还认得出，Chrome 重启后组 ID 失效，读的时候清掉。
// Chrome 会自动保存每个标签组（saved_tab_group，含标题和网址），解散或关掉才删除：所以会话结束一定要解散，标题也只写 Agent 名字。
const KEY = 'agentGroups';
const UNGROUPED = -1;

interface Origin { windowId: number; index: number }
interface GroupRecord {
  groupId: number; windowId: number; owner: string; agentId: string; title: string; startedAt: string;
  // 这个会话自己的标签页：它开的、它接管的，和这些页面打开的链接。用户拖进组的不算，要给 Agent 用还是走 claim_tab。
  tabs: number[];
  // 用户原来的标签页被接管时的位置，释放时放回去。Agent 自己开的标签页不在这里。
  origins: Record<string, Origin>;
}
// 用户从组里拖走的标签页，算收回：Agent 不能写也不能再接管，拖回来就恢复。不放在组记录里：最后一个标签页被拖走时组就没了，收回不能跟着没。
const RETURNED = 'agentReturned';
type Returned = Record<string, number[]>;

// 并行的 new_tab 不能各建一个组。标签页事件也排进来，才能排在触发它的操作之后，分得清是这里做的还是用户做的。
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => {});
  return next;
}
// 用户正在拖标签页时 Chrome 拒绝编辑，松手就好，等一下再试。
async function whenEditable<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await work(); }
    catch (error) {
      if (attempt >= 20 || !/cannot be edited/i.test(String(error))) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

async function load() {
  const stored = (await chrome.storage.local.get(KEY))[KEY];
  return Array.isArray(stored) ? stored as GroupRecord[] : [];
}
const save = (records: GroupRecord[]) => chrome.storage.local.set({ [KEY]: records });
async function loadReturned() {
  const stored = (await chrome.storage.local.get(RETURNED))[RETURNED];
  return (stored && typeof stored === 'object' ? stored : {}) as Returned;
}
// 会话结束（不是用户点“结束并释放”）时记下它的标签页：同一个 Agent 的客户端断线重连后换了会话，写这些标签页时服务可以直接接回，不用逐个 claim_tab。
// 放 storage.session：浏览器重启后标签页 ID 会重用，记录跟着清掉；扩展重载也清掉，最多是退回手动接管。
const ENDED = 'agentEnded', ENDED_MS = 24 * 60 * 60 * 1000;
interface EndedTab { tabId: number; origin: string; claimed: boolean }
interface Ended { owner: string; agentId: string; title: string; endedAt: number; tabs: EndedTab[] }
const originOf = (url?: string) => { try { return new URL(url || '').origin; } catch { return ''; } };
async function loadEnded() {
  const stored = (await chrome.storage.session.get(ENDED).catch(() => ({} as Record<string, unknown>)))[ENDED];
  return (Array.isArray(stored) ? stored as Ended[] : []).filter(item => Date.now() - item.endedAt < ENDED_MS);
}
const saveEnded = (ended: Ended[]) => chrome.storage.session.set({ [ENDED]: ended.filter(item => item.tabs.length).slice(-32) }).catch(() => {});
async function forgetEnded(tabIds: number[]) {
  const ended = await loadEnded(), before = JSON.stringify(ended);
  for (const item of ended) item.tabs = item.tabs.filter(tab => !tabIds.includes(tab.tabId));
  if (JSON.stringify(ended) !== before) await saveEnded(ended);
}
// 崩溃的会话没有机会清理，留个上限。
const saveReturned = (returned: Returned) => chrome.storage.local.set({ [RETURNED]: Object.fromEntries(Object.entries(returned).filter(([, tabs]) => tabs.length).slice(-64)) });
async function alive(records: GroupRecord[]) {
  const kept: GroupRecord[] = [];
  for (const record of records) {
    const group = await chrome.tabGroups.get(record.groupId).catch(() => undefined);
    if (group) kept.push({ ...record, windowId: group.windowId });
  }
  return kept;
}
const stored = async () => alive(await load());
const without = (ids: number[], tabId: number) => ids.filter(id => id !== tabId);

// 只在标签页没换窗口时放回去：用户把它拖走了就不再管。
async function restore(tabId: number, origin: Origin | undefined) {
  if (!origin) return;
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (tab && tab.windowId === origin.windowId) await whenEditable(() => chrome.tabs.move(tabId, { index: origin.index })).catch(() => {});
}

interface JoinInput { tabId: number; owner: string; agentId: string; title: string; color: string; claimed: boolean }
async function createGroup(input: JoinInput, windowId: number): Promise<GroupRecord> {
  const groupId = await whenEditable(() => chrome.tabs.group({ tabIds: [input.tabId], createProperties: { windowId } }));
  await whenEditable(() => chrome.tabGroups.update(groupId, { title: input.title, color: input.color as `${chrome.tabGroups.Color}` }));
  return { groupId, windowId, owner: input.owner, agentId: input.agentId, title: input.title, startedAt: new Date().toISOString(), tabs: [], origins: {} };
}
function join(input: JoinInput) {
  return serial(async () => {
    const records = await stored(), tab = await chrome.tabs.get(input.tabId);
    const mine = records.find(record => record.owner === input.owner && record.windowId === tab.windowId);
    if (mine && tab.groupId === mine.groupId) {
      mine.tabs = [...without(mine.tabs, input.tabId), input.tabId];
      await save(records);
      return { grouped: true, groupId: mine.groupId, title: mine.title };
    }
    // 固定的标签页和用户自己组里的标签页不动，免得打乱用户的整理。弹窗移进组窗口就没了，OAuth 这类流程会断。
    if (tab.pinned) return { grouped: false, reason: 'pinned' };
    if (tab.groupId !== UNGROUPED) return { grouped: false, reason: 'other_group' };
    if ((await chrome.windows.get(tab.windowId)).type !== 'normal') return { grouped: false, reason: 'popup' };
    const origin = { windowId: tab.windowId, index: tab.index }, record = mine ?? await createGroup(input, tab.windowId);
    if (mine) await whenEditable(() => chrome.tabs.group({ tabIds: [input.tabId], groupId: mine.groupId }));
    else records.push(record);
    record.tabs.push(input.tabId);
    if (input.claimed) record.origins[input.tabId] = origin;
    await save(records);
    await forgetEnded([input.tabId]);
    return { grouped: true, groupId: record.groupId, title: record.title };
  });
}

function leave(tabId: number, owner: string) {
  return serial(async () => {
    const records = await stored(), record = records.find(item => item.owner === owner && item.origins[tabId]);
    if (!record) return { left: false };
    const origin = record.origins[tabId], tab = await chrome.tabs.get(tabId).catch(() => undefined);
    delete record.origins[tabId];
    record.tabs = without(record.tabs, tabId);
    if (tab?.groupId === record.groupId) await whenEditable(() => chrome.tabs.ungroup(tabId));
    await restore(tabId, origin);
    await save(records);
    return { left: true };
  });
}

interface Dissolved { owner: string; tabIds: number[] }
export function dissolveGroups(match: { owner?: string; groupId?: number }) {
  return serial(async () => {
    const records = await stored(), ended: Dissolved[] = [], remembered = await loadEnded();
    for (const record of records.filter(item => item.owner === match.owner || item.groupId === match.groupId)) {
      const tabIds = (await chrome.tabs.query({ groupId: record.groupId })).flatMap(tab => tab.id === undefined ? [] : [tab.id]);
      // 用户点“结束并释放”是收回，不记。
      if (match.owner) {
        const tabs: EndedTab[] = [];
        for (const tabId of record.tabs) { const tab = await chrome.tabs.get(tabId).catch(() => undefined); if (tab) tabs.push({ tabId, origin: originOf(tab.url || tab.pendingUrl), claimed: !!record.origins[tabId] }); }
        if (tabs.length) remembered.push({ owner: record.owner, agentId: record.agentId, title: record.title, endedAt: Date.now(), tabs });
      }
      if (tabIds.length) await whenEditable(() => chrome.tabs.ungroup(tabIds as [number, ...number[]]));
      for (const [tabId, origin] of Object.entries(record.origins).sort((a, b) => a[1].index - b[1].index)) await restore(Number(tabId), origin);
      ended.push({ owner: record.owner, tabIds });
    }
    await save(records.filter(item => item.owner !== match.owner && item.groupId !== match.groupId));
    if (match.owner) { const returned = await loadReturned(); delete returned[match.owner]; await saveReturned(returned); await saveEnded(remembered); }
    else await forgetEnded(ended.flatMap(item => item.tabIds));
    return ended;
  });
}

function list() {
  return serial(async () => {
    const records = await stored(), tabs = await chrome.tabs.query({});
    await save(records);
    return Promise.all(records.map(async record => {
      const members = tabs.filter(tab => tab.groupId === record.groupId), ids = new Set(members.map(tab => tab.id));
      const group = await chrome.tabGroups.get(record.groupId).catch(() => undefined);
      // 弹窗进不了组，按打开它的标签页算到这个组：OAuth 窗口也是这次工作的一部分。
      const popups = tabs.filter(tab => tab.groupId === UNGROUPED && tab.openerTabId !== undefined && ids.has(tab.openerTabId) && !ids.has(tab.id));
      const view = (tab: chrome.tabs.Tab, popup: boolean) => ({ tabId: tab.id, title: tab.title || '', active: tab.active, ...(popup ? { popup: true } : {}) });
      return { groupId: record.groupId, windowId: record.windowId, owner: record.owner, agentId: record.agentId, title: record.title, startedAt: record.startedAt, color: group?.color, tabs: [...members.map(tab => view(tab, false)), ...popups.map(tab => view(tab, true))] };
    }));
  });
}

function windowOf(owner: string) {
  return serial(async () => {
    const record = (await stored()).find(item => item.owner === owner);
    return record ? { windowId: record.windowId } : {};
  });
}

// 写操作之前核对。弹窗和组里页面打开的链接算打开它的会话的，OAuth 这类流程中途不用接管。
function check(tabId: number, owner: string) {
  return serial(async () => {
    const records = await stored(), tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab) return { missing: true };
    const mine = records.filter(item => item.owner === owner), opener = tab.openerTabId;
    const member = mine.some(item => item.groupId === tab.groupId && item.tabs.includes(tabId) || opener !== undefined && item.tabs.includes(opener));
    const holder = records.find(item => item.owner !== owner && item.groupId === tab.groupId && item.tabs.includes(tabId))?.owner;
    // 原来属于哪个已经结束的会话：服务据此决定能不能直接接回，或在报错里写明。
    const ended = member || holder ? undefined : (await loadEnded()).findLast(item => item.tabs.some(entry => entry.tabId === tabId));
    const entry = ended?.tabs.find(item => item.tabId === tabId);
    return {
      member, takenBack: (await loadReturned())[owner]?.includes(tabId) === true, holder,
      ...(ended && entry ? { former: { owner: ended.owner, agentId: ended.agentId, title: ended.title, endedAt: new Date(ended.endedAt).toISOString(), sameOrigin: entry.origin !== '' && entry.origin === originOf(tab.url || tab.pendingUrl), claimed: entry.claimed, ungrouped: tab.groupId === UNGROUPED, pinned: tab.pinned } } : {}),
    };
  });
}

// 接管释放和解散都在各自的步骤里先从记录去掉标签页，排到这里时已经找不到了；还找得到的就是用户拖走的。
function groupChanged(tabId: number, groupId: number, released: (owner: string, tabIds: number[]) => void) {
  return serial(async () => {
    const records = await load(), returned = await loadReturned(), left = records.find(item => item.groupId !== groupId && item.tabs.includes(tabId)), entered = records.find(item => item.groupId === groupId);
    if (left) {
      left.tabs = without(left.tabs, tabId);
      returned[left.owner] = [...without(returned[left.owner] ?? [], tabId), tabId];
      delete left.origins[tabId];
      released(left.owner, [tabId]);
    }
    if (entered) {
      const opener = (await chrome.tabs.get(tabId).catch(() => undefined))?.openerTabId;
      if (returned[entered.owner]?.includes(tabId) || opener !== undefined && entered.tabs.includes(opener)) entered.tabs = [...without(entered.tabs, tabId), tabId];
      returned[entered.owner] = without(returned[entered.owner] ?? [], tabId);
    }
    if (left || entered) { await save(records); await saveReturned(returned); }
  });
}
export function attachGroupEvents(released: (owner: string, tabIds: number[]) => void) {
  chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.groupId !== undefined) void groupChanged(tabId, change.groupId, released).catch(() => {}); });
}

export async function showGroup(groupId: number) {
  const tabs = await chrome.tabs.query({ groupId }), target = tabs.find(tab => tab.active) ?? tabs[0];
  if (target?.id === undefined) return { shown: false };
  await chrome.tabs.update(target.id, { active: true });
  await chrome.windows.update(target.windowId, { focused: true });
  return { shown: true };
}

export async function groupCommand(operation: string, args: JsonObject) {
  if (operation === 'group.join') return join({ tabId: Number(args.tabId), owner: String(args.owner), agentId: String(args.agentId), title: String(args.title), color: String(args.color), claimed: args.claimed === true });
  if (operation === 'group.leave') return leave(Number(args.tabId), String(args.owner));
  if (operation === 'group.dissolve') return dissolveGroups(typeof args.groupId === 'number' ? { groupId: args.groupId } : { owner: String(args.owner) });
  if (operation === 'group.list') return list();
  if (operation === 'group.window') return windowOf(String(args.owner));
  if (operation === 'group.check') return check(Number(args.tabId), String(args.owner));
  if (operation === 'group.show') return showGroup(Number(args.groupId));
  throw new Error(`未知的标签组操作：${operation}`);
}
