import { describe, expect, it } from 'vitest';
import { answerOrEof, confirmTty, decisionOf, parseExpect } from './confirm-tty.js';
import type { LockApprovalRequest } from './approve.js';

const DIGEST = 'a'.repeat(64);

const REQUEST: LockApprovalRequest = {
  kind: 'first',
  recipes: [],
  manifestHash: DIGEST,
  requestedAt: '2026-08-28T00:00:00.000Z',
};

describe('parseExpect', () => {
  it('берёт значение ПОСЛЕ флага, а не сам флаг', () => {
    expect(parseExpect(['--expect', DIGEST])).toEqual({ kind: 'digest', digest: DIGEST });
  });

  it('принимает и форму со знаком равенства', () => {
    expect(parseExpect([`--expect=${DIGEST}`])).toEqual({ kind: 'digest', digest: DIGEST });
  });

  it('находит флаг не только первым аргументом', () => {
    expect(parseExpect(['--verbose', '--expect', DIGEST])).toEqual({ kind: 'digest', digest: DIGEST });
  });

  it('без флага — absent, то есть ожидания нет', () => {
    expect(parseExpect([])).toEqual({ kind: 'absent' });
    expect(parseExpect(['--verbose'])).toEqual({ kind: 'absent' });
  });

  it('флаг без значения ОТКАЗЫВАЕТ, а не снимает ограничение', () => {
    // Это средство защиты, и «значения нет» не имеет права означать «проверять не надо»:
    // одна незакавыченная пустая переменная в вызове иначе молча снимала бы связывание.
    expect(parseExpect(['--expect']).kind).toBe('invalid');
    expect(parseExpect(['--expect', '--verbose']).kind).toBe('invalid');
    expect(parseExpect(['--expect=']).kind).toBe('invalid');
  });

  it('значение, не похожее на дайджест, тоже отказ', () => {
    expect(parseExpect(['--expect', 'abc']).kind).toBe('invalid');
    expect(parseExpect(['--expect', DIGEST.toUpperCase()]).kind).toBe('invalid');
  });
});

describe('answerOrEof', () => {
  it('конец потока доезжает пустой строкой, а не подвисает навсегда', async () => {
    // Измерено: `rl.question` на закрытом stdin не резолвится НИКОГДА, и команда выходила с
    // кодом 13, напечатав весь дифф и не сказав ни слова. Пустая строка — уже отказ.
    const never = new Promise<string>(() => undefined);
    await expect(answerOrEof(never, Promise.resolve())).resolves.toBe('');
    expect(decisionOf(await answerOrEof(never, Promise.resolve()))).toBe('denied');
  });

  it('ответ человека выигрывает у ещё не наступившего конца потока', async () => {
    const never = new Promise<unknown>(() => undefined);
    await expect(answerOrEof(Promise.resolve('y'), never)).resolves.toBe('y');
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
