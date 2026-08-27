import { describe, expect, it } from 'vitest';
import { ANNOTATION_DEFAULTS, deriveRiskTier, type ToolAnnotations } from './annotations.js';
import type { RiskTier } from './domain.js';

const CASES: ReadonlyArray<readonly [string, ToolAnnotations, RiskTier]> = [
  ['молчание манифеста', {}, 'high'],
  ['readOnly', { readOnlyHint: true }, 'low'],
  ['readOnly перебивает destructive', { readOnlyHint: true, destructiveHint: true }, 'low'],
  ['ни то, ни другое', { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, 'medium'],
  ['destructive', { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, 'high'],
  ['openWorld', { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, 'high'],
];

describe('deriveRiskTier', () => {
  for (const [name, annotations, expected] of CASES) {
    it(`${name} → ${expected}`, () => {
      expect(deriveRiskTier(annotations)).toBe(expected);
    });
  }

  it('дефолты — пессимистичные значения спеки MCP', () => {
    expect(ANNOTATION_DEFAULTS).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it('idempotentHint на тир не влияет', () => {
    // Он есть в контракте (спека его объявляет) и попадает в событие аудита,
    // но таблица тиров его не читает. Тест фиксирует это, чтобы «доработка»
    // с учётом idempotentHint краснела, а не проходила молча.
    expect(deriveRiskTier({ readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true }))
      .toBe('medium');
    expect(deriveRiskTier({ readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false }))
      .toBe('medium');
  });
});
