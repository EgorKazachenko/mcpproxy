import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { AuditEvent, ChainedEvent } from '@mcpproxy/contracts';
import { canonicalizeJcs } from '@mcpproxy/contracts';
import { chainHash, verifyChain } from '@mcpproxy/contracts/audit';

/**
 * Append-only журнал аудита: JSONL + хэш-цепочка.
 *
 * **Формула здесь не живёт.** `chainHash` и `verifyChain` заморожены в E0 (`./audit`), и
 * вторая копия предиката в этом файле — это две формулы, расходящиеся на первой правке, при
 * которой ни один тест не покраснеет. Модуль отвечает за файл: где он лежит, с какими
 * правами, как восстанавливается `prev` после рестарта и что делать с оборванным хвостом.
 *
 * **Чего журнал не доказывает** (`10-honest-limitations.md`, и это записано, а не умолчано):
 * он tamper-**evident**, а не tamper-proof. Атакующий с правами на файл перепишет его целиком
 * и пересчитает цепочку; отдельно — он может **обрезать хвост**, и укороченный лог останется
 * согласованным, потому что предикат связывает запись с предыдущей, а не с внешним якорем.
 * Против обоих нужен Merkle-корень наружу, и его тут нет.
 */

/**
 * Код отказа. Ветвиться потребитель обязан по нему, а не по тексту `message`.
 *
 * Конвенция взята не с потолка: `packages/contracts/src/types.ts` заводит `DiagnosticCode`
 * ровно с этим обоснованием — «без кода семь эпиков ветвились бы `String.includes` по прозе,
 * и первая же правка формулировки тихо ломала бы ветвление, не уронив ни одного теста».
 * Решения у вызывающего разные и несводимые: `corrupt` — вмешательство оператора, вызовы
 * без аудита пускать нельзя; `closed` и `already-open` — ошибка программиста, чинится кодом;
 * `insecure-directory` — конфигурация прав; `short-write` — диск.
 */
export type AuditLogErrorCode = 'corrupt' | 'closed' | 'already-open' | 'short-write' | 'insecure-directory';

export class AuditLogError extends Error {
  constructor(
    readonly code: AuditLogErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'AuditLogError';
  }
}

export interface AuditLog {
  readonly path: string;
  /**
   * Журнал был восстановлен при открытии: предыдущий запуск убили на середине записи, и
   * недописанный хвост срезан. Флаг отдаётся наружу, чтобы E7 показал «восстановлен после
   * аварийного завершения», а не молчал: молчание тут неотличимо от «ничего не случилось».
   */
  readonly repairedTornTail: boolean;
  readonly append: (event: AuditEvent & { chain?: never }) => ChainedEvent;
  /** Хэш последней записи — он же `prev` следующей. `null` до первой записи. */
  readonly head: () => string | null;
  readonly close: () => void;
}

/**
 * Путь по умолчанию. `MCPPROXY_HOME` перекрывает домашний каталог — им пользуются тесты и
 * им же пользуется тот, у кого `$HOME` на сетевом диске.
 *
 * Пустая строка трактуется как **незаданная**, а не как значение. Это единственное место
 * в E6, где правило R2 («пустая строка — заданное значение») сознательно не применяется:
 * `??` пропустил бы `''` дальше, и `join('', 'audit.jsonl')` дал бы ОТНОСИТЕЛЬНЫЙ путь —
 * журнал с `argv` и `cwd` приземлился бы в текущий каталог демона, а `mkdirSync(dirname)`
 * создал бы `.` вместо защищённого `0700`-каталога.
 */
export function defaultAuditLogPath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const home = env.MCPPROXY_HOME;
  return join(home === undefined || home === '' ? join(homedir(), '.mcpproxy') : home, 'audit.jsonl');
}

export interface ReadLogResult {
  /**
   * Разобранные записи ПОДРЯД, начиная с нулевой строки. Индекс записи равен номеру строки —
   * на это опирается `brokenAt`, и ради этого чтение останавливается на первой неразобранной
   * строке вместо того, чтобы её перепрыгнуть.
   */
  readonly records: readonly ChainedEvent[];
  /**
   * Последняя строка файла оборвана: демон убит на середине `write`. **Это не порча.**
   * Падение процесса, нарисованное залу как взлом, стоит доверия к бейджу целиком.
   */
  readonly trailingPartial: boolean;
  /** Первая строка, которая не разобралась и при этом не является оборванным хвостом. */
  readonly malformedAt: number | null;
  /**
   * Индексы записей, чья версия формы **новее** нашей: читаются, помечаются «форма новее
   * меня». Требование `07-contracts.md`: одна запись из будущего не имеет права сделать
   * нечитаемым весь предшествующий лог, перегенерировать который нельзя.
   */
  readonly future: readonly number[];
  /**
   * Индексы записей, чья версия формы **старее** нашей.
   *
   * Отдельно от `future`, потому что `future` — утверждение о ПОРЯДКЕ, а не о неравенстве.
   * Пока это различие считалось через `!==`, в тот день, когда проект выпустит писателя
   * `mcpproxy.audit/2`, новая сборка прочитала бы весь существующий журнал — всю историю
   * установки — и пометила бы КАЖДУЮ запись как «форма новее меня», а сайдкар экспорта
   * сообщил бы то же получателю. Лог append-only: снять такую пометку перегенерацией нельзя.
   */
  readonly legacy: readonly number[];
}

/**
 * Версия формы, которую пишет ЭТА сборка.
 *
 * Аннотация типом контракта — не украшение: она делает дрейф невозможным. Литерал обязан
 * совпадать с `AuditEvent['schema']`, и если E0 когда-нибудь двинет версию, этот файл
 * перестанет компилироваться вместо того, чтобы молча начать клеймить «из будущего» записи,
 * только что написанные собственным писателем. Рантайм-константы контракт не экспортирует,
 * а он заморожен, поэтому связь держится компилятором, а не импортом.
 */
const KNOWN_SCHEMA: AuditEvent['schema'] = 'mcpproxy.audit/1';
const SCHEMA_PREFIX = 'mcpproxy.audit/';

const versionOf = (schema: string): number | null => {
  if (!schema.startsWith(SCHEMA_PREFIX)) return null;
  const tail = schema.slice(SCHEMA_PREFIX.length);
  return /^(?:0|[1-9]\d*)$/.test(tail) ? Number(tail) : null;
};

const KNOWN_VERSION = versionOf(KNOWN_SCHEMA) ?? 1;

/** Обязательное ядро `AuditEvent` — то, что существует на ЛЮБОЙ стадии, включая `received`. */
const CORE_STRINGS = [
  'schema',
  'operation',
  'protocolVersion',
  'toolName',
  'sessionId',
  'traceId',
  'spanId',
  'startTime',
  'endTime',
  'stage',
  'verdict',
] as const;

/**
 * Проверка формы записи на границе чтения.
 *
 * Проверяются **типы полей ядра v1 и канонизируемость**, а не значения и не версия. Это не
 * противоречит R20: поля ядра заморожены навсегда, а неизвестное значение `schema` и любые
 * неизвестные ЛИШНИЕ поля проходят.
 *
 * Без этой проверки строка, прошедшая `JSON.parse`, приводилась к `ChainedEvent` и уезжала в
 * `verifyChain` → `chainHash` → `canonicalizeJcs`, который **бросает** на нефинитном числе
 * (`1e400`), одиночном суррогате и вложенности глубже 128. Итог: функция, чей единственный
 * смысл — отдать вердикт по возможно подделанному файлу, на подделанном файле вердикта не
 * отдавала, а `exportJsonl` отказывался экспортировать. Отказ экспорта хуже разрыва: разрыв
 * несут в тикет, отказ — нет.
 */
function isReadableRecord(value: unknown): value is ChainedEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

  const record = value as Record<string, unknown>;

  const chain = record.chain;
  if (typeof chain !== 'object' || chain === null) return false;
  const { prev, self } = chain as { prev?: unknown; self?: unknown };
  if (!(prev === null || typeof prev === 'string') || typeof self !== 'string') return false;

  for (const key of CORE_STRINGS) if (typeof record[key] !== 'string') return false;
  if (typeof record.durationUs !== 'number' || !Number.isFinite(record.durationUs)) return false;
  if (!(record.parentSpanId === null || typeof record.parentSpanId === 'string')) return false;

  const recipe = record.recipe;
  if (typeof recipe !== 'object' || recipe === null) return false;
  if (typeof (recipe as { name?: unknown }).name !== 'string') return false;

  // Канонизируемость — часть формы, а не отдельная забота: запись, которую JCS не берёт,
  // не может быть ни проверена нами, ни перепроверена получателем экспорта.
  try {
    canonicalizeJcs(record as Parameters<typeof canonicalizeJcs>[0]);
  } catch {
    return false;
  }
  return true;
}

/**
 * Читает журнал целиком.
 *
 * Толерантность здесь ровно двух видов и ни одного больше: оборванный **хвост** и незнакомая
 * версия формы. Неразобранная строка **в середине** — не толерантность, а дыра: последующие
 * `prev` ссылаются на запись, которой в разборе нет, и «пропустить и читать дальше» выдало бы
 * согласованную цепочку на порченом файле. Поэтому чтение на ней останавливается.
 */
export function readLog(path: string): ReadLogResult {
  const empty: ReadLogResult = { records: [], trailingPartial: false, malformedAt: null, future: [], legacy: [] };
  if (!existsSync(path)) return empty;

  const raw = readFileSync(path, 'utf8');
  if (raw === '') return empty;

  // Хвост без `\n` — это недописанная строка. Полностью записанная всегда оканчивается им,
  // потому что перевод строки уезжает тем же единственным `write`, что и сама запись.
  const endsComplete = raw.endsWith('\n');
  const lines = raw.split('\n');
  if (endsComplete) lines.pop();
  const partialTail = endsComplete ? null : lines.pop();

  const records: ChainedEvent[] = [];
  const future: number[] = [];
  const legacy: number[] = [];
  let malformedAt: number | null = null;

  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedAt = index;
      break;
    }
    if (!isReadableRecord(parsed)) {
      malformedAt = index;
      break;
    }

    const version = versionOf(parsed.schema);
    // Версию, которую мы не умеем разобрать как число, тоже считаем «новее меня»: понять её
    // мы не можем, а объявлять порчей нельзя — форма читается.
    if (version === null || version > KNOWN_VERSION) future.push(index);
    else if (version < KNOWN_VERSION) legacy.push(index);

    records.push(parsed);
  }

  return {
    records,
    // Пустой хвост после последнего `\n` оборванным не считается — это просто конец файла.
    trailingPartial: partialTail !== null && partialTail !== undefined && partialTail !== '',
    malformedAt,
    future,
    legacy,
  };
}

export type LogVerification =
  | { readonly ok: true; readonly count: number }
  | {
      readonly ok: false;
      readonly brokenAt: number;
      readonly count: number;
      /**
       * Порча файла или подделка цепочки. Оператору это разные события: `corrupt` — строка,
       * которую не разобрать (правка руками, обрезанный `write`, битый диск); `chain` —
       * запись разобралась, но дайджест или связь не сходятся. Одна вывеска на оба
       * предъявляла бы сбой носителя как взлом.
       */
      readonly kind: 'corrupt' | 'chain';
    };

/**
 * Вердикт по журналу — тот самый бейдж «цепочка верифицирована» из S9.
 *
 * Предикат не переписывается: он взят из `verifyChain` E0, где заморожены обе половины —
 * и совпадение дайджеста, и связь `prev` ↔ `self` предыдущей записи. Без второй половины
 * проверка «каждая запись самосогласована» даёт ноль доказательной силы: формула публична,
 * и атакующий, правящий запись, пересчитывает её `self` сам.
 *
 * Оборванный хвост вердикт **не** роняет: это падение демона, а не подделка. Функция никогда
 * не бросает — форма каждой записи проверена на границе чтения (`isReadableRecord`).
 */
export function verifyLog(log: ReadLogResult): LogVerification {
  if (log.malformedAt !== null) {
    return { ok: false, brokenAt: log.malformedAt, count: log.records.length, kind: 'corrupt' };
  }
  const verification = verifyChain(log.records);
  return verification.ok
    ? { ok: true, count: log.records.length }
    : { ok: false, brokenAt: verification.brokenAt, count: log.records.length, kind: 'chain' };
}

export interface OpenAuditLogOptions {
  readonly path?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Срезает недописанный хвост до конца последней ЦЕЛОЙ записи.
 *
 * Отсчёт в БАЙТАХ, а не в символах: `ftruncate` берёт смещение в байтах, а `argv` и `cwd`
 * в журнале бывают многобайтовыми, и `lastIndexOf` по строке дал бы смещение, режущее
 * запись посередине символа. `-1` (в файле нет ни одного `\n`) даёт `0` — файл из одного
 * огрызка обнуляется целиком, и это верно: записи в нём нет.
 */
function truncateTornTail(path: string): void {
  const buffer = readFileSync(path);
  const fd = openSync(path, 'r+');
  try {
    ftruncateSync(fd, buffer.lastIndexOf(0x0a) + 1);
  } finally {
    closeSync(fd);
  }
}

/**
 * Реестр открытых журналов по разрешённому пути.
 *
 * Два экземпляра на один файл держат каждый свой `previous` и, чередуя записи, ломают цепочку
 * необратимо и молча — бейдж потом показывает подделку на обычной ошибке интеграции. Функция
 * публична и имеет путь по умолчанию, так что «позвать дважды» — не экзотика.
 *
 * Реестр внутри процесса. Против ВТОРОГО ПРОЦЕССА он не помогает — для этого нужен lock-файл
 * (`openSync(..., 'wx')`), и его здесь нет: демон в текущем срезе один. Записано, а не выдано
 * за покрытое.
 */
const openLogs = new Map<string, AuditLog>();

/**
 * Открывает журнал на дозапись.
 *
 * **`prev` восстанавливается из файла, а не начинается заново.** Перезапуск демона не имеет
 * права выглядеть как генезис: иначе после каждого рестарта в логе лежит разрыв, неотличимый
 * от подделки, и бейдж S9 краснеет на штатной операции.
 *
 * **Оборванный хвост чинится, а не наследуется.** R17 сознательно отказывается от `fsync`,
 * то есть файл, оканчивающийся недописанной строкой, — спроектированный исход падения демона.
 * Дескриптор на `'a'` приклеил бы первую же новую запись к огрызку: событие потерялось бы
 * внутри порченой строки (а `07-contracts.md` называет отказ без записи в аудит багом), бейдж
 * показал бы разрыв на штатном падении, и каждое следующее открытие бросало бы «повреждён» —
 * журнал забетонирован навсегда. Срезаемые байты никогда не были записью и в цепочку не
 * входят, поэтому после среза цепочка ровно та же, что вернул `readLog`.
 *
 * Восстановление читает файл целиком — O(n) на старте. Для среза это дёшево (лог живёт одну
 * демонстрацию); на длинном логе сюда просится чтение с конца, и это записано как известная
 * цена, а не как сделанное.
 *
 * **Права.** Каталог создаётся `0700`, файл — `0600`. `mode` у `openSync` — это ПОТОЛОК:
 * umask может снять биты, но не добавить, поэтому файл никогда не окажется доступнее. Права
 * уже существующего файла не трогаются: это может быть осознанная настройка владельца.
 * А вот КАТАЛОГ проверяется: `mkdirSync` на существующем каталоге права не меняет, и каталог,
 * открытый на запись группе, позволяет соседу **переименовать** `audit.jsonl` и положить свой,
 * не имея прав на файл. Отказ, а не молчаливый `chmod` чужого каталога.
 */
export function openAuditLog(options: OpenAuditLogOptions = {}): AuditLog {
  const path = resolve(options.path ?? defaultAuditLogPath(options.env ?? process.env));

  if (openLogs.has(path)) {
    throw new AuditLogError(
      'already-open',
      path,
      `журнал ${path} уже открыт в этом процессе: два писателя ломают цепочку необратимо`,
    );
  }

  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryMode = statSync(directory).mode & 0o777;
  if ((directoryMode & 0o077) !== 0) {
    throw new AuditLogError(
      'insecure-directory',
      path,
      `каталог ${directory} имеет права ${directoryMode.toString(8)}: посторонний может подменить журнал целиком, `
        + `не имея прав на файл. Исправить: chmod 700 ${directory}`,
    );
  }

  const existing = readLog(path);
  if (existing.malformedAt !== null) {
    // Дописывать в порченый файл — значит подшить новые записи к цепочке, которая уже
    // разошлась, и получить лог, где верификация показывает разрыв в середине навсегда.
    throw new AuditLogError(
      'corrupt',
      path,
      `журнал ${path} повреждён на записи ${existing.malformedAt}: дозапись запрещена`,
    );
  }

  const repairedTornTail = existing.trailingPartial;
  if (repairedTornTail) truncateTornTail(path);

  const fd = openSync(path, 'a', 0o600);
  let previous = existing.records.at(-1)?.chain.self ?? null;
  let closed = false;

  const append = (event: AuditEvent & { chain?: never }): ChainedEvent => {
    if (closed) throw new AuditLogError('closed', path, `журнал ${path} закрыт`);

    const self = chainHash(event, previous);
    const chained: ChainedEvent = { ...event, chain: { prev: previous, self } };

    // ОДНА запись — один логический `write`, вместе с переводом строки: два вызова оставили
    // бы запись без `\n` в окне между ними, и читатель увидел бы её как оборванный хвост.
    //
    // Возврат `writeSync` ПРОВЕРЯЕТСЯ. Короткая запись (кончилось место, `EINTR`) молча
    // породила бы ровно тот оборванный хвост, вокруг которого построен R19, — но уже без
    // падения процесса, которое можно было бы заметить, и с `ChainedEvent`, возвращённым
    // вызывающему как подтверждение записи, которой нет.
    //
    // `fsync` НЕ вызывается. Он стоит 0.5–2 мс, а `09-metrics-and-eval.md` требует оверхед
    // ≤50 мс p95 при цели p50 9 мс. Цена: при потере ПИТАНИЯ последние записи, осевшие в
    // кэше ОС, пропадут. Это в честных границах; на защиту от ПРАВКИ лога это не влияет.
    const buffer = Buffer.from(`${JSON.stringify(chained)}\n`, 'utf8');
    let written = 0;
    while (written < buffer.length) {
      const n = writeSync(fd, buffer, written, buffer.length - written);
      if (n <= 0) {
        throw new AuditLogError(
          'short-write',
          path,
          `запись в ${path} остановилась на ${written} из ${buffer.length} байт: событие не легло в журнал`,
        );
      }
      written += n;
    }

    // Только после ПОЛНОЙ записи: иначе следующее событие сослалось бы на запись, которой в
    // файле нет целиком, и разрыв уехал бы на позицию дальше настоящей причины.
    previous = self;
    return chained;
  };

  const log: AuditLog = {
    path,
    repairedTornTail,
    append,
    head: () => previous,
    close: () => {
      if (closed) return;
      closed = true;
      openLogs.delete(path);
      closeSync(fd);
    },
  };

  openLogs.set(path, log);
  return log;
}
