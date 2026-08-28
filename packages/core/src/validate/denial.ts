import { DESCRIPTION_MAX_LENGTH, sanitizeDescription, type Stage } from '@mcpproxy/contracts';

/**
 * Общие типы E2 и словарь отказов.
 *
 * Словарь свой, внутри `core`: замороженная поверхность контрактов не расширяется (D2, R24).
 * `Stage` уже различает `validate` и `resolve_paths`, а потребителю, которому нужна причина
 * точнее, доступен импорт отсюда.
 */

/** Значение параметра после валидации. Три типа — ровно то, что выражает схема манифеста. */
export type ParamValue = string | number | boolean;

/**
 * Стадии, которые исполняет E2. Массив с `as const satisfies`, а не инлайновый `Extract`:
 * `Extract<Stage, 'validaet'>` даёт `never` молча и всё остальное продолжает компилироваться,
 * а `satisfies readonly Stage[]` роняет сборку на опечатке. Идиом стоит в
 * `packages/contracts/src/domain.test.ts:25`.
 */
export const E2_STAGES = ['validate', 'resolve_paths', 'build_argv'] as const satisfies readonly Stage[];

export type E2Stage = (typeof E2_STAGES)[number];

/**
 * Стадии, на которых возможен отказ. Уже `E2_STAGES`: `buildArgv` тотальна, отказать ей
 * нечем, поэтому `build_argv` в стадии отказа недостижим. `E2Stage` остаётся широким —
 * длительность меряется у всех трёх.
 */
export const DENIAL_STAGES = ['validate', 'resolve_paths'] as const satisfies readonly E2Stage[];

export type DenialStage = (typeof DENIAL_STAGES)[number];

/**
 * Абсолютный потолок длины строкового значения, независимый от `maxLength` манифеста (R30).
 *
 * Нужен потому, что `PathParam` не имеет **ни** `pattern`, **ни** `maxLength` вовсе, то есть
 * без него путь в мегабайт доехал бы до `realpath`, argv, `argsHash` и записи аудита.
 * Прецедента в доках у него нет: родственный `JCS_MAX_DEPTH` ограничивает глубину
 * вложенности, а не длину, и это другой класс.
 */
export const VALUE_MAX_CODE_POINTS = 4096;

/**
 * Потолок на длину списка отказов (R30а). Значение выбрано так, чтобы человек в модалке мог
 * их прочитать: список длиннее уже не диагностика, а стена текста. `IpcRequest` потолка
 * размера не несёт, а полный контроль над сокетом входит в модель угроз (И6).
 *
 * При усечении список получает `DENIALS_MAX + 1` элемент: тридцать два отказа плюс
 * суммирующий `denials-truncated`. Маркер не входит в потолок намеренно — иначе факт
 * усечения вытеснял бы одну из строк, ради которых потолок и существует.
 */
export const DENIALS_MAX = 32;

declare const validated: unique symbol;
declare const resolved: unique symbol;

/**
 * Карта проверенных значений — выход `validateParams`. Бренд стирается в рантайме, цены нет.
 *
 * Существует потому, что на шве фасада обе карты живут одновременно, а без бренда они одного
 * типа: передать в `buildArgv` **до**резолвную карту — то есть сырую непроверенную строку
 * прямо в argv — компилятор молча позволил бы.
 */
export type ValidatedValues = ReadonlyMap<string, ParamValue> & { readonly [validated]: true };

/** Карта значений после резолва путей — выход `resolvePaths`. Вторая половина того же шва. */
export type ResolvedValues = ReadonlyMap<string, ParamValue> & { readonly [resolved]: true };

/**
 * Причины отказа, машиночитаемо. Массивом, а не только юнионом, — по тому же доводу, по
 * которому `CHECK_IDS` объявлен массивом (`packages/contracts/src/validate/branch-checks.ts:10`):
 * перепись «код ↔ вектор» в `corpus.test.ts` иначе была бы односторонней, и код, переставший
 * производиться, не уронил бы ничего.
 *
 * Таблица кодов стоит ЗДЕСЬ, а не построчным JSDoc внутри массива, и причина исполняемая.
 * Снапшот публичной поверхности сверяется побайтово, а declaration emit не детерминирован:
 * одна пересборка переиспользует исходные узлы и печатает массив многострочно вместе с JSDoc,
 * другая синтезирует его одной строкой. Замерено на этом дереве — два прогона при неизменном
 * исходнике дали разный `.d.ts`, и гейт `api-surface` флакал. `api-surface.ts` по этой же
 * причине уже нормализует кавычки; вынос документации из массива убирает вторую половину той
 * же непостоянности в источнике, а не ещё одной нормализацией.
 *
 * | код | когда |
 * |---|---|
 * | `bad-params-container` | `params` — не объект: `null`, массив, строка, число. Претензия к запросу, не к параметру. |
 * | `unknown-param` | Ключ запроса, которого нет в `recipe.params`. |
 * | `missing-required` | Обязательный параметр не передан. |
 * | `wrong-type` | `typeof` значения не тот, что объявлен веткой параметра. |
 * | `not-canonicalizable` | Строка не переживёт `canonicalizeJcs` — одиночный суррогат. |
 * | `value-oversized` | Строка длиннее `VALUE_MAX_CODE_POINTS`, независимо от `maxLength` манифеста. |
 * | `pattern-mismatch` | `matcher.test` вернул `false`. |
 * | `too-long` | Строка длиннее `maxLength` манифеста, в кодовых точках. |
 * | `not-in-enum` | Значения нет в `values`. |
 * | `not-finite` | Число не конечно: `1e400` из JSON даёт `Infinity`. |
 * | `out-of-range` | Число вне `min`/`max`. |
 * | `not-integer` | `integer: true`, а значение дробное. |
 * | `path-not-found` | `realpath` бросил `ENOENT`: пути нет. |
 * | `path-escapes-root` | Резолвнутый путь лежит вне `root` (И3). |
 * | `path-unusable` | Путь непригоден: нулевой байт, нерезолвимый `root`, не-строка. |
 * | `denials-truncated` | Список отказов усечён по `DENIALS_MAX`; общее число — в тексте причины. |
 */
export const DENIAL_CODES = [
  'bad-params-container',
  'unknown-param',
  'missing-required',
  'wrong-type',
  'not-canonicalizable',
  'value-oversized',
  'pattern-mismatch',
  'too-long',
  'not-in-enum',
  'not-finite',
  'out-of-range',
  'not-integer',
  'path-not-found',
  'path-escapes-root',
  'path-unusable',
  'denials-truncated',
] as const;

export type DenialCode = (typeof DENIAL_CODES)[number];

export interface Denial {
  readonly stage: DenialStage;
  /** Ветвиться потребитель обязан по нему. `reason` — для человека. */
  readonly code: DenialCode;
  /** `null` значит «претензия к самому запросу, а не к параметру»: известно и пусто. */
  readonly paramName: string | null;
  readonly reason: string;
}

/**
 * Одиночные суррогаты обеих половин; корректная пара переживает (Ф11).
 *
 * Литеральная регулярка, а не `new RegExp`: конструктор в `src/validate/**` запрещён и это
 * проверяет сорс-скан `deps.test.ts` (R3). Флага `u` здесь нет намеренно — работа идёт
 * именно по единицам UTF-16, в которых суррогат и живёт.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Приписывается, когда зачистка изменила текст: молчаливая потеря — сама по себе дефект. */
const SCRUBBED_MARK = ' [зачистка изменила текст]';

/**
 * Ставится вместо имени, которое зачистка съела целиком: `''` не должно путаться с `null`,
 * который по контракту значит «претензия к самому запросу, а не к параметру».
 */
const NAME_ERASED = '<имя вырезано зачисткой>';

/**
 * И отдельно — ключ, который **пришёл** пустым. `{"": 1}` — валидный JSON-объект, достижимый
 * по И6, и зачистка в нём ничего не вырезала. Один плейсхолдер на два разных случая дал бы
 * разбирающему запись объяснение, которого не было.
 */
const NAME_EMPTY = '<пустой ключ запроса>';

/**
 * Две зачистки подряд, и обе обязательны, потому что каждая закрывает то, что пропускает
 * другая (R27, замерено в Ф13): `sanitizeDescription` вырезает `Cc`/`Cf` и ANSI, но
 * одиночные суррогаты оставляет; собственная вырезает суррогаты, но не `Cf`.
 *
 * `sanitizeDescription` — санитайзер СВОБОДНОГО ТЕКСТА, и делает он больше, чем вырезает:
 * схлопывает `\r\n\t\v\f` и повторные пробелы в один, обрезает края и режет результат по
 * `DESCRIPTION_MAX_LENGTH` = 1024 кодовых точек. Для причины отказа это наблюдаемо и вредно:
 * замерено, что законное имя файла `/root/a  b\tc.log` приезжает как `/root/a b c.log` —
 * путь, которого на диске нет, — а причина из двух длинных путей режется ровно на 1024, и
 * хвост с `root` пропадает без следа. Заменить санитайзер нельзя: R27 требует именно его.
 * Поэтому потеря перестаёт быть молчаливой.
 */
function scrubbed(text: string): string {
  return sanitizeDescription(text).text.replace(LONE_SURROGATE, '');
}

/**
 * Пометка приписывается ВНУТРИ потолка, а не сверх него: `sanitizeDescription` гарантирует
 * `<= DESCRIPTION_MAX_LENGTH` кодовых точек, и наивное `clean + MARK` эту гарантию тихо
 * снимало бы — замерено, причина из 2000 символов приезжала длиной 1050.
 */
function marked(clean: string, original: string): string {
  if (clean === original) return clean;
  const room = DESCRIPTION_MAX_LENGTH - [...SCRUBBED_MARK].length;
  return `${[...clean].slice(0, room).join('')}${SCRUBBED_MARK}`;
}

/** Причина: изменённый текст помечается, чтобы искажённый путь не читался как факт. */
function scrubReason(text: string): string {
  return marked(scrubbed(text), text);
}

/**
 * Имя параметра: сначала дешёвая отсечка по единицам UTF-16, потом зачистка.
 *
 * Отсечка обязана стоять ПЕРВОЙ и работать по единицам, а не по кодовым точкам: ключ запроса
 * ничем не ограничен (R30а), а разворот стомегабайтного ключа в массив кодовых точек убивает
 * процесс раньше, чем что-либо успевает его усечь. Кодовых точек всегда не больше, чем
 * единиц, поэтому срез по единицам — корректная верхняя граница.
 */
function scrubName(name: string): string {
  if (name === '') return NAME_EMPTY;

  const clamped = name.length > VALUE_MAX_CODE_POINTS ? name.slice(0, VALUE_MAX_CODE_POINTS) : name;
  const clean = scrubbed(clamped);
  if (clean === '') return NAME_ERASED;

  // Имя помечается по тому же правилу, что и причина: «потеря не бывает молчаливой» — принцип,
  // а не свойство одного поля. Замерено, что без пометки ключ из 4096 эмодзи, ключ из 32 млн
  // единиц и ключ из 2048 эмодзи с хвостом приезжают одинаковыми 1024 точками, и различить их
  // по записи нельзя.
  return marked(clean, name);
}

/**
 * Конструктор отказа. Аргумент **объектный**, а не позиционный: позиционная форма ставит
 * рядом `paramName` и `reason`, оба строковые, их перестановка компилируется и кладёт прозу
 * в имя, а имя — в причину, ровно в том единственном месте, где значение может проехать
 * мимо R25.
 *
 * `paramName` санитизируется наравне с `reason`, а не «на всякий случай»: он недоверен ровно
 * в коде `unknown-param`, где берётся из ключей **запроса**. Имена манифеста ограничены
 * `propertyNames` схемы, ключи запроса — нет.
 */
export function denial(input: {
  stage: DenialStage;
  code: DenialCode;
  paramName: string | null;
  reason: string;
}): Denial {
  return {
    stage: input.stage,
    code: input.code,
    paramName: input.paramName === null ? null : scrubName(input.paramName),
    reason: scrubReason(input.reason),
  };
}

/**
 * Переживёт ли строка `canonicalizeJcs` (R28).
 *
 * Реализуется проверкой на непарные суррогаты, а не вызовом `canonicalizeJcs` в `try/catch`:
 * предикат зовётся на каждое строковое значение каждого вызова, и городить исключение на
 * горячем пути ради булева ответа дорого. Эквивалентность двух реализаций фиксируется тестом —
 * иначе предикат и канонизатор разъезжаются молча, и гейт R28 становится декоративным.
 */
export function isCanonicalizable(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0xd800 || code > 0xdfff) continue;
    if (code > 0xdbff) return false;
    const next = value.charCodeAt(i + 1);
    if (next >= 0xdc00 && next <= 0xdfff) {
      i += 1;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Длина в кодовых точках, а не в единицах UTF-16: для эмодзи это 1 против 2 (Ф11).
 *
 * Разворачивает строку целиком, поэтому зовётся ТОЛЬКО там, где длина уже ограничена —
 * после того, как `codePointLengthAtMost` пропустил значение. На недоверенном входе вместо
 * неё стоит ограниченный счётчик: см. его комментарий.
 */
export function codePointLength(value: string): number {
  return [...value].length;
}

/**
 * «Кодовых точек не больше `max`?» — с ограниченной работой и без единой аллокации.
 *
 * Существует потому, что гейт, введённый ПРОТИВ гигантских значений, не может позволить себе
 * их разворачивать. Замерено на этом дереве: `[...value].length` на строке в 16 млн единиц —
 * 30.6 мс и +122 МБ кучи, на 100 млн — фатальный OOM процесса, который `try/catch` не ловит,
 * то есть вызов не получает отказа, а демон исчезает вместе с незаписанным решением. Вход
 * достижим по И6: `IpcRequest` потолка размера не несёт, а у `PathParam` нет ни `pattern`,
 * ни `maxLength`, так что до этой проверки не стоит ни одной другой.
 *
 * Две дешёвые отсечки точны, потому что кодовых точек всегда `≥ length / 2` и `≤ length`.
 * За ними цикл, который обрывается на `max + 1`-й точке, то есть смотрит не более
 * `2 * (max + 1)` единиц независимо от длины входа.
 */
export function codePointLengthAtMost(value: string, max: number): boolean {
  if (value.length <= max) return true;
  if (value.length > max * 2) return false;

  let count = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    count += 1;
    if (count > max) return false;
  }
  return true;
}
