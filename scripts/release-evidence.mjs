import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { packagedDocs } from './release-docs.mjs';

export const requiredReleaseGroups = ['typecheck', 'service', 'ui', 'browser', 'performance'];
const coveredDirectories = ['src', 'extension', 'ui', 'scripts', 'tests'];

async function hashSources(root, normalizeLineEndings) {
  const files = ['package.json', 'package-lock.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'packaging/npm-README.md', ...packagedDocs];
  async function visit(directory) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(relative);
      else if (entry.isFile()) files.push(relative);
    }
  }
  for (const directory of coveredDirectories) await visit(directory);
  for (const file of await readdir(root)) if (/^tsconfig.*\.json$/.test(file)) files.push(file);
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    let content = await readFile(path.join(root, file));
    // latin1 往返逐字节保真，只把 CRLF 折成 LF。
    if (normalizeLineEndings) content = Buffer.from(content.toString('latin1').replaceAll('\r\n', '\n'), 'latin1');
    hash.update(file).update('\0').update(content).update('\0');
  }
  return hash.digest('hex');
}
// 构建前后用来判断“源码有没有变”的指纹：工作区原始字节，任何改动（含换行符）都立即使候选作废。
export const sourceFingerprint = root => hashSources(root, false);
// 同一批文件、换行折成 LF 的指纹：只用于追溯。干净检出（git archive / 另一台电脑）上能重新算出同一个值，
// 原始字节指纹则受 core.autocrlf 影响；它不参与放行判断。
export const normalizedSourceFingerprint = root => hashSources(root, true);

const git = async (root, args) => (await promisify(execFile)('git', args, { cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })).stdout;
const listCap = 100;
// 记录候选包构建时的 git 提交与工作区状态，让证据能追溯到源码。clean=false 时 modified/untracked 说明偏离提交的文件。
// ignoredCovered 是被指纹覆盖、却被 .gitignore 排除的文件：干净检出里不会有它们，指纹因此无法复现。
export async function sourceProvenance(root) {
  try {
    const commit = (await git(root, ['rev-parse', 'HEAD'])).trim(), branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const entries = (await git(root, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'])).split('\0').filter(Boolean).map(entry => ({ xy: entry.slice(0, 2), file: entry.slice(3) }));
    const modified = entries.filter(entry => entry.xy !== '??').map(entry => entry.file), untracked = entries.filter(entry => entry.xy === '??').map(entry => entry.file);
    const ignoredCovered = (await git(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...coveredDirectories])).split('\0').filter(Boolean);
    return { schemaVersion: 1, commit, branch, clean: !modified.length && !untracked.length,
      modifiedCount: modified.length, modified: modified.slice(0, listCap), untrackedCount: untracked.length, untracked: untracked.slice(0, listCap), ignoredCovered };
  } catch (error) { throw new Error(`无法读取 git 提交与工作区状态，发行候选必须能追溯到源码：${error instanceof Error ? error.message : error}`); }
}

// ---- 集成测试与发行门禁分组 ----
// 每个 tests/*.integration.ts 要么属于下面某个门禁分组，要么在 integrationExemptions 里写明为什么不在门禁内。
export const browserEntryTests = ['browser.integration.ts'];
export const browserSuitePattern = /^(?:execution|interaction|navigation|styled-controls|extension-compatibility|product-depth).*\.integration\.ts$/;
export const uiSuitePattern = /^ui.*\.integration\.ts$/;
export const performanceTests = ['service-performance.integration.ts', 'interaction-performance.integration.ts'];
export const integrationExemptions = {
  'npm-package.integration.ts': 'npm run test:npm 在 Windows 与 Linux 各用同一候选包做真实安装与生命周期验收；promote-npm 逐平台核对报告（assertNpmReport）。',
  'client-compat.integration.ts': '需要已登录的真实模型客户端（Claude Code、OpenCode）；npm run test:clients 手工运行，证据为 .local/verification/client-*.json，在发行记录的 realModels 项独立标记。',
  'claude-trust.integration.ts': '需要本机装有 Claude Code CLI，模型换成本地桩，不用额度；npm run test:claude-trust 手工运行，证据为 claude-trust.json。',
  'self-update.integration.ts': '要操作真实的文件夹选择框和 Chrome 授权，只能在有桌面的 Windows 上跑，会弹出窗口；npm run test:self-update 手工运行，Chrome for Testing 和正式版各一次，结果写进发行记录。',
  'codex-trust.integration.ts': '需要真实 Codex CLI 和模型额度；npm run test:codex-trust 手工运行，证据为 codex-trust*.json，属 realModels 项。',
  'opencode-trust.integration.ts': '需要真实 OpenCode CLI 和模型额度；npm run test:opencode-trust 手工运行，证据为 opencode-trust*.json，属 realModels 项。',
  'todomvc.integration.ts': '需要访问外网 demo.playwright.dev，结果受第三方站点影响，不放进可重复的发行门禁；手工运行，证据为 .local/verification/todomvc-<版本>-isolated.json。',
};
export function integrationGroups(testFiles) {
  const integration = testFiles.filter(name => name.endsWith('.integration.ts'));
  const browserEntry = integration.filter(name => browserEntryTests.includes(name));
  const browserSuite = integration.filter(name => browserSuitePattern.test(name) && !name.includes('performance'));
  const ui = integration.filter(name => uiSuitePattern.test(name));
  const performance = integration.filter(name => performanceTests.includes(name));
  const grouped = new Set([...browserEntry, ...browserSuite, ...ui, ...performance]);
  return { browserEntry, browserSuite, ui, performance,
    unclassified: integration.filter(name => !grouped.has(name) && !Object.hasOwn(integrationExemptions, name)),
    staleExemptions: Object.keys(integrationExemptions).filter(name => !integration.includes(name)),
    overlappingExemptions: Object.keys(integrationExemptions).filter(name => grouped.has(name)) };
}
export function assertIntegrationPlan(testFiles) {
  const plan = integrationGroups(testFiles);
  assert.deepEqual(plan.unclassified, [], `这些集成测试既不在任何发行门禁分组也没有带理由的豁免，请在 scripts/release-evidence.mjs 归类：${plan.unclassified.join(', ')}`);
  assert.deepEqual(plan.staleExemptions, [], `豁免清单里的文件已不存在：${plan.staleExemptions.join(', ')}`);
  assert.deepEqual(plan.overlappingExemptions, [], `已在门禁分组内的文件不应再列入豁免：${plan.overlappingExemptions.join(', ')}`);
  return plan;
}

// verify:release 每个分组实际执行的 node 参数列表；独立成函数，使“哪些测试在门禁里”可以直接断言。
export function releaseCommands(testFiles, { npmCli }) {
  const plan = assertIntegrationPlan(testFiles);
  const test = (names, extra = []) => ['--import', 'tsx', '--test', ...extra, ...names.map(name => `tests/${name}`)];
  return {
    typecheck: [[npmCli, 'run', 'typecheck']],
    service: [test(testFiles.filter(name => name.endsWith('.test.ts')))],
    ui: [test(plan.ui, ['--test-concurrency=1'])],
    browser: [...plan.browserEntry.map(name => ['--import', 'tsx', `tests/${name}`]), test(plan.browserSuite, ['--test-concurrency=1'])],
    performance: [['--expose-gc', ...test(['service-performance.integration.ts'])], test(['interaction-performance.integration.ts'])],
  };
}

// 比较两个目录树的逐文件 SHA-256；用于确认直接读取工作区 dist/extension 的测试与候选 stage 里的产品字节一致。
// onlyLeft：只报告 a 里有而 b 里缺失或不同的文件，b 多出的文件不算差异。
export async function treeDifferences(a, b, { onlyLeft = false } = {}) {
  async function hashes(root) {
    const result = new Map();
    async function visit(directory) {
      for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
        const relative = directory ? `${directory}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await visit(relative);
        else if (entry.isFile()) result.set(relative, createHash('sha256').update(await readFile(path.join(root, relative))).digest('hex'));
      }
    }
    await visit(''); return result;
  }
  const [left, right] = await Promise.all([hashes(a), hashes(b)]);
  return [...new Set([...left.keys(), ...(onlyLeft ? [] : right.keys())])].sort().filter(file => left.get(file) !== right.get(file));
}

// 受测 stage 必须与候选 TGZ 逐字节一致：把 TGZ 解到临时目录，TGZ 里每个文件在 stage 里都要存在且哈希相同；
// stage 的 dist、ui 以及 package.json 里不能多出 TGZ 没有的文件（测试会直接导入 stage 的服务代码）。返回差异文件列表。
export async function stageDifferences(tgz, stage, { tarExecutable } = {}) {
  const { mkdtemp, rm } = await import('node:fs/promises'), os = await import('node:os');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'saltedfish-stage-check-'));
  try {
    // Windows 用系统自带 bsdtar：Git Bash 的 GNU tar 会把 C: 当成远程主机。
    const tar = tarExecutable || (process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar');
    await promisify(execFile)(tar, ['-xzf', tgz, '-C', temp], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    const packaged = path.join(temp, 'package'), different = await treeDifferences(packaged, stage, { onlyLeft: true });
    // stage 多出的文件只看产品代码目录。
    for (const directory of ['dist', 'ui']) for (const file of await treeDifferences(path.join(packaged, directory), path.join(stage, directory))) if (!different.includes(`${directory}/${file}`)) different.push(`${directory}/${file}`);
    return different.sort();
  } finally { await rm(temp, { recursive: true, force: true }); }
}

// ---- 上一发行版（npm 升级/回滚场景的基线） ----
function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) throw new Error(`版本号无效：${value}`);
  return { core: match.slice(1, 4).map(Number), pre: match[4] ? match[4].split('.') : [] };
}
export function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    if (numeric) return Number(x) < Number(y) ? -1 : 1;
    if (/^\d+$/.test(x) !== /^\d+$/.test(y)) return /^\d+$/.test(x) ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
// 在 release/ 里找版本号低于候选的最新冻结 npm 包；哈希必须同时匹配文件内容和旁边的 .sha256。没有更早的发行返回 undefined。
export async function previousRelease(releaseDirectory, version) {
  let names;
  try { names = await readdir(releaseDirectory); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  const found = names.map(name => /^saltedfish-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz$/.exec(name)).filter(Boolean)
    .map(match => ({ name: match[0], version: match[1] })).filter(item => compareVersions(item.version, version) < 0)
    .sort((x, y) => compareVersions(y.version, x.version))[0];
  if (!found) return undefined;
  const target = path.join(releaseDirectory, found.name);
  const recorded = /^([a-f0-9]{64})\b/.exec(await readFile(`${target}.sha256`, 'utf8').catch(() => ''))?.[1];
  assert.ok(recorded, `上一版发行包缺少有效的 ${found.name}.sha256，不能作为升级/回滚基线`);
  const sha256 = createHash('sha256').update(await readFile(target)).digest('hex');
  assert.equal(sha256, recorded, `上一版发行包 ${found.name} 与 .sha256 记录不一致，拒绝作为升级/回滚基线`);
  return { version: found.version, target, sha256 };
}

// ---- npm 生命周期报告 ----
export const npmPreviousScenario = '真实上一发行版升级与回滚门槛，拒绝不兼容降级且数据和信任保持';
export function npmScenarioNames(platform, withPrevious) {
  return [
    '离线 npm 安装与实际命令 shim，安装无后台或配置副作用',
    '安装本机后台与稳定配对路径，真实 SDK 握手发现 46 工具',
    'Codex/OpenCode 一次信任、原配置保留与重复接入幂等',
    '显式 stop 阻止 MCP 自动重启，start 后原凭据继续工作',
    ...(platform === 'win32' ? ['状态记录短暂文件共享锁释放后继续读取，不误判离线'] : []),
    '同一 npm 包的 gateway 后台、电脑离线首次接入与管理鉴权',
    'npm 更新不改变运行版本、PID、固定入口或客户端配置',
    '执行中升级拒绝，不打断或重放原操作',
    '明确 upgrade 切换两个角色，配对/六份凭据/一次信任保持',
    '跨版本 rollback 保留当前用户数据与信任，固定 MCP 入口继续可用',
    '升级和回滚保持显式停止的本机服务，不为更新扩展短暂启动',
    '校验损坏在停服前拒绝；启动失败回退两个角色',
    '升级后撤销一次信任仅影响此服务，日志有界可读且不泄漏令牌',
    '强制停止保留已派发操作的 unknown，重启不重放',
    '遗留管理锁需明确恢复，活进程锁不被抢占或杀死',
    'upgrade 自己下载新版再切换，不降级，连不上仓库不影响已装的包',
    ...(withPrevious ? [npmPreviousScenario] : []),
  ];
}
// allowNoPrevious 只给“确实没有更早发行”的首个版本用，必须由调用方显式传入，报告里会留下 previousScenario: 'skipped'。
export function assertNpmReport(report, { platform, candidate, allowNoPrevious = false }) {
  assert.equal(report.platform, platform, `${platform} 报告的 platform 字段是 ${report.platform}，不是在该平台生成的`);
  assert.equal(report.version, candidate.version, `${platform} 报告版本不匹配`);
  assert.equal(report.packageSha256, candidate.sha256, `${platform} 报告未绑定当前候选包`);
  // 生命周期测试不在五组门禁内、也不进 TGZ：只改测试时包哈希不变而源码指纹变，所以必须同时绑定指纹和提交记录。
  assert.equal(report.sourceFingerprint, candidate.sourceFingerprint, `${platform} 报告未绑定当前源码（测试或源码在报告之后改过），请重新跑 test:npm`);
  assert.deepEqual(report.provenance, candidate.provenance, `${platform} 报告未绑定当前候选的 git 提交记录`);
  assert.equal(report.passed, true, `${platform} 生命周期验收未通过`);
  assert.deepEqual(report.cleanupErrors, [], `${platform} 报告有清理错误`);
  const skipped = report.previousScenario === 'skipped';
  if (skipped) {
    assert.ok(allowNoPrevious, `${platform} 报告跳过了“真实上一发行版升级与回滚”场景；只有确认没有更早发行时才可设置 SALTEDFISH_ALLOW_NO_PREVIOUS=1 放行`);
    assert.equal(report.previousVersion, undefined, `${platform} 报告同时声明跳过和上一版本`);
  } else {
    assert.equal(typeof report.previousVersion, 'string', `${platform} 报告没有上一发行版本，该场景没有真实运行`);
    if (candidate.previous) assert.equal(report.previousVersion, candidate.previous.version, `${platform} 报告验证的上一版本不是候选记录里的 ${candidate.previous.version}`);
    assert.ok(compareVersions(report.previousVersion, candidate.version) < 0, `${platform} 报告的上一版本必须低于候选版本`);
    const states = report.stateVersions;
    assert.ok(states && Number.isInteger(states.previous) && Number.isInteger(states.current) && states.previous > 0 && states.current > 0, `${platform} 报告缺少 stateVersions，请用当前 test:npm 重新生成`);
    assert.ok(states.current >= states.previous, `${platform} 报告的数据格式版本倒退`);
    if (states.current > states.previous) assert.equal(report.incompatiblePreviousRollbackRejected, true, `${platform} 数据格式已升高（${states.previous}→${states.current}），但报告没有“拒绝不兼容降级”的证据`);
  }
  assert.deepEqual(report.checks, npmScenarioNames(platform, !skipped), `${platform} 报告的场景清单与要求不一致（缺项、多项或顺序变化）`);
}

// ---- 性能验收 ----
// 把交互性能测试写出的报告整理成 performance 分组报告里的 performance 字段。测试在没有基线时只采集数据（compared:false），
// 这里必须决定怎么处理：默认视为未通过，操作者显式放行（确实没有更早版本）时才记录为 waived。
export function performanceEvidence(measured, { reportFile, allowNoBaseline = false }) {
  const performance = { reportFile, baselineVersion: measured.baselineVersion, compared: measured.compared === true, thresholds: measured.thresholds, failures: measured.failures ?? [] };
  if (performance.compared) return { performance };
  if (allowNoBaseline) return { performance: { ...performance, waived: true, waiverReason: '操作者设置 PERF_ALLOW_NO_BASELINE=1，本次没有与上一版基线比较。' } };
  return { performance, failure: '交互性能没有与基线比较：设置 PERF_BASELINE 指向上一版的交互性能报告（确实没有更早版本时才设置 PERF_ALLOW_NO_BASELINE=1）。' };
}
// 性能门禁必须真的和基线比较过；确实没有基线的特例要显式放行并留在记录里，不能静默通过。
export function assertPerformanceEvidence(report) {
  const performance = report.performance;
  assert.ok(performance && typeof performance === 'object', 'performance 报告没有记录交互性能比较结果，请用当前 verify:release 重新验收');
  if (performance.compared === true) {
    assert.ok(performance.baselineVersion, 'performance 报告缺少基线版本');
    assert.ok(performance.thresholds && Number.isFinite(performance.thresholds.maxCdpRatio), 'performance 报告缺少阈值记录');
    assert.deepEqual(performance.failures, [], 'performance 报告含未通过的比较项');
  } else {
    assert.equal(performance.waived, true, 'performance 验收没有与基线比较：设置 PERF_BASELINE 指向上一版的交互性能报告后重新验收');
    assert.ok(performance.waiverReason, 'performance 无基线放行必须记录原因');
  }
}

export function assertReleaseEvidence(candidate, reports) {
  assert.match(candidate.sourceFingerprint || '', /^[a-f0-9]{64}$/, '候选包缺少源码指纹，请重新构建候选');
  assert.ok(candidate.provenance?.commit, '候选包缺少 git 提交与工作区状态记录，请重新构建候选');
  assert.match(candidate.normalizedSourceFingerprint || '', /^[a-f0-9]{64}$/, '候选包缺少规范化源码指纹，请重新构建候选');
  for (const group of requiredReleaseGroups) {
    const report = reports.find(item => item.group === group);
    assert.ok(report, `缺少 ${group} 发行验收`);
    assert.equal(report.schemaVersion, 1, `${group} 报告格式不匹配`);
    assert.equal(report.version, candidate.version, `${group} 报告版本不匹配`);
    assert.equal(report.packageSha256, candidate.sha256, `${group} 未绑定当前候选包`);
    assert.equal(report.sourceFingerprint, candidate.sourceFingerprint, `${group} 未绑定当前源码`);
    assert.deepEqual(report.provenance, candidate.provenance, `${group} 未绑定当前候选的 git 提交记录`);
    assert.equal(report.passed, true, `${group} 验收未通过`);
    assert.ok(report.commands.length > 0 && report.commands.every(command => command.exitCode === 0), `${group} 没有成功执行记录`);
    if (group === 'performance') assertPerformanceEvidence(report);
  }
}
