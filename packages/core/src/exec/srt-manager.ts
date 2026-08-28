import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { encodeSandboxedCommand } from '@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js';
import type { SandboxViolationEvent } from '@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js';
import type { SandboxViolation } from '@mcpproxy/contracts';
import { parseAndClassify } from './violation.js';
import type { ClassifyPolicy } from './violation.js';
import { ExecError } from './errors.js';
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
 * Потолок **времени** на чтение тела, а не только объёма.
 *
 * Прокси не идёт наверх, пока колбэк не вернул решение, поэтому чанкованный запрос, который
 * тянется под лимитом байт — стриминговая загрузка, длинный POST, — висел бы до таймаута
 * рецепта, и рабочий запрос отчитался бы как `timeout`. «Бесконечное тело обязано не
 * подвешивать запрос» (R26) без потолка по времени выполняется только для тел, которые
 * превысили потолок по байтам.
 */
export const BODY_SAMPLE_MS = 250;

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

/**
 * Сведение URL к тому, что не несёт секретов, — **до** того, как он станет `target`
 * нарушения и уедет в цепочку аудита.
 *
 * Форма скопирована с вендорской `redactUrlForViolation` (`sandbox-manager.js:170-190`) и по
 * той же причине, сформулированной там дословно: query-строки рутинно несут учётные данные
 * (`api_key=`, `access_token=`, подписанные URL), которые ребёнок подставил в рантайме и
 * которых не было в контексте модели. Наш колбэк получает URL **нередактированным** — это
 * цена `tlsTerminate` (D12), — и без этого сведения секрет лёг бы открытым текстом в
 * append-only лог, то есть туда, откуда его уже не убрать.
 *
 * Редакция E6 сюда не годится: она объявлена для потоков вывода (R20) и работает над
 * буфером, а здесь нужен разбор URL. Маркер вместо самой строки сохраняет наблюдаемость
 * «запрос был с параметрами», не сохраняя параметров.
 */
export function redactUrlForTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}${parsed.search === '' ? '' : '?…'}`;
  } catch {
    // Не абсолютный URL — режем всё после `?`, вместо того чтобы рискнуть утечкой.
    const at = url.indexOf('?');
    return at === -1 ? url : `${url.slice(0, at)}?…`;
  }
}

/** Результат попытки посчитать тело: либо число, либо признанный отказ счётчика. */
export type BodyCount = { readonly ok: true; readonly bytes: number } | { readonly ok: false };

/**
 * Запись о разрешённом запросе строится **из результата счёта, а не вместо него**.
 *
 * Отдельной чистой функцией потому, что инвариант здесь ровно один и его нужно уметь
 * утверждать: сбой счётчика байт уносит **байты**, а не запрос. Пока `collected.push` стоял
 * внутри того же `try`, что и `countBody`, отказ счётчика (тело уже прочитано, клиент
 * оборвал загрузку) уносил вместе с байтами и сам запрос — то есть в режиме `none` из
 * аудита исчезал тот самый запрос эксфильтрации, ради показа которого S5 существует, и
 * исчезал бесследно: `consumerFailures` документирован под другое.
 */
export function telemetryRecord(url: string, count: BodyCount): { violation: SandboxViolation; countFailed: boolean } {
  return {
    violation: {
      type: 'network',
      // Сведённый URL, а не сырой: сырой уехал бы с query-строкой в цепочку аудита.
      target: redactUrlForTarget(url),
      action: 'allowed',
      bytes: count.ok ? count.bytes : 0,
    },
    countFailed: !count.ok,
  };
}

export interface InvocationResult<T> {
  readonly value: T;
  readonly violations: readonly SandboxViolation[];
  readonly violationsLost: number;
  readonly attributionMissing: number;
  readonly attributionForeign: number;
  readonly unrecognizedLines: number;
  readonly suppressedLines: number;
  readonly consumerFailures: number;
  readonly bodyCountFailures: number;
  readonly lateUnattributed: number;
}

export interface InvocationContext {
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

/**
 * Текст один на все точки отказа: после `dispose()` вызов пошёл бы со старым конфигом и
 * `getProxyPort() === undefined`, то есть прокси-переменные не эмитятся вовсе — сеть
 * оказывается тихо **открыта** в `none` и тихо **мертва** в `seatbelt` (R50).
 */
export const DISPOSED_MESSAGE =
  'песочница уже освобождена: run() после dispose() запрещён, потому что вызов пошёл бы со ' +
  'старым конфигом и getProxyPort() === undefined (R50)';

interface ActiveInvocation {
  readonly encoded: string;
  readonly classify: ClassifyPolicy;
  readonly onViolation: (violation: SandboxViolation) => void;
  readonly collected: SandboxViolation[];
  lost: number;
  missing: number;
  foreign: number;
  unrecognized: number;
  suppressed: number;
  consumerFailures: number;
  bodyCountFailures: number;
}

class SrtSingleton {
  private initPromise: Promise<void> | undefined;
  private baseConfig: SandboxRuntimeConfig | undefined;
  private unsubscribe: (() => void) | undefined;
  private refs = 0;

  /**
   * Поднятый флаг означает, что группа процессов прошлого вызова не подтвердила пустоту
   * (R52). Он **терминальный**: каждый следующий вызов отказывает сразу и громко.
   *
   * Держать при этом семафор занятым навсегда — соблазнительное прочтение «отказа
   * освобождать», и оно хуже: вызов, вставший в очередь ДО отравления, не получил бы ни
   * ответа, ни ошибки — MCP-запрос повис бы навсегда, без записи в аудит. Поэтому семафор
   * освобождается, а отказывает флаг: каждый ждущий просыпается, видит отравление,
   * пропускает очередь дальше и бросает. «Ни один следующий вызов не идёт» исполняется,
   * «демон повешен» не наступает.
   */
  private poisoned: string | undefined;

  private readonly semaphore = new Semaphore();
  private lastSeen = 0;

  /**
   * Нарушения, приехавшие, когда активного вызова нет. Курсор их всё равно ретирует —
   * иначе следующий вызов получил бы чужие, — но выбрасывать их молча нельзя: ровно так
   * выглядит недостаточное `DRAIN_WINDOW_MS`, чьё собственное описание признаёт, что «ноль
   * на одной машине не ноль всегда». Вызов, чьи нарушения опоздали, уже отчитался
   * `violationsLost: 0`, то есть утверждает полный набор, которого у него нет.
   */
  private lateUnattributed = 0;

  /** Активный сборщик нарушений. Не `undefined` ровно тогда, когда семафор занят. */
  private active: ActiveInvocation | undefined;

  /**
   * Ссылка берётся при создании песочницы, а не при вызове.
   *
   * Считать вызовы было бы дефектом, а не стилем: `run()` зовёт `ensureInitialized`, поэтому
   * счётчик рос бы на каждом прогоне, `dispose()` уменьшал бы его на единицу и до нуля не
   * доходил бы никогда — глобальное состояние не сносилось бы вовсе.
   */
  retain(): void {
    this.refs += 1;
  }

  async ensureInitialized(baseConfig: SandboxRuntimeConfig): Promise<void> {
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
    if (active === undefined) {
      this.lateUnattributed += step.take + step.lost;
      return;
    }
    active.lost += step.lost;

    for (const event of all.slice(all.length - step.take)) {
      // Исключение отсюда улетело бы в обработчик `data` вендорского `log stream`
      // (`macos-sandbox-utils.js`, без `try`), а необработанное исключение в слушателе
      // потока роняет процесс. То есть дефектный колбэк потребителя убивал бы демон — и
      // вместе с ним остальные нарушения из того же уведомления.
      try {
        this.dispatch(active, event);
      } catch {
        active.consumerFailures += 1;
      }
    }
  }

  private dispatch(active: ActiveInvocation, event: SandboxViolationEvent): void {
    // Атрибуция — **окно семафора**, а не `encodedCommand` (R45): всё, что стор набрал
    // между захватом и освобождением, принадлежит текущему вызову. Ключ ненадёжен с обеих
    // сторон — имя пользователя прокси вшито в env ребёнка, то есть им управляет ребёнок,
    // а со стороны ядра ключ отсутствует, когда строка `CMD64_` не попала в тот же чанк
    // вывода `log stream`, что и строка отказа.
    //
    // Отсутствие и расхождение считаются ОТДЕЛЬНО, потому что значат разное. Отсутствие —
    // обычное дело: вендор ставит ключ, только когда обе строки легли в один чанк, а имя
    // пользователя прокси вырождается в голое `srt`, когда base64 не влезает в 255 байт
    // RFC 1929. Чужой ключ — наоборот, сигнал, что кто-то подписался не своим именем. Один
    // счётчик на оба случая читался бы как тревога на каждом втором вызове и перестал бы
    // значить что-либо.
    if (event.encodedCommand === undefined) active.missing += 1;
    else if (event.encodedCommand !== active.encoded) active.foreign += 1;

    const parsed = parseAndClassify(event.line, active.classify);
    if (parsed.kind === 'suppressed') {
      active.suppressed += 1;
      return;
    }
    if (parsed.kind === 'unrecognized') {
      // Строка ядра, чью операцию мы не знаем, — это отказ, который ПРОИЗОШЁЛ. Выбросив её
      // без счётчика, мы бы обещали «неразобранное громко видно» и обещания не выполняли:
      // отказ исчезал бы из `ExecOutcome`, из потока событий и из любого счётчика разом.
      active.unrecognized += 1;
      return;
    }
    active.collected.push(parsed.violation);
    // Стримим по мере возникновения (R29): красная строка S5 появляется, пока процесс
    // ещё жив, а не пакетом после выхода.
    active.onViolation(parsed.violation);
  }

  /**
   * Колбэк телеметрии. Регистрируется **только в `initialize`** (R26): прокси захватывает
   * его по значению при создании, и установка позже через `updateConfig` не действует,
   * причём тихо — байты станут нулём, а S5 покажет «0 KB» при зелёных тестах.
   */
  buildFilterRequest(): (request: Request) => Promise<{ action: 'allow' }> {
    return async (request: Request): Promise<{ action: 'allow' }> => {
      // Счёт байт и ЗАПИСЬ о запросе разведены намеренно. Обоснование «ошибка даёт allow, а
      // не deny» (R26) объясняет только решение: политика уже применена `updateConfig`, и
      // бросок здесь резал бы разрешённый трафик. Оно не даёт права выронить саму запись —
      // а именно это происходило, пока `collected.push` стоял внутри того же `try`: сбой
      // `countBody` (тело уже прочитано, клиент оборвал загрузку) уносил вместе с байтами и
      // запрос, ради показа которого S5 существует. Байт нет — пишем ноль и считаем сбой;
      // записи нет — писать нечего никогда.
      let count: BodyCount;
      try {
        count = { ok: true, bytes: await countBody(request) };
      } catch {
        count = { ok: false };
      }

      const active = this.active;
      if (active !== undefined) {
        const { violation, countFailed } = telemetryRecord(request.url, count);
        if (countFailed) active.bodyCountFailures += 1;
        active.collected.push(violation);
        try {
          active.onViolation(violation);
        } catch {
          active.consumerFailures += 1;
        }
      }
      return { action: 'allow' };
    };
  }

  /**
   * Снятие вызова целиком (R46): **занять семафор → `updateConfig` политикой вызова →
   * обернуть → запустить → дождаться → убить группу и подтвердить её пустоту → drain-окно →
   * `updateConfig` пустым списком → освободить семафор.**
   *
   * Снятие политики и drain живут в `finally`, а не на успешном пути. Иначе рецепт, чей
   * `exec[0]` не существует на диске (`spawn` эмитит `error`), оставлял бы **глобальный**
   * конфиг с allowlist упавшего вызова — в `none` это буквально `['*']`. Это ровно форма
   * «на ошибке возвращаем allow», и запрещает её R52, объявляя идловым состоянием пустой
   * список. Drain обязан переехать вместе со снятием: без него нарушения, приехавшие после
   * падения тела, атрибутировались бы **следующему** вызову.
   */
  async withNetworkPolicy<T>(options: WithPolicyOptions<T>): Promise<InvocationResult<T>> {
    const context = { commandId: options.commandId };
    if (this.poisoned !== undefined) throw new ExecError('poisoned', this.poisoned, context);

    const base = this.baseConfig;
    if (base === undefined) throw new ExecError('srt-uninitialized', 'srt не инициализирован', context);

    const release = await this.semaphore.acquire();

    // Отравление могло случиться, пока этот вызов стоял в очереди. Проверка ДО `acquire`
    // его не видит, а без проверки здесь ждущий пошёл бы исполняться после того, как демон
    // уже объявил, что новых вызовов не выдаёт.
    if (this.poisoned !== undefined) {
      release();
      throw new ExecError('poisoned', this.poisoned, context);
    }

    const active: ActiveInvocation = {
      encoded: encodeSandboxedCommand(options.commandId),
      classify: options.classify,
      onViolation: options.onViolation,
      collected: [],
      lost: 0,
      missing: 0,
      foreign: 0,
      unrecognized: 0,
      suppressed: 0,
      consumerFailures: 0,
      bodyCountFailures: 0,
    };
    const inheritedLate = this.lateUnattributed;
    this.lateUnattributed = 0;
    this.active = active;

    try {
      applyNetwork(base, options.policy);
      let outcome;
      try {
        outcome = await options.body({ commandId: options.commandId });
      } catch (error) {
        // Отказ тела тоже может оставить живую группу — `runProcess` сообщает об этом
        // полем `groupDrained` в контексте ошибки. Без разбора здесь аварийный путь
        // отпускал бы демон дальше с выжившим потомком, и не осталось бы ни записи, ни
        // отравления: `outcome` не был бы присвоен, а ветка ниже — не исполнена.
        if (error instanceof ExecError && error.context.groupDrained === false) {
          this.poison(options.commandId, error.context.pid);
        }
        throw error;
      }

      if (!outcome.groupDrained) {
        // Тихий проход здесь возвращает исходный дефект: фоновый потомок остаётся привязан
        // к порту прокси и попадает под СЛЕДУЮЩУЮ политику (R52).
        this.poison(options.commandId);
        throw new ExecError('group-not-drained', this.poisoned ?? '', context);
      }

      return {
        value: outcome.value,
        violations: [...active.collected],
        violationsLost: active.lost,
        attributionMissing: active.missing,
        attributionForeign: active.foreign,
        unrecognizedLines: active.unrecognized,
        suppressedLines: active.suppressed,
        consumerFailures: active.consumerFailures,
        bodyCountFailures: active.bodyCountFailures,
        lateUnattributed: inheritedLate,
      };
    } finally {
      // Порядок внутри `finally` тот же, что был на успешном пути, и он несущий:
      // drain → снять политику → отпустить семафор. Отпустить раньше снятия значит сделать
      // ложным утверждение «под семафором всё, что видит колбэк, принадлежит текущему
      // вызову» ровно в том окне, ради которого drain и заведён.
      await delay(DRAIN_WINDOW_MS);
      try {
        applyNetwork(base, IDLE_NETWORK);
      } catch (error) {
        this.poisoned =
          `не удалось вернуть allowlist в пустое состояние после вызова ${options.commandId}: ` +
          `${String(error)}. Демон не выдаёт новых вызовов до вмешательства (R52)`;
      }
      this.active = undefined;
      release();
    }
  }

  /**
   * Отравление именует **вызов и pid**, а не только правило. Флаг терминальный, поэтому
   * после него каждый следующий отказ несёт одинаковый текст: без идентификаторов оператор,
   * читая аудит, не может сказать, какой рецепт оставил выжившего и какой процесс идти
   * искать, — а R45 просит, чтобы атрибуция докладывалась громко.
   */
  private poison(commandId: CommandId, pid?: number): void {
    const where = pid === undefined ? '' : `, лидер группы pid ${pid}`;
    this.poisoned =
      `группа процессов не подтвердила пустоту после вызова ${commandId}${where}: фоновый ` +
      'потомок пережил вызов и попал бы под политику следующего. Демон не выдаёт новых ' +
      'вызовов до вмешательства (R52)';
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
   * Счёт ссылок; на последней — снос глобального состояния.
   *
   * Флаг «эта песочница мертва» живёт **в самой песочнице** (`onceDispose`), а не здесь, и
   * различие несущее. R50 требует, чтобы `run()` бросал у **освобождённого экземпляра**; он
   * не требует, чтобы процесс больше никогда не смог поднять песочницу. Сделав флаг
   * процессным, мы запретили бы переключить режим на слайде S5 после того, как обе прошлые
   * песочницы освобождены: `createSandbox` бросал бы до конца жизни процесса.
   *
   * Переподъём безопасен: `reset()` у srt чистит `initializationPromise`, поэтому следующий
   * `initialize` проходит целиком и ставит свежий `config`. Опасен ровно тот случай, который
   * R50 и называет: вызов **после** `reset()` без повторной инициализации.
   */
  async dispose(): Promise<void> {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs > 0) return;
    if (this.initPromise === undefined) return;

    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.initPromise = undefined;
    this.baseConfig = undefined;
    this.active = undefined;
    await SandboxManager.reset();
  }
}

/**
 * `updateConfig` заменяет конфиг **целиком** (`structuredClone` без слияния), поэтому
 * пер-вызовный конфиг — это сохранённая база с заменой ровно **двух** доменных списков
 * (R56).
 *
 * Литерал из двух полей проходит проверку типов и молча роняет `strictAllowlist` (R43),
 * `tlsTerminate` (D12) и `credentials`: телеметрия обнуляется, S5 показывает «0 KB»,
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
    throw new ExecError(
      'wildcard-dropped',
      'политика с allowedDomains: ["*"] не доехала до srt: вендор начал валидировать список, ' +
        'и режим none из «наблюдаем всё» стал «блокируем всё» (R54)',
    );
  }
}

/**
 * Тело читается **не более `BODY_SAMPLE_BYTES` и не дольше `BODY_SAMPLE_MS`**, после чего
 * читатель явно отменяется.
 *
 * Без отмены ветка tee продолжает буферизовать остаток загрузки для брошенного читателя —
 * то есть «прочитали до потолка и перестали» хуже, чем не читать вовсе, и это ровно
 * амплификация A13.
 *
 * Потолок по времени нужен отдельно от потолка по байтам: прокси не идёт наверх, пока
 * колбэк не вернул решение, поэтому тело, которое тянется медленно, но под лимитом байт,
 * держало бы запрос до таймаута рецепта — и рабочий запрос отчитался бы как отказ.
 */
async function countBody(request: Request): Promise<number> {
  const body = request.body;
  if (body === null) return 0;

  const reader = body.getReader();
  let bytes = 0;
  const readLoop = async (): Promise<void> => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes >= BODY_SAMPLE_BYTES) break;
    }
  };

  try {
    await Promise.race([readLoop(), delay(BODY_SAMPLE_MS)]);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return bytes;
}

/** Один синглтон на процесс — как и сам `SandboxManager`, который он оборачивает. */
export const srt = new SrtSingleton();
