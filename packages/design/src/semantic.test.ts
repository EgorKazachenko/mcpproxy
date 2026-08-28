import { describe, expect, it } from 'vitest';
import type { ViolationType } from '@mcpproxy/contracts';
import type { Role } from './semantic.js';
import { violationRole } from './semantic.js';

/**
 * Все пять типов нарушений на обоих исходах. Таблица целиком, а не выборка: правило
 * «янтарь если отбито» имеет ровно одно исключение, и увидеть его можно только рядом с
 * теми случаями, где оно не действует.
 */
const CASES: ReadonlyArray<readonly [ViolationType, 'denied' | 'allowed', Role]> = [
  ['network', 'denied', 'warn'],
  ['network', 'allowed', 'danger'],
  ['file-read', 'denied', 'warn'],
  ['file-read', 'allowed', 'danger'],
  ['file-write', 'denied', 'warn'],
  ['file-write', 'allowed', 'danger'],
  ['process', 'denied', 'warn'],
  ['process', 'allowed', 'danger'],
  ['mandatory-deny', 'denied', 'danger'],
  ['mandatory-deny', 'allowed', 'danger'],
];

describe('violationRole', () => {
  it.each(CASES)('%s + %s → %s', (type, action, expected) => {
    expect(violationRole(type, action)).toBe(expected);
  });

  /**
   * Содержание сценария S5 одной строкой: один и тот же вызов в двух режимах песочницы.
   * Реализация, игнорирующая `action`, вернула бы `warn` в обоих случаях — и различие,
   * ради которого продукт существует, исчезло бы, не уронив ни одного другого теста.
   */
  it('различает отбитое нарушение и прошедшее насквозь', () => {
    expect(violationRole('network', 'denied')).not.toBe(violationRole('network', 'allowed'));
  });

  /**
   * Отбито успешно, но сам факт попытки записи в persistence-путь означает, что код
   * пытался закрепиться в системе. Единственная пара, где отбитое красное.
   */
  it('красит persistence красным даже когда попытка отбита', () => {
    expect(violationRole('mandatory-deny', 'denied')).toBe('danger');
  });
});
