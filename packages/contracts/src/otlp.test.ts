import { describe, expect, it } from 'vitest';
import type { AuditEvent } from './event.js';
import { OVERHEAD_EXCLUDED_STAGES, overheadMs } from './event.js';
import type { Stage } from './domain.js';
import { toOtlp, type OtlpKeyValue } from './otlp.js';

const CORE: AuditEvent = {
  schema: 'mcpproxy.audit/1',
  operation: 'execute_tool',
  protocolVersion: '2025-11-25',
  toolName: 'run_tests',
  sessionId: 'sess-1',
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  spanId: '00f067aa0ba902b7',
  parentSpanId: '0123456789abcdef',
  startTime: '2026-08-27T10:00:00.000000Z',
  endTime: '2026-08-27T10:00:12.412500Z',
  durationUs: 9_120,
  stage: 'complete',
  verdict: 'allowed',
  recipe: { name: 'run_tests', hash: 'a'.repeat(64) },
};

const FULL: AuditEvent = {
  ...CORE,
  denyReason: null,
  argv: ['/opt/homebrew/bin/pnpm', 'test', '--testPathPattern', 'auth'],
  cwd: '/Users/u/proj',
  env: { allowed: ['PATH', 'HOME'] },
  sandbox: { mode: 'seatbelt', violations: [{ type: 'network', target: 'evil.io:443', action: 'denied', bytes: 0 }] },
  risk: { tier: 'medium', annotations: { readOnlyHint: false } },
  approval: {
    channel: 'electron',
    decision: 'approved',
    scope: 'once',
    expiresAt: null,
    argsHash: 'b'.repeat(64),
    sessionId: 'sess-1',
  },
  exit: { code: 0, signal: null },
  output: { bytes: 4211, truncated: false },
  redactions: [{ rule: 'aws-access-key-id', count: 1, stream: 'stdout' }],
  duration: { overheadMs: 14 },
};

/** Плоские **имена полей** JSON. Индексы массивов входят как номера; значения не входят. */
function fieldNames(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => fieldNames(item, `${prefix}.${index}`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [`${prefix}.${key}`, ...fieldNames(child, `${prefix}.${key}`)]);
}

const attributeKeys = (attributes: OtlpKeyValue[]): string[] => attributes.map((one) => one.key);

describe('toOtlp — форма', () => {
  it('трассировочные идентификаторы едут hex-строками, kind — числом', () => {
    const span = toOtlp(FULL);
    expect(span.traceId).toBe(FULL.traceId);
    expect(span.spanId).toBe(FULL.spanId);
    expect(span.parentSpanId).toBe(FULL.parentSpanId);
    expect(span.kind).toBe(1);
    expect(span.name).toBe('execute_tool');
  });

  it('время — десятичные строки наносекунд, включая доли миллисекунды', () => {
    const span = toOtlp(FULL);
    // Литералы, посчитанные от эпохи, а НЕ через `isoToUnixNano` — её же и проверяем.
    // Сверка с функцией под тестом двигала обе стороны вместе: сдвиг на секунду внутри
    // `isoToUnixNano` оставлял файл зелёным, а каждый экспортированный спан — сдвинутым,
    // и в OTLP у приёмника нет второго мнения о времени.
    expect(span.startTimeUnixNano).toBe('1787824800000000000');
    expect(span.endTimeUnixNano).toBe('1787824812412500000');
    // 12.4125 с разницы — микросекунды обязаны дожить до экспорта, иначе замер оверхеда
    // невоспроизводим по логу.
    expect(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)).toBe(12_412_500_000n);
  });

  it('корневой спан не несёт parentSpanId вовсе', () => {
    const span = toOtlp({ ...CORE, parentSpanId: null });
    expect('parentSpanId' in span).toBe(false);
  });

  it('отвергает не-ISO время, а не молча пишет NaN', () => {
    expect(() => toOtlp({ ...CORE, startTime: 'вчера' })).toThrow(TypeError);
  });

  it('отвергает время без зоны — иначе оно молча считается локальным', () => {
    // `Date.parse('2026-08-27T10:00:00')` по спеке ECMAScript — ЛОКАЛЬНОЕ время, поэтому
    // писатель, забывший `Z`, дал бы спан, сдвинутый на смещение машины, и ни одной ошибки.
    expect(() => toOtlp({ ...CORE, startTime: '2026-08-27T10:00:00' })).toThrow(TypeError);
    expect(() => toOtlp({ ...CORE, startTime: '2026-08-27T10:00:00+03:00' })).not.toThrow();
  });

  it('ошибка ставит статус спана, отказ политики — нет', () => {
    // Без `status` спан всегда STATUS_UNSET, и бэкенд, считающий ошибки по статусу, не
    // отличает сбой от успеха. `denied` при этом штатный исход решения, а не сбой: пометив
    // его ошибкой, мы нарисовали бы работающую политику как отказавший сервис.
    expect(toOtlp({ ...CORE, verdict: 'error', denyReason: 'upstream закрыл сокет' }).status).toEqual({
      code: 2,
      message: 'upstream закрыл сокет',
    });
    expect(toOtlp({ ...CORE, verdict: 'denied' }).status).toBeUndefined();
    expect(toOtlp({ ...CORE, verdict: 'allowed' }).status).toBeUndefined();
  });
});

describe('toOtlp — R14: имена полей', () => {
  it('в выводе нет ни одного ключа со знаком подчёркивания', () => {
    // Приёмник OTLP обязан молча игнорировать поля с неизвестными именами (Ф8), поэтому
    // `trace_id` не даёт ошибки — он теряется. Проверяется отсутствие ЛЮБОГО ключа с `_`,
    // а не наличие конкретных.
    const names = fieldNames(toOtlp(FULL));
    expect(names.filter((one) => one.includes('_'))).toEqual([]);
  });

  it('имена атрибутов при этом подчёркивания содержат — и это законно', () => {
    // Они значения поля `key`, а не имена полей JSON. Утверждение стоит рядом с предыдущим
    // намеренно: без него первый же красный прогон «чинится» ослаблением проверки выше.
    expect(attributeKeys(toOtlp(FULL).attributes)).toContain('gen_ai.tool.name');
  });
});

describe('toOtlp — атрибуты', () => {
  it('эмитит имена, подтверждённые разведкой', () => {
    const keys = attributeKeys(toOtlp(FULL).attributes);
    expect(keys).toEqual(
      expect.arrayContaining([
        'gen_ai.operation.name',
        'gen_ai.tool.name',
        'network.transport',
        'mcp.session.id',
        'mcp.method.name',
        'mcp.protocol.version',
      ]),
    );
  });

  it('не эмитит несуществующих mcp.* и не эмитит jsonrpc.request.id', () => {
    const keys = attributeKeys(toOtlp(FULL).attributes);
    for (const absent of ['mcp.tool.name', 'mcp.request.id', 'mcp.transport', 'mcp.resource.uri', 'jsonrpc.request.id']) {
      expect(keys).not.toContain(absent);
    }
  });

  it('транспорт и метод — константы', () => {
    const attributes = toOtlp(FULL).attributes;
    expect(attributes.find((one) => one.key === 'network.transport')?.value.stringValue).toBe('pipe');
    expect(attributes.find((one) => one.key === 'mcp.method.name')?.value.stringValue).toBe('tools/call');
    // Ревизия — из события, а не из константы сборки: сессия со старым клиентом обязана
    // оставить в логе то, на чём договорились, иначе запись утверждает неправду.
    expect(attributes.find((one) => one.key === 'mcp.protocol.version')?.value.stringValue).toBe('2025-11-25');
    const older = toOtlp({ ...FULL, protocolVersion: '2025-06-18' }).attributes;
    expect(older.find((one) => one.key === 'mcp.protocol.version')?.value.stringValue).toBe('2025-06-18');
  });

  it('int64 едет строкой, как требует proto3 JSON', () => {
    const attributes = toOtlp(FULL).attributes;
    expect(attributes.find((one) => one.key === 'mcpproxy.output.bytes')?.value.intValue).toBe('4211');
  });

  it('полный вызов несёт argv, cwd и тир — контроль к проверке ниже', () => {
    // Без этого кейса три отрицания ниже были вакуумными: удалив эмиссию `mcpproxy.argv`,
    // `mcpproxy.cwd` и `mcpproxy.risk.tier`, весь набор оставался зелёным, а экспортёр
    // молча переставал отдавать argv, на который опираются модалка S8 и аудит.
    const attributes = toOtlp(FULL).attributes;
    const find = (key: string) => attributes.find((one) => one.key === key)?.value;
    expect(find('mcpproxy.argv')?.arrayValue?.values.map((one) => one.stringValue)).toEqual([
      '/opt/homebrew/bin/pnpm',
      'test',
      '--testPathPattern',
      'auth',
    ]);
    expect(find('mcpproxy.cwd')?.stringValue).toBe('/Users/u/proj');
    expect(find('mcpproxy.risk.tier')?.stringValue).toBe('medium');
    expect(find('mcpproxy.env.allowed')?.arrayValue?.values.map((one) => one.stringValue)).toEqual(['PATH', 'HOME']);
    expect(find('mcpproxy.sandbox.mode')?.stringValue).toBe('seatbelt');
    expect(find('mcpproxy.sandbox.violations.count')?.intValue).toBe('1');
    expect(find('mcpproxy.approval.channel')?.stringValue).toBe('electron');
    expect(find('mcpproxy.exit.code')?.intValue).toBe('0');
    expect(find('mcpproxy.redactions.count')?.intValue).toBe('1');
    expect(find('mcpproxy.duration.overhead_ms')?.intValue).toBe('14');
  });

  it('вызов, остановленный на lock_check, не несёт выдуманного argv', () => {
    const keys = attributeKeys(toOtlp({ ...CORE, stage: 'lock_check', verdict: 'denied' }).attributes);
    expect(keys).not.toContain('mcpproxy.argv');
    expect(keys).not.toContain('mcpproxy.cwd');
    expect(keys).not.toContain('mcpproxy.risk.tier');
  });
});

describe('overheadMs', () => {
  const durations = new Map<Stage, number>([
    ['received', 1_000],
    ['lock_check', 2_000],
    ['validate', 1_000],
    ['approval', 30_000_000],
    ['spawn', 12_000_000],
    ['violation', 500_000],
    ['complete', 1_000],
  ]);

  it('исключает время процесса, человека и собственное', () => {
    // 1000 + 2000 + 1000 микросекунд = 4 мс. Включив spawn или approval, S8 отрапортовал бы
    // десятки тысяч миллисекунд при цели ≤50 мс p95.
    expect(overheadMs(durations)).toBe(4);
  });

  it('множество исключённых стадий не пересекается с посчитанными', () => {
    expect([...OVERHEAD_EXCLUDED_STAGES].sort()).toEqual(['approval', 'complete', 'spawn', 'violation']);
  });
});
