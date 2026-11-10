import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, rename, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredReleaseGroups, sourceFingerprint, releaseCommands, treeDifferences, performanceEvidence, stageDifferences } from './release-evidence.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--scope') throw new Error('使用 verify:release -- --scope typecheck,service,ui,browser,performance；all 运行全部必要范围。performance 需要 PERF_BASELINE 指向上一版的交互性能报告。');
const groups = args[1] === 'all' ? requiredReleaseGroups : [...new Set(args[1].split(','))];
assert.ok(groups.length && groups.every(group => [...requiredReleaseGroups, 'performance'].includes(group)), '未知验收范围');
const candidate = JSON.parse(await readFile(path.join(root, '.local/last-npm-package.json'), 'utf8'));
assert.equal(candidate.candidate, true, '需要尚未冻结的候选包');
assert.equal(createHash('sha256').update(await readFile(candidate.target)).digest('hex'), candidate.sha256, '候选包哈希变化');
assert.equal(await sourceFingerprint(root), candidate.sourceFingerprint, '构建后源码/测试已变化；先重新构建候选，再验收');
const files = await readdir(path.join(root, 'tests'));
// 新增的集成测试必须归入某个门禁分组，或在 release-evidence.mjs 里带理由豁免；否则这里和 release-gates 单元测试都会拒绝。
const commands = releaseCommands(files, { npmCli: process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js') });
const directory = path.join(root, '.local/verification'); await mkdir(directory, { recursive: true });
const performanceLabel = `release-${candidate.version}`, performanceReport = path.join(directory, `interaction-performance-${performanceLabel}.json`);
// 每次运行有独立 ID：报告和日志按「候选包哈希前缀 + 运行 ID」另存且不覆盖，失败证据永远留着；
// release-<版本>-<分组>.json 只是 promote-npm 读取的「当前报告」索引，指向最近一次运行。
const runId = `${new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 15)}-${randomBytes(3).toString('hex')}`, runTag = `${candidate.sha256.slice(0, 12)}-${runId}`;
const saveReport = async (group, report) => {
  const text = JSON.stringify({ ...report, runId }, null, 2);
  await writeFile(path.join(directory, `release-${candidate.version}-${runTag}-${group}.json`), text, { flag: 'wx' });
  await writeFile(path.join(directory, `release-${candidate.version}-${group}.json`), text);
};
// 受测 stage 必须与候选 TGZ 逐字节一致；每组测试前后各核对一次。
const stageProblem = async () => { const different = await stageDifferences(candidate.target, candidate.stage); return different.length ? `候选 stage 与候选包不一致（${different.slice(0, 10).join(', ')}${different.length > 10 ? ` 等 ${different.length} 个` : ''}）；重新构建候选后再验收` : undefined; };
for (const group of groups) {
  const report = { schemaVersion: 1, group, version: candidate.version, packageSha256: candidate.sha256, sourceFingerprint: candidate.sourceFingerprint, normalizedSourceFingerprint: candidate.normalizedSourceFingerprint, provenance: candidate.provenance, startedAt: new Date().toISOString(), passed: false, basis: '源码与候选包绑定；产品UI/交互夹具使用候选stage，分发另有Windows/Linux同包验证', additionalCoverage: { realModels: 'pending', dailyChromeProfiles: 'pending', server91: 'pending', currentVersion72h: 'pending' }, commands: [] };
  const before = await stageProblem();
  if (before) {
    Object.assign(report, { failure: before, completedAt: new Date().toISOString() });
    await saveReport(group, report);
    process.exitCode = 1; break;
  }
  if (group === 'browser') {
    // extension-compatibility、product-depth 直接读取工作区 dist/extension，而不是候选 stage；两者字节必须一致，证据才算绑定候选。
    const different = await treeDifferences(path.join(root, 'dist/extension'), path.join(candidate.stage, 'dist/extension'));
    if (different.length) {
      Object.assign(report, { failure: `工作区 dist/extension 与候选 stage 不一致（${different.slice(0, 10).join(', ')}）；重新构建候选后再验收`, completedAt: new Date().toISOString() });
      await saveReport(group, report);
      process.exitCode = 1; break;
    }
    report.extensionBinding = 'dist/extension 与候选 stage 逐文件一致';
  }
  // 上一次的性能报告改名保留（不删除），让本次的比较结果不会混进旧数据。
  if (group === 'performance') await access(performanceReport).then(() => rename(performanceReport, path.join(directory, `interaction-performance-${performanceLabel}-superseded-${runId}.json`)), () => {});
  for (const [index, command] of commands[group].entries()) {
    const log = path.join(directory, `release-${candidate.version}-${runTag}-${group}-${index}.txt`);
    let output = '';
    const child = spawn(process.execPath, command, { cwd: root, windowsHide: true, env: { ...process.env, PRODUCT_SERVICE_ROOT: candidate.stage, INTERACTION_SERVICE_ROOT: candidate.stage, INTERACTION_EXTENSION: path.join(candidate.stage, 'dist/extension'), ...(group === 'performance' ? { PERF_SAMPLES: '100', PERF_CONTROLS: '5000', PERF_LABEL: performanceLabel, PERF_MAX_CDP_RATIO: process.env.PERF_MAX_CDP_RATIO || '1.01' } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const capture = data => { process.stdout.write(data); output += data; };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const exitCode = await new Promise(resolve => { child.once('error', error => { output += String(error); resolve(-1); }); child.once('close', resolve); });
    await writeFile(log, output, { flag: 'wx' });
    report.commands.push({ executable: process.execPath, args: command, exitCode, log });
    if (exitCode !== 0) break;
  }
  report.passed = report.commands.length === commands[group].length && report.commands.every(command => command.exitCode === 0);
  if (group === 'performance' && report.passed) {
    // 交互性能测试在没有基线时只采集数据、不做比较，所以这里必须确认它真的比较过；确实没有基线的特例要显式放行并留在记录里。
    try {
      const { performance, failure } = performanceEvidence(JSON.parse(await readFile(performanceReport, 'utf8')), { reportFile: performanceReport, allowNoBaseline: process.env.PERF_ALLOW_NO_BASELINE === '1' });
      report.performance = performance;
      if (failure) { report.passed = false; report.failure = failure; }
    } catch (error) { report.passed = false; report.failure = `读不到本次交互性能报告：${error instanceof Error ? error.message : error}`; }
  }
  report.completedAt = new Date().toISOString();
  if (await sourceFingerprint(root) !== candidate.sourceFingerprint) { report.passed = false; report.failure = '验收期间源码或测试发生变化'; }
  const after = await stageProblem();
  if (after) { report.passed = false; report.failure = `验收期间${after}`; }
  await saveReport(group, report);
  if (!report.passed) { process.exitCode = 1; break; }
}
