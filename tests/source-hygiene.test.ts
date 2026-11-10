import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { projectDir } from '../src/config.js';

// 与审核 maintainability:6 用同一种办法发现：对 src 工程（tsconfig.json 的 include，也就是整个 src）开启 noUnusedLocals（只读，--noEmit，不写任何文件）。
// beta.22 清掉最后三处历史遗留后，范围从“接入向导与 npm 命令行”扩大到整个 src：今后任何文件新增的未使用导入或局部变量都会在这里失败。
// 诊断码：6133 单个名字未使用；6192 整条 import 的名字都未使用（多个名字时 tsc 报它而不是 6133，只认 6133 会放过）；
// 6196 未使用的类型/接口；6198 解构出的名字都未使用；6199 整条变量声明都未使用；6205 类型参数都未使用。
const unusedCode = /error TS(?:6133|6192|6196|6198|6199|6205):/;
const tsc = path.join(projectDir, 'node_modules/typescript/bin/tsc');
const lines = (text: string) => text.split(/\r?\n/);

async function compile(args: string[], cwd: string) {
  const child = spawn(process.execPath, [tsc, '--noEmit', '--pretty', 'false', ...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  const timer = setTimeout(() => child.kill(), 240_000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timer));
  return { code, stdout, stderr };
}

test('src 下没有未使用的导入或局部变量（tsc --noUnusedLocals，整个 src 工程）', async () => {
  const { code, stdout, stderr } = await compile(['--noUnusedLocals', '-p', 'tsconfig.json'], projectDir);
  // 编译器确实跑了：要么全部通过，要么有诊断输出——否则“没有诊断”可能只是 tsc 没启动。
  assert.ok(code === 0 || /error TS\d+/.test(stdout), `tsc 没有正常运行（退出码 ${code}）：${stderr}${stdout}`.slice(0, 2000));
  assert.deepEqual(lines(stdout).filter(line => unusedCode.test(line)), [], '这些文件里有声明了却从未读取的导入/变量，应删除');
});

test('检查范围覆盖整个 src：src 下每个 .ts 文件都在 tsconfig.json 的编译范围内', async () => {
  const { stdout } = await compile(['--listFilesOnly', '-p', 'tsconfig.json'], projectDir);
  const covered = new Set(lines(stdout).filter(Boolean).map(line => path.resolve(line.trim())));
  const files = readdirSync(path.join(projectDir, 'src'), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.ts')).map(entry => path.resolve(entry.parentPath, entry.name));
  assert.ok(files.length > 20, '应当读到 src 下的源码文件');
  assert.deepEqual(files.filter(file => !covered.has(file)), [], '这些文件不在 tsconfig.json 的编译范围内，未使用导入检查覆盖不到它们');
});

test('检测办法本身有效：单个未使用的名字（6133）和整条未使用的 import（6192）都会被抓到，被使用的不误报', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'saltedfish-hygiene-'));
  try {
    await writeFile(path.join(directory, 'dep.ts'), 'export const alpha = 1, beta = 2;\n');
    await writeFile(path.join(directory, 'one.ts'), "import { alpha, beta } from './dep.js';\nexport const value = alpha;\n");
    await writeFile(path.join(directory, 'all.ts'), "import { alpha, beta } from './dep.js';\nexport const other = 1;\n");
    await writeFile(path.join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true, types: [] }, include: ['*.ts'] }));
    const { stdout } = await compile(['--noUnusedLocals', '-p', 'tsconfig.json'], directory);
    const found = lines(stdout).filter(line => unusedCode.test(line));
    assert.ok(found.some(line => line.startsWith('one.ts(') && line.includes('TS6133') && line.includes("'beta'")), stdout);
    assert.ok(found.some(line => line.startsWith('all.ts(') && line.includes('TS6192')), stdout);
    assert.equal(found.length, 2, `只应有这两条：${stdout}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
