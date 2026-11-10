import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { projectDir } from '../src/config.js';
import { connectHelp } from '../src/client-connect.js';

// 真实运行 saltedfish help（src/npm-cli.ts）：帮助是用户发现选项的唯一入口，命令行实际接受的选项都必须写在里面。
async function run(args: string[]) {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(projectDir, 'src/npm-cli.ts'), ...args], { cwd: projectDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  const timer = setTimeout(() => child.kill(), 60_000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timer));
  return { code, stdout, stderr };
}
const read = (file: string) => readFile(path.join(projectDir, file), 'utf8');

test('saltedfish help 写明 dashboard 的 --onboarding / --logout-all 和 recover-lock 的 --forget-run', async () => {
  const { code, stdout, stderr } = await run(['help']);
  assert.equal(code, 0, stderr);
  // src/cli.ts 的 dashboard 实际有这两个选项；npm 入口的帮助必须同步，用户才能发现“注销全部管理页登录”
  assert.match(stdout, /dashboard \[--onboarding \| --logout-all\]/);
  assert.match(stdout, /--logout-all[^\n]*注销全部管理页登录/, '要说明 --logout-all 做什么（它不打开页面）');
  assert.match(stdout, /--onboarding[^\n]*接入页/);
  // npm 生命周期那批新增的恢复选项
  assert.match(stdout, /recover-lock \[--forget-run local\|gateway\]/);
  assert.match(stdout, /--forget-run[^\n]*陈旧的运行记录/);
  // connect --refresh 是升级后更新已登记连接的入口（docs/npm.md 在用），要在 connect 的用法行里，而不只出现在别处的说明里
  assert.match(stdout, /connect \[--clients[^\n]*\n[^\n]*\[--preview \| --history \| --restore ID \| --refresh\]/);
  // `saltedfish --help` 与 `saltedfish help` 输出一致
  assert.equal((await run(['--help'])).stdout, stdout);
});

test('帮助覆盖命令行实际解析的每一个选项：新增选项后漏写帮助会让本用例失败', async () => {
  const { stdout } = await run(['help']);
  const parsed = new Set<string>();
  // npm 入口和 cli.ts 里以单引号字符串解析的选项（帮助模板是反引号字符串，不会混进来）
  for (const file of ['src/npm-cli.ts', 'src/cli.ts']) for (const match of (await read(file)).matchAll(/'(--[a-z][a-z-]*)'/g)) parsed.add(match[1]!);
  // 接入命令自己声明的用法
  for (const match of connectHelp.matchAll(/--[a-z][a-z-]*/g)) parsed.add(match[0]);
  parsed.delete('--help'); // 它是显示帮助本身
  assert.ok(parsed.size >= 20, `扫描应取到全部选项，实际 ${[...parsed].join(' ')}`);
  for (const required of ['--onboarding', '--logout-all', '--forget-run', '--refresh', '--device-name', '--profiles', '--read-only', '--version']) assert.ok(parsed.has(required), `扫描遗漏 ${required}`);
  assert.deepEqual([...parsed].filter(option => !stdout.includes(option)), [], '这些选项命令行会解析，但帮助里没有');
});

test('帮助里的子命令与 cli.ts 的用法一致：clients / results / version 不再只是省略号', async () => {
  const { stdout } = await run(['help']);
  assert.match(stdout, /clients list \| add NAME \[--profiles UUID,UUID\] \[--read-only\] \| revoke ID/);
  assert.match(stdout, /results list \| remove ARTIFACT_ID/);
  assert.match(stdout, /\bversion\b/);
  assert.match(stdout, /gateway init[^\n]*\n[^\n]*--device-name NAME[^\n]*--no-start/, 'gateway init 实际接受 --device-name 与 --no-start');
});
