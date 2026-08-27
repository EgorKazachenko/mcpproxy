import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AuditEvent, ChainedEvent } from '@mcpproxy/contracts';
import { chainHash, unchain, verifyChain } from '@mcpproxy/contracts/audit';

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

/** Один `write` на запись; `fsync` не делается — см. `appendEvent`. */
export interface AuditLog {
  readonly path: string;
  /** Дописывает событие, возвращая то, что реально легло в файл. */
  readonly append: (event: AuditEvent & { chain?: never }) => ChainedEvent;
  /** Хэш последней записи — он же `prev` следующей. `null` до первой записи. */
  readonly head: () => string | null;
  readonly close: () => void;
}

/**
 * Путь по умолчанию. `MCPPROXY_HOME` перекрывает домашний каталог — им пользуются тесты и
 * им же пользуется тот, у кого `$HOME` на сетевом диске.
 */
export function defaultAuditLogPath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return join(env.MCPPROXY_HOME ?? join(homedir(), '.mcpproxy'), 'audit.jsonl');
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
   * Индексы записей, чей `schema` нам неизвестен: читаются, помечаются «форма новее меня».
   * Требование `07-contracts.md`: одна запись из будущего не имеет права сделать нечитаемым
   * весь предшествующий лог, перегенерировать который нельзя.
   */
  readonly future: readonly number[];
}

const KNOWN_SCHEMA = 'mcpproxy.audit/1';

/** Минимальная форма, без которой запись не участвует в цепочке. Версию формы НЕ проверяет. */
function hasChainShape(value: unknown): value is ChainedEvent {
  if (typeof value !== 'object' || value === null) return false;
  const chain = (value as { chain?: unknown }).chain;
  if (typeof chain !== 'object' || chain === null) return false;
  const { prev, self } = chain as { prev?: unknown; self?: unknown };
  return (prev === null || typeof prev === 'string') && typeof self === 'string';
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
  if (!existsSync(path)) return { records: [], trailingPartial: false, malformedAt: null, future: [] };

  const raw = readFileSync(path, 'utf8');
  if (raw === '') return { records: [], trailingPartial: false, malformedAt: null, future: [] };

  // Хвост без `\n` — это недописанная строка. Полностью записанная всегда оканчивается им,
  // потому что перевод строки уезжает тем же единственным `write`, что и сама запись.
  const endsComplete = raw.endsWith('\n');
  const lines = raw.split('\n');
  if (endsComplete) lines.pop();
  const partialTail = endsComplete ? null : lines.pop();

  const records: ChainedEvent[] = [];
  const future: number[] = [];
  let malformedAt: number | null = null;

  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedAt = index;
      break;
    }
    if (!hasChainShape(parsed)) {
      malformedAt = index;
      break;
    }
    if ((parsed as { schema?: unknown }).schema !== KNOWN_SCHEMA) future.push(index);
    records.push(parsed);
  }

  return {
    records,
    // Пустой хвост после последнего `\n` оборванным не считается — это просто конец файла.
    trailingPartial: partialTail !== null && partialTail !== undefined && partialTail !== '',
    malformedAt,
    future,
  };
}

export type LogVerification = { readonly ok: true; readonly count: number } | {
  readonly ok: false;
  readonly brokenAt: number;
  readonly count: number;
};

/**
 * Вердикт по журналу — тот самый бейдж «цепочка верифицирована» из S9.
 *
 * Предикат не переписывается: он взят из `verifyChain` E0, где заморожены обе половины —
 * и совпадение дайджеста, и связь `prev` ↔ `self` предыдущей записи. Без второй половины
 * проверка «каждая запись самосогласована» даёт ноль доказательной силы: формула публична,
 * и атакующий, правящий запись, пересчитывает её `self` сам.
 *
 * Оборванный хвост вердикт **не** роняет: это падение демона, а не подделка.
 */
export function verifyLog(log: ReadLogResult): LogVerification {
  if (log.malformedAt !== null) return { ok: false, brokenAt: log.malformedAt, count: log.records.length };
  const verification = verifyChain(log.records);
  return verification.ok
    ? { ok: true, count: log.records.length }
    : { ok: false, brokenAt: verification.brokenAt, count: log.records.length };
}

export interface OpenAuditLogOptions {
  readonly path?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Открывает журнал на дозапись.
 *
 * **`prev` восстанавливается из файла, а не начинается заново.** Перезапуск демона не имеет
 * права выглядеть как генезис: иначе после каждого рестарта в логе лежит разрыв, неотличимый
 * от подделки, и бейдж S9 краснеет на штатной операции.
 *
 * Восстановление читает файл целиком — O(n) на старте. Для среза это дёшево (лог живёт одну
 * демонстрацию); на длинном логе сюда просится чтение с конца, и это записано как известная
 * цена, а не как сделанное.
 *
 * **Права.** Каталог создаётся `0700`, файл — `0600`. Лог несёт `argv`, `cwd` и имена
 * переменных окружения; читаемый всем файл — тот же A12 через другую дверь. `mode` у
 * `openSync` — это ПОТОЛОК: umask может снять биты, но не добавить, поэтому файл никогда не
 * окажется доступнее. Права уже существующего файла не трогаются: это может быть осознанная
 * настройка владельца, а молча менять чужие права — не наше дело.
 */
export function openAuditLog(options: OpenAuditLogOptions = {}): AuditLog {
  const path = options.path ?? defaultAuditLogPath(options.env ?? process.env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const existing = readLog(path);
  if (existing.malformedAt !== null) {
    // Дописывать в порченый файл — значит подшить новые записи к цепочке, которая уже
    // разошлась, и получить лог, где верификация показывает разрыв в середине навсегда.
    throw new Error(`журнал ${path} повреждён на записи ${existing.malformedAt}: дозапись запрещена`);
  }

  const fd = openSync(path, 'a', 0o600);
  let previous = existing.records.at(-1)?.chain.self ?? null;
  let closed = false;

  const append = (event: AuditEvent & { chain?: never }): ChainedEvent => {
    if (closed) throw new Error(`журнал ${path} закрыт`);

    const self = chainHash(event, previous);
    const chained: ChainedEvent = { ...event, chain: { prev: previous, self } };

    // ОДИН `write` на запись, вместе с переводом строки: два вызова оставили бы запись без
    // `\n` в окне между ними, и читатель увидел бы её как оборванный хвост.
    //
    // `fsync` НЕ вызывается. Он стоит 0.5–2 мс, а `09-metrics-and-eval.md` требует оверхед
    // ≤50 мс p95 при цели p50 9 мс — то есть пятая часть бюджета ушла бы на журнал. Цена
    // решения: при потере питания последние записи, осевшие в кэше ОС, пропадут. Это
    // записано в честные границы; на защиту от ПРАВКИ лога это не влияет никак.
    writeSync(fd, `${JSON.stringify(chained)}\n`);
    previous = self;
    return chained;
  };

  return {
    path,
    append,
    head: () => previous,
    close: () => {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  };
}
