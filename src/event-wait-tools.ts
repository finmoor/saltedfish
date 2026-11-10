import { z } from 'zod';
import type { ToolDefinition } from './tools.js';

const profileId = z.string().min(1).describe('明确的 Chrome 配置 ID；不会切换账号。');
const timeoutMs = z.number().int().min(100).max(300000).default(30000);

export const waitResponseArgs = z.object({
  url: z.string().url().max(8192).optional().describe('精确匹配响应 URL；与 urlContains、requestId 三选一。'),
  urlContains: z.string().min(1).max(2000).optional().describe('响应 URL 必须包含此字符串，不执行正则。'),
  requestId: z.string().min(1).max(200).optional().describe('精确的 Network requestId；有子会话时同时指定 sessionId。'),
  sessionId: z.string().min(1).max(200).optional(),
  method: z.string().regex(/^[A-Za-z]+$/).max(30).optional().describe('HTTP 方法，不区分大小写。'),
  status: z.number().int().min(100).max(599).optional().describe('所匹配请求的期望状态码；不符立即失败。'),
  since: z.number().int().nonnegative().describe('动作前 chrome_network_start 返回的 since，或 chrome_events.headSequence；只检查此游标之后捕获的请求，不追回启用前流量。'),
  waitFor: z.enum(['response', 'finished']).default('finished').describe('response 等到响应头；finished 还等待正文接收结束，随后可用 chrome_network_body。'),
}).strict().refine(value => [value.url, value.urlContains, value.requestId].filter(value => value !== undefined).length === 1, 'url、urlContains、requestId 必须且只能指定一个。');

export const waitDownloadArgs = z.object({
  downloadId: z.number().int().nonnegative().describe('chrome_download 或 chrome_downloads 返回的明确下载 ID。'),
}).strict();

// 不依赖 tools.ts，方便工具目录和任务步骤共用同一份严格 schema。
export const eventWaitToolDefinitions: ToolDefinition[] = [
  {
    name: 'chrome_wait_response',
    description: '等待指定游标后的网络响应，默认等正文接收结束；返回 requestId/sessionId。须先 network_start，并保存动作前游标。状态不符、请求失败或事件丢失明确失败；不会重发请求。',
    schema: waitResponseArgs.safeExtend({ profileId, tabId: z.number().int().nonnegative(), timeoutMs }),
    readOnly: true,
  },
  {
    name: 'chrome_wait_download',
    description: '等下载完成：downloadId 指定下载；tabId 等这个标签页的下一次下载（含 15 秒内刚开始的），连续等时把结果的 sequence 传给 since。中断或文件被删明确失败；超时提示是否被 Chrome 拦下。不会重复下载。',
    schema: z.object({ downloadId: waitDownloadArgs.shape.downloadId.optional(), tabId: z.number().int().nonnegative().optional().describe('等这个标签页的下一次下载；与 downloadId 二选一。'), since: z.number().int().nonnegative().optional().describe('只认这个事件游标之后开始的下载。'), profileId, timeoutMs }).strict()
      .refine(value => (value.downloadId === undefined) !== (value.tabId === undefined) && (value.since === undefined || value.tabId !== undefined), 'downloadId 和 tabId 必须且只能给一个；since 只和 tabId 一起用。'),
    readOnly: true,
  },
];

export type ResponseWaitArgs = z.infer<typeof waitResponseArgs>;
export type DownloadWaitArgs = z.infer<typeof waitDownloadArgs>;
