import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectDir } from '../src/config.js';
import { testDirectory } from './helpers.js';
import { comparePerformance, performanceThresholds, type PerformanceRun } from './performance-compare.js';

const evidence = await import(new URL('../scripts/release-evidence.mjs', import.meta.url).href);
const testFiles = () => readdir(path.join(projectDir, 'tests'));

test('每个集成测试要么属于某个发行门禁分组，要么在带理由的豁免清单里；新增文件悄悄漏掉会让本测试失败', async () => {
  const plan = evidence.assertIntegrationPlan(await testFiles());
  // 曾经漏在门禁外的两个：extension-compatibility 是 interaction-v5 反向检查的唯一回归，product-depth 覆盖 F05–F09。
  for (const name of ['extension-compatibility.integration.ts', 'product-depth.integration.ts', 'execution-regressions.integration.ts', 'execution-review.integration.ts', 'interaction.integration.ts', 'navigation.integration.ts', 'styled-controls.integration.ts']) {
    assert.ok(plan.browserSuite.includes(name), `${name} 应在 browser 分组`);
  }
  assert.deepEqual(plan.browserEntry, ['browser.integration.ts']);
  assert.ok(plan.ui.length >= 7 && plan.ui.every((name: string) => name.startsWith('ui')));
  assert.deepEqual(plan.performance.sort(), ['interaction-performance.integration.ts', 'service-performance.integration.ts']);
  assert.ok(!plan.browserSuite.some((name: string) => name.includes('performance')));
  // 豁免必须写明原因和证据路径；需要外网的 todomvc 明确在门禁外。
  for (const [name, reason] of Object.entries(evidence.integrationExemptions) as [string, string][]) assert.ok(reason.length >= 30, `${name} 的豁免理由太简略`);
  assert.match(evidence.integrationExemptions['todomvc.integration.ts'], /外网/);
  assert.deepEqual(Object.keys(evidence.integrationExemptions).sort(), ['claude-trust.integration.ts', 'client-compat.integration.ts', 'codex-trust.integration.ts', 'npm-package.integration.ts', 'opencode-trust.integration.ts', 'self-update.integration.ts', 'todomvc.integration.ts']);
});

test('集成测试归类规则：未归类、过期豁免和重复归类都被指出', () => {
  const base = ['browser.integration.ts', 'execution.integration.ts', 'ui-a.integration.ts', 'service-performance.integration.ts', 'interaction-performance.integration.ts', 'npm-package.integration.ts', 'client-compat.integration.ts', 'codex-trust.integration.ts', 'opencode-trust.integration.ts', 'todomvc.integration.ts', 'unit.test.ts'];
  assert.deepEqual(evidence.integrationGroups(base).unclassified, []);
  assert.deepEqual(evidence.integrationGroups([...base, 'brand-new.integration.ts', 'execution-performance.integration.ts']).unclassified, ['brand-new.integration.ts', 'execution-performance.integration.ts']);
  assert.throws(() => evidence.assertIntegrationPlan([...base, 'brand-new.integration.ts']), /brand-new\.integration\.ts/);
  assert.throws(() => evidence.releaseCommands([...base, 'brand-new.integration.ts'], { npmCli: 'npm' }), /brand-new\.integration\.ts/);
  assert.throws(() => evidence.assertIntegrationPlan(base.filter(name => name !== 'todomvc.integration.ts')), /已不存在.*todomvc/);
  const overlapping = evidence.integrationGroups(base);
  assert.deepEqual(overlapping.overlappingExemptions, []);
});

test('verify:release 实际执行的命令包含 extension-compatibility 与 product-depth，且各分组范围不变', async () => {
  const files = await testFiles(), commands = evidence.releaseCommands(files, { npmCli: '/npm-cli.js' });
  assert.deepEqual(commands.typecheck, [['/npm-cli.js', 'run', 'typecheck']]);
  assert.deepEqual(commands.browser[0], ['--import', 'tsx', 'tests/browser.integration.ts']);
  const suite = commands.browser[1] as string[];
  assert.deepEqual(suite.slice(0, 4), ['--import', 'tsx', '--test', '--test-concurrency=1']);
  for (const name of ['extension-compatibility', 'product-depth', 'interaction', 'navigation', 'styled-controls', 'execution-regressions']) assert.ok(suite.includes(`tests/${name}.integration.ts`), name);
  for (const name of ['todomvc', 'npm-package', 'client-compat', 'interaction-performance', 'service-performance']) assert.ok(!suite.includes(`tests/${name}.integration.ts`), name);
  assert.ok((commands.ui[0] as string[]).every(arg => !arg.startsWith('tests/') || /tests\/ui[\w-]*\.integration\.ts$/.test(arg)));
  assert.ok((commands.service[0] as string[]).includes('tests/release-gates.test.ts'));
  assert.ok((commands.service[0] as string[]).every(arg => !arg.startsWith('tests/') || arg.endsWith('.test.ts')));
  assert.deepEqual(commands.performance.map((command: string[]) => command.filter(arg => arg.startsWith('tests/'))), [['tests/service-performance.integration.ts'], ['tests/interaction-performance.integration.ts']]);
  assert.equal(commands.performance[0][0], '--expose-gc');
});

test('npm-package 集成测试里的每个 check 名称与共享场景清单一致（含 Windows 专属与上一版场景）', async () => {
  const source = await readFile(path.join(projectDir, 'tests/npm-package.integration.ts'), 'utf8');
  const literals = [...source.matchAll(/check\('([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(literals, evidence.npmScenarioNames('win32', true));
  assert.deepEqual(literals.filter(name => name !== evidence.npmScenarioNames('win32', true)[4]), evidence.npmScenarioNames('linux', true));
  assert.ok(source.includes('npmScenarioNames(process.platform,!!packed.previous)'), '测试末尾必须逐项比对场景清单，而不只是数数量');
});

async function runNpmPackageTest(env: Record<string, string | undefined>) {
  const temp = await testDirectory(), version = '0.0.0-gate-test.1';
  const record = path.join(temp.directory, 'record.json'), reportFile = path.join(projectDir, `.local/verification/npm-${process.platform}-${version}.json`);
  try {
    await writeFile(record, JSON.stringify({ version, target: path.join(temp.directory, 'missing.tgz'), stage: path.join(temp.directory, 'missing-stage'), sha256: 'a'.repeat(64), candidate: true }));
    await rm(reportFile, { force: true });
    // NODE_TEST_CONTEXT 来自外层测试运行器；留着它，内层 node --test 会按子进程模式静默退出。
    const { npm_execpath: _npm, SALTEDFISH_ALLOW_NO_PREVIOUS: _allow, NODE_TEST_CONTEXT: _context, ...inherited } = process.env;
    const child = spawn(process.execPath, ['--import', 'tsx', '--test', path.join(projectDir, 'tests/npm-package.integration.ts')], { cwd: projectDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...inherited, SALTEDFISH_TEST_PACKAGE_RECORD: record, SALTEDFISH_TEST_NPM: process.execPath, ...env } });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    return { code, output, report: JSON.parse(await readFile(reportFile, 'utf8')) };
  } finally { await rm(reportFile, { force: true }); await temp.cleanup(); }
}

test('npm-package 集成测试：候选记录缺少 previous 时立即失败；只有显式开关才跳过，且报告留下 skipped 标记', { timeout: 120000 }, async () => {
  const missing = await runNpmPackageTest({});
  assert.notEqual(missing.code, 0); assert.match(missing.output, /候选记录没有 previous/); assert.equal(missing.report.passed, false); assert.equal(missing.report.previousScenario, undefined); assert.deepEqual(missing.report.checks, []);
  const allowed = await runNpmPackageTest({ SALTEDFISH_ALLOW_NO_PREVIOUS: '1' });
  // 开关打开后测试继续往下走，随后因为这条合成记录没有真实安装包而在别处失败。
  assert.notEqual(allowed.code, 0); assert.doesNotMatch(allowed.output, /候选记录没有 previous/); assert.equal(allowed.report.previousScenario, 'skipped'); assert.equal(allowed.report.passed, false);
});

const run = (p95 = 10, cdpBytes = 1000, cdpCalls = 3): PerformanceRun => ({ p50: 5, p95, cdpBytes, cdpCalls });
const runs = (patch: Record<string, PerformanceRun> = {}) => ({ warmInspect: run(), click: run(), fill: run(), insertText: run(), ...patch });

test('交互性能比较：没有基线明确标为未比较；四类操作的 p95、CDP 字节和调用数回退都会被发现', () => {
  const strict = performanceThresholds({ PERF_MAX_CDP_RATIO: '1.01' });
  assert.deepEqual(comparePerformance(runs(), undefined, 100, strict), { compared: false, failures: [], comparison: undefined, baselineVersion: undefined });
  const same = comparePerformance(runs(), { version: '0.2.0-beta.21', controls: 100, runs: runs() }, 100, strict);
  assert.equal(same.compared, true); assert.deepEqual(same.failures, []); assert.equal(same.baselineVersion, '0.2.0-beta.21');
  const against = (patch: Record<string, PerformanceRun>, thresholds = strict) => comparePerformance(runs(patch), { controls: 100, runs: runs() }, 100, thresholds).failures;
  // 热读取字节：1.005 倍通过，1.02 倍超过 1.01 的上限。
  assert.deepEqual(against({ warmInspect: run(10, 1005) }), []);
  assert.match(against({ warmInspect: run(10, 1020) }).join(), /warmInspect: CDP bytes.*ratio 1\.01/);
  // 不设阈值时沿用原默认：热读取字节必须比基线少 70% 以上。
  assert.match(comparePerformance(runs(), { controls: 100, runs: runs() }, 100, performanceThresholds({})).failures.join(), /warmInspect/);
  // 点击、填值、插入文本此前不受任何断言约束。
  assert.match(against({ click: run(10, 1200) }).join(), /click: CDP bytes/);
  assert.deepEqual(against({ click: run(10, 1200) }, performanceThresholds({ PERF_MAX_CDP_RATIO: '1.01', PERF_MAX_ACTION_CDP_RATIO: '1.3' })), []);
  assert.match(against({ fill: run(10, 1000, 4) }).join(), /fill: 1 extra CDP calls/);
  assert.deepEqual(against({ fill: run(10, 1000, 4) }, performanceThresholds({ PERF_MAX_CDP_RATIO: '1.01', PERF_MAX_EXTRA_CALLS: '1' })), []);
  assert.match(against({ insertText: run(10, 1000, 5) }, performanceThresholds({ PERF_MAX_CDP_RATIO: '1.01', PERF_MAX_EXTRA_CALLS: '1' })).join(), /insertText: 2 extra CDP calls/);
  // beta.21 相对 beta.20 的实际变化（fill 字节 1.237 倍多 1 次调用，insertText 1.426 倍多 2 次调用）现在需要显式接受，而不是静默通过。
  const beta21 = against({ fill: run(10, 1237, 4), insertText: run(10, 1426, 5) });
  assert.equal(beta21.filter(failure => failure.startsWith('fill')).length, 2); assert.equal(beta21.filter(failure => failure.startsWith('insertText')).length, 2);
  // p95：超过 ×1.25+20ms 才算回退，边界值通过。
  assert.deepEqual(against({ click: run(10 * 1.25 + 20) }), []);
  assert.match(against({ click: run(10 * 1.25 + 20.5) }).join(), /click: p95 regression/);
  // 基线夹具不同或缺少某项数据，不能当作通过。
  assert.throws(() => comparePerformance(runs(), { controls: 5000, runs: runs() }, 100, strict), /baseline fixture must match/);
  assert.throws(() => comparePerformance(runs(), { runs: runs() }, 5000, strict), /baseline fixture must match/);
  // Chrome 参数不同的基线同样不可比：关闭 vsync 的结果不能和默认基线比较，顺序不影响结果也不算通过。
  const noVsync = ['--disable-gpu-vsync', '--disable-frame-rate-limit'];
  assert.throws(() => comparePerformance(runs(), { controls: 100, runs: runs() }, 100, strict, noVsync), /baseline fixture must match/);
  assert.throws(() => comparePerformance(runs(), { controls: 100, chromeArgs: noVsync, runs: runs() }, 100, strict), /baseline fixture must match/);
  assert.equal(comparePerformance(runs(), { controls: 100, chromeArgs: [...noVsync].reverse(), runs: runs() }, 100, strict, noVsync).compared, true);
  assert.match(comparePerformance(runs(), { controls: 100, runs: { ...runs(), fill: undefined } }, 100, strict).failures.join(), /fill: 基线没有这项数据/);
  assert.match(comparePerformance(runs(), { controls: 100, runs: runs({ click: { p50: 5, p95: 10, cdpBytes: Number.NaN, cdpCalls: 3 } }) }, 100, strict).failures.join(), /click: CDP bytes/);
});

test('交互性能阈值只接受有意义的取值', () => {
  assert.deepEqual(performanceThresholds({}), { maxCdpRatio: .3, maxActionCdpRatio: 1.1, maxExtraCalls: 0, p95Factor: 1.25, p95SlackMs: 20 });
  for (const env of [{ PERF_MAX_CDP_RATIO: '0' }, { PERF_MAX_CDP_RATIO: '1.2' }, { PERF_MAX_CDP_RATIO: 'abc' }, { PERF_MAX_ACTION_CDP_RATIO: '2.5' }, { PERF_MAX_EXTRA_CALLS: '1.5' }, { PERF_MAX_EXTRA_CALLS: '-1' }, { PERF_MAX_EXTRA_CALLS: '11' }]) {
    assert.throws(() => performanceThresholds(env), /PERF_MAX/, JSON.stringify(env));
  }
  assert.equal(performanceThresholds({ PERF_MAX_CDP_RATIO: '', PERF_MAX_EXTRA_CALLS: '2' }).maxExtraCalls, 2);
});

test('交互性能集成测试使用共享比较规则，并在报告里写明是否比较过', async () => {
  const source = await readFile(path.join(projectDir, 'tests/interaction-performance.integration.ts'), 'utf8');
  assert.ok(source.includes('comparePerformance(runs,') && source.includes('performanceThresholds(process.env)'));
  assert.ok(source.includes('compared:result.compared') && source.includes('report.passed=result.compared&&failures.length===0'));
  assert.ok(!source.includes('if(process.env.PERF_BASELINE){'), '性能断言不能再整体放在 PERF_BASELINE 条件里');
});
