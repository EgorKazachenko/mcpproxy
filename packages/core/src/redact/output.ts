import type { AuditEvent, NormalizedDefaults, Redaction } from '@mcpproxy/contracts';
import type { Redactor } from './engine.js';

/**
 * Стадия `redact` целиком: что уезжает в модель и что уезжает в запись аудита.
 *
 * Два направления живут в двух функциях, потому что делают разное. `redactOutput` **заменяет**
 * найденное — это исходящий поток, и секрет обязан не доехать. `redactInbound` только
 * **считает** и готовит безопасную копию для журнала — настоящий argv правке не подлежит:
 * рецепт с параметром-токеном получил бы `[redacted:…]` вместо значения и сломался бы молча,
 * а вердикт вызова эвристика с ложняками менять не должна (D4).
 */

/**
 * Эффективный `output`-профиль из `normalizeRecipe(...).effective`. Пересчитывать нечего.
 *
 * Псевдоним контрактного типа, а не структурная копия: копия совпадала бы сегодня и разошлась
 * бы молча в тот день, когда E0 добавит поле или сдвинет `maxBytes`. Тождество утверждает
 * компилятор, а не комментарий рядом.
 */
export type OutputLimits = NormalizedDefaults['output'];

export interface ProcessOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export interface RedactedOutput {
  readonly stdout: string;
  readonly stderr: string;
  /** Ровно `AuditEvent['output']` — ссылкой на контракт, а не повторением его формы. */
  readonly output: NonNullable<AuditEvent['output']>;
  readonly redactions: readonly Redaction[];
}

export interface InboundInput {
  /** argv, собранный из параметров модели. Возвращается **копия** для журнала. */
  readonly argv: readonly string[];
  /** Окружение после `buildEnv`. Сканируются ЗНАЧЕНИЯ; наружу не отдаётся ни одно. */
  readonly env: Readonly<Record<string, string>>;
}

export interface RedactedInbound {
  /** Безопасная копия argv — она и только она попадает в `AuditEvent.argv` (R9). */
  readonly argv: readonly string[];
  readonly redactions: readonly Redaction[];
}

/** Порядок юниона в контракте. По нему сортируется отчёт, чтобы запись была детерминирована. */
const STREAM_ORDER: readonly Redaction['stream'][] = ['stdout', 'stderr', 'argv', 'env'];

/**
 * Обрезка по БАЙТАМ с сохранением границы кодовой точки.
 *
 * Наивный `buffer.subarray(0, maxBytes).toString()` режет многобайтовую последовательность
 * пополам, и на месте разреза появляется U+FFFD — то есть потолок, заданный в байтах, портит
 * последний символ вместо того, чтобы его выбросить. Отступаем назад по байтам продолжения
 * (`10xxxxxx`), пока не встанем на начало символа.
 */
function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  // Клампинг сознательный: отрицательный потолок сюда доехать не должен (схема манифеста его
  // не пропускает), но если доедет — он обязан значить «ничего не отдавать», а не «отдать всё».
  const limit = Math.max(0, maxBytes);
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= limit) return { text, truncated: false };

  let end = limit;
  while (end > 0) {
    const byte = buffer[end];
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) break;
    end -= 1;
  }
  return { text: buffer.subarray(0, end).toString('utf8'), truncated: true };
}

function toRedactions(counts: ReadonlyMap<string, number>, stream: Redaction['stream']): Redaction[] {
  return [...counts.entries()].map(([rule, count]) => ({ rule, count, stream }));
}

/** Детерминированный порядок: сначала поток по порядку юниона, внутри потока — правило по имени. */
const sortRedactions = (redactions: readonly Redaction[]): readonly Redaction[] =>
  [...redactions].sort(
    (a, b) => STREAM_ORDER.indexOf(a.stream) - STREAM_ORDER.indexOf(b.stream) || a.rule.localeCompare(b.rule),
  );

/**
 * Исходящее направление: `stdout` и `stderr`.
 *
 * **Порядок заморожен: сначала редакция, потом обрезка (R10).** Обратный порядок разрезает
 * секрет ровно на границе потолка — хвост уезжает, а голова остаётся в тексте, не совпадая
 * уже ни с одним паттерном, и приезжает в модель. Это не гипотеза: при `maxBytes: 50` и
 * секрете, начинающемся на сороковом байте, «сначала обрезали» оставляет `ghp_016ABC`.
 *
 * **Потолок применяется к каждому потоку отдельно**, а не к их сумме. Общий бюджет означал
 * бы, что длинный `stdout` съедает `stderr` целиком, и при упавшей сборке в модель уезжает
 * гора логов без единой строки ошибки — то есть режется ровно то, ради чего вызов и делали.
 * Цена решения — до `2 × maxBytes` в худшем случае; это известная константа, а не рост.
 */
export function redactOutput(redactor: Redactor, output: ProcessOutput, limits: OutputLimits): RedactedOutput {
  const redactions: Redaction[] = [];
  const cleaned: Record<'stdout' | 'stderr', string> = { stdout: output.stdout, stderr: output.stderr };

  for (const stream of ['stdout', 'stderr'] as const) {
    // Энтропия включена только здесь — это единственные два потока, где встречаются блобы
    // без формы, и единственные, где ложняк не ломает вызов, а лишь портит строку лога.
    const result = redactor.redact(output[stream], { entropy: true });

    // СКАНИРУЕМ ВСЕГДА, заменяем только при `redact: true`. Раньше `redact: false` выключал
    // и подсчёт, и запись аудита не содержала следа того, что процесс напечатал ключ. R14
    // требует выключить РЕДАКЦИЮ и про отчёт не высказывается, а принцип записан рядом же,
    // в `output.test.ts`: отчёт обязан быть о том, ЧТО ПРОИЗОШЛО, а не о том, что доехало.
    // Поскольку E0 держит пол (`redact: false` возможен только явным решением владельца
    // манифеста), это ровно тот случай, когда сигнал в журнале нужнее всего.
    cleaned[stream] = limits.redact ? result.text : output[stream];
    redactions.push(...toRedactions(result.counts, stream));
  }

  const limit = limits.maxBytes;
  const stdout = limit === null ? { text: cleaned.stdout, truncated: false } : truncateUtf8(cleaned.stdout, limit);
  const stderr = limit === null ? { text: cleaned.stderr, truncated: false } : truncateUtf8(cleaned.stderr, limit);

  return {
    stdout: stdout.text,
    stderr: stderr.text,
    // Байты того, что РЕАЛЬНО отдано вызывающему: после редакции и после обрезки (R11).
    // Событие описывает то, что видела модель, а не то, что напечатал процесс.
    output: {
      bytes: Buffer.byteLength(stdout.text, 'utf8') + Buffer.byteLength(stderr.text, 'utf8'),
      truncated: stdout.truncated || stderr.truncated,
    },
    redactions: sortRedactions(redactions),
  };
}

/**
 * Входящее направление: `argv` от модели и значения окружения после `buildEnv`.
 *
 * **Ничего не блокирует и ничего не ломает (D4).** Срабатывание означает «allowlist слишком
 * широк» или «модель тащит украденное» — и то и другое надо показать человеку, а не
 * превратить эвристику с ложняками в отказ в обслуживании.
 *
 * **Полиси `output.redact` сюда не относится.** `redact: false` — решение владельца манифеста
 * про свой вывод; про то, что попадёт в append-only журнал, оно не высказывается, а журнал
 * читают через месяцы (R14).
 *
 * Энтропия выключена: в `argv` лежат пути и значения параметров, где детектор длинных
 * base64-ранов даёт ложняки и не добавляет находок.
 */
export function redactInbound(redactor: Redactor, input: InboundInput): RedactedInbound {
  const redactions: Redaction[] = [];

  const argvCounts = new Map<string, number>();
  const argv = input.argv.map((argument) => {
    const result = redactor.redact(argument, { entropy: false });
    for (const [rule, count] of result.counts) argvCounts.set(rule, (argvCounts.get(rule) ?? 0) + count);
    return result.text;
  });
  redactions.push(...toRedactions(argvCounts, 'argv'));

  const envCounts = new Map<string, number>();
  for (const value of Object.values(input.env)) {
    // Значение окружения только СЧИТАЕТСЯ: в событие уезжают одни имена (`env.allowed`),
    // поэтому отредактированный текст здесь некуда деть — и не надо.
    for (const [rule, count] of redactor.redact(value, { entropy: false }).counts) {
      envCounts.set(rule, (envCounts.get(rule) ?? 0) + count);
    }
  }
  redactions.push(...toRedactions(envCounts, 'env'));

  return { argv, redactions: sortRedactions(redactions) };
}
