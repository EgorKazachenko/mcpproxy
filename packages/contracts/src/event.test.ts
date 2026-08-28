import { describe, expect, it } from 'vitest';
import { chainHash } from './audit/chain.js';
import type { AuditEvent } from './event.js';
import { toOtlp } from './otlp.js';

/**
 * Ядро события на любой стадии. Стадию и поля стадии подставляют хелперы ниже — так видно,
 * что различает случаи, а не что у них общего.
 */
const CORE = {
  schema: 'mcpproxy.audit/1',
  operation: 'execute_tool',
  protocolVersion: '2025-11-25',
  toolName: 'run_tests',
  sessionId: 'sess-1',
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  spanId: '00f067aa0ba902b7',
  parentSpanId: null,
  startTime: '2026-08-27T10:00:00.000000Z',
  endTime: '2026-08-27T10:00:00.000340Z',
  durationUs: 340,
  verdict: 'allowed',
  recipe: { name: 'run_tests' },
} as const satisfies Omit<AuditEvent, 'stage'>;

const received: AuditEvent = { ...CORE, stage: 'received' };

const buildArgv: AuditEvent = {
  ...CORE,
  stage: 'build_argv',
  argv: ['pnpm', 'test', '--testPathPattern', 'auth'],
  argvFromParams: [3],
};

describe('argvFromParams', () => {
  it('отсутствует у события, которое ещё не собирало команду', () => {
    expect(Object.hasOwn(received, 'argvFromParams')).toBe(false);
  });

  it('на build_argv указывает в позиции argv, занятые параметрами', () => {
    expect(buildArgv.argvFromParams).toEqual([3]);
  });

  it('указывает в существующие позиции argv того же события', () => {
    const argv = buildArgv.argv ?? [];
    for (const index of buildArgv.argvFromParams ?? []) {
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(argv.length);
    }
  });

  it('канонизируется, то есть событие с ним остаётся хэшируемым', () => {
    expect(() => chainHash(buildArgv, null)).not.toThrow();
  });

  /**
   * Инвариант поля — не украшение JSDoc. Нефинитное число роняет канонизацию так же, как это
   * сделала бы строка с одиночным суррогатом, а значит нехэшируемое событие E6 не допишет и
   * в append-only логе останется дыра. «Числа безопасны» верно только при инварианте.
   */
  it('нефинитное число роняет канонизацию — числа безопасны только при инварианте', () => {
    const broken: AuditEvent = { ...buildArgv, argvFromParams: [Number.NaN] };
    expect(() => chainHash(broken, null)).toThrow(TypeError);
  });

  /**
   * Спан по контракту — сводка, а не полная запись. Поиск по вхождению, а не сравнение с
   * точным именем: все атрибуты `toOtlp` несут префикс пространства имён, и естественная
   * ошибка выглядит как `mcpproxy.argvFromParams`, которую точное сравнение пропустило бы.
   */
  it('не протекает в OTLP-спан', () => {
    const leaked = toOtlp(buildArgv).attributes.filter((a) => a.key.includes('argvFromParams'));
    expect(leaked).toEqual([]);
  });
});
