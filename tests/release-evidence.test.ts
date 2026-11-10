import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { testDirectory } from './helpers.js';
import { projectDir } from '../src/config.js';

const evidence = await import(new URL('../scripts/release-evidence.mjs', import.meta.url).href);
const docs = await import(new URL('../scripts/release-docs.mjs', import.meta.url).href);

const provenance = { schemaVersion: 1, commit: 'a'.repeat(40), branch: 'main', clean: true, modifiedCount: 0, modified: [], untrackedCount: 0, untracked: [], ignoredCovered: [] };
const performance = { reportFile: 'interaction-performance-release.json', baselineVersion: '0.2.0-beta.21', compared: true, thresholds: { maxCdpRatio: 1.01 }, failures: [] };
const candidate = { version: '0.2.0-beta.22', sha256: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64), normalizedSourceFingerprint: 'c'.repeat(64), provenance };
const groupReports = (patch: Record<string, unknown> = {}) => evidence.requiredReleaseGroups.map((group: string) => ({ schemaVersion: 1, group, version: candidate.version, packageSha256: candidate.sha256, sourceFingerprint: candidate.sourceFingerprint, provenance, passed: true, commands: [{ exitCode: 0 }], ...(group === 'performance' ? { performance } : {}), ...patch }));

test('冻结验收拒绝缺项、其他包、其他源码、其他提交记录和失败结果', () => {
  const reports = groupReports();
  evidence.assertReleaseEvidence(candidate, reports);
  assert.throws(() => evidence.assertReleaseEvidence(candidate, reports.slice(1)));
  for (const patch of [{ packageSha256: 'c'.repeat(64) }, { sourceFingerprint: 'c'.repeat(64) }, { passed: false }, { commands: [] }, { provenance: { ...provenance, commit: 'd'.repeat(40) } }, { provenance: undefined }]) {
    assert.throws(() => evidence.assertReleaseEvidence(candidate, [{ ...reports[0], ...patch }, ...reports.slice(1)]), Error, JSON.stringify(patch));
  }
  // 候选记录必须带 git 提交与规范化指纹，旧格式候选要求重新构建。
  assert.throws(() => evidence.assertReleaseEvidence({ ...candidate, provenance: undefined }, reports), /git 提交/);
  assert.throws(() => evidence.assertReleaseEvidence({ ...candidate, normalizedSourceFingerprint: undefined }, reports), /规范化源码指纹/);
});

test('性能分组必须与基线比较过：无基线默认拒绝，显式放行留痕，比较失败拒绝', () => {
  const withPerformance = (value: unknown) => groupReports().map((report: any) => report.group === 'performance' ? { ...report, performance: value } : report);
  evidence.assertReleaseEvidence(candidate, withPerformance(performance));
  const missing = groupReports().map((report: any) => { if (report.group !== 'performance') return report; const { performance: _, ...rest } = report; return rest; });
  assert.throws(() => evidence.assertReleaseEvidence(candidate, missing), /没有记录交互性能比较结果/);
  assert.throws(() => evidence.assertReleaseEvidence(candidate, withPerformance({ ...performance, compared: false })), /没有与基线比较/);
  assert.throws(() => evidence.assertReleaseEvidence(candidate, withPerformance({ ...performance, compared: false, waived: true })), /记录原因/);
  evidence.assertReleaseEvidence(candidate, withPerformance({ ...performance, compared: false, waived: true, waiverReason: '首个版本' }));
  assert.throws(() => evidence.assertReleaseEvidence(candidate, withPerformance({ ...performance, failures: ['click: p95 regression'] })), /未通过的比较项/);
  assert.throws(() => evidence.assertReleaseEvidence(candidate, withPerformance({ ...performance, thresholds: undefined })), /阈值/);
  assert.throws(() => evidence.assertReleaseEvidence(candidate, withPerformance({ ...performance, baselineVersion: undefined })), /基线版本/);
});

test('交互性能报告整理：比较过则记录阈值与基线；无基线默认不通过，显式放行才记为 waived', () => {
  const measured = { baselineVersion: '0.2.0-beta.21', compared: true, thresholds: { maxCdpRatio: 1.01 }, failures: [] };
  const compared = evidence.performanceEvidence(measured, { reportFile: 'r.json' });
  assert.equal(compared.failure, undefined); assert.equal(compared.performance.compared, true); assert.equal(compared.performance.baselineVersion, '0.2.0-beta.21');
  const none = { compared: false, thresholds: { maxCdpRatio: 1.01 }, failures: [] };
  assert.match(evidence.performanceEvidence(none, { reportFile: 'r.json' }).failure, /PERF_BASELINE/);
  const waived = evidence.performanceEvidence(none, { reportFile: 'r.json', allowNoBaseline: true });
  assert.equal(waived.failure, undefined); assert.equal(waived.performance.waived, true); assert.equal(waived.performance.compared, false);
  assert.match(waived.performance.waiverReason, /PERF_ALLOW_NO_BASELINE/);
  // 旧报告没有 compared 字段（beta.21 及以前），不能被当成比较过。
  assert.equal(evidence.performanceEvidence({ baselineVersion: '0.2.0-beta.20', failures: [] }, { reportFile: 'r.json' }).performance.compared, false);
});

test('用户文档随包完整可达，缺链接或过时安装命令阻止打包', async () => {
  const temp = await testDirectory();
  try {
    const pkg = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'));
    await writeFile(path.join(temp.directory, 'package.json'), JSON.stringify(pkg));
    for (const file of docs.packagedDocs as string[]) {
      const target = path.join(temp.directory, file); await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join(projectDir, file), target);
    }
    // 源码升版可以晚于独立修复分支；这里验证模板/包内链接机制，不替代check-release真值检查。
    const npmFile = path.join(temp.directory, 'docs/npm.md');
    await writeFile(npmFile, (await readFile(npmFile, 'utf8')).replace(/saltedfish-\d+\.\d+\.\d+-beta\.\d+\.tgz/g, `saltedfish-${pkg.version}.tgz`));
    const readme = await docs.packageReadme(projectDir);
    await writeFile(path.join(temp.directory, 'README.md'), readme);
    await docs.checkPackagedDocs(temp.directory);
    await writeFile(path.join(temp.directory, 'README.md'), readme + '\n[missing](docs/absent.md)');
    await assert.rejects(docs.checkPackagedDocs(temp.directory), /帮助不可达/);
    await writeFile(path.join(temp.directory, 'README.md'), readme);
    await writeFile(npmFile, 'npm install saltedfish-0.0.0-beta.1.tgz');
    await assert.rejects(docs.checkPackagedDocs(temp.directory), /版本过时/);
  } finally { await temp.cleanup(); }
});

test('版本比较遵循 semver：beta.9 < beta.10，预发布 < 正式版', () => {
  const ascending = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0',
    '0.2.0-beta.9', '0.2.0-beta.10', '0.2.0-beta.21', '0.2.0-beta.22', '0.2.0'];
  const sorted = (list: string[]) => [...list].sort(evidence.compareVersions);
  assert.deepEqual(sorted(ascending.slice(0, 11)), ascending.slice(0, 11));
  assert.deepEqual(sorted(ascending.slice(11)), ascending.slice(11));
  assert.equal(evidence.compareVersions('0.2.0-beta.22', '0.2.0-beta.22'), 0);
  assert.equal(evidence.compareVersions('0.2.0-beta.22', '0.2.0-beta.21'), 1);
  assert.throws(() => evidence.compareVersions('latest', '1.0.0'), /版本号无效/);
});

test('上一发行版取 release/ 里版本低于候选的最新冻结包，哈希必须匹配 .sha256；没有更早发行返回空', async () => {
  const temp = await testDirectory();
  try {
    const release = path.join(temp.directory, 'release'); await mkdir(release);
    const freeze = async (name: string, content: string, recorded?: string) => {
      await writeFile(path.join(release, name), content);
      await writeFile(path.join(release, `${name}.sha256`), `${recorded ?? createHash('sha256').update(content).digest('hex')}  ${name}\n`);
      return createHash('sha256').update(content).digest('hex');
    };
    assert.equal(await evidence.previousRelease(path.join(temp.directory, 'absent'), '0.2.0-beta.22'), undefined);
    assert.equal(await evidence.previousRelease(release, '0.2.0-beta.22'), undefined);
    await freeze('saltedfish-0.2.0-beta.9.tgz', 'nine'); await freeze('saltedfish-0.2.0-beta.20.tgz', 'twenty');
    const twentyOne = await freeze('saltedfish-0.2.0-beta.21.tgz', 'twenty-one');
    // 同版本、更高版本、其他形式的发行文件都不能被选作上一版。
    await freeze('saltedfish-0.2.0-beta.22.tgz', 'same'); await freeze('saltedfish-0.2.0-beta.23.tgz', 'newer'); await freeze('saltedfish-0.2.0.tgz', 'stable');
    await writeFile(path.join(release, 'saltedfish-0.2.0-beta.21-windows-x64.zip'), 'zip'); await writeFile(path.join(release, 'saltedfish-extension-0.2.0-beta.21.zip'), 'ext');
    const previous = await evidence.previousRelease(release, '0.2.0-beta.22');
    assert.deepEqual(previous, { version: '0.2.0-beta.21', target: path.join(release, 'saltedfish-0.2.0-beta.21.tgz'), sha256: twentyOne });
    assert.equal((await evidence.previousRelease(release, '0.2.0-beta.21')).version, '0.2.0-beta.20');
    assert.equal((await evidence.previousRelease(release, '0.2.0-beta.10')).version, '0.2.0-beta.9');
    assert.equal((await evidence.previousRelease(release, '0.2.0-beta.9')), undefined);
    // 文件被改动或 .sha256 缺失：拒绝，而不是悄悄退到更早的版本。
    await writeFile(path.join(release, 'saltedfish-0.2.0-beta.21.tgz'), 'tampered');
    await assert.rejects(evidence.previousRelease(release, '0.2.0-beta.22'), /与 \.sha256 记录不一致/);
    await freeze('saltedfish-0.2.0-beta.21.tgz', 'twenty-one'); await rm(path.join(release, 'saltedfish-0.2.0-beta.21.tgz.sha256'));
    await assert.rejects(evidence.previousRelease(release, '0.2.0-beta.22'), /缺少有效的/);
  } finally { await temp.cleanup(); }
});

function report(platform: string, patch: Record<string, unknown> = {}) {
  return { version: candidate.version, platform, packageSha256: candidate.sha256, sourceFingerprint: candidate.sourceFingerprint, provenance, time: new Date().toISOString(), checks: evidence.npmScenarioNames(platform, true), passed: true,
    incompatiblePreviousRollbackRejected: true, previousVersion: '0.2.0-beta.21', stateVersions: { previous: 1, current: 2 }, cleanupErrors: [], ...patch };
}
const npmCandidate = { ...candidate, previous: { version: '0.2.0-beta.21' } };

test('npm 生命周期报告：完整场景（含真实上一版升级与回滚）才放行，缺项、错平台、无上一版、数据格式升高却无降级拒绝证据都拒绝', () => {
  for (const platform of ['win32', 'linux']) {
    evidence.assertNpmReport(report(platform), { platform, candidate: npmCandidate });
    const names = evidence.npmScenarioNames(platform, true);
    for (let index = 0; index < names.length; index++) {
      assert.throws(() => evidence.assertNpmReport(report(platform, { checks: names.filter((_: string, i: number) => i !== index) }), { platform, candidate: npmCandidate }), /场景清单/, `缺少第 ${index + 1} 项`);
    }
    assert.throws(() => evidence.assertNpmReport(report(platform, { checks: [names[1], names[0], ...names.slice(2)] }), { platform, candidate: npmCandidate }), /场景清单/);
    assert.throws(() => evidence.assertNpmReport(report(platform, { checks: [...names, '额外场景'] }), { platform, candidate: npmCandidate }), /场景清单/);
  }
  assert.equal(evidence.npmScenarioNames('win32', true).length, 17); assert.equal(evidence.npmScenarioNames('linux', true).length, 16); assert.equal(evidence.npmScenarioNames('linux', false).length, 15);
  // 把 Windows 报告改名顶替 Linux 报告：platform 字段和场景清单都对不上。
  assert.throws(() => evidence.assertNpmReport(report('win32'), { platform: 'linux', candidate: npmCandidate }), /platform/);
  for (const patch of [{ version: '0.2.0-beta.21' }, { packageSha256: 'f'.repeat(64) }, { passed: false }, { cleanupErrors: ['left behind'] }, { previousVersion: '0.2.0-beta.20' }, { previousVersion: '0.2.0-beta.22' }, { previousVersion: undefined }]) {
    assert.throws(() => evidence.assertNpmReport(report('linux', patch), { platform: 'linux', candidate: npmCandidate }), Error, JSON.stringify(patch));
  }
  // 数据格式升高：必须有“拒绝不兼容降级”的证据；格式相同则不要求。
  assert.throws(() => evidence.assertNpmReport(report('linux', { incompatiblePreviousRollbackRejected: false }), { platform: 'linux', candidate: npmCandidate }), /拒绝不兼容降级/);
  assert.throws(() => evidence.assertNpmReport(report('linux', { incompatiblePreviousRollbackRejected: undefined }), { platform: 'linux', candidate: npmCandidate }), /拒绝不兼容降级/);
  evidence.assertNpmReport(report('linux', { stateVersions: { previous: 2, current: 2 }, incompatiblePreviousRollbackRejected: undefined }), { platform: 'linux', candidate: npmCandidate });
  assert.throws(() => evidence.assertNpmReport(report('linux', { stateVersions: { previous: 3, current: 2 } }), { platform: 'linux', candidate: npmCandidate }), /倒退/);
  assert.throws(() => evidence.assertNpmReport(report('linux', { stateVersions: undefined }), { platform: 'linux', candidate: npmCandidate }), /stateVersions/);
  // 候选记录没有 previous（手工记录）时仍要求报告证明确实跑过某个更低版本。
  evidence.assertNpmReport(report('linux'), { platform: 'linux', candidate });
});

test('npm 生命周期报告必须绑定当前源码指纹和提交记录：包哈希相同但测试指纹变了也拒绝', () => {
  for (const patch of [{ sourceFingerprint: 'e'.repeat(64) }, { sourceFingerprint: undefined }, { provenance: { ...provenance, commit: 'd'.repeat(40) } }, { provenance: undefined }]) {
    assert.throws(() => evidence.assertNpmReport(report('linux', patch), { platform: 'linux', candidate: npmCandidate }), /未绑定当前/, JSON.stringify(patch));
  }
});

test('stage 与候选 TGZ 逐文件比对：被改、被删、dist 里多出的文件都能发现', async () => {
  const temp = await testDirectory();
  try {
    const stage = path.join(temp.directory, 'stage'), pack = path.join(temp.directory, 'pack');
    for (const [file, text] of Object.entries({ 'package.json': '{}', 'dist/a.js': 'a', 'ui/app.js': 'u', 'node_modules/x/index.js': 'x' })) { await mkdir(path.dirname(path.join(pack, 'package', file)), { recursive: true }); await writeFile(path.join(pack, 'package', file), text); }
    const tgz = path.join(temp.directory, 'c.tgz');
    execFileSync(process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar', ['-czf', tgz, '-C', pack, 'package']);
    await cp(path.join(pack, 'package'), stage, { recursive: true });
    assert.deepEqual(await evidence.stageDifferences(tgz, stage), []);
    await writeFile(path.join(stage, 'dist/a.js'), 'tampered');
    assert.deepEqual(await evidence.stageDifferences(tgz, stage), ['dist/a.js']);
    await writeFile(path.join(stage, 'dist/a.js'), 'a'); await rm(path.join(stage, 'node_modules/x/index.js'));
    assert.deepEqual(await evidence.stageDifferences(tgz, stage), ['node_modules/x/index.js']);
    await writeFile(path.join(stage, 'node_modules/x/index.js'), 'x'); await writeFile(path.join(stage, 'dist/extra.js'), 'e');
    assert.deepEqual(await evidence.stageDifferences(tgz, stage), ['dist/extra.js']);
  } finally { await temp.cleanup(); }
});

test('跳过上一版场景只能显式放行：报告标记 skipped 且 promote 传入同一开关，二者缺一不可', () => {
  const skipped = (platform: string, patch: Record<string, unknown> = {}) => report(platform, { checks: evidence.npmScenarioNames(platform, false), previousScenario: 'skipped', previousVersion: undefined, stateVersions: undefined, incompatiblePreviousRollbackRejected: undefined, ...patch });
  assert.throws(() => evidence.assertNpmReport(skipped('linux'), { platform: 'linux', candidate }), /SALTEDFISH_ALLOW_NO_PREVIOUS/);
  evidence.assertNpmReport(skipped('linux'), { platform: 'linux', candidate, allowNoPrevious: true });
  evidence.assertNpmReport(skipped('win32'), { platform: 'win32', candidate, allowNoPrevious: true });
  // 没有声明跳过、也没有上一版本的报告（场景静默缺失）即使开关打开也不放行。
  assert.throws(() => evidence.assertNpmReport(report('linux', { checks: evidence.npmScenarioNames('linux', false), previousVersion: undefined }), { platform: 'linux', candidate, allowNoPrevious: true }), /没有上一发行版本/);
  assert.throws(() => evidence.assertNpmReport(skipped('linux', { previousVersion: '0.2.0-beta.21' }), { platform: 'linux', candidate, allowNoPrevious: true }), /同时声明/);
  assert.throws(() => evidence.assertNpmReport(skipped('linux', { checks: evidence.npmScenarioNames('linux', true) }), { platform: 'linux', candidate, allowNoPrevious: true }), /场景清单/);
});

async function sourceTree(root: string) {
  const files: Record<string, string> = { 'package.json': '{"name":"x"}\n', 'package-lock.json': '{}\n', 'README.md': '# x\n', 'LICENSE': 'l\n', 'THIRD_PARTY_NOTICES.md': 'n\n', 'packaging/npm-README.md': 'p\n',
    'src/a.ts': 'export const a = 1;\nexport const b = 2;\n', 'extension/b.ts': 'b\n', 'ui/c.js': 'c\n', 'scripts/d.mjs': 'd\n', 'tests/e.test.ts': 'e\n', 'tsconfig.json': '{}\n', '.gitignore': '*.pem\n' };
  for (const doc of docs.packagedDocs as string[]) files[doc] = `${doc}\n`;
  for (const [name, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); }
}

test('源码指纹按原始字节判定变化；规范化指纹忽略换行符差异，可从干净检出重新算出', async () => {
  const temp = await testDirectory();
  try {
    await sourceTree(temp.directory);
    const raw = () => evidence.sourceFingerprint(temp.directory), normalized = () => evidence.normalizedSourceFingerprint(temp.directory);
    const base = { raw: await raw(), normalized: await normalized() };
    // 全是 LF 的树（干净检出的样子）上两种指纹相同；工作区被 core.autocrlf 转成 CRLF 后原始指纹才偏离。
    assert.match(base.raw, /^[a-f0-9]{64}$/); assert.equal(base.raw, base.normalized);
    assert.deepEqual({ raw: await raw(), normalized: await normalized() }, base);
    const file = path.join(temp.directory, 'src/a.ts'), text = await readFile(file, 'utf8');
    await writeFile(file, text.replaceAll('\n', '\r\n'));
    assert.notEqual(await raw(), base.raw, '换行变化必须使原始指纹立即变化，构建期间的改动才会被发现');
    assert.equal(await normalized(), base.normalized);
    await writeFile(file, text.replace('= 2', '= 3'));
    assert.notEqual(await raw(), base.raw); assert.notEqual(await normalized(), base.normalized);
    await writeFile(file, text);
    assert.equal(await raw(), base.raw);
    await writeFile(path.join(temp.directory, 'tests/extra.ts'), 'x');
    assert.notEqual(await raw(), base.raw); assert.notEqual(await normalized(), base.normalized);
    await rm(path.join(temp.directory, 'tests/extra.ts'));
    await writeFile(path.join(temp.directory, 'notes.txt'), 'outside the covered set');
    assert.equal(await raw(), base.raw);
  } finally { await temp.cleanup(); }
});

const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'user.name=release-test', '-c', 'user.email=release-test@example.invalid', ...args], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

test('发行记录带 git 提交与工作区状态：干净、已修改、未跟踪、被忽略却被指纹覆盖的文件都能区分', async () => {
  const temp = await testDirectory();
  try {
    await sourceTree(temp.directory);
    gitIn(temp.directory, 'init', '-q'); gitIn(temp.directory, 'add', '-A'); gitIn(temp.directory, 'commit', '-q', '-m', 'initial');
    const head = gitIn(temp.directory, 'rev-parse', 'HEAD').trim();
    const clean = await evidence.sourceProvenance(temp.directory);
    assert.equal(clean.commit, head); assert.equal(clean.branch, gitIn(temp.directory, 'rev-parse', '--abbrev-ref', 'HEAD').trim());
    assert.equal(clean.clean, true); assert.deepEqual(clean.modified, []); assert.deepEqual(clean.untracked, []); assert.deepEqual(clean.ignoredCovered, []);
    await writeFile(path.join(temp.directory, 'src/a.ts'), 'changed\n');
    const modified = await evidence.sourceProvenance(temp.directory);
    assert.equal(modified.clean, false); assert.deepEqual(modified.modified, ['src/a.ts']); assert.equal(modified.modifiedCount, 1); assert.equal(modified.commit, head);
    await writeFile(path.join(temp.directory, 'tests/new.test.ts'), 'new\n');
    const untracked = await evidence.sourceProvenance(temp.directory);
    assert.deepEqual(untracked.untracked, ['tests/new.test.ts']); assert.equal(untracked.untrackedCount, 1);
    // 被 .gitignore 排除、却在指纹覆盖目录里的文件（gateway-test.pem 就是这样漏出去的）单独列出，且不算“工作区不干净”。
    gitIn(temp.directory, 'checkout', '--', 'src/a.ts'); await rm(path.join(temp.directory, 'tests/new.test.ts'));
    await mkdir(path.join(temp.directory, 'tests/fixtures')); await writeFile(path.join(temp.directory, 'tests/fixtures/server.pem'), 'secret');
    const ignored = await evidence.sourceProvenance(temp.directory);
    assert.deepEqual(ignored.ignoredCovered, ['tests/fixtures/server.pem']); assert.equal(ignored.clean, true);
    // 列表有上限，计数保留真实数量。
    for (let index = 0; index < 120; index++) await writeFile(path.join(temp.directory, `tests/many-${index}.ts`), 'x');
    const many = await evidence.sourceProvenance(temp.directory);
    assert.equal(many.untrackedCount, 120); assert.equal(many.untracked.length, 100);
  } finally { await temp.cleanup(); }
});

test('不在 git 仓库里无法追溯，候选构建被明确拒绝', async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), 'saltedfish-provenance-'));
  try {
    try { gitIn(outside, 'rev-parse', 'HEAD'); return; } catch { /* 预期：临时目录不在任何仓库内 */ }
    await assert.rejects(evidence.sourceProvenance(outside), /无法读取 git 提交与工作区状态/);
  } finally { await rm(outside, { recursive: true, force: true }); }
});

test('目录树比较逐文件报告差异：改动、多出和缺少的文件', async () => {
  const temp = await testDirectory();
  try {
    const a = path.join(temp.directory, 'a'), b = path.join(temp.directory, 'b');
    for (const root of [a, b]) { await mkdir(path.join(root, 'nested'), { recursive: true }); await writeFile(path.join(root, 'manifest.json'), '{}'); await writeFile(path.join(root, 'nested/background.js'), 'same'); }
    assert.deepEqual(await evidence.treeDifferences(a, b), []);
    await writeFile(path.join(b, 'nested/background.js'), 'changed'); await writeFile(path.join(b, 'extra.js'), 'x'); await rm(path.join(a, 'manifest.json'));
    await writeFile(path.join(a, 'only-a.js'), 'x');
    assert.deepEqual(await evidence.treeDifferences(a, b), ['extra.js', 'manifest.json', 'nested/background.js', 'only-a.js']);
  } finally { await temp.cleanup(); }
});
