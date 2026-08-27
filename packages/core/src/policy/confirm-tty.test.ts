import { describe, expect, it } from 'vitest';
import { confirmTty, decisionOf, parseExpect } from './confirm-tty.js';
import type { LockApprovalRequest } from './approve.js';

const REQUEST: LockApprovalRequest = {
  kind: 'first',
  recipes: ['run_tests'],
  manifestHash: 'a'.repeat(64),
  requestedAt: '2026-08-28T00:00:00.000Z',
};

describe('parseExpect', () => {
  it('берёт значение ПОСЛЕ флага, а не сам флаг', () => {
    expect(parseExpect(['--expect', 'abc'])).toBe('abc');
  });

  it('принимает и форму со знаком равенства', () => {
    expect(parseExpect(['--expect=abc'])).toBe('abc');
  });

  it('находит флаг не только первым аргументом', () => {
    expect(parseExpect(['--verbose', '--expect', 'abc'])).toBe('abc');
  });

  it('без флага — null, то есть ожидания нет', () => {
    expect(parseExpect([])).toBeNull();
    expect(parseExpect(['--verbose'])).toBeNull();
  });

  it('флаг без значения не превращается в дайджест', () => {
    // Пустая строка вместо `null` означала бы «ожидается дайджест, которому ничто не равно»,
    // то есть команда отказывала бы всегда и молча.
    expect(parseExpect(['--expect'])).toBeNull();
    expect(parseExpect(['--expect', '--verbose'])).toBeNull();
    expect(parseExpect(['--expect='])).toBeNull();
  });
});

describe('decisionOf', () => {
  it('утвердительные ответы', () => {
    expect(['y', 'Y', 'yes', ' да ', 'ДА'].map(decisionOf)).toEqual(Array(5).fill('approved'));
  });

  it('всё остальное — отказ, включая пустую строку', () => {
    expect(['', 'n', 'нет', 'позже', 'yep'].map(decisionOf)).toEqual(Array(5).fill('denied'));
  });
});

describe('confirmTty', () => {
  it('показывает рендер и связывает вердикт дайджестом ИЗ ЗАПРОСА', async () => {
    const printed: string[] = [];
    const verdict = await confirmTty(REQUEST, 'что показали', {
      print: (text) => void printed.push(text),
      ask: async () => 'y',
      now: () => '2026-08-28T00:00:01.000Z',
    });

    expect(printed).toEqual(['что показали']);
    expect(verdict).toEqual({
      manifestHash: REQUEST.manifestHash,
      decision: 'approved',
      decidedAt: '2026-08-28T00:00:01.000Z',
    });
  });

  it('отказ доезжает вердиктом, а не исключением', async () => {
    const verdict = await confirmTty(REQUEST, '', { print: () => {}, ask: async () => 'n' });
    expect(verdict.decision).toBe('denied');
  });
});
