import { stageOrder, type ChainedEvent, type Stage, type Verdict } from '@mcpproxy/contracts';
import { describe, expect, it } from 'vitest';
import { foldCalls } from '../../shared/call.js';
import { commandView, stagePresence } from './commandView.js';
import { STAGE_TEMPLATES, stageDetail } from './stageDetail.js';

let tick = 0;
const event = (stage: Stage, verdict: Verdict = 'allowed', extra: Partial<ChainedEvent> = {}): ChainedEvent =>
  ({
    schema: 'mcpproxy.audit/1',
    operation: 'execute_tool',
    protocolVersion: '2025-11-25',
    toolName: 'run_tests',
    sessionId: 'sess-1',
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

const ARGV = ['pnpm', 'test', '--testPathPattern', 'auth'];

describe('commandView', () => {
  /**
   * Оба утверждения обязательны. Без второго реализация, всегда отвечающая `not-built`,
   * прошла бы первое — а именно она и получается, если ветвиться по истинности длины вместо
   * наличия ключа.
   */
  it('у остановленного вызова команда не собиралась', () => {
    const call = foldCalls([event('received'), event('lock_check', 'denied')])[0]!;
    expect(commandView(call).kind).toBe('not-built');
  });

  it('у успешного вызова команда собрана', () => {
    const call = foldCalls([
      event('received'),
      event('build_argv', 'allowed', { argv: ARGV, argvFromParams: [3] }),
      event('complete'),
    ])[0]!;
    expect(commandView(call).kind).toBe('built');
  });

  it('несёт происхождение элементов команды', () => {
    const call = foldCalls([event('build_argv', 'allowed', { argv: ARGV, argvFromParams: [3] })])[0]!;
    const view = commandView(call);
    expect(view.kind === 'built' && view.fromParams).toEqual([3]);
  });

  /**
   * Контрактное поле необязательно. Свёртка отсутствия в пустоту допустима здесь и только
   * здесь: для подсветки «нет подстановок» и «нет поля» — одно и то же.
   */
  it('отсутствие происхождения сворачивается в пустой список', () => {
    const call = foldCalls([event('build_argv', 'allowed', { argv: ARGV })])[0]!;
    const view = commandView(call);
    expect(view.kind === 'built' && view.fromParams).toEqual([]);
  });

  it('называет стадию, на которой вызов остановился', () => {
    const call = foldCalls([event('received'), event('validate', 'denied')])[0]!;
    const view = commandView(call);
    expect(view.kind === 'not-built' && view.stoppedAt).toBe('validate');
  });
});

describe('stagePresence', () => {
  /** «Прошло мгновенно» и «до стадии не дошло» обязаны различаться. */
  it('различает достигнутую стадию и недостигнутую', () => {
    const call = foldCalls([event('received'), event('validate', 'denied')])[0]!;
    const presence = stagePresence(call);

    expect(presence.find((p) => p.stage === 'validate')?.present).toBe(true);
    expect(presence.find((p) => p.stage === 'spawn')?.present).toBe(false);
  });

  it('перечисляет все стадии контракта', () => {
    const call = foldCalls([event('received')])[0]!;
    expect(stagePresence(call).map((p) => p.stage)).toEqual(stageOrder);
  });
});

describe('stageDetail', () => {
  /**
   * Полнота таблицы. Двенадцать шаблонов на тринадцать стадий дают пустую строку на
   * тринадцатой, и заметить это без утверждения о покрытии нечем.
   */
  it('покрывает все 13 стадий', () => {
    expect(Object.keys(STAGE_TEMPLATES).sort()).toEqual([...stageOrder].sort());
  });

  it.each([...stageOrder])('на стадии %s даёт непустую строку', (stage) => {
    expect(stageDetail(event(stage))).not.toBe('');
  });

  it('на сборке команды называет число подстановок', () => {
    const detail = stageDetail(event('build_argv', 'allowed', { argv: ARGV, argvFromParams: [3] }));
    expect(detail).toContain('4');
    expect(detail).toContain('1');
  });

  it('отказ показывает свою причину, а не общую формулировку', () => {
    const detail = stageDetail(event('validate', 'denied', { denyReason: 'значение не соответствует шаблону' }));
    expect(detail).toBe('значение не соответствует шаблону');
  });
});
