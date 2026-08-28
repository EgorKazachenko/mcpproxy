import type { ChainedEvent, SandboxViolation, Stage, Verdict } from '@mcpproxy/contracts';
import { describe, expect, it } from 'vitest';
import { foldCalls } from '../../shared/call.js';
import { CALL_OUTCOMES } from '../../shared/callOutcome.js';
import { STRINGS } from '../strings.js';
import { callLine, groupBar } from './callLine.js';

let tick = 0;
const event = (
  stage: Stage,
  verdict: Verdict = 'allowed',
  extra: Partial<ChainedEvent> = {},
): ChainedEvent =>
  ({
    schema: 'mcpproxy.audit/1',
    operation: 'execute_tool',
    protocolVersion: '2025-11-25',
    toolName: 'run_tests',
    sessionId: 's',
    traceId: 't',
    spanId: `sp${(tick += 1)}`,
    parentSpanId: null,
    startTime: `2026-08-27T10:00:${String(tick).padStart(2, '0')}.000000Z`,
    endTime: `2026-08-27T10:00:${String(tick).padStart(2, '0')}.001000Z`,
    durationUs: 1000,
    stage,
    verdict,
    recipe: { name: 'run_tests' },
    chain: { prev: null, self: 'x'.repeat(64) },
    ...extra,
  }) as ChainedEvent;

const violated = (v: SandboxViolation, mode: 'none' | 'seatbelt') =>
  foldCalls([
    event('received'),
    event('spawn', 'allowed', { sandbox: { mode } }),
    event('violation', 'allowed', { sandbox: { mode, violations: [v] } }),
    event('complete'),
  ])[0]!;

describe('callLine', () => {
  /** Содержание сценария S5: один и тот же вызов в двух режимах даёт разный исход. */
  it('нарушение, прошедшее насквозь, даёт исход passed', () => {
    const call = violated({ type: 'network', target: 'evil.io:443', action: 'allowed', bytes: 1247 }, 'none');
    expect(callLine(call).outcome).toBe('passed');
    expect(callLine(call).role).toBe('danger');
  });

  it('отбитое нарушение даёт исход blocked и янтарь', () => {
    const call = violated({ type: 'network', target: 'evil.io:443', action: 'denied', bytes: 0 }, 'seatbelt');
    expect(callLine(call).outcome).toBe('blocked');
    expect(callLine(call).role).toBe('warn');
  });

  /**
   * Незавершённый вызов обязан иметь свой исход: проигрыватель отдаёт события по одному, и
   * половина вызовов на экране всегда в полёте. Без шестого значения он подписывался бы
   * «Выполнено».
   */
  it('вызов в полёте подписан running, а не clean', () => {
    const call = foldCalls([event('received'), event('spawn')])[0]!;
    expect(callLine(call).outcome).toBe('running');
  });

  it('завершённый вызов без нарушений подписан clean', () => {
    const call = foldCalls([event('received'), event('complete')])[0]!;
    expect(callLine(call).outcome).toBe('clean');
  });

  it('отказанный вызов подписан denied', () => {
    const call = foldCalls([event('received'), event('validate', 'denied')])[0]!;
    expect(callLine(call).outcome).toBe('denied');
  });

  /**
   * Две оси расходятся ровно здесь: попытка отбита, ничего не прошло, но строка красная —
   * и зелёный бейдж вердикта рядом спорил бы сам с собой. Правило «глушить только
   * прошедшее насквозь» дало бы false.
   */
  it('persistence глушит бейдж вердикта, хотя попытка отбита', () => {
    const call = violated(
      { type: 'mandatory-deny', target: '/Users/y/.zshrc', action: 'denied', bytes: 0 },
      'seatbelt',
    );
    expect(callLine(call).verdictMuted).toBe(true);
    expect(callLine(call).outcome).toBe('blocked');
  });

  it('чистый вызов бейдж не глушит', () => {
    const call = foldCalls([event('received'), event('complete')])[0]!;
    expect(callLine(call).verdictMuted).toBe(false);
  });

  /** Режим нужен в строке: без него два соседних вызова S5 отличаются одним словом. */
  it('несёт режим песочницы', () => {
    const call = violated({ type: 'network', target: 'x', action: 'denied', bytes: 0 }, 'none');
    expect(callLine(call).sandbox).toBe('none');
  });

  it('у вызова, не дошедшего до spawn, режима нет', () => {
    const call = foldCalls([event('received'), event('validate', 'denied')])[0]!;
    expect(callLine(call).sandbox).toBeUndefined();
  });

  it('у каждого исхода есть подпись', () => {
    for (const outcome of CALL_OUTCOMES) expect(STRINGS.outcome[outcome]).toBeTruthy();
  });
});

describe('groupBar', () => {
  it('красит группу по худшему исходу, а не по первому', () => {
    const call = foldCalls([
      event('received'),
      event('spawn', 'allowed', { sandbox: { mode: 'seatbelt' } }),
      event('violation', 'allowed', {
        sandbox: { mode: 'seatbelt', violations: [{ type: 'network', target: 'a', action: 'denied', bytes: 0 }] },
      }),
      event('violation', 'allowed', {
        sandbox: { mode: 'none', violations: [{ type: 'network', target: 'b', action: 'allowed', bytes: 9 }] },
      }),
    ])[0]!;

    expect(groupBar(call).find((g) => g.group === 'execution')?.role).toBe('danger');
  });

  /** Счётчики, а не одна роль: макет рисует полосу пропорционально и оставляет рельс. */
  it('сообщает, сколько стадий группы достигнуто', () => {
    const call = foldCalls([event('received'), event('lock_check')])[0]!;
    const checks = groupBar(call).find((g) => g.group === 'checks');

    expect(checks).toMatchObject({ reached: 2, total: 6 });
  });

  it('у каждой группы есть подпись', () => {
    for (const bar of groupBar(foldCalls([event('received')])[0]!)) {
      expect(STRINGS.group[bar.group]).toBeTruthy();
    }
  });
});
