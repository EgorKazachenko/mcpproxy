import { describe, expect, it } from 'vitest';
import { asRecipeName, asSessionId, toOtlp } from '@mcpproxy/contracts';
import { chainHash } from '@mcpproxy/contracts/audit';
import { lockCheckEvent } from './event.js';
import type { LockCheckEventInput } from './event.js';
import type { LockVerdict } from './lock-check.js';

const VERIFIED: LockVerdict = {
  check: { status: 'verified' },
  diagnostics: [],
  mismatched: [],
  digest: null,
  denyReason: null,
};

const ABSENT: LockVerdict = {
  check: { status: 'absent' },
  diagnostics: [],
  mismatched: [],
  digest: null,
  denyReason: 'lock-absent: mcpproxy.lock отсутствует, одобрения нет',
};

const inputOf = (patch: Partial<LockCheckEventInput> = {}): LockCheckEventInput => ({
  verdict: VERIFIED,
  recipeName: asRecipeName('run_tests'),
  recipeDigest: 'a'.repeat(64),
  protocolVersion: '2025-11-25',
  sessionId: asSessionId('session-1'),
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: 'b7ad6b7169203331',
  parentSpanId: null,
  startTime: '2026-08-28T00:00:00.000Z',
  endTime: '2026-08-28T00:00:00.001Z',
  durationUs: 1200,
  ...patch,
});

describe('lockCheckEvent: обязательное ядро', () => {
  it('стадия и вердикт соответствуют статусу сверки', () => {
    expect(lockCheckEvent(inputOf()).stage).toBe('lock_check');
    expect(lockCheckEvent(inputOf()).verdict).toBe('allowed');
    expect(lockCheckEvent(inputOf({ verdict: ABSENT })).verdict).toBe('denied');
  });

  it('protocolVersion приходит входом, а не берётся из константы сборки', () => {
    expect(lockCheckEvent(inputOf({ protocolVersion: '2025-06-18' })).protocolVersion).toBe('2025-06-18');
  });

  it('имя рецепта едет и в toolName, и в recipe.name', () => {
    const event = lockCheckEvent(inputOf());
    expect(event.toolName).toBe('run_tests');
    expect(event.recipe.name).toBe('run_tests');
  });

  it('событие вписывается в цепочку — то есть канонизируется', () => {
    expect(chainHash(lockCheckEvent(inputOf({ verdict: ABSENT })), null)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('lockCheckEvent: ключа argv нет вовсе', () => {
  it('ни у отказа, ни у пропуска', () => {
    // `null` здесь не годится: JCS различает отсутствующий ключ и `null` побайтово, и обе
    // формы попадают внутрь `chain.self`.
    expect(Object.hasOwn(lockCheckEvent(inputOf({ verdict: ABSENT })), 'argv')).toBe(false);
    expect(Object.hasOwn(lockCheckEvent(inputOf()), 'argv')).toBe(false);
  });
});

describe('lockCheckEvent: denyReason только когда есть что сказать', () => {
  it('на verified ключа нет', () => {
    expect(Object.hasOwn(lockCheckEvent(inputOf()), 'denyReason')).toBe(false);
  });

  it('на отказе ключ есть и несёт причину', () => {
    const event = lockCheckEvent(inputOf({ verdict: ABSENT }));
    expect(Object.hasOwn(event, 'denyReason')).toBe(true);
    expect(event.denyReason).toBe(ABSENT.denyReason);
  });

  it('причина доезжает до OTLP как mcpproxy.deny_reason', () => {
    // Самый важный отказ продукта иначе приезжает оператору без причины (R12a).
    const attributes = toOtlp(lockCheckEvent(inputOf({ verdict: ABSENT }))).attributes;
    const denyReason = attributes.find((one) => one.key === 'mcpproxy.deny_reason');

    expect(denyReason?.value).toEqual({ stringValue: ABSENT.denyReason });
    expect(toOtlp(lockCheckEvent(inputOf())).attributes.some((one) => one.key === 'mcpproxy.deny_reason')).toBe(false);
  });
});

describe('lockCheckEvent: recipe.hash только у известного имени', () => {
  it('имя из манифеста несёт дайджест', () => {
    expect(Object.hasOwn(lockCheckEvent(inputOf()).recipe, 'hash')).toBe(true);
  });

  it('имя, которого в манифесте нет, дайджеста не имеет — и ключа тоже', () => {
    const event = lockCheckEvent(inputOf({ recipeDigest: undefined, verdict: ABSENT }));
    expect(Object.hasOwn(event.recipe, 'hash')).toBe(false);
  });
});
