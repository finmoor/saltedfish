import test from 'node:test';
import assert from 'node:assert/strict';
import { framePoint } from '../extension/frame-point.js';
import { errorInfo, type JsonObject } from '../src/shared.js';

// 页面里既有跨进程 iframe 又有 dedicated worker 时，遍历子会话读取 frame 树不能因某个会话没有 Page 域而整体失败。
// 这里用脚本化的 CDP 应答覆盖 framePoint 的这一段逻辑；真实 Chrome 的目标类型与错误文本需实机验证。
// 帧结构：main（顶层）→ child（会话 outer 内的跨进程 iframe）→ grandchild（会话 inner 内的跨进程 iframe，点击目标所在）；worker 会话没有 frame 树。
function scripted(brokenSessions: string[]) {
  const calls: { method: string; sessionId?: string }[] = [];
  const trees: Record<string, JsonObject> = { outer: { id: 'child', parentId: 'main' }, inner: { id: 'grandchild', parentId: 'child' } };
  const send = async (_tabId: number, method: string, _params: JsonObject = {}, sessionId?: string): Promise<JsonObject> => {
    calls.push({ method, sessionId });
    if (method === 'Page.getFrameTree') {
      if (sessionId && (brokenSessions.includes(sessionId) || sessionId === 'worker')) throw new Error(JSON.stringify({ code: -32601, message: "'Page.getFrameTree' wasn't found" }));
      return { frameTree: { frame: sessionId ? trees[sessionId] : { id: 'main' } } };
    }
    if (method === 'DOM.getFrameOwner') return { backendNodeId: 7 };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'owner-node' } };
    if (method === 'DOM.getBoxModel') return { model: { content: [100, 100, 300, 100, 300, 250, 100, 250], border: [0, 0, 1000, 0, 1000, 800, 0, 800] } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: true } };
    return {};
  };
  const evaluate = async (_tabId: number, expression: string, _args: JsonObject, _deadline: number, byValue?: boolean): Promise<unknown> => {
    if (byValue === false) return { objectId: 'document-element' };
    if (expression.includes('FengPage.pageDom')) return { x: 20, y: 30, width: 300, height: 150, documentId: 'doc-1', ref: 'doc-1:1' };
    return { x: 0, y: 0, w: 1000, h: 800, width: 1000, height: 800, unsupported: false };
  };
  const contexts = [{ id: 1, auxData: { isDefault: true, frameId: 'main' } }, { id: 5, sessionId: 'outer', auxData: { isDefault: true, frameId: 'child' } }, { id: 6, sessionId: 'inner', auxData: { isDefault: true, frameId: 'grandchild' } }];
  return { calls, access: { send, evaluate, contexts: () => contexts as JsonObject[], sessions: () => ['outer', 'inner', 'worker'], context: async () => 77 } };
}
const target = { action: 'click', selector: '#pay', sessionId: 'inner' };

test('页面同时有跨进程 iframe 和 worker：worker 会话读取 frame 树失败时被跳过，仍得到所在会话的输入坐标', async () => {
  const { calls, access } = scripted([]);
  const point = await framePoint(1, target, Date.now() + 5000, access);
  assert.deepEqual({ x: point.x, y: point.y, documentId: point.documentId, ref: point.ref }, { x: 20, y: 30, documentId: 'doc-1', ref: 'doc-1:1' });
  assert.ok(calls.some(call => call.method === 'Page.getFrameTree' && call.sessionId === 'worker'), '确实尝试并跳过了 worker 会话');
});

test('跳过不能掩盖缺失的父链：祖先 frame 所在会话读不出 frame 树时，是明确的未派发拒绝（UNKNOWN_FRAME），而不是未分类的原始错误或猜测坐标', async () => {
  const { access } = scripted(['outer']);
  await assert.rejects(framePoint(1, target, Date.now() + 5000, access), (error: unknown) => {
    const info = errorInfo(error);
    assert.equal(info.code, 'UNKNOWN_FRAME'); assert.equal(info.phase, 'precondition'); assert.equal(info.outcome, 'not_dispatched');
    return true;
  });
});
