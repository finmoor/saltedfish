import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// 测试要用的本机程序：先看环境变量，没有就按常见的安装位置找。找不到时照样返回默认位置，启动失败的报错里看得到去哪找过。
const windows = process.platform === 'win32';

// npm 全局包目录：Windows 在 node.exe 旁边，其他系统在 <prefix>/lib/node_modules。
export const globalNodeModules = windows ? path.join(path.dirname(process.execPath), 'node_modules') : path.join(path.dirname(process.execPath), '../lib/node_modules');

// Chrome for Testing：`npx @puppeteer/browsers install chrome@stable --path ~/.cache/puppeteer` 装到的位置，有多个版本时取最新的。
function chromeForTesting() {
  const root = path.join(homedir(), '.cache/puppeteer/chrome');
  const binaries = windows ? ['chrome-win64/chrome.exe'] : process.platform === 'darwin'
    ? ['chrome-mac-arm64', 'chrome-mac-x64'].map(folder => `${folder}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
    : ['chrome-linux64/chrome'];
  let versions: string[] = [];
  try { versions = readdirSync(root); } catch { /* 没装过 */ }
  const version = (name: string) => (name.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/)?.slice(1) ?? []).map(Number);
  const newer = (a: string, b: string) => { const x = version(a), y = version(b); for (let i = 0; i < 4; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return 0; };
  for (const name of versions.sort(newer).reverse()) for (const binary of binaries) {
    const file = path.join(root, name, binary);
    if (existsSync(file)) return file;
  }
  return path.join(root, '<版本>', binaries[0]!);
}

export const chromeTestExecutable = () => process.env.CHROME_TEST_EXECUTABLE || chromeForTesting();
// Claude Code 原生安装的位置。
export const claudeTestExecutable = () => process.env.CLAUDE_TEST_EXECUTABLE || path.join(homedir(), '.local/bin', windows ? 'claude.exe' : 'claude');
export const openCodeTestExecutable = () => process.env.OPENCODE_TEST_EXECUTABLE || path.join(globalNodeModules, '@opencode/cli/bin', windows ? 'opencode.exe' : 'opencode');
// npm 装的 Codex 把各平台的原生程序放在可选依赖里；只有 Windows x64 的路径是固定的，其他平台用 CODEX_TEST_EXECUTABLE 指定。
export const codexTestExecutable = () => process.env.CODEX_TEST_EXECUTABLE || path.join(globalNodeModules, '@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
