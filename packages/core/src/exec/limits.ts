import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { ExecError } from './errors.js';
import type { StreamOutcome, Termination } from './sandbox.js';

/**
 * Запуск, таймаут по группе процессов и потолок вывода с hold-back окном.
 *
 * Единственный модуль E3, который порождает процессы. Всё, что здесь есть, есть потому,
 * что проба показала цену его отсутствия: без `detached: true` убийство по pid оставляет
 * трёх живых потомков (факт Ф5), а без hold-back окна секрет, легший ровно на границу
 * потолка, разрезается до того, как его увидит редактор E6.
 */

/**
 * Grace между SIGTERM и SIGKILL — **константа демона**, не поле манифеста (R17): в
 * замороженной схеме выразить её нечем, а придумывать ей место в `SandboxProfile` значило
 * бы двигать контракт ради настройки, которую никто не просил.
 */
export const DEFAULT_GRACE_MS = 2_000;

/**
 * Подтверждение пустоты группы (R52) — **ограниченный** опрос. Ни блокировка навсегда (она
 * вешает демон: семафор один на все последующие вызовы), ни тихий проход, возвращающий
 * исходный дефект — фоновый потомок остаётся привязан к порту прокси и попадает под
 * СЛЕДУЮЩУЮ политику, а в режиме `none` это `*`.
 */
export const GROUP_DRAIN_ATTEMPTS = 40;
export const GROUP_DRAIN_INTERVAL_MS = 25;

/** Сколько ждём закрытия потоков после выхода процесса, прежде чем отдать что есть. */
const STREAM_DRAIN_MS = 250;

export interface ProcessLimits {
  readonly timeoutMs: number;
  readonly graceMs: number;
  /** `null` — потолка нет (D8): тип `number | null` в `lock.ts:68` вынуждает ветку. */
  readonly maxBytes: number | null;
  /** Запас сверх потолка, чтобы E6 увидел секрет на границе целиком (D13, R19). */
  readonly holdBackBytes: number;
  /**
   * Шов с E6, объявленный **сейчас**, а не когда E6 напишут (R20). По умолчанию
   * тождественный. Без слота порядок «редакция раньше обрезки» остаётся фразой, которую
   * некому исполнить, а тест на hold-back зеленеет при `holdBackBytes: 0`.
   *
   * Параметр называется `window`, а не `chunk`, намеренно: «chunk» приглашает редактировать
   * по кусочкам, а это ровно тот баг, против которого hold-back и заведён.
   */
  readonly redact?: (window: Buffer) => Buffer;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  /**
   * Зовётся синхронно, как только `spawn()` вернул управление, — то есть когда ребёнок
   * действительно запущен, а не когда он уже умер.
   *
   * Слот есть потому, что событие стадии `spawn` обязано попасть в таймлайн ДО первого
   * нарушения: нарушения стримятся, пока процесс жив (R29), а `stageOrder` кладёт `spawn`
   * перед `violation` (`domain.ts:26-40`). Событие, отправленное после выхода процесса,
   * инвертировало бы замороженный порядок — S5 отрисовал бы нарушение процесса, о запуске
   * которого лог ещё не сказал.
   */
  readonly onSpawn?: (pid: number | undefined) => void;
}

export interface RawStream {
  /** Итог: после редакции E6 и после обрезки до `maxBytes`. */
  readonly buffer: Buffer;
  /** Сколько байт процесс **произвёл** — считается всё, даже то, что мы не храним. */
  readonly producedBytes: number;
  /** Сколько байт доехало до потребителя. Второе имя обязательно: числа разные (R20). */
  readonly bytes: number;
  /** Истинно тогда и только тогда, когда данные отброшены. */
  readonly truncated: boolean;
}

export interface RawRun {
  readonly termination: Termination;
  readonly exit: { readonly code: number | null; readonly signal: string | null };
  readonly stdout: RawStream;
  readonly stderr: RawStream;
  /**
   * Подтверждена ли пустота группы процессов (R52). `false` означает, что фоновый потомок
   * пережил вызов, — и вызывающий обязан отказаться освобождать семафор, а не пройти мимо.
   */
  readonly groupDrained: boolean;
}

/**
 * Обрезка по **байтам**, а не по единицам UTF-16 (R19). Обрезка на границе многобайтовой
 * последовательности даёт U+FFFD в последнем символе — признанное поведение, и его
 * закрепляет тест; считать `text.length` нельзя, потому что для не-ASCII вывода числа
 * разойдутся, а потолок заведён против A13, то есть против памяти.
 */
export function truncateToBytes(text: string | Buffer, maxBytes: number): Buffer {
  const buffer = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
  return buffer.byteLength <= maxBytes ? buffer : buffer.subarray(0, maxBytes);
}

/** Декодирование — **после** редакции и обрезки (R20). */
export function toStreamOutcome(stream: RawStream): StreamOutcome {
  return { text: stream.buffer.toString('utf8'), bytes: stream.bytes, truncated: stream.truncated };
}

/**
 * Накопитель одного потока: считает всё, хранит не больше окна.
 *
 * Чтение **не прекращается** на потолке и процесс **не убивается** (R49). Останов чтения
 * при живом процессе заполнил бы pipe-буфер и заблокировал ребёнка до таймаута — то есть
 * ветка «превысил вывод» тихо превратилась бы в ветку «таймаут», а таблица упорядоченности
 * плана обещает монотонность. Убийство же превратило бы многословную, но безобидную команду
 * в отказ и сдвинуло бы метрику Utility under Attack.
 */
class StreamCollector {
  private readonly chunks: Buffer[] = [];
  private held = 0;
  private errored = false;
  produced = 0;

  /**
   * Ошибка канала — это потеря байт, а не только повод не падать. Без этого флага после
   * `EIO` коллектор просто перестаёт получать данные, `produced === held`, и `finish()`
   * отдаёт `truncated: false` — то есть потребителю сообщают, что вывод полон, когда часть
   * его пропала. А `truncated` — ровно то поле, на котором висят R19 и R20.
   */
  markErrored(): void {
    this.errored = true;
  }

  constructor(private readonly windowBytes: number) {}

  push(chunk: Buffer): void {
    this.produced += chunk.byteLength;
    const room = this.windowBytes - this.held;
    if (room <= 0) return;
    const kept = chunk.byteLength <= room ? chunk : chunk.subarray(0, room);
    this.chunks.push(kept);
    this.held += kept.byteLength;
  }

  finish(limits: ProcessLimits): RawStream {
    const window = Buffer.concat(this.chunks, this.held);
    const redacted = limits.redact === undefined ? window : limits.redact(window);
    const buffer = limits.maxBytes === null ? redacted : truncateToBytes(redacted, limits.maxBytes);

    // «Данные отброшены» — две независимые причины: не поместились в окно чтения и не
    // поместились в потолок после редакции. Дизъюнкция, а не одна из них.
    const droppedAtRead = this.produced > this.held;
    const droppedAtCap = buffer.byteLength < redacted.byteLength;

    return {
      buffer,
      producedBytes: this.produced,
      bytes: buffer.byteLength,
      truncated: droppedAtRead || droppedAtCap || this.errored,
    };
  }
}

const windowFor = (limits: ProcessLimits): number =>
  limits.maxBytes === null ? Number.POSITIVE_INFINITY : limits.maxBytes + limits.holdBackBytes;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Убийство **группы**, а не процесса (R16, факт Ф5): `process.kill(-pid)` вместо
 * `process.kill(pid)`. Убийство одного `exec[0]` оставляет живым дерево, которое он успел
 * породить, а гарантия `10-honest-limitations.md:14` сформулирована для всего дерева.
 *
 * ESRCH — не ошибка, а ответ «группы уже нет»; она возникает на каждом штатном выходе.
 */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Группы нет — цель достигнута.
  }
}

/**
 * Есть ли ещё кто-нибудь в группе. Сигнал `0` ничего не шлёт, только проверяет.
 *
 * Разбор errno **обязателен**, а не аккуратен: `ESRCH` означает «группы нет», но `EPERM`
 * означает «группа есть, а сигналить ей нам не разрешено», и `EINVAL` — «вопрос задан
 * неверно». Схлопнув всё в `false`, единственная проба, решающая судьбу R52, читала бы
 * «мне не дали спросить» как «спрашивать не о ком»: `groupDrained` приехал бы `true`,
 * отравление не сработало бы, а выживший потомок ушёл бы под политику следующего вызова —
 * и в записи не осталось бы ничего, что отличает это от чистого выхода.
 *
 * Неизвестный код — «жива»: подтвердить пустоту не удалось, а R52 требует в этом случае
 * громкого отказа, а не тихого прохода.
 */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !isGroupGone(error);
  }
}

/**
 * Решение по errno — отдельной чистой функцией, потому что иначе оно не проверяемо: чтобы
 * получить `EPERM` от `kill(0)`, нужна чужая группа процессов, а тест, который её заводит,
 * зависит от прав машины больше, чем от нашего кода. Здесь же оба кода подаются литералом.
 */
export function isGroupGone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ESRCH';
}

async function confirmGroupEmpty(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < GROUP_DRAIN_ATTEMPTS; attempt += 1) {
    if (!groupAlive(pid)) return true;
    killGroup(pid, 'SIGKILL');
    await delay(GROUP_DRAIN_INTERVAL_MS);
  }
  return !groupAlive(pid);
}

const collectInto = (stream: Readable, collector: StreamCollector): void => {
  stream.on('data', (chunk: Buffer) => {
    collector.push(chunk);
  });
  // Слушатель `error` обязателен, а не гигиеничен: `EIO`/`EPIPE` на pipe — штатное явление,
  // когда группу убивают SIGKILL посреди записи (то есть на КАЖДОМ таймауте). Поток без
  // слушателя `error` заставляет Node перебросить ошибку как необработанное исключение, и
  // демон падает ровно на том пути, ради которого таймаут и заведён.
  stream.on('error', () => {
    // Обрыв канала помечает поток потерявшим: слушатель обязателен, чтобы Node не перебросил
    // ошибку необработанным исключением, а флаг обязателен, чтобы «полный вывод» не был
    // объявлен там, где часть байт пропала.
    collector.markErrored();
  });
};

/** `stdio: ['ignore', 'pipe', 'pipe']` — `stdin` у ребёнка нет, и тип обязан это отражать. */
type SpawnedChild = ChildProcessByStdio<null, Readable, Readable>;

interface ExitRecord {
  readonly code: number | null;
  readonly signal: string | null;
}

const waitForExit = (child: SpawnedChild): Promise<ExitRecord> =>
  new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });

export async function runProcess(
  command: readonly [string, ...string[]],
  limits: ProcessLimits,
): Promise<RawRun> {
  const child = spawn(command[0], command.slice(1), {
    // `shell: false` — argv собран E2 и в оболочку не отдаётся ни при каких условиях.
    // `detached: true` — ребёнок становится лидером своей группы, и только тогда SIGKILL
    // по `-pid` достаёт всё дерево (факт Ф5).
    shell: false,
    detached: true,
    cwd: limits.cwd,
    env: limits.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const pid = child.pid;
  const windowBytes = windowFor(limits);
  const stdout = new StreamCollector(windowBytes);
  const stderr = new StreamCollector(windowBytes);
  collectInto(child.stdout, stdout);
  collectInto(child.stderr, stderr);

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  let exit: ExitRecord | undefined;
  let failure: unknown;

  try {
    // Всё, что ниже, живёт под `finally`, и это не гигиена, а R52. С момента, когда `spawn`
    // вернул управление, существует ОТДЕЛЬНАЯ группа процессов, и убить её обязаны мы — на
    // любом пути. Бросок отсюда (аудит-сток потребителя на стадии `spawn`, позднее событие
    // `error` у ребёнка) без `finally` пропускал бы и убийство, и подтверждение пустоты:
    // живая detached-группа уходила бы под политику следующего вызова, а `ExecOutcome` не
    // порождался бы вовсе — то есть не осталось бы даже записи о том, что подтверждать
    // было нечего.
    limits.onSpawn?.(pid);

    timer = setTimeout(() => {
      timedOut = true;
      if (pid === undefined) return;
      killGroup(pid, 'SIGTERM');
      graceTimer = setTimeout(() => {
        killGroup(pid, 'SIGKILL');
      }, limits.graceMs);
    }, limits.timeoutMs);

    exit = await waitForExit(child);
  } catch (error) {
    failure = error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
  }

  // Группа убивается и подтверждается на **каждом** пути выхода (R52), включая аварийный, —
  // поэтому вне `try`, а не внутри его удачной ветки.
  const groupDrained = pid === undefined ? true : await confirmGroupEmpty(pid);
  await drainStreams(child);

  if (failure !== undefined || exit === undefined) {
    // Результат отказа несёт `groupDrained`: без него вызывающий не смог бы отравить демон
    // на аварийном пути и живой потомок ушёл бы под следующую политику молча.
    throw new ExecError('spawn-failed', `не удалось выполнить ${command[0]}: ${String(failure)}`, {
      groupDrained,
      ...(pid === undefined ? {} : { pid }),
    });
  }

  const outStream = stdout.finish(limits);
  const errStream = stderr.finish(limits);
  return {
    // Приоритет задан, а не выведен из порядка проверок (R49): сработали и потолок, и
    // таймаут — побеждает таймаут, он же определяет вердикт. Без правила поле одно, а
    // исходов два.
    termination: terminationOf(timedOut, outStream, errStream),
    exit,
    stdout: outStream,
    stderr: errStream,
    groupDrained,
  };
}

function terminationOf(timedOut: boolean, stdout: RawStream, stderr: RawStream): Termination {
  if (timedOut) return 'timeout';
  return stdout.truncated || stderr.truncated ? 'output-cap' : 'exited';
}

/**
 * Даём потокам договорить после выхода процесса — но не бесконечно. Ждать `close` вечно
 * нельзя: потомок, унаследовавший pipe, держал бы его открытым, и вызов висел бы после
 * смерти собственного процесса. Группа к этому моменту уже убита, так что ожидание короткое.
 */
async function drainStreams(child: SpawnedChild): Promise<void> {
  const ended = (stream: Readable): Promise<void> =>
    stream.readableEnded ? Promise.resolve() : new Promise((resolve) => stream.once('end', resolve));

  await Promise.race([Promise.all([ended(child.stdout), ended(child.stderr)]), delay(STREAM_DRAIN_MS)]);
}
