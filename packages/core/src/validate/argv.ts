import type { ResolvedValues } from './denial.js';
import { ARGV_SLOT, type PreparedRecipe } from './prepare.js';

/**
 * Стадия `build_argv`. Тотальна: всё, что могло не пройти, до этой стадии не дошло — поэтому
 * `build_argv` отсутствует в `DenialStage`.
 *
 * Конкатенации строки команды не происходит нигде: инъекция убивается конструкцией, а не
 * проверкой (И1, И2).
 */

/**
 * Строковое представление значения — ЯВНОЙ функцией, а не `String(value)`.
 *
 * Замерено (Ф13): `String(1e21)` даёт `'1e+21'`, то есть скрипт получил бы экспоненциальную
 * запись вместо числа. Целые любой величины проходят через `BigInt`, у которого
 * экспоненциальной формы нет вовсе; дробные остаются на кратчайшем round-trip-представлении
 * ECMAScript — том же, которое использует `canonicalizeJcs`, так что argv и `argsHash`
 * говорят об одном значении.
 */
function argvText(value: string | number): string {
  if (typeof value === 'string') return value;
  return Number.isInteger(value) ? BigInt(value).toString() : String(value);
}

/**
 * Подстановка НЕ интерпретирует подставляемое (R20а).
 *
 * `String.replace` со строковой заменой трактует `$&`, `` $` ``, `$'` и `$$` как управляющие
 * последовательности. Замерено (Ф17): существующий файл `a$'b.log`, прошедший confinement,
 * наивной подстановкой даёт argv с путём `ab.log` — другим и несуществующим. То есть дефект
 * проявляется на законном имени, а не только как вектор атаки.
 */
function substitute(template: string, text: string): string {
  const parts = template.split(ARGV_SLOT);
  if (parts.length > 2) {
    // Избыточная страховка, и она обязана быть НЕДОСТИЖИМОЙ: счёт слотов стоит в
    // `prepareRecipe`, потому что там есть форма отказа, а здесь её нет.
    throw new Error(`шаблон argv содержит слот ${ARGV_SLOT} больше одного раза`);
  }
  return parts.join(text);
}

/**
 * Результат стадии. Второе поле — расписка `WORK.md` по `AuditEvent.argvFromParams`: индексы
 * считаются **здесь**, в том же проходе, что и сама подстановка, потому что только здесь ещё
 * известно, какой элемент пришёл из параметра, а какой — из манифеста.
 *
 * Пересчёт по значениям (искать в готовом argv строки, равные значениям параметров) даёт
 * другой ответ там, где значение совпало с константой рецепта, и там, где редакция вырезала
 * секрет, — то есть ровно в тех вызовах, ради которых поле и заведено (`R62`, `R63`).
 */
export interface BuiltArgv {
  readonly argv: readonly string[];
  /**
   * Позиции элементов, **подставленных** из значений параметров: строго возрастающие,
   * без повторов, каждая меньше `argv.length`.
   *
   * Элементы `boolean`-параметра сюда НЕ попадают, и это не упущение. Их текст — константа
   * манифеста; модель управляет их присутствием, но не содержимым, а потребитель поля —
   * правило выбора опасного токена (`R41`) — велит человеку набрать то, чем управляет
   * модель. Флаг `--force` из рецепта таким токеном не является.
   */
  readonly fromParams: readonly number[];
}

export function buildArgv(prepared: PreparedRecipe, values: ResolvedValues): BuiltArgv {
  // В `exec` НИЧЕГО не подставляется — ни одного вызова замены над его элементами (R22).
  const argv: string[] = [...prepared.exec];
  const fromParams: number[] = [];

  // В порядке объявления (R19): порядок входит в нормализованную форму рецепта именно
  // потому, что из него собирается argv (ADR-0006).
  for (const param of prepared.params) {
    const value = values.get(param.name);
    // Отсутствующее значение не даёт элементов (R7). Шаблон уже нормализован подготовкой в
    // `[]`, поэтому ветки «шаблона нет» здесь не существует.
    if (value === undefined) continue;

    if (param.kind === 'boolean') {
      // Раскрывается присутствием или отсутствием своих элементов, без подстановки (R21).
      if (value === true) argv.push(...param.argv);
      continue;
    }

    if (typeof value === 'boolean') continue;

    for (const template of param.argv) {
      // Каждый элемент шаблона — ОТДЕЛЬНЫЙ элемент результата (R20). Для `path` в карте лежит
      // результат `realpath`: задача резолва вернула ровно одну карту и заменила значение в
      // ней, так что второго источника, из которого можно было бы взять сырую строку, нет.
      const substituted = template.includes(ARGV_SLOT);
      if (substituted) fromParams.push(argv.length);
      argv.push(substituted ? substitute(template, argvText(value)) : template);
    }
  }

  return { argv, fromParams };
}
