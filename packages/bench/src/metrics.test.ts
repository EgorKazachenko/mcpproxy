import { describe, expect, it } from 'vitest';
import { attackMetrics, percentiles, utilityMetrics } from './metrics.js';
import type { CaseResult } from './types.js';

const attack = (id: string, status: CaseResult['status']): CaseResult => ({
  id,
  kind: 'attack',
  klass: 'A1',
  title: id,
  mode: 'seatbelt',
  status,
  denyCode: null,
  detail: '',
  durationMs: 1,
});

const utility = (id: string, status: CaseResult['status']): CaseResult => ({ ...attack(id, status), kind: 'utility', klass: 'tests' });

describe('percentiles', () => {
  it('берёт ближайший ранг, а не интерполирует', () => {
    // На семи точках интерполяция вернула бы значение, которого в выборке нет, и отчёт
    // предъявил бы придуманную миллисекунду как измеренную.
    expect(percentiles([1, 2, 3, 4, 5, 6, 7])).toEqual({ p50: 4, p95: 7, samples: 7 });
  });

  it('пустая выборка не делит на ноль', () => {
    expect(percentiles([])).toEqual({ p50: 0, p95: 0, samples: 0 });
  });
});

describe('ASR', () => {
  it('считается по исполненным, а пропущенные в знаменатель не идут', () => {
    // Иначе пропуск класса УЛУЧШАЛ бы ASR: пять неисполненных кейсов молча превратились бы
    // в пять блоков, и цифра стала бы тем лучше, чем меньше корпус реально проверил.
    const metrics = attackMetrics([
      attack('a', 'blocked'),
      attack('b', 'blocked'),
      attack('c', 'achieved'),
      attack('d', 'skipped'),
      attack('e', 'skipped'),
    ]);
    expect(metrics.total).toBe(5);
    expect(metrics.executed).toBe(3);
    expect(metrics.skipped).toBe(2);
    expect(metrics.asr).toBeCloseTo(33.3, 1);
  });

  it('пустой корпус даёт ноль, а не NaN', () => {
    expect(attackMetrics([]).asr).toBe(0);
  });
});

describe('Utility', () => {
  it('ложная блокировка и пропуск — разные исходы', () => {
    const metrics = utilityMetrics([
      utility('a', 'completed'),
      utility('b', 'completed'),
      utility('c', 'false-block'),
      utility('d', 'skipped'),
    ]);
    expect(metrics.executed).toBe(3);
    expect(metrics.rate).toBeCloseTo(66.7, 1);
    expect(metrics.falseBlockRate).toBeCloseTo(33.3, 1);
    expect(metrics.skipped).toBe(1);
  });
});
