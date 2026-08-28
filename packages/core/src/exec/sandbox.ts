import { randomBytes } from 'node:crypto';
import type { NormalizedDefaults, RecipeName, SandboxMode, SandboxViolation } from '@mcpproxy/contracts';
import { ExecError } from './errors.js';
import type { EventSink } from './events.js';
import { createNoneSandbox } from './modes/none.js';
import { createSeatbeltSandbox } from './modes/seatbelt.js';

/**
 * Публичная поверхность E3. Ни один тип из `@anthropic-ai/sandbox-runtime` здесь не
 * появляется и появиться не может: ADR-0002 требует изоляции дословно, а проверяет её
 * обход графа `.d.ts` в `events.test.ts` (R1).
 */

/**
 * Идентичность вызова, брендированная так же, как `RecipeName` в контрактах
 * (`packages/contracts/src/ipc.ts:13`).
 *
 * Голая строка здесь была бы дырой, а не мелочью: `run({recipeName: id, commandId: name})`
 * прошло бы проверку типов, а R30 существует ровно потому, что идентичность вызова путают
 * с текстом команды — и тогда srt, сравнивающий ключи по первым 100 символам, атрибутирует
 * нарушения чужому вызову.
 */
export type CommandId = string & { readonly __brand: 'CommandId' };

/**
 * Энтропия обязана лежать в **первых 100 символах** (R48): дальше srt идентификатор
 * обрезает, и два ключа с общим стосимвольным префиксом слились бы в один.
 *
 * Счётчик или хэш от текста команды не годятся: имя пользователя прокси вшито в env
 * ребёнка, то есть предсказуемый идентификатор даёт процессу внутри песочницы способ
 * подписаться чужим ключом и переложить свои нарушения на другой вызов.
 */
export function newCommandId(): CommandId {
  return randomBytes(16).toString('hex') as CommandId;
}

export function asCommandId(value: string): CommandId {
  if (value.length === 0) throw new TypeError('пустой commandId');
  return value as CommandId;
}

export interface ExecRequest {
  readonly recipeName: RecipeName;
  /**
   * Уже собранный argv (E2). Кортеж, а не массив: под `noUncheckedIndexedAccess`
   * (`tsconfig.base.json:10`) `command[0]` у массива — `string | undefined`, и `spawn`
   * потребовал бы `!` ровно в security-значимой точке.
   */
  readonly command: readonly [string, ...string[]];
  /**
   * Каталог **рецепта**, не демона. Различие несущее: `macGetMandatoryDenyPatterns` якорит
   * пути на `process.cwd()` демона (проба П3b), поэтому свой mandatory-deny E3 якорит сам —
   * и здесь лежит авторитетное значение, от которого резолвятся относительные пути профиля.
   */
  readonly recipeCwd: string;
  /**
   * Эффективный профиль, никогда `own`: пол и потолок применены именно в `effective`
   * (`packages/contracts/src/lock.ts:239-244`), и передача `own` тихо сняла бы их.
   */
  readonly effective: NormalizedDefaults;
  readonly commandId: CommandId;
}

/**
 * Чем закончился прогон. Отдельным полем, а не выводом из `exit.signal`: единственная улика
 * в `exit` — `signal === 'SIGKILL'`, неотличимый от убийства чем угодно ещё на машине.
 * R18 требует, чтобы таймаут дал `verdict: 'denied'` как решение политики (D6), и без
 * дискриминатора E4 выводил бы политику из артефакта ОС.
 */
export type Termination = 'exited' | 'timeout' | 'output-cap';

export interface StreamOutcome {
  readonly text: string;
  /** Байты, доехавшие до потребителя: после редакции E6 и после обрезки (R20). */
  readonly bytes: number;
  /** Истинно тогда и только тогда, когда данные отброшены. */
  readonly truncated: boolean;
}

export interface ExecOutcome {
  readonly termination: Termination;
  readonly exit: { readonly code: number | null; readonly signal: string | null };
  readonly stdout: StreamOutcome;
  readonly stderr: StreamOutcome;
  /** Полный набор, включая каждое уже отданное в `onViolation` — если `violationsLost` ноль. */
  readonly violations: readonly SandboxViolation[];
  /** Сколько нарушений вытеснило кольцо стора srt. Ненуль означает, что набор неполон (R45). */
  readonly violationsLost: number;
  /**
   * Наблюдаемость атрибуции и разбора (R45, R27, R39). Поля, а не строчки в логе, потому что
   * «докладывается громко» обязано быть проверяемо — и потому что ноль в каждом из них
   * означает разное.
   *
   * Нарушение по расхождению ключа **не отбрасывается**: иначе процесс, переписавший имя
   * пользователя прокси — а оно вшито в его же env, — выкинул бы свои отказы из нашей
   * корзины, и S5 показал бы ноль при работающей защите.
   */
  /** Нарушений без ключа атрибуции. Обычное дело: вендор ставит ключ не всегда. */
  readonly attributionMissing: number;
  /** Нарушений с ЧУЖИМ ключом. Не рутина, а сигнал: кто-то подписался не своим именем. */
  readonly attributionForeign: number;
  /**
   * Строк ядра, чью операцию не знает ни отображение в `ViolationType`, ни список шума.
   * Каждая — отказ, который произошёл; ненуль означает, что в `violations` его нет.
   */
  readonly unrecognizedLines: number;
  /** Строк, отброшенных как шум по явному списку (R39). Ноль подозрителен: шум есть всегда. */
  readonly suppressedLines: number;
  /**
   * Сколько раз бросил колбэк потребителя. Ненуль означает, что часть потока нарушений до
   * него не доехала, — и что демон это пережил, а не упал внутри обработчика вендора.
   */
  readonly consumerFailures: number;
  /**
   * Сколько разрешённых запросов не удалось посчитать по байтам. Запись о самом запросе при
   * этом **не теряется** — она едет с `bytes: 0`, иначе запрос, ради показа которого S5 и
   * существует, исчезал бы из аудита ровно в момент сбоя счётчика.
   */
  readonly bodyCountFailures: number;
  /**
   * Нарушений, приехавших, когда ни один вызов не был активен, — то есть после drain-окна
   * предыдущего. Считается на уровне синглтона и докладывается следующим вызовом.
   *
   * Ненуль означает, что `DRAIN_WINDOW_MS` мал для этой машины: нарушения вызова опоздали и
   * не попали в его собственный набор, хотя он уже отчитался `violationsLost: 0`. Без этого
   * счётчика недостаточное окно не наблюдаемо ничем.
   */
  readonly lateUnattributed: number;
  /**
   * Хэш JCS применённой политики, **включая доменные списки** (R47). Материал для сверки
   * согласия в E5. Узко намеренно: он доказывает тождество нашего входа, а не итоговой
   * политики — srt при обёртке доливает `getDefaultWritePaths()`, mandatory-deny и пути
   * учётных данных, поэтому исполненный набор всегда шире манифестного.
   */
  readonly policyHash: string;
}

export interface Sandbox {
  readonly mode: SandboxMode;
  /**
   * `onViolation` зовётся **по мере возникновения**, пока процесс ещё жив (R29): красная
   * строка S5 появляется в таймлайне до выхода, а не пакетом после него.
   */
  run(
    request: ExecRequest,
    onViolation: (violation: SandboxViolation) => void,
    /**
     * Сток событий четырёх стадий E3 (R32). Третьим параметром, а не полем запроса: событие
     * пишется и на вызове, остановленном отказом, то есть до того, как `run()` вернёт
     * что-либо вообще.
     */
    onEvent?: EventSink,
  ): Promise<ExecOutcome>;
  /** Считает ссылки; после последнего вызова любой `run()` бросает (R50). */
  dispose(): Promise<void>;
}

/**
 * Поддержан ли режим на этой платформе — **вопросом**, а не броском.
 *
 * Бросок как способ ответить «поддерживается ли» заставляет UI строить `try/catch` вокруг
 * проверки, которую делает чистая функция. E5 и E7 спрашивают именно так; `createSandbox`
 * для этого не годится — он на первой строке берёт ссылку на синглтон.
 */
export function isModeSupported(mode: SandboxMode, platform: NodeJS.Platform = process.platform): boolean {
  if (mode === 'container') return false;
  return mode !== 'seatbelt' || platform === 'darwin';
}

/**
 * Проверка режима, отделённая от конструирования, чтобы её можно было утверждать без
 * поднятия прокси и seatbelt.
 *
 * `container` бросает, а не откатывается на `seatbelt` (R3, D7): fail-closed, как везде в
 * проекте. Молчаливый откат дал бы вызывающему песочницу слабее запрошенной и слайд,
 * утверждающий контейнер там, где его нет.
 *
 * `seatbelt` вне macOS бросает, а не деградирует до `none` (R2): `10-honest-limitations.md:84`
 * объявляет ровно эту границу, и тихая деградация сняла бы её без следа в аудите.
 */
export function assertModeSupported(mode: SandboxMode, platform: NodeJS.Platform = process.platform): void {
  if (mode === 'container') {
    throw new ExecError(
      'mode-unsupported',
      'режим container не реализован: контейнерной песочницы в этой сборке нет, ' +
        'и притворяться, что она есть, опаснее, чем отказать (ADR-0002, D7)',
    );
  }
  if (mode === 'seatbelt' && platform !== 'darwin') {
    throw new ExecError(
      'mode-unsupported',
      `режим seatbelt поддерживается только на macOS, а платформа — ${platform}; ` +
        'тихой деградации до none нет намеренно (10-honest-limitations.md:84)',
    );
  }
}

/**
 * Единственный вход. Режим приходит **параметром вызова**, а не из манифеста (R4): в
 * замороженной схеме поля под режим нет и добавить его нельзя, а переключение режима в UI
 * для одного и того же рецепта — требование S5.
 *
 * Проверка отделена в `assertModeSupported`, чтобы её можно было утверждать, не поднимая
 * прокси и seatbelt; здесь она стоит **первой** — до любого импорта режима, до `initialize`
 * и до единой строки в аудите.
 */
export function createSandbox(mode: SandboxMode, platform: NodeJS.Platform = process.platform): Sandbox {
  assertModeSupported(mode, platform);
  return mode === 'none' ? createNoneSandbox() : createSeatbeltSandbox();
}
