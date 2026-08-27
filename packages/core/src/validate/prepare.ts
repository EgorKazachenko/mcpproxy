import { isAbsolute, relative, resolve, sep } from 'node:path';
import { matcherKey, type PatternMatcher, type Recipe, type RecipeName } from '@mcpproxy/contracts';
import { isCanonicalizable } from './denial.js';

/**
 * Подготовка рецепта — первая из двух фаз (R2, D1). Выполняется один раз после загрузки
 * манифеста; всё, что можно сделать один раз, делается здесь, потому что три стадии вызова
 * целиком лежат внутри оверхед-бюджета ≤50 мс p95.
 */

/**
 * Замкнутая форма параметра: из схемы переносится только то, что нужно проверке.
 *
 * Поля `schema: StringParam` в ней **нет**, и это структурная часть R3: `StringParam.pattern` —
 * недоверенная строка, ради недоступности которой существует `PatternMatcher`
 * (`packages/contracts/src/types.ts:95`), и положить её в горячую структуру значит оставить
 * `new RegExp(param.schema.pattern)` на расстоянии одного нажатия.
 *
 * Ветка `path` несёт **только** резолвнутый `root`. Сырого `schema.root` рядом нет по тому же
 * доводу, по которому R18 запрещает два поля `cwd`: два поля с одним смыслом, одно
 * проверенное, другое нет, — это приглашение взять не то.
 */
export type PreparedParam =
  | {
      readonly kind: 'string';
      readonly name: string;
      readonly required: boolean;
      readonly argv: readonly string[];
      /**
       * Не `PatternMatcher | null`. Тип обязан выражать то, что гарантирует проверка
       * подготовки: иначе `validateParams` не скомпилируется без второй проверки, а второй
       * проверкой будет либо запрещённая R4 развилка, либо `matcher!`.
       */
      readonly matcher: PatternMatcher;
      readonly maxLength: number | null;
    }
  | {
      readonly kind: 'enum';
      readonly name: string;
      readonly required: boolean;
      readonly argv: readonly string[];
      readonly values: readonly string[];
    }
  | {
      readonly kind: 'number';
      readonly name: string;
      readonly required: boolean;
      readonly argv: readonly string[];
      readonly min: number | null;
      readonly max: number | null;
      readonly integer: boolean;
    }
  | {
      readonly kind: 'boolean';
      readonly name: string;
      readonly required: boolean;
      readonly argv: readonly string[];
    }
  | {
      readonly kind: 'path';
      readonly name: string;
      readonly required: boolean;
      readonly argv: readonly string[];
      readonly root: string;
    };

export interface PreparedRecipe {
  readonly recipeName: RecipeName;
  /** В порядке объявления: из него собирается argv (R19, ADR-0006). */
  readonly params: readonly PreparedParam[];
  /**
   * Единственный вычислитель `cwd` — эта фаза (R18). По контракту события `cwd` впервые
   * **появляется** на стадии `resolve_paths`; это утверждение о том, где он виден, а не о том,
   * кто его считает.
   */
  readonly cwd: string;
  readonly exec: readonly string[];
}

export type PrepareResult =
  | { ok: true; prepared: PreparedRecipe }
  /** Текст для человека: ветвиться по нему нельзя. Станет причин много — заведётся код. */
  | { ok: false; problems: readonly string[] };

/** Слот подстановки. Литерал, а не регулярка: считать вхождения дешевле и без движка. */
const SLOT = '{}';

const slotCount = (text: string): number => text.split(SLOT).length - 1;

export function prepareRecipe(
  recipeName: RecipeName,
  recipe: Recipe,
  matchers: ReadonlyMap<string, PatternMatcher>,
  manifestDir: string,
): PrepareResult {
  const problems: string[] = [];
  const dir = resolve(manifestDir);

  // R28, источник 3. `recipeName` уезжает в `argsHash` первым аргументом, а имена параметров
  // становятся ключами объекта `params`, по которому этот же хэш считается, — и `canonicalizeJcs`
  // бросает на суррогате в **ключе** тоже (Ф16). Загрузчик ограничивает их схемой, но
  // `prepareRecipe` принимает `Recipe`, собранный программно и минующий загрузчик.
  const requireCanonicalizable = (label: string, value: string): void => {
    if (!isCanonicalizable(value)) problems.push(`${label} не канонизируется: одиночный суррогат`);
  };

  requireCanonicalizable('имя рецепта', recipeName);

  // `exec` целиком: ни один параметр в него не подставляется (R22, И2), и проверяется это
  // здесь, а не доверяется загрузке, — `docs/07-contracts.md:161` прямым текстом объясняет,
  // почему пол и потолок держатся в двух местах.
  const exec = [...recipe.exec];
  exec.forEach((element, index) => {
    requireCanonicalizable(`exec[${index}]`, element);
    if (slotCount(element) > 0) problems.push(`exec[${index}] содержит слот ${SLOT}: ни один параметр в exec не подставляется`);
  });

  if (recipe.cwd !== undefined) {
    requireCanonicalizable('cwd', recipe.cwd);
    if (slotCount(recipe.cwd) > 0) problems.push(`cwd содержит слот ${SLOT}: ни один параметр в cwd не подставляется`);
  }
  const cwd = recipe.cwd === undefined ? dir : resolve(dir, recipe.cwd);

  const params: PreparedParam[] = [];

  // Порядок берётся из `Object.entries` того же объекта, который лёг в нормализованную форму:
  // порядок параметров входит в форму именно потому, что из него собирается argv (ADR-0006).
  for (const [name, param] of Object.entries(recipe.params ?? {})) {
    requireCanonicalizable(`имя параметра ${JSON.stringify(name)}`, name);

    // Отсутствующий шаблон нормализуется в `[]` здесь: `argv?: ArgvTemplate` необязателен у
    // всех пяти типов, и, закрыв ветку один раз на подготовке, `buildArgv` избавляется от неё.
    const argv = [...(param.argv ?? [])];
    argv.forEach((element, index) => {
      requireCanonicalizable(`${name}.argv[${index}]`, element);
      if (slotCount(element) > 1) {
        problems.push(`${name}.argv[${index}] содержит слот ${SLOT} больше одного раза`);
      }
    });

    const required = param.required ?? false;
    const head = { name, required, argv } as const;

    switch (param.type) {
      case 'string': {
        // Ключ строится вызовом `matcherKey`, а не конкатенацией: иначе `get()` возвращает
        // `undefined` и на «у параметра нет pattern», и на «ключ собран неправильно» (R3).
        const matcher = matchers.get(matcherKey(recipeName, name));
        if (matcher === undefined) {
          // Ошибка подготовки, а не пер-вызовная развилка (R4): развилка «матчер не найден»
          // на горячем пути возвращает тот самый выбор, запасной путь в котором — `new RegExp`.
          problems.push(`${name}: нет скомпилированного матчера для параметра type: string`);
          break;
        }
        params.push({ kind: 'string', ...head, matcher, maxLength: param.maxLength ?? null });
        break;
      }
      case 'enum': {
        for (const value of param.values) requireCanonicalizable(`${name}.values`, value);
        params.push({ kind: 'enum', ...head, values: [...param.values] });
        break;
      }
      case 'number': {
        params.push({
          kind: 'number',
          ...head,
          min: param.min ?? null,
          max: param.max ?? null,
          integer: param.integer ?? false,
        });
        break;
      }
      case 'boolean': {
        params.push({ kind: 'boolean', ...head });
        break;
      }
      case 'path': {
        requireCanonicalizable(`${name}.root`, param.root);
        const root = isAbsolute(param.root) ? resolve(param.root) : resolve(dir, param.root);

        // Две половины одной проверки, и вторую нельзя опускать, взяв только первую: они
        // стоят рядом в `refine.ts:213` и `:223`, а программный `Recipe` с `root: '../..'`
        // проходит первую и выходит за каталог манифеста.
        if (root === resolve('/')) {
          problems.push(`${name}.root: "/" не ограничивает ничего`);
          break;
        }
        if (!isAbsolute(param.root)) {
          // Ровно `..` либо `../…`, а не любое начало с двух точек: `root: "./..cache"` даёт
          // `relative` = `"..cache"` — это законный ПОДкаталог.
          const outside = relative(dir, root);
          if (outside === '..' || outside.startsWith(`..${sep}`)) {
            problems.push(`${name}.root: относительный root не может выходить за каталог манифеста`);
            break;
          }
        }
        params.push({ kind: 'path', ...head, root });
        break;
      }
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, prepared: { recipeName, params, cwd, exec } };
}
