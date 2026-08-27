import { describe, expect, it } from 'vitest';
import type { AuditEvent } from './event.js';
import { OVERHEAD_EXCLUDED_STAGES, overheadMs } from './event.js';
import type { Stage } from './domain.js';
import { isoToUnixNano, toOtlp, type OtlpKeyValue } from './otlp.js';

const CORE: AuditEvent = {
  operation: 'execute_tool',
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
    expect(span.startTimeUnixNano).toBe(isoToUnixNano('2026-08-27T10:00:00.000000Z'));
    expect(typeof span.endTimeUnixNano).toBe('string');
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
    expect(attributes.find((one) => one.key === 'mcp.protocol.version')?.value.stringValue).toBe('2025-11-25');
  });

  it('int64 едет строкой, как требует proto3 JSON', () => {
    const attributes = toOtlp(FULL).attributes;
    expect(attributes.find((one) => one.key === 'mcpproxy.output.bytes')?.value.intValue).toBe('4211');
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
