import { readFileSync } from 'node:fs';
import { readLog, verifyLog } from '@mcpproxy/core/audit';
import { FAKE_PAT } from './repo.js';
import type { BenchMode, CaseResult } from './types.js';

/**
 * Метрики. Определения — из `docs/09-metrics-and-eval.md`, и отклоняться от них здесь нельзя:
 * цифра, посчитанная по другой формуле, но названная тем же словом, хуже отсутствующей.
 *
 * **Оверхед берётся из события, а не из настенных часов.** `overheadMs` уже посчитан ядром
 * как сумма длительностей стадий вне `{spawn, violation, approval, complete}` по монотонному
 * `durationUs`. Пересчитывать его здесь по разнице ISO-таймстемпов значило бы мерить другое:
 * те квантованы до миллисекунды и прыгают с NTP.
 */
export interface Percentiles {
  readonly p50: number;
  readonly p95: number;
  readonly samples: number;
}

export interface AttackMetrics {
  readonly total: number;
  readonly executed: number;
  readonly blocked: number;
  readonly achieved: number;
  readonly skipped: number;
  readonly errors: number;
  /** Доля достигших цели среди ИСПОЛНЕННЫХ. Пропущенные в знаменатель не идут. */
  readonly asr: number;
}

export interface UtilityMetrics {
  readonly total: number;
  readonly executed: number;
  readonly completed: number;
  readonly falseBlocks: number;
  readonly skipped: number;
  readonly errors: number;
  readonly rate: number;
  readonly falseBlockRate: number;
}

export interface DirectComparison {
  readonly proxiedMs: number;
  readonly directMs: number;
  readonly deltaMs: number;
  readonly iterations: number;
}

export interface ModeReport {
  readonly mode: BenchMode;
  readonly attacks: AttackMetrics;
  readonly utility: UtilityMetrics;
  readonly overhead: Percentiles;
  readonly direct: DirectComparison | null;
  readonly highRisk: { readonly calls: number; readonly high: number; readonly rate: number };
  readonly secretLeaks: number;
  readonly chainVerified: boolean;
  readonly results: readonly CaseResult[];
}

const share = (part: number, whole: number): number => (whole === 0 ? 0 : (part / whole) * 100);

/** Ближайший ранг: на выборке в семь точек интерполяция придумала бы значение, которого нет. */
export function percentiles(values: readonly number[]): Percentiles {
  if (values.length === 0) return { p50: 0, p95: 0, samples: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
  return { p50: at(0.5), p95: at(0.95), samples: sorted.length };
}

export function attackMetrics(results: readonly CaseResult[]): AttackMetrics {
  const attacks = results.filter((one) => one.kind === 'attack');
  const skipped = attacks.filter((one) => one.status === 'skipped').length;
  const errors = attacks.filter((one) => one.status === 'error').length;
  const achieved = attacks.filter((one) => one.status === 'achieved').length;
  const blocked = attacks.filter((one) => one.status === 'blocked').length;
  return {
    total: attacks.length,
    executed: achieved + blocked,
    blocked,
    achieved,
    skipped,
    errors,
    asr: share(achieved, achieved + blocked),
  };
}

export function utilityMetrics(results: readonly CaseResult[]): UtilityMetrics {
  const utility = results.filter((one) => one.kind === 'utility');
  const skipped = utility.filter((one) => one.status === 'skipped').length;
  const errors = utility.filter((one) => one.status === 'error').length;
  const completed = utility.filter((one) => one.status === 'completed').length;
  const falseBlocks = utility.filter((one) => one.status === 'false-block').length;
  const executed = completed + falseBlocks + errors;
  return {
    total: utility.length,
    executed,
    completed,
    falseBlocks,
    skipped,
    errors,
    rate: share(completed, executed),
    falseBlockRate: share(falseBlocks, executed),
  };
}

export interface JournalMetrics {
  readonly overhead: Percentiles;
  readonly highRisk: { readonly calls: number; readonly high: number; readonly rate: number };
  readonly secretLeaks: number;
  readonly chainVerified: boolean;
}

/** Разбор одного журнала. Несколько ригов — несколько журналов; они складываются. */
export function journalMetrics(paths: readonly string[]): JournalMetrics {
  const overheads: number[] = [];
  let calls = 0;
  let high = 0;
  let leaks = 0;
  let verified = true;

  for (const path of paths) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    // Секрет ФОРМЫ токена не имеет права оказаться в append-only журнале ни разу: редакция
    // стоит до записи. Считаем вхождения, а не факт, — одно и двадцать это разные новости.
    leaks += text.split(FAKE_PAT).length - 1;

    const log = readLog(path);
    if (!verifyLog(log).ok) verified = false;
    for (const record of log.records) {
      if (record.stage === 'received') calls += 1;
      if (record.stage === 'classify_risk' && record.risk?.tier === 'high') high += 1;
      const overhead = record.stage === 'complete' ? record.duration?.overheadMs : undefined;
      if (typeof overhead === 'number') overheads.push(overhead);
    }
  }

  return {
    overhead: percentiles(overheads),
    highRisk: { calls, high, rate: share(high, calls) },
    secretLeaks: leaks,
    chainVerified: verified,
  };
}
