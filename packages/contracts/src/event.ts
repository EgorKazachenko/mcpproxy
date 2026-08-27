import type { ToolAnnotations } from './annotations.js';
import type { ApprovalRecord } from './approval.js';
import type { RiskTier, SandboxMode, Stage, Verdict, ViolationType } from './domain.js';
import type { SandboxProfile } from './manifest.generated.js';

/**
 * Событие аудита. Внутренний шейп — вложенный, время — ISO-8601, enum'ы — строки;
 * в OTLP его отображает `toOtlp` (решение D2). Своя схема, а не нативная OTel, потому что
 * статус всего `gen_ai.*` — Development, и дрейф уже наблюдался (Ф9).
 *
 * **Поля `chain` здесь нет** и не будет: цепочку добавляет `ChainedEvent`. Тогда `chainHash`
 * хэширует свой аргумент целиком, и вопрос «что исключить перед хэшированием» не возникает —
 * а вместе с ним не возникает и тихая дыра, в которую проваливается каждое поле, добавленное
 * после заморозки.
 *
 * **Необязательное поле отсутствует как ключ**, а не присутствует со значением `null`.
 * `null` означает ровно «известно и пусто» (`exit.signal`, `denyReason` при
 * `verdict: 'allowed'`). Различие не стилистическое: JCS различает отсутствующий ключ и
 * `null` побайтово, и оба варианта попадают внутрь `chain.self`.
 *
 * Стадия, на которой поле впервые может появиться (`stageOrder`, `docs/07-contracts.md`):
 *
 * | Стадия | Что впервые появляется |
 * |---|---|
 * | `received` | обязательное ядро целиком |
 * | `lock_check` | `recipe.hash` |
 * | `resolve_paths` | `cwd` |
 * | `build_argv` | `argv` |
 * | `classify_risk` | `risk` |
 * | `approval` | `approval` |
 * | `build_env` | `env` |
 * | `build_profile` | `sandbox.profile` |
 * | `spawn` | `sandbox.mode` |
 * | `violation` | `sandbox.violations` |
 * | `redact` | `redactions`, `output` |
 * | `complete` | `exit`, `duration.overheadMs` |
 *
 * Событие пишется на **каждой** стадии, включая отказ, поэтому вызов, остановленный на
 * `lock_check`, обязан уметь не иметь `argv` вовсе — иначе он понесёт выдуманный `argv: []`,
 * и UI отрисует его как настоящую пустую команду.
 */
export interface AuditEvent {
  /**
   * Версия формы записи. Запись аудита обязана быть самоописывающейся: лог append-only,
   * `chainHash` хэширует событие целиком, поэтому добавить это поле **после** заморозки
   * нельзя дважды — и по правилу заморозки, и потому что новое обязательное поле даёт
   * новый дайджест, а старые и новые записи лежат в одной цепочке.
   *
   * Читатель обязан быть tolerant: неизвестное значение — читаемая запись с пометкой
   * «форма новее меня», а не исключение. Иначе одна запись из будущего делает
   * нечитаемым весь предшествующий лог, который перегенерировать нельзя.
   */
  readonly schema: 'mcpproxy.audit/1';
  /** `gen_ai.operation.name`. У прокси она одна. */
  readonly operation: 'execute_tool';
  /**
   * Ревизия MCP, **согласованная в этой сессии**, а не константа сборки. `MCP_PROTOCOL_VERSION`
   * — предпочитаемая нами ревизия и разумный дефолт для писателя; но сессия со старым
   * клиентом, договорившимся на `2025-06-18`, обязана оставить в логе `2025-06-18`. Запись,
   * утверждающая нашу константу вместо согласованного значения, — не потеря поля, а ложное
   * утверждение в доказательстве.
   */
  readonly protocolVersion: string;
  readonly toolName: string;
  /**
   * IPC-сессия. В обязательном ядре, а не в опциональных: он известен уже на `received`, и
   * без него append-only лог многосессионного демона не может сказать, какая сессия сделала
   * вызов, — единственный криминалистический артефакт для атаки A5 (украденный токен).
   */
  readonly sessionId: string;
  readonly traceId: string;
  readonly spanId: string;
  /** `null` — корневой спан: родителя нет, а не «неизвестен». */
  readonly parentSpanId: string | null;
  readonly startTime: string;
  readonly endTime: string;
  /**
   * Монотонная длительность **стадии**, микросекунды, целым числом (`process.hrtime.bigint`).
   * Рядом с ISO-временем стены, а не вместо: метки, квантованные до миллисекунды, дают
   * ошибку порядка самого измерения, а часы стены ещё и прыгают по NTP. Без этого поля
   * оверхед, который публикуют S2 и `09-metrics-and-eval.md`, из события не выводится.
   */
  readonly durationUs: number;
  readonly stage: Stage;
  readonly verdict: Verdict;
  readonly recipe: { readonly name: string; readonly hash?: string };

  readonly denyReason?: string | null;
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly env?: { readonly allowed: readonly string[] };
  readonly sandbox?: {
    readonly mode: SandboxMode;
    readonly profile?: SandboxProfile;
    readonly violations?: readonly SandboxViolation[];
  };
  readonly risk?: { readonly tier: RiskTier; readonly annotations: ToolAnnotations };
  readonly approval?: ApprovalRecord;
  readonly exit?: { readonly code: number | null; readonly signal: string | null };
  readonly output?: { readonly bytes: number; readonly truncated: boolean };
  readonly redactions?: readonly Redaction[];
  /** Только на `complete`. Как считается — см. `overheadMs`. */
  readonly duration?: { readonly overheadMs: number };
}

/**
 * Событие, уже вписанное в цепочку. Тип объявлен здесь, в корневом входе, а не рядом с
 * `chainHash`: рендереру, который показывает лог, нужен именно он, а `node:crypto` — нет.
 *
 * `prev: null` означает генезис. Формула `self` заморожена в `./audit`.
 */
export type ChainedEvent = AuditEvent & {
  readonly chain: { readonly prev: string | null; readonly self: string };
};

export interface SandboxViolation {
  readonly type: ViolationType;
  readonly target: string;
  readonly action: 'denied' | 'allowed';
  readonly bytes: number;
}

/**
 * Что именно было вырезано и откуда. `stream` шире, чем два потока вывода, намеренно:
 * в этом же событии лежит `argv` со значениями, пришедшими от модели, и список разрешённых
 * имён переменных окружения — то есть места, откуда секрет придётся вырезать, замороженным
 * событием обязаны быть выразимы. Расширять юнион после заморозки дорого: по нему строятся
 * исчерпывающие `Record<Union, …>` у потребителей.
 */
export interface Redaction {
  readonly rule: string;
  readonly count: number;
  readonly stream: 'stdout' | 'stderr' | 'argv' | 'env';
}

/**
 * Стадии, чья длительность **не** входит в оверхед прокси.
 *
 * - `spawn` — это время дочернего процесса, а не наше;
 * - `violation` — нарушений может быть много, и возникают они, пока дочерний процесс
 *   работает, то есть внутри окна `spawn`: суммируя их наравне, мы прибавляли бы уже
 *   посчитанное время;
 * - `approval` — это человек, смотрящий на модалку. `09-metrics-and-eval.md` определяет
 *   оверхед как задержку прокси относительно прямого вызова при цели ≤50 мс p95; включив
 *   сюда апрув, S8 (`publish_release`) отрапортовал бы десятки тысяч миллисекунд;
 * - `complete` — значение вычисляется **на** этом событии, и его собственный `durationUs`
 *   в этот момент ещё не известен. Формула, включающая его, невычислима.
 */
export const OVERHEAD_EXCLUDED_STAGES: readonly Stage[] = ['spawn', 'violation', 'approval', 'complete'] as const;

/**
 * Оверхед прокси в миллисекундах: работа без времени дочернего процесса и без времени
 * человека. Считается по непересекающемуся множеству стадий, поэтому окно `spawn` не
 * прибавляется дважды.
 */
export function overheadMs(stageDurationsUs: ReadonlyMap<Stage, number>): number {
  let total = 0;
  for (const [stage, us] of stageDurationsUs) {
    if (OVERHEAD_EXCLUDED_STAGES.includes(stage)) continue;
    total += us;
  }
  return Math.round(total / 1000);
}
