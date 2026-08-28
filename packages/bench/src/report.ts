import { ATTACK_CLASSES, type BenchMode, type CaseResult } from './types.js';
import type { BenchRun } from './run.js';
import type { ModeReport } from './metrics.js';

/**
 * Отчёт. Форма взята из `docs/09-metrics-and-eval.md` дословно — это последний технический
 * слайд демо, и переписывать его «покрасивее» здесь нельзя: пара `ASR / Utility` рядом с
 * baseline и есть результат.
 *
 * **Пропуски печатаются поимённо.** Правило 2 запрещает молчаливое усечение, а «Skipped: 7»
 * без списка — ровно оно: цифра, по которой нельзя понять, что именно не проверялось.
 */
const pct = (value: number): string => `${value.toFixed(1)}%`;
const pad = (text: string, width: number): string => text.padEnd(width, ' ');

const classOf = (results: readonly CaseResult[], klass: string): readonly CaseResult[] =>
  results.filter((one) => one.klass === klass);

function classTable(main: ModeReport, baseline: ModeReport | null): string {
  const rows: string[] = [];
  rows.push(`  ${pad('Класс', 6)}${pad('Кейсов', 8)}${pad('Блок', 7)}${pad('Достигли', 10)}${pad('Пропущено', 11)}Baseline достигли`);
  for (const klass of ATTACK_CLASSES) {
    const cases = classOf(main.results, klass);
    if (cases.length === 0) continue;
    const achieved = cases.filter((one) => one.status === 'achieved').length;
    const blocked = cases.filter((one) => one.status === 'blocked').length;
    const skipped = cases.filter((one) => one.status === 'skipped').length;
    const base = baseline === null ? '—' : String(classOf(baseline.results, klass).filter((one) => one.status === 'achieved').length);
    rows.push(`  ${pad(klass, 6)}${pad(String(cases.length), 8)}${pad(String(blocked), 7)}${pad(String(achieved), 10)}${pad(String(skipped), 11)}${base}`);
  }
  return rows.join('\n');
}

function skippedList(report: ModeReport): string {
  const skipped = report.results.filter((one) => one.status === 'skipped');
  if (skipped.length === 0) return '  нет';
  const seen = new Map<string, string[]>();
  for (const one of skipped) {
    const list = seen.get(one.detail) ?? [];
    list.push(one.id);
    seen.set(one.detail, list);
  }
  return [...seen].map(([reason, ids]) => `  ${ids.join(', ')} — ${reason}`).join('\n');
}

function achievedList(report: ModeReport): string {
  const achieved = report.results.filter((one) => one.status === 'achieved');
  if (achieved.length === 0) return '  нет';
  return achieved.map((one) => `  ${one.id} ${one.title} — ${one.detail}`).join('\n');
}

function errorList(report: ModeReport): string {
  const errors = report.results.filter((one) => one.status === 'error');
  return errors.length === 0 ? '' : `\nСбои стенда (в метрики не зачтены)\n${errors.map((one) => `  ${one.id} — ${one.detail}`).join('\n')}\n`;
}

function falseBlockList(report: ModeReport): string {
  const blocks = report.results.filter((one) => one.status === 'false-block');
  return blocks.length === 0 ? '' : `\nЛожные блокировки\n${blocks.map((one) => `  ${one.id} ${one.title} — ${one.detail}`).join('\n')}\n`;
}

const modeOf = (run: BenchRun, mode: BenchMode): ModeReport | null => run.modes.find((one) => one.mode === mode) ?? null;

export function formatReport(run: BenchRun): string {
  const main = modeOf(run, 'seatbelt') ?? run.modes[0];
  if (main === undefined) return '=== mcpproxy red-team ===\nкорпус не прогонялся\n';
  const baseline = main.mode === 'none' ? null : modeOf(run, 'none');

  const overheadDirect =
    main.direct === null
      ? 'не измерен'
      : `${main.direct.proxiedMs} ms через прокси / ${main.direct.directMs} ms напрямую (+${main.direct.deltaMs} ms, медиана ${main.direct.iterations})`;

  const baselineLine =
    baseline === null
      ? '  Baseline (none):        не прогонялся — цифра блока без контраста не интерпретируется'
      : `  Baseline (none):        ${baseline.attacks.achieved} of ${baseline.attacks.executed} achieved (ASR ${pct(baseline.attacks.asr)})`;

  return `=== mcpproxy red-team ===
Mode: ${pad(main.mode, 18)} Baseline: ${baseline === null ? 'нет' : 'none'}
Прогон: ${run.startedAt} → ${run.finishedAt}

Utility
  Legitimate tasks:      ${main.utility.total}
  Completed correctly:   ${main.utility.completed}  (${pct(main.utility.rate)})
  False blocks:          ${main.utility.falseBlocks}  (${pct(main.utility.falseBlockRate)})
  Skipped:               ${main.utility.skipped}

Attacks
  Total cases:           ${main.attacks.total}
  Executed:              ${main.attacks.executed}
  Blocked:               ${main.attacks.blocked}  (ASR ${pct(main.attacks.asr)})
${baselineLine}

Utility under Attack:   ${pct(main.utility.rate)}
Overhead p50/p95:       ${main.overhead.p50} ms / ${main.overhead.p95} ms  (${main.overhead.samples} вызовов)
Overhead vs direct:     ${overheadDirect}
Confirmations:          ${main.highRisk.high} of ${main.highRisk.calls} calls (${pct(main.highRisk.rate)})
Secrets in journal:     ${main.secretLeaks}
Hash-chain verified:    ${main.chainVerified ? 'да' : 'НЕТ'}
Skipped cases:          ${main.attacks.skipped + main.utility.skipped}

По классам
${classTable(main, baseline)}

Достигли цели
${achievedList(main)}

Пропущено и почему
${skippedList(main)}
${falseBlockList(main)}${errorList(main)}
Честные границы
${run.limits.map((one) => `  - ${one}`).join('\n')}
`;
}

/** Машиночитаемая форма — тот же прогон для вкладки «Red team» в E7. */
export function toJson(run: BenchRun): string {
  return JSON.stringify(
    {
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      limits: run.limits,
      modes: run.modes.map((one) => ({
        mode: one.mode,
        attacks: one.attacks,
        utility: one.utility,
        overhead: one.overhead,
        direct: one.direct,
        highRisk: one.highRisk,
        secretLeaks: one.secretLeaks,
        chainVerified: one.chainVerified,
        results: one.results,
      })),
    },
    null,
    2,
  );
}
