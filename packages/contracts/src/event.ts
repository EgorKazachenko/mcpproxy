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
 * | `validate` | ничего: стадия проверяет параметры и новых полей не вводит |
 * | `build_argv` | `argv`, `argvFromParams` |
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

  /**
   * Позиции в `argv`, занятые значениями, которые пришли из параметров вызова, — то есть
   * то, чем управляла модель. Без этого поля UI показывает собранную команду и не может
   * сказать, какая её часть пришла снаружи, а S2 обещает «видно не что разрешено, а почему».
   *
   * Индексы, а не параллельный массив меток: массив обязан совпадать с `argv` по длине, и
   * это условие никто не проверяет, тогда как список индексов либо пуст, либо указывает в
   * существующие позиции.
   *
   * Самих параметров здесь нет и не будет. Они приходят от модели и стали бы известны на
   * `received`, то есть **до** `validate`: `canonicalizeJcs` бросает на одиночном суррогате
   * и на превышении глубины, а `jcs.ts` называет `IpcRequest.params` поимённо как
   * произвольный JSON из сокета. Одна подстроенная строка сделала бы событие нехэшируемым,
   * и в append-only логе появилась бы дыра, выбранная атакующим. Вдобавок `Redaction.stream`
   * не имеет для них члена, то есть вырезать из них секрет было бы нечем.
   *
   * **Инвариант.** Неотрицательные целые, строго меньше длины `argv` **этого же события**,
   * без повторов; ключ присутствует только когда присутствует `argv`. «Этого же события» —
   * несущее уточнение: в событие приземляется безопасная копия `argv` после редакции, и
   * индексы обязаны указывать в неё, а не в исходную команду, иначе они разъедутся ровно
   * там, где был вырезан секрет. Нефинитное число и дырка в массиве канонизацию роняют — обе
   * проверки живут в `jcs.ts` и покрыты тестами, а не подразумеваются: до 2026-08-28 дырка
   * тихо уезжала на диск и давала при перечитывании другой хэш. «Числа безопасны» верно
   * только при этом инварианте.
   */
  readonly argvFromParams?: readonly number[];

  readonly cwd?: string;
  readonly env?: { readonly allowed: readonly string[] };
  readonly sandbox?: {
    readonly mode: SandboxMode;
    readonly profile?: SandboxProfile;
    readonly violations?: readonly SandboxViolation[];
    /** Только на `complete`, и только у вызова, дошедшего до `spawn`. См. `SandboxEvidence`. */
    readonly evidence?: SandboxEvidence;
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

/**
 * Счётчики качества самой записи о нарушениях, а не поведения процесса.
 *
 * Поле добавлено в E4 и **необязательно**: событие без него канонизируется ровно так же, как
 * канонизировалось до добавления, поэтому уже записанные цепочки остаются верифицируемыми, а
 * `CONTRACTS_VERSION` не двигается.
 *
 * Заведено потому, что альтернативой было выронить их навсегда. `ExecOutcome` объявляет эти
 * величины доказательствами: `violationsLost` больше нуля означает, что бейдж «нарушений нет»
 * в UI неотличим от «нарушения были, но не доехали», а `policyHash` — единственное, что
 * связывает запись с политикой, которая на самом деле применялась. Журнал append-only:
 * запись, сделанная без них, не дополняется задним числом.
 */
export interface SandboxEvidence {
  /** Хэш применённой политики: `policyHash` из `@mcpproxy/core`, посчитанный на `build_profile`. */
  readonly policyHash: string;
  readonly violationsLost: number;
  readonly attributionMissing: number;
  readonly attributionForeign: number;
  readonly unrecognizedLines: number;
  readonly suppressedLines: number;
  readonly consumerFailures: number;
  readonly bodyCountFailures: number;
  readonly lateUnattributed: number;
}

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
