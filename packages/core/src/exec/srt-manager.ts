import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { encodeSandboxedCommand } from '@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js';
import type { SandboxViolationEvent } from '@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js';
import type { SandboxViolation } from '@mcpproxy/contracts';
import { parseAndClassify } from './violation.js';
import type { ClassifyPolicy } from './violation.js';
import type { CommandId } from './sandbox.js';

/**
 * Синглтон srt: единственное место, где живёт всё глобальное — прокси, стор нарушений,
 * подписка и семафор.
 *
 * Отдельно от `modes/` потому, что синглтон **общий для обоих режимов**: по D2 режим `none`
 * тоже поднимает прокси, значит делит стор и семафор с `seatbelt`. Положив жизненный цикл в
 * `modes/seatbelt.ts`, мы оставили бы `none` ровно с той ошибкой атрибуции, ради которой
 * семафор и существует.
 */

/**
 * Кольцо стора у srt — сто записей (`sandbox-violation-store.js`, `maxSize = 100`), и
 * `reset()` его не чистит. Значит копим нарушения своего вызова сами и на стор как на
 * хранилище не полагаемся (R44).
 */
export const STORE_RING_SIZE = 100;

/**
 * Drain-окно после выхода процесса, прежде чем снять политику (R46). Путь через unified log
 * асинхронен по природе: проба П6a показала нулевой лаг на ненагруженной машине, но
 * «ноль на одной машине» — не «ноль всегда», и окно здесь страховка, а не признание
 * задержки.
 */
export const DRAIN_WINDOW_MS = 150;

/** Сколько байт тела запроса читаем в телеметрии, прежде чем отменить читателя (R26). */
export const BODY_SAMPLE_BYTES = 1_048_576;

/**
 * Идловое состояние allowlist — **пустой список** (R52). Фоновый потомок, переживший вызов,
 * не должен попасть под чужую политику, а в режиме `none` чужая политика — это `*`.
 */
const IDLE_NETWORK = { allowedDomains: [] as string[], deniedDomains: [] as string[] };

export interface NetworkPolicy {
  readonly allowedDomains: readonly string[];
  readonly deniedDomains: readonly string[];
}

export interface CursorInput {
  readonly totalCount: number;
  readonly lastSeen: number;
  /** Сколько записей стор реально держит — насыщается на `STORE_RING_SIZE`. */
  readonly available: number;
}

export interface CursorStep {
  /** Сколько записей вытеснило кольцо и мы их не увидим никогда. */
  readonly lost: number;
  /** Сколько последних записей отданного массива — новые. */
  readonly take: number;
  readonly lastSeen: number;
}

/**
 * Курсор ведётся по `getTotalCount()`, который монотонен и не сбрасывается, **а не по
 * индексу в отданном массиве** (R44): массив насыщается на сотне и перестаёт расти, поэтому
 * индексный курсор молча остановился бы — и счётчик S5 замер бы на ста при работающей
 * защите.
 *
 * Функция чистая ради ветки потери: воспроизводить гонку бессмысленно, `notifyListeners`
 * синхронен внутри `addViolation`, и в продакшене ветка почти недостижима — именно поэтому
 * её легко написать неправильно и не узнать (R45).
 */
export function advanceCursor(input: CursorInput): CursorStep {
  const delta = input.totalCount - input.lastSeen;
  if (delta <= 0) return { lost: 0, take: 0, lastSeen: input.totalCount };
  const take = Math.min(delta, input.available);
  return { lost: delta - take, take, lastSeen: input.totalCount };
}

export interface TelemetryRequest {
  readonly url: string;
  readonly method: string;
  readonly bodyBytes: number;
}

export interface InvocationResult<T> {
  readonly value: T;
  readonly violations: readonly SandboxViolation[];
  readonly violationsLost: number;
  /**
   * Сколько нарушений приехало с чужим или отсутствующим `encodedCommand`. Докладывается
   * громко, но нарушение **не отбрасывает** (R45).
   */
  readonly attributionMismatches: number;
}

export interface InvocationContext {
  /** `{argv, env}` от srt — обёртка уже применена под уже выставленной политикой. */
  readonly commandId: CommandId;
}

export interface WithPolicyOptions<T> {
  readonly commandId: CommandId;
  readonly policy: NetworkPolicy;
  readonly classify: ClassifyPolicy;
  readonly onViolation: (violation: SandboxViolation) => void;
  readonly body: (context: InvocationContext) => Promise<{ value: T; groupDrained: boolean }>;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Семафор с потолком **1**. Это не нагрузочное ограничение, а несущее (R21):
 * `updateConfig` подменяет **глобальный** конфиг, и второй вызов в полёте получил бы чужой
 * allowlist.
 *
 * Побочное следствие — под семафором `filterRequest` видит запросы ровно одного вызова, и
 * атрибуция байт становится бесплатной. Это и закрывает невозможность прочитать `commandId`
 * на HTTPS (проба П8).
 */
class Semaphore {
  private tail: Promise<void> = Promise.resolve();

  acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wait = this.tail.then(() => release);
    this.tail = this.tail.then(() => next);
    return wait;
  }
}

export class SrtManagerError extends Error {}

/**
 * Текст один на все точки отказа: после `dispose()` вызов идёт со старым конфигом и
 * `getProxyPort() === undefined`, то есть прокси-переменные не эмитятся вовсе — сеть
 * оказывается тихо **открыта** в `none` и тихо **мертва** в `seatbelt` (R50).
 */
const DISPOSED_MESSAGE =
  'песочница уже освобождена: любой run() после dispose() запрещён, потому что reset() у srt ' +
  'чистит initializationPromise, но не config, и повторный initialize — тихий no-op (R50)';

class SrtSingleton {
  private initPromise: Promise<void> | undefined;
  private baseConfig: SandboxRuntimeConfig | undefined;
  private unsubscribe: (() => void) | undefined;
  private refs = 0;
  private disposed = false;
  /**
   * Поднятый флаг означает, что группа процессов прошлого вызова не подтвердила пустоту
   * (R52). Семафор после этого не освобождается — но и висеть на нём вечно нельзя: демон
   * один на все последующие вызовы, поэтому каждый следующий `run()` отказывает СРАЗУ и
   * громко, вместо того чтобы молча не возвращаться.
   */
  private poisoned: string | undefined;

  private readonly semaphore = new Semaphore();
  private lastSeen = 0;

  /** Активный сборщик нарушений. Не `undefined` ровно тогда, когда семафор занят. */
  private active:
    | {
        readonly commandId: CommandId;
        readonly encoded: string;
        readonly classify: ClassifyPolicy;
        readonly onViolation: (violation: SandboxViolation) => void;
        readonly collected: SandboxViolation[];
        lost: number;
        mismatches: number;
      }
    | undefined;

  /** Телеметрия из `filterRequest`: запросы, которые прокси пропустил (R26). */
  private readonly telemetry: TelemetryRequest[] = [];

  /**
   * Ссылка берётся при создании песочницы, а не при вызове.
   *
   * Считать вызовы было бы дефектом, а не стилем: `run()` зовёт `ensureInitialized`, поэтому
   * счётчик рос бы на каждом прогоне, `dispose()` уменьшал бы его на единицу и до нуля не
   * доходил бы никогда — флаг R50 не выставлялся бы, а `SandboxManager.reset()` не звался бы
   * вовсе. Тесты при этом остались бы зелёными: они просто не увидели бы отказа.
   */
  retain(): void {
    if (this.disposed) throw new SrtManagerError(DISPOSED_MESSAGE);
    this.refs += 1;
  }

  async ensureInitialized(baseConfig: SandboxRuntimeConfig): Promise<void> {
    if (this.disposed) throw new SrtManagerError(DISPOSED_MESSAGE);
    if (this.initPromise !== undefined) return this.initPromise;

    this.baseConfig = baseConfig;
    this.initPromise = this.doInitialize(baseConfig);
    return this.initPromise;
  }

  private async doInitialize(baseConfig: SandboxRuntimeConfig): Promise<void> {
    // Третий аргумент обязателен и обязан быть `true` (R37, факт Ф10): по умолчанию он
    // `false`, и тогда песочница работает, а в сторе ноль нарушений — граница цела,
    // наблюдаемость мертва.
    //
    // `sandboxAskCallback` (второй аргумент) НЕ регистрируем: это решение E5, и вместе со
    // `strictAllowlist: true` оно определяет, спрашивает ли демон про неизвестный хост или
    // отказывает (R43).
    await SandboxManager.initialize(baseConfig, undefined, true);

    const store = SandboxManager.getSandboxViolationStore();
    // Стор при `initialize` чистым не считается — `reset()` его не очищает, — поэтому
    // курсор ставится на текущий тотал, а не на ноль.
    this.lastSeen = store.getTotalCount();
    this.unsubscribe = store.subscribe((all) => {
      this.onStoreNotify(all);
    });
  }

  private onStoreNotify(all: readonly SandboxViolationEvent[]): void {
    const store = SandboxManager.getSandboxViolationStore();
    const step = advanceCursor({ totalCount: store.getTotalCount(), lastSeen: this.lastSeen, available: all.length });
    this.lastSeen = step.lastSeen;
    if (step.take === 0 && step.lost === 0) return;

    const active = this.active;
    if (active === undefined) return;
    active.lost += step.lost;

    for (const event of all.slice(all.length - step.take)) {
      // Атрибуция — **окно семафора**, а не `encodedCommand` (R45): всё, что стор набрал
      // между захватом и освобождением, принадлежит текущему вызову. Ключ ненадёжен с обеих
      // сторон — имя пользователя прокси вшито в env ребёнка, то есть им управляет ребёнок,
      // а со стороны ядра ключ отсутствует, когда строка `CMD64_` не попала в тот же чанк
      // вывода `log stream`, что и строка отказа.
      if (event.encodedCommand !== undefined && event.encodedCommand !== active.encoded) {
        active.mismatches += 1;
      }
      const parsed = parseAndClassify(event.line, active.classify);
      if (parsed.kind !== 'violation') continue;
      active.collected.push(parsed.violation);
      // Стримим по мере возникновения (R29): красная строка S5 появляется, пока процесс
      // ещё жив, а не пакетом после выхода.
      active.onViolation(parsed.violation);
    }
  }

  /**
   * Колбэк телеметрии. Регистрируется **только в `initialize`** (R26): прокси захватывает
   * его по значению при создании, и установка позже через `updateConfig` не действует,
   * причём тихо — байты станут нулём, а S5 покажет «0 KB» при зелёных тестах.
   */
  buildFilterRequest(): (request: Request) => Promise<{ action: 'allow' }> {
    return async (request: Request): Promise<{ action: 'allow' }> => {
      try {
        const bodyBytes = await countBody(request);
        this.telemetry.push({ url: request.url, method: request.method, bodyBytes });
        const active = this.active;
        if (active !== undefined) {
          const violation: SandboxViolation = {
            type: 'network',
            target: request.url,
            action: 'allowed',
            bytes: bodyBytes,
          };
          active.collected.push(violation);
          active.onViolation(violation);
        }
      } catch {
        // Тело в try/catch, и ошибка даёт `allow`, а не `deny` (R26): политика уже
        // применена `updateConfig`, и бросок здесь резал бы разрешённый трафик — то есть
        // дефект телеметрии превращался бы в отказ границы.
      }
      return { action: 'allow' };
    };
  }

  telemetrySnapshot(): readonly TelemetryRequest[] {
    return [...this.telemetry];
  }

  /**
   * Снятие вызова целиком (R46): **занять семафор → `updateConfig` политикой вызова →
   * обернуть → запустить → дождаться → убить группу и подтвердить её пустоту → drain-окно →
   * `updateConfig` пустым списком → освободить семафор.**
   *
   * Освобождение **после** drain, а не до: иначе утверждение «под семафором всё, что видит
   * колбэк, принадлежит текущему вызову» ложно ровно в том окне, ради которого drain и
   * заведён.
   */
  async withNetworkPolicy<T>(options: WithPolicyOptions<T>): Promise<InvocationResult<T>> {
    if (this.disposed) throw new SrtManagerError(DISPOSED_MESSAGE);
    if (this.poisoned !== undefined) throw new SrtManagerError(this.poisoned);

    const base = this.baseConfig;
    if (base === undefined) throw new SrtManagerError('srt не инициализирован');

    const release = await this.semaphore.acquire();
    let releaseCalled = false;
    try {
      this.active = {
        commandId: options.commandId,
        encoded: encodeSandboxedCommand(options.commandId),
        classify: options.classify,
        onViolation: options.onViolation,
        collected: [],
        lost: 0,
        mismatches: 0,
      };

      applyNetwork(base, options.policy);
      const outcome = await options.body({ commandId: options.commandId });

      await delay(DRAIN_WINDOW_MS);
      applyNetwork(base, IDLE_NETWORK);

      const active = this.active;
      const result: InvocationResult<T> = {
        value: outcome.value,
        violations: active === undefined ? [] : [...active.collected],
        violationsLost: active?.lost ?? 0,
        attributionMismatches: active?.mismatches ?? 0,
      };

      if (!outcome.groupDrained) {
        // Тихий проход здесь возвращает исходный дефект: фоновый потомок остаётся привязан
        // к порту прокси и попадает под СЛЕДУЮЩУЮ политику (R52).
        this.poisoned =
          'группа процессов не подтвердила пустоту: фоновый потомок пережил вызов и попал бы ' +
          'под политику следующего. Демон не выдаёт новых вызовов до вмешательства (R52)';
        throw new SrtManagerError(this.poisoned);
      }

      this.active = undefined;
      releaseCalled = true;
      release();
      return result;
    } finally {
      if (!releaseCalled) {
        this.active = undefined;
        // Семафор освобождается на аварийном пути тоже — но только если он не отравлен:
        // отравленный означает живого потомка, и следующий вызов обязан не начаться.
        if (this.poisoned === undefined) release();
      }
    }
  }

  wrap(
    command: string,
    customConfig: Partial<SandboxRuntimeConfig>,
    commandId: CommandId,
    cwd: string,
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> {
    // `commandId` — идентификатор вызова, а не текст команды (R30): srt сравнивает ключи по
    // первым 100 символам, поэтому две длинные команды с общим префиксом атрибутировались бы
    // друг другу, а повтор той же команды унаследовал бы нарушения прошлого прогона.
    return SandboxManager.wrapWithSandboxArgv(command, undefined, customConfig, undefined, cwd, { commandId });
  }

  proxyPort(): number | undefined {
    return SandboxManager.getProxyPort();
  }

  socksPort(): number | undefined {
    return SandboxManager.getSocksProxyPort();
  }

  proxyToken(): string | undefined {
    return SandboxManager.getProxyAuthToken();
  }

  caTrustBundlePath(): string | undefined {
    return SandboxManager.getMitmCA()?.trustBundlePath;
  }

  /**
   * Счёт ссылок и флаг, после которого любой `run()` бросает (R50).
   *
   * `reset()` у srt глобален, чистит `initializationPromise`, но **не** `config`, а
   * `initialize` возвращается сразу, если промис уже стоит. Значит повторный `initialize` —
   * тихий no-op, а вызов после `reset()` идёт со старым конфигом и
   * `getProxyPort() === undefined`: прокси-переменные не эмитятся вовсе, и сеть оказывается
   * тихо **открыта** в `none` и тихо **мертва** в `seatbelt`.
   */
  async dispose(): Promise<void> {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs > 0) return;
    if (this.disposed) return;

    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.initPromise = undefined;
    this.baseConfig = undefined;
    this.telemetry.length = 0;
    await SandboxManager.reset();
  }

  /** Только для тестов: снимает флаг освобождения, чтобы следующий набор поднял всё заново. */
  resetForTests(): void {
    this.disposed = false;
    this.poisoned = undefined;
    this.refs = 0;
    this.initPromise = undefined;
    this.baseConfig = undefined;
    this.active = undefined;
    this.telemetry.length = 0;
  }

  isPoisoned(): boolean {
    return this.poisoned !== undefined;
  }
}

/**
 * `updateConfig` заменяет конфиг **целиком** (`structuredClone` без слияния), поэтому
 * пер-вызовный конфиг — это сохранённая база с заменой ровно **двух** доменных списков
 * (R56).
 *
 * Литерал из двух полей проходит проверку типов и при этом молча роняет `strictAllowlist`
 * (R43), `tlsTerminate` (D12) и `credentials`: телеметрия обнуляется, S5 показывает «0 KB»,
 * тесты зелёные.
 */
function applyNetwork(base: SandboxRuntimeConfig, policy: NetworkPolicy): void {
  SandboxManager.updateConfig({
    ...base,
    network: {
      ...base.network,
      allowedDomains: [...policy.allowedDomains],
      deniedDomains: [...policy.deniedDomains],
    },
  });
  assertWildcardSurvived(policy);
}

/**
 * Громкая проверка (R54). `allowedDomains: ['*']` схема вендора объявляет **недопустимым** и
 * сегодня пропускает лишь потому, что `updateConfig` — голый `structuredClone` без валидации.
 *
 * Без проверки обновление вендора превратит `none` из «наблюдаем всё» в «блокируем всё», а
 * заблокированный HTTP возвращает `exit=0` с телом `Connection blocked by network allowlist`
 * (факт Ф6) — то есть демо показало бы нулевую эксфильтрацию и осталось бы зелёным.
 *
 * Проверка стоит здесь, а не на старте демона, потому что `'*'` появляется только в
 * пер-вызовном конфиге режима `none`: базовый конфиг всегда уезжает с пустыми списками (R52).
 */
function assertWildcardSurvived(policy: NetworkPolicy): void {
  if (!policy.allowedDomains.includes('*')) return;
  const applied = SandboxManager.getConfig();
  if (applied === undefined || !applied.network.allowedDomains.includes('*')) {
    throw new SrtManagerError(
      'политика с allowedDomains: ["*"] не доехала до srt: вендор начал валидировать список, ' +
        'и режим none из «наблюдаем всё» стал «блокируем всё» (R54)',
    );
  }
}

/**
 * Тело читается **не более `BODY_SAMPLE_BYTES`, после чего читатель явно отменяется**.
 *
 * Без отмены ветка tee продолжает буферизовать остаток загрузки для брошенного читателя —
 * то есть «прочитали до потолка и перестали» хуже, чем не читать вовсе, и это ровно
 * амплификация A13. Бесконечное тело обязано не подвешивать запрос, поэтому решение
 * возвращается сразу после отмены.
 */
async function countBody(request: Request): Promise<number> {
  const body = request.body;
  if (body === null) return 0;

  const reader = body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes >= BODY_SAMPLE_BYTES) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return bytes;
}

/** Один синглтон на процесс — как и сам `SandboxManager`, который он оборачивает. */
export const srt = new SrtSingleton();
