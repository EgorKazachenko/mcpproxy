import { describe, expect, it } from 'vitest';
import { formatReport } from './report.js';
import { runBench } from './run.js';

/**
 * Смоук поднимает настоящий демон, настоящий сокет и настоящую песочницу. Подмножеством, а не
 * всем корпусом: полный прогон — работа CLI и CI, а здесь проверяется, что стенд собирается и
 * что цифры получаются из исходов кейсов, а не из констант.
 */
describe('прогон корпуса', () => {
  it('считает ASR и Utility на подмножестве и печатает отчёт', async () => {
    const run = await runBench({ modes: ['none'], only: ['A1-01', 'A4-01', 'U-T02'], overheadIterations: 2 });
    const report = run.modes[0];
    expect(report?.mode).toBe('none');
    expect(report?.attacks.executed).toBe(2);
    expect(report?.attacks.achieved).toBe(0);
    expect(report?.utility.completed).toBe(1);
    // Журнал сошёлся: метрики сняты с той же цепочки, которую предъявляет аудит.
    expect(report?.chainVerified).toBe(true);
    expect(formatReport(run)).toContain('=== mcpproxy red-team ===');
  });

  it('baseline отличается от seatbelt — иначе песочница бесполезна', async () => {
    // Контрольная точка E8 из WORK.md, исполняемая: запись в `~/.zshrc` обязана проходить под
    // `none` и отбиваться под `seatbelt`. Совпадение этих двух исходов означало бы, что второй
    // слой обороны не делает ничего, и вся пара метрик перестала бы что-либо доказывать.
    const run = await runBench({ modes: ['seatbelt', 'none'], only: ['A11-01'], overheadIterations: 1 });
    const seatbelt = run.modes.find((one) => one.mode === 'seatbelt');
    const baseline = run.modes.find((one) => one.mode === 'none');
    expect(seatbelt?.results[0]?.status).toBe('blocked');
    expect(baseline?.results[0]?.status).toBe('achieved');
  });

  it('пропуски названы поимённо и не улучшают ASR', async () => {
    const run = await runBench({ modes: ['none'], only: ['A15-01'], overheadIterations: 1 });
    const report = run.modes[0];
    expect(report?.attacks.skipped).toBe(1);
    expect(report?.attacks.executed).toBe(0);
    expect(formatReport(run)).toContain('A15-01 —');
  });
});
