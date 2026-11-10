// 交互性能与基线的比较规则。独立成纯函数，使“无基线”“字节回退”“多出 CDP 调用”这些规则不启动浏览器也能单测。
export interface PerformanceRun { p50: number; p95: number; cdpBytes: number; cdpCalls: number }
export interface PerformanceBaseline { version?: string; controls?: number; chromeArgs?: string[]; runs: Record<string, PerformanceRun | undefined> }
export interface PerformanceThresholds { maxCdpRatio: number; maxActionCdpRatio: number; maxExtraCalls: number; p95Factor: number; p95SlackMs: number }
export const comparedOperations = ['warmInspect', 'click', 'fill', 'insertText'] as const;

export function performanceThresholds(env: Record<string, string | undefined>): PerformanceThresholds {
  const number = (name: string, fallback: number) => { const raw = env[name]; return raw === undefined || raw === '' ? fallback : Number(raw); };
  const maxCdpRatio = number('PERF_MAX_CDP_RATIO', .3), maxActionCdpRatio = number('PERF_MAX_ACTION_CDP_RATIO', 1.1), maxExtraCalls = number('PERF_MAX_EXTRA_CALLS', 0);
  if (!(maxCdpRatio > 0 && maxCdpRatio <= 1.1)) throw new Error('PERF_MAX_CDP_RATIO 需要在 (0, 1.1] 内');
  if (!(maxActionCdpRatio > 0 && maxActionCdpRatio <= 2)) throw new Error('PERF_MAX_ACTION_CDP_RATIO 需要在 (0, 2] 内');
  if (!(Number.isInteger(maxExtraCalls) && maxExtraCalls >= 0 && maxExtraCalls <= 10)) throw new Error('PERF_MAX_EXTRA_CALLS 需要是 0–10 的整数');
  return { maxCdpRatio, maxActionCdpRatio, maxExtraCalls, p95Factor: 1.25, p95SlackMs: 20 };
}

// baseline 为 undefined 表示没有提供基线：不做任何比较，compared 明确为 false，由发行门禁决定是否接受。
export function comparePerformance(runs: Record<string, PerformanceRun>, baseline: PerformanceBaseline | undefined, controls: number, thresholds: PerformanceThresholds, chromeArgs: string[] = []) {
  if (!baseline) return { compared: false as const, failures: [] as string[], comparison: undefined, baselineVersion: undefined };
  if ((baseline.controls ?? 100) !== controls) throw new Error(`baseline fixture must match：基线控件数 ${baseline.controls ?? 100}，本次 ${controls}`);
  const argsKey = (args: string[]) => [...args].sort().join(' ');
  if (argsKey(baseline.chromeArgs ?? []) !== argsKey(chromeArgs)) throw new Error(`baseline fixture must match：基线 Chrome 参数“${argsKey(baseline.chromeArgs ?? [])}”，本次“${argsKey(chromeArgs)}”`);
  const failures: string[] = [], comparison: Record<string, { p50Ratio: number; p95Ratio: number; cdpBytesRatio: number; extraCalls: number }> = {};
  for (const key of comparedOperations) {
    const old = baseline.runs[key], now = runs[key];
    if (!old || !now) { failures.push(`${key}: ${old ? '本次' : '基线'}没有这项数据，无法比较`); continue; }
    comparison[key] = { p50Ratio: now.p50 / old.p50, p95Ratio: now.p95 / old.p95, cdpBytesRatio: now.cdpBytes / old.cdpBytes, extraCalls: now.cdpCalls - old.cdpCalls };
    if (now.p95 > old.p95 * thresholds.p95Factor + thresholds.p95SlackMs) failures.push(`${key}: p95 regression ${now.p95} vs ${old.p95}`);
    const limit = key === 'warmInspect' ? thresholds.maxCdpRatio : thresholds.maxActionCdpRatio;
    if (!(now.cdpBytes <= old.cdpBytes * limit)) failures.push(`${key}: CDP bytes ${now.cdpBytes} vs baseline ${old.cdpBytes} exceeds ratio ${limit}`);
    if (now.cdpCalls - old.cdpCalls > thresholds.maxExtraCalls + 1e-9) failures.push(`${key}: ${now.cdpCalls - old.cdpCalls} extra CDP calls per operation, limit ${thresholds.maxExtraCalls}`);
  }
  return { compared: true as const, failures, comparison, baselineVersion: baseline.version };
}
