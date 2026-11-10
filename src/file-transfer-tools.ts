import { z } from 'zod';
import type { ToolDefinition } from './tools.js';

import {FILE_CHUNK_BYTES,FILE_MAX_BYTES} from './file-limits.js';
export {FILE_CHUNK_BYTES,FILE_MAX_BYTES} from './file-limits.js';
const profile = { profileId: z.string().min(1) };
const transfer = { ...profile, transferId: z.string().uuid() };
export const transferFilename = z.string().min(1).max(200).refine(value => !/[\\/:\x00-\x1f<>"|?*]/.test(value) && value !== '.' && value !== '..' && !/[. ]$/.test(value) && !/^(CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)/i.test(value), '只接受普通文件名，不接受路径、设备名或结尾空格/点。');
export const fileBeginArgs = z.object({ ...profile, filename: transferFilename, size: z.number().int().min(0).max(FILE_MAX_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/i), submissionId: z.string().uuid().describe('本次文件传输生成一次 UUID，重试复用。') }).strict();
export const fileWriteArgs = z.object({ ...transfer, offset: z.number().int().nonnegative(), base64: z.string().min(1).max(Math.ceil(FILE_CHUNK_BYTES / 3) * 4).describe('最多 256 KiB 原始字节的标准 base64；offset 是字节偏移，重复块必须与已接收字节完全相同。') }).strict();
export const fileReadArgs = z.object({ ...transfer, offset: z.number().int().nonnegative().default(0), length: z.number().int().min(1).max(FILE_CHUNK_BYTES).default(16384) }).strict();
export const fileExportArgs = z.object({ ...profile, downloadId: z.number().int().nonnegative(), submissionId: z.string().uuid() }).strict();
const entry = (name: string, description: string, schema: z.ZodType, readOnly: boolean): ToolDefinition => ({ name: `chrome_${name}`, description, schema, readOnly });
export const fileTransferToolDefinitions: ToolDefinition[] = [
  entry('file_begin', '接收 Agent 传入的文件内容：声明文件名、字节数与 SHA256，返回 transferId；只写入当前服务专用暂存目录。按浏览器和客户端隔离；最多 100 MiB，1 小时到期。同一 submissionId 重试返回原传输。', fileBeginArgs, false),
  entry('file_write', '按字节偏移顺序写入一个 base64 文件块；最多 256 KiB。相同块重试不会重复追加；不允许跨过尚未收到的内容。随后 file_commit 核对完整文件。', fileWriteArgs, false),
  entry('file_commit', '核对已收文件的完整长度与 SHA256；成功后可把 transferId 传给 chrome_upload 的 transferIds。不执行网页上传；校验失败不提供该文件。重复提交返回原已完成结果。', z.object(transfer).strict(), false),
  entry('file_status', '查询本客户端在指定浏览器下的文件传输进度、到期时间与校验状态；不返回服务暂存路径。', z.object(transfer).strict(), true),
  entry('file_read', '按字节偏移读取当前服务中已完成传输的 base64 块，返回下一偏移与 eof；只访问本客户端已授权的 transferId。浏览器下载须先 file_export，再分块读取。', fileReadArgs, true),
  entry('file_export', '读取指定浏览器中已完成的 Chrome downloadId，保存到当前服务并返回 transferId、长度与 SHA256。直连浏览器需要浏览器电脑上的可选助手（当前提供Windows版），只读这个 downloadId 对应的下载文件，不接受任意路径。重复 submissionId 返回原快照。', fileExportArgs, false),
];
