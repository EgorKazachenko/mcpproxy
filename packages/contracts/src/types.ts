import type { Manifest } from './manifest.generated.js';

/**
 * Именованные формы загрузки живут в **корневом** входе, а не в `./validate`.
 * Рендереру, который показывает диагностику с координатами (R4), иначе пришлось бы
 * импортировать валидатор — то есть раскол на входы не выполнил бы ту работу, ради
 * которой существует.
 */

/** Откуда пришёл манифест. `maxBytes` может только **понижать** `MANIFEST_MAX_BYTES`. */
export interface ManifestSource {
  readonly path: string;
  readonly maxBytes?: number;
}

/**
 * Диагностика загрузки. Поле называется `pointer`, а не `path`: путь к файлу лежит в
 * `ManifestSource.path`, и два соседних замороженных типа не должны называть одним словом
 * файл и точечный указатель внутрь него.
 */
/**
 * Причина отказа, машиночитаемо. Существует потому, что `message` — свободный русский текст,
 * а последствия у отказов разные: «RE2 отверг паттерн» — решение политики, «синтаксис YAML» —
 * ввод-вывод, и потребитель обязан их различать. `pointer` для этого не годится: у «RE2
 * отверг паттерн» и у «`pattern` не прошёл `SafeText` схемы» он один и тот же —
 * `tools.X.params.Y.pattern`.
 *
 * Без кода семь эпиков ветвились бы `String.includes` по прозе, и первая же правка
 * формулировки тихо ломала бы ветвление, не уронив ни одного теста.
 */
export type DiagnosticCode =
  /** Файл больше потолка — до разбора. */
  | 'size-limit'
  /** Синтаксис YAML, неизвестный тег, дубль ключа, алиас-бомба, директива, второй документ. */
  | 'yaml'
  /** Документ разобран, но не соответствует схеме манифеста. */
  | 'schema'
  /** Проверка, которую схема выразить не может (`refine`): confinement, слоты, форма `exec[0]`. */
  | 'invariant'
  /** `pattern` не принят движком RE2. */
  | 'pattern';

export interface Diagnostic {
  /** Точечный путь внутрь документа, например `tools.publish_release.params.tag`. */
  readonly pointer: string;
  /** 1-based. */
  readonly line: number;
  /** 1-based. */
  readonly column: number;
  /**
   * Ветвиться потребитель обязан по нему. `message` — для человека, и его текст не заморожен.
   */
  readonly code: DiagnosticCode;
  /**
   * Безопасен для отрисовки: всё, что интерполируется сюда из недоверенного манифеста,
   * проходит через `sanitizeDescription`. Без этого сообщение RE2, эхоящее фрагмент паттерна,
   * донесло бы до глаз человека bidi-override и ANSI-escape.
   */
  readonly message: string;
}

/**
 * Скомпилированный матчер. Он существует, чтобы потребителю **не приходилось** звать
 * `new RegExp(pattern)` и возвращать ReDoS, закрытый здесь на загрузке (R29): ни `source`,
 * ни `flags` наружу не выставлены.
 *
 * Чего он НЕ даёт, и это записано, чтобы не переоценивать границу: сама строка `pattern`
 * остаётся в `Manifest` — она обязательна в схеме, из неё же генерируется тип — и уезжает в
 * `Tool.inputSchema` через `toTool`, потому что модели без неё нечем валидировать аргумент.
 * То есть гарантия «строку никто не скомпилирует бэктрекающим движком» держится **внутри
 * демона**, а не у MCP-клиента. Подробности и цена — в `docs/10-honest-limitations.md`.
 */
export interface PatternMatcher {
  test(value: string): boolean;
}

export type ParseManifestResult =
  | { ok: true; manifest: Manifest; matchers: ReadonlyMap<string, PatternMatcher> }
  | { ok: false; diagnostics: Diagnostic[] };

/** Потолок размера манифеста до разбора. Понизить можно, повысить — нет. */
export const MANIFEST_MAX_BYTES = 262_144;

/**
 * Ключ матчера в карте. Строится функцией, а не конкатенацией на стороне вызывающего:
 * иначе `get()` возвращает `undefined` и на «у параметра нет `pattern`», и на «ключ собран
 * неправильно», а второй случай возвращает потребителю ровно ту развилку, ради закрытия
 * которой R29 и существует, — и запасной путь там `new RegExp`.
 *
 * Формат: `tools.publish_release.params.tag`.
 */
export function matcherKey(recipeName: string, paramName: string): string {
  return `tools.${recipeName}.params.${paramName}`;
}
