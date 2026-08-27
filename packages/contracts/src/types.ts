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
export interface Diagnostic {
  /** Точечный путь внутрь документа, например `tools.publish_release.params.tag`. */
  readonly pointer: string;
  /** 1-based. */
  readonly line: number;
  /** 1-based. */
  readonly column: number;
  readonly message: string;
}

/**
 * Скомпилированный матчер. Через границу пакета едет он, а не голая строка `pattern` (R29):
 * иначе потребитель волен вызвать `new RegExp(pattern)` и вернуть ReDoS, закрытый здесь
 * только на загрузке. Ни `source`, ни `flags` наружу не выставлены намеренно.
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
