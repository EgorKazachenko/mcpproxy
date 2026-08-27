import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
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
  produced = 0;

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
      truncated: droppedAtRead || droppedAtCap,
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

/** Есть ли ещё кто-нибудь в группе. Сигнал `0` ничего не шлёт, только проверяет. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
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

  const windowBytes = windowFor(limits);
  const stdout = new StreamCollector(windowBytes);
  const stderr = new StreamCollector(windowBytes);
  collectInto(child.stdout, stdout);
  collectInto(child.stderr, stderr);

  const pid = child.pid;
  let timedOut = false;
  let graceTimer: NodeJS.Timeout | undefined;

  const timer = setTimeout(() => {
    timedOut = true;
    if (pid === undefined) return;
    killGroup(pid, 'SIGTERM');
    graceTimer = setTimeout(() => {
      killGroup(pid, 'SIGKILL');
    }, limits.graceMs);
  }, limits.timeoutMs);

  let exit: ExitRecord;
  try {
    exit = await waitForExit(child);
  } finally {
    clearTimeout(timer);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
  }

  // Группа убивается на **каждом** пути выхода (R52), а не только по таймауту: фоновый
  // потомок иначе переживает вызов, остаётся привязан к порту прокси и попадает под
  // политику следующего вызова.
  const groupDrained = pid === undefined ? true : await confirmGroupEmpty(pid);
  await drainStreams(child);

  return {
    // Приоритет задан, а не выведен из порядка проверок (R49): сработали и потолок, и
    // таймаут — побеждает таймаут, он же определяет вердикт. Без правила поле одно, а
    // исходов два.
    termination: terminationOf(timedOut, stdout, stderr, limits),
    exit,
    stdout: stdout.finish(limits),
    stderr: stderr.finish(limits),
    groupDrained,
  };
}

function terminationOf(
  timedOut: boolean,
  stdout: StreamCollector,
  stderr: StreamCollector,
  limits: ProcessLimits,
): Termination {
  if (timedOut) return 'timeout';
  if (limits.maxBytes === null) return 'exited';
  // Граница включительна намеренно: `maxBytes` — «потолок», а не «строго меньше».
  const over = stdout.produced > limits.maxBytes || stderr.produced > limits.maxBytes;
  return over ? 'output-cap' : 'exited';
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
