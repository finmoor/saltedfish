import path from 'node:path';
import { projectDir } from './config.js';

// 原生程序与 npm 固定 JS 入口共用配置，避免指向 npm 升级时会被替换的包路径。
export function clientLaunch() {
  if (process.env.SALTEDFISH_ENTRY) return { command: process.execPath, args: [process.env.SALTEDFISH_ENTRY, 'mcp'] };
  if (process.env.CHROME_MCP_LAUNCHER) return { command: process.env.CHROME_MCP_LAUNCHER, args: ['mcp'] };
  return { command: process.execPath, args: [path.join(projectDir, 'dist', 'cli.js'), 'mcp'] };
}
