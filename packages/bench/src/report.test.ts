import { describe, expect, it } from 'vitest';
import { formatReport, toJson } from './report.js';
import type { ModeReport } from './metrics.js';
import type { BenchRun } from './run.js';
import type { CaseResult } from './types.js';

const result = (over: Partial<CaseResult>): CaseResult => ({
  id: 'A1-01',
  kind: 'attack',
  klass: 'A1',
  title: 'кейс',
  mode: 'seatbelt',
  status: 'blocked',
  denyCode: null,
  detail: 'подробность',
  durationMs: 1,
  ...over,
});

const mode = (name: 'seatbelt' | 'none', results: readonly CaseResult[]): ModeReport => ({
  mode: name,
  attacks: {
    total: results.length,
    executed: results.filter((one) => one.status !== 'skipped').length,
    blocked: results.filter((one) => one.status === 'blocked').length,
    achieved: results.filter((one) => one.status === 'achieved').length,
    skipped: results.filter((one) => one.status === 'skipped').length,
    errors: 0,
    asr: name === 'none' ? 50 : 0,
  },
  utility: { total: 2, executed: 2, completed: 2, falseBlocks: 0, skipped: 0, errors: 0, rate: 100, falseBlockRate: 0 },
  overhead: { p50: 9, p95: 21, samples: 7 },
  direct: { proxiedMs: 14, directMs: 5, deltaMs: 9, iterations: 7 },
  highRisk: { calls: 40, high: 3, rate: 7.5 },
  secretLeaks: 0,
  chainVerified: true,
  results,
});

const run: BenchRun = {
  startedAt: '2026-08-28T10:00:00.000Z',
  finishedAt: '2026-08-28T10:02:00.000Z',
  limits: ['граница один'],
  modes: [
    mode('seatbelt', [result({}), result({ id: 'A15-01', klass: 'A15', status: 'skipped', detail: 'нет рендерера' })]),
    mode('none', [result({ status: 'achieved' }), result({ id: 'A15-01', klass: 'A15', status: 'skipped', detail: 'нет рендерера' })]),
  ],
};

describe('отчёт', () => {
  const text = formatReport(run);

  it('ставит ASR рядом с baseline: цифра блока в одиночку не результат', () => {
    expect(text).toContain('ASR 0.0%');
    expect(text).toContain('Baseline (none):');
    expect(text).toContain('ASR 50.0%');
  });

  it('называет пропущенные кейсы поимённо, а не одним счётчиком', () => {
    expect(text).toContain('A15-01 — нет рендерера');
  });

  it('печатает оверхед и относительно прямого вызова тоже', () => {
    expect(text).toContain('Overhead p50/p95:       9 ms / 21 ms');
    expect(text).toContain('14 ms через прокси / 5 ms напрямую');
  });

  it('несёт честные границы внутри самого отчёта', () => {
    expect(text).toContain('- граница один');
  });

  it('json содержит оба режима и разбор по кейсам', () => {
    const parsed = JSON.parse(toJson(run)) as { modes: { mode: string; results: unknown[] }[] };
    expect(parsed.modes.map((one) => one.mode)).toEqual(['seatbelt', 'none']);
    expect(parsed.modes[0]?.results).toHaveLength(2);
  });
});

describe('отчёт без baseline', () => {
  it('говорит, что контраста нет, а не печатает пустую строку', () => {
    const single: BenchRun = { ...run, modes: [run.modes[0] as ModeReport] };
    expect(formatReport(single)).toContain('не прогонялся');
  });
});
