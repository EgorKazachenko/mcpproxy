import { APPROVAL_DENY_CODES, DENIAL_CODES } from '@mcpproxy/core';
import { describe, expect, it } from 'vitest';
import { ALL_DENY_CODES, E4_DENY_CODES, denyReason, isTerminal, parseDenyReason, verdictOfExecError } from './deny.js';

describe('denyReason — формат, который переживёт границу лога', () => {
  it('код и текст собираются в стабильный префикс', () => {
    expect(denyReason('pattern-mismatch', 'значение не подошло под шаблон')).toBe('pattern-mismatch: значение не подошло под шаблон');
  });

  it('каждый код словаря разбирается обратно', () => {
    // Ради этого формат и заводился: событие несёт `denyReason?: string`, и если код не
    // достаётся обратно, машиночитаемость отказа кончается на append-only записи.
    for (const code of ALL_DENY_CODES) {
      const parsed = parseDenyReason(denyReason(code, 'текст, в котором есть : двоеточие'));
      expect(parsed).not.toBeNull();
      expect(parsed?.code).toBe(code);
      expect(parsed?.text).toBe('текст, в котором есть : двоеточие');
    }
  });

  it('строка не в формате даёт null, а не выдуманный код', () => {
    expect(parseDenyReason('просто проза без кода')).toBeNull();
    expect(parseDenyReason('неизвестный-код: текст')).toBeNull();
    expect(parseDenyReason(': текст')).toBeNull();
    expect(parseDenyReason('')).toBeNull();
  });

  it('шесть словарей не пересекаются', () => {
    // Непересечение — предпосылка формата: два словаря с общим кодом сделали бы разбор
    // неоднозначным именно там, где он нужен.
    expect(new Set(ALL_DENY_CODES).size).toBe(ALL_DENY_CODES.length);
    expect(ALL_DENY_CODES.length).toBe(6 + DENIAL_CODES.length + 9 + 5 + APPROVAL_DENY_CODES.length + E4_DENY_CODES.length);
  });
});

describe('verdictOfExecError — отказ политики не сбой прокси (D6 E3)', () => {
  it('invalid-domain — denied', () => {
    expect(verdictOfExecError('invalid-domain')).toBe('denied');
  });

  it('сбои прокси и демона — error', () => {
    for (const code of ['proxy-down', 'spawn-failed', 'srt-uninitialized', 'poisoned', 'group-not-drained', 'disposed', 'wildcard-dropped', 'mode-unsupported'] as const) {
      expect(verdictOfExecError(code)).toBe('error');
    }
  });

  it('терминальны ровно два кода — те, после которых атрибуция чужая', () => {
    expect(isTerminal('poisoned')).toBe(true);
    expect(isTerminal('group-not-drained')).toBe(true);
    expect(isTerminal('proxy-down')).toBe(false);
    expect(isTerminal('invalid-domain')).toBe(false);
  });
});
