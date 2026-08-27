import type { AuditEvent } from './event.js';

/**
 * Экспортёр события в OTLP/JSON.
 *
 * **Имена полей — lowerCamelCase, и это не стиль, а требование спеки OTLP:** «The keys of
 * JSON objects are field names converted to lowerCamelCase. Original field names are not
 * valid to use as keys.» Приёмник при этом обязан **молча игнорировать** поля с неизвестными
 * именами, поэтому `trace_id` не даст ошибки — он просто потеряется. Отсюда R14: тест на
 * отсутствие snake_case обязателен, иначе дефект ненаблюдаем вообще ничем.
 *
 * Имена **атрибутов** — это значения поля `key`, а не имена полей JSON, и `gen_ai.tool.name`
 * содержит `_` совершенно законно. Спутать одно с другим — получить красный тест на первом
 * же прогоне и «починить» его ослаблением до не-проверки.
 */

export interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  /** int64 в proto3 JSON — десятичная строка, а не число. */
  intValue?: string;
  doubleValue?: number;
  arrayValue?: { values: OtlpAnyValue[] };
}

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** `SPAN_KIND_INTERNAL`. Константа экспортёра, а не поле события. */
  kind: 1;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  /**
   * `STATUS_CODE_ERROR` = 2. Без этого поля спан всегда `STATUS_UNSET`, и в любом бэкенде,
   * который считает ошибки по статусу спана — а это все, — ошибка неотличима от успеха.
   * Аргумент тот же, что у R14: приёмник не жалуется, поэтому дефект ненаблюдаем.
   *
   * `denied` статусом **не** помечается намеренно: отказ политики — это штатный исход
   * решения, а не сбой прокси. Смешав их, мы получили бы дашборд, на котором работающая
   * политика выглядит как отказавший сервис.
   */
  status?: { code: 2; message?: string };
}

const SPAN_KIND_INTERNAL = 1 as const;
const SPAN_STATUS_ERROR = 2 as const;

/**
 * ISO-8601 → десятичные наносекунды.
 *
 * `Date.parse` режет дробную часть до миллисекунд, поэтому доли миллисекунды собираются
 * из самой строки: событие несёт микросекундные длительности, и терять их при экспорте
 * значило бы делать замер оверхеда невоспроизводимым.
 */
/**
 * Зона обязана быть указана. `Date.parse('2026-08-27T10:00:00')` — форма без `Z` и без
 * смещения — по спеке ECMAScript трактуется как **локальное** время, поэтому два писателя
 * событий, один из которых забыл `Z`, дали бы спаны, разъехавшиеся на смещение машины, и ни
 * один из них не был бы ошибкой. `AuditEvent.startTime: string` формы не ограничивает, значит
 * ограничивает экспортёр.
 */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function isoToUnixNano(iso: string): string {
  if (!ISO_WITH_ZONE.test(iso)) throw new TypeError(`не ISO-8601 с указанной зоной: ${iso}`);
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new TypeError(`не ISO-8601: ${iso}`);
  const fraction = /\.(\d+)/.exec(iso)?.[1] ?? '';
  const nanosInSecond = BigInt(`${fraction}000000000`.slice(0, 9));
  const seconds = BigInt(Math.floor(ms / 1000));
  return (seconds * 1_000_000_000n + nanosInSecond).toString();
}

const str = (key: string, value: string): OtlpKeyValue => ({ key, value: { stringValue: value } });
const int = (key: string, value: number): OtlpKeyValue => ({ key, value: { intValue: String(value) } });
const bool = (key: string, value: boolean): OtlpKeyValue => ({ key, value: { boolValue: value } });
const strings = (key: string, values: readonly string[]): OtlpKeyValue => ({
  key,
  value: { arrayValue: { values: values.map((one) => ({ stringValue: one })) } },
});

export function toOtlp(event: AuditEvent): OtlpSpan {
  const attributes: OtlpKeyValue[] = [
    // Имена подтверждены разведкой по репозиторию конвенций, а не по npm-пакету (Ф9).
    // `mcp.tool.name`, `mcp.request.id` и `mcp.transport` не существуют — их здесь нет и не будет.
    str('gen_ai.operation.name', event.operation),
    str('gen_ai.tool.name', event.toolName),
    // Константа: MCP-сессия — это stdio между клиентом и шимом. Сокет шим↔демон внутренний
    // и MCP-транспортом не является.
    str('network.transport', 'pipe'),
    str('mcp.session.id', event.sessionId),
    str('mcp.method.name', 'tools/call'),
    // Согласованная ревизия из события, а не константа сборки: см. `AuditEvent.protocolVersion`.
    str('mcp.protocol.version', event.protocolVersion),
    // `jsonrpc.request.id` НЕ эмитится, и это записано, а не забыто: id живёт в E4 между
    // клиентом и шимом и через IpcRequest не едет (И5). Корреляция идёт по traceId.
    // `mcp.resource.uri` тоже нет: ресурсов у нас нет.

    str('mcpproxy.stage', event.stage),
    str('mcpproxy.verdict', event.verdict),
    str('mcpproxy.recipe.name', event.recipe.name),
    int('mcpproxy.duration.stage_us', event.durationUs),
  ];

  if (event.recipe.hash !== undefined) attributes.push(str('mcpproxy.recipe.hash', event.recipe.hash));
  if (event.denyReason != null) attributes.push(str('mcpproxy.deny_reason', event.denyReason));
  if (event.argv !== undefined) attributes.push(strings('mcpproxy.argv', event.argv));
  if (event.cwd !== undefined) attributes.push(str('mcpproxy.cwd', event.cwd));
  if (event.env !== undefined) attributes.push(strings('mcpproxy.env.allowed', event.env.allowed));
  if (event.sandbox !== undefined) {
    attributes.push(str('mcpproxy.sandbox.mode', event.sandbox.mode));
    if (event.sandbox.violations !== undefined) {
      // `.count`, а не `.violations`: имя без суффикса обещало бы сам список, а спан несёт
      // только длину. Полная запись живёт в JSONL — см. «Экспорт в OTLP» в 07-contracts.md.
      attributes.push(int('mcpproxy.sandbox.violations.count', event.sandbox.violations.length));
    }
  }
  if (event.risk !== undefined) attributes.push(str('mcpproxy.risk.tier', event.risk.tier));
  if (event.approval !== undefined) {
    attributes.push(str('mcpproxy.approval.channel', event.approval.channel));
    attributes.push(str('mcpproxy.approval.decision', event.approval.decision));
    attributes.push(str('mcpproxy.approval.scope', event.approval.scope));
  }
  if (event.exit?.code != null) attributes.push(int('mcpproxy.exit.code', event.exit.code));
  if (event.exit?.signal != null) attributes.push(str('mcpproxy.exit.signal', event.exit.signal));
  if (event.output !== undefined) {
    attributes.push(int('mcpproxy.output.bytes', event.output.bytes));
    attributes.push(bool('mcpproxy.output.truncated', event.output.truncated));
  }
  if (event.redactions !== undefined) attributes.push(int('mcpproxy.redactions.count', event.redactions.length));
  if (event.duration !== undefined) attributes.push(int('mcpproxy.duration.overhead_ms', event.duration.overheadMs));

  return {
    traceId: event.traceId,
    spanId: event.spanId,
    ...(event.parentSpanId !== null ? { parentSpanId: event.parentSpanId } : {}),
    name: event.operation,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: isoToUnixNano(event.startTime),
    endTimeUnixNano: isoToUnixNano(event.endTime),
    attributes,
    ...(event.verdict === 'error'
      ? { status: { code: SPAN_STATUS_ERROR, ...(event.denyReason == null ? {} : { message: event.denyReason }) } }
      : {}),
  };
}
