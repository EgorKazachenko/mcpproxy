import { asRecipeName, matcherKey, type Param, type PatternMatcher, type Recipe } from '@mcpproxy/contracts';
import { describe, expect, it } from 'vitest';
import { isCanonicalizable } from './denial.js';
import { prepareRecipe, type PreparedParam } from './prepare.js';

const NAME = asRecipeName('run_tests');
const DIR = '/home/u/proj';
const LONE_HIGH = '\uD800';

/** Литеральная регулярка, а не `new RegExp`: конструктор в `src/validate/**` запрещён (R3). */
const okMatcher: PatternMatcher = { test: (value: string): boolean => /^[\w./-]{0,64}$/u.test(value) };

const matchersFor = (...paramNames: readonly string[]): ReadonlyMap<string, PatternMatcher> =>
  new Map(paramNames.map((one) => [matcherKey(NAME, one), okMatcher]));

const recipeOf = (over: Partial<Recipe>): Recipe => ({ description: 'опись', exec: ['/usr/bin/true'], ...over });

describe('prepareRecipe — матчер берётся один раз (R3, R4)', () => {
  it('отсутствие матчера у string-параметра — ошибка ПОДГОТОВКИ, а не пер-вызовная развилка', () => {
    // Утверждается `ok === false`, а не текст проблемы: тексту ветвиться не положено.
    const result = prepareRecipe(NAME, recipeOf({ params: { pattern: { type: 'string', pattern: '^x$' } } }), new Map(), DIR);
    expect(result.ok).toBe(false);
  });

  it('матчер найден — подготовка проходит и кладёт его в замкнутую форму', () => {
    const result = prepareRecipe(
      NAME,
      recipeOf({ params: { pattern: { type: 'string', pattern: '^x$' } } }),
      matchersFor('pattern'),
      DIR,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const first = result.prepared.params[0];
    expect(first?.kind).toBe('string');
    if (first?.kind !== 'string') return;
    expect(first.matcher.test('v1.2.3')).toBe(true);
    expect(first.matcher.test('v1.2.3; rm -rf /')).toBe(false);
  });
});

describe('prepareRecipe — собственная перепроверка инвариантов (R22)', () => {
  // По вектору на КАЖДЫЙ из четырёх инвариантов, а не два из четырёх: правило «один вектор
  // зелен при отсутствии другой проверки» само же их и порождает.
  const vectors: ReadonlyArray<readonly [string, Recipe]> = [
    ['слот в exec — R22 нарушен буквально', recipeOf({ exec: ['sh', '-c', '{}'] })],
    ['root: "/" — confinement не ограничивает ничего', recipeOf({ params: { f: { type: 'path', root: '/' } } })],
    ['относительный root уходит за каталог манифеста', recipeOf({ params: { f: { type: 'path', root: '../..' } } })],
    [
      'два слота в одном элементе argv — бросок случился бы на третьей стадии',
      recipeOf({ params: { f: { type: 'path', root: './logs', argv: ['--x={}{}'] } } }),
    ],
    // Инвариантов, которые код держит, шесть, а таблица обещала «по вектору на КАЖДЫЙ» —
    // и два вектора отсутствовали: снятие проверки слота в `cwd` не красило ничего.
    ['слот в cwd — подстановки туда нет вовсе', recipeOf({ cwd: './{}' })],
    [
      'слот в argv boolean-параметра: подстановки нет, значит скобки уедут литералом',
      recipeOf({ params: { f: { type: 'boolean', argv: ['--f={}'] } } }),
    ],
  ];

  it('каждый из шести нарушенных инвариантов даёт ok: false', () => {
    for (const [label, recipe] of vectors) {
      expect(prepareRecipe(NAME, recipe, matchersFor(), DIR).ok, label).toBe(false);
    }
  });

  it('законные соседи этих векторов проходят', () => {
    // Обратная сторона: проверка не должна отвергать `root: "./..cache"` (законный подкаталог,
    // `relative` = `"..cache"`) и один слот на элемент.
    const ok = prepareRecipe(
      NAME,
      recipeOf({ params: { f: { type: 'path', root: './..cache', argv: ['--x={}'] } } }),
      matchersFor(),
      DIR,
    );
    expect(ok.ok).toBe(true);
  });
});

describe('prepareRecipe — канонизируемость строк рецепта (R28, источник 3)', () => {
  // Вектор берётся именно на `exec`, а не на значении параметра: гейт значений живёт в
  // `validateParams` и этот путь не покрывает. Без проверки подготовка проходит, значение
  // доезжает до argv, и `chainHash` бросает на **разрешённом** вызове.
  it('одиночный суррогат в exec[0] — ошибка подготовки', () => {
    expect(prepareRecipe(NAME, recipeOf({ exec: [`/usr/bin/tr${LONE_HIGH}ue`] }), matchersFor(), DIR).ok).toBe(false);
  });

  it('одиночный суррогат в ИМЕНИ параметра — тоже: канонизация проверяет ключи объекта', () => {
    const recipe = recipeOf({ params: { [`f${LONE_HIGH}`]: { type: 'boolean' } } });
    expect(prepareRecipe(NAME, recipe, matchersFor(), DIR).ok).toBe(false);
  });

  it('одиночный суррогат в значении enum — тоже', () => {
    const recipe = recipeOf({ params: { m: { type: 'enum', values: [`a${LONE_HIGH}`] } } });
    expect(prepareRecipe(NAME, recipe, matchersFor(), DIR).ok).toBe(false);
  });

  it('одиночный суррогат в cwd, в элементе argv и в root — тоже', () => {
    // Три из семи точек гейта R28 не фальсифицировались ничем: снятие их всех оставляло
    // 97/97 зелёных, а зонд показывал разрешённый вызов, чьи `cwd` и `argv[1]` несут
    // одиночный суррогат, — то есть `canonicalizeJcs` бросил бы на записи события, ровно
    // тот сценарий, ради которого R28 написан. (`argsHash` его не ловит: он считается
    // только по `params`, отсюда и ощущение покрытия.)
    const vectors: ReadonlyArray<readonly [string, Recipe]> = [
      ['суррогат в cwd', recipeOf({ cwd: `./wo${LONE_HIGH}rk` })],
      [
        'суррогат в элементе argv',
        recipeOf({ params: { f: { type: 'path', root: './logs', argv: [`--file=${LONE_HIGH}{}`] } } }),
      ],
      ['суррогат в root', recipeOf({ params: { f: { type: 'path', root: `./lo${LONE_HIGH}gs` } } })],
    ];
    for (const [label, recipe] of vectors) {
      expect(prepareRecipe(NAME, recipe, matchersFor(), DIR).ok, label).toBe(false);
    }
  });

  it('одиночный суррогат в КАТАЛОГЕ МАНИФЕСТА — тоже: он вбирается в cwd', () => {
    // Четвёртый источник строк R28. `cwd` уезжает наружу и становится `AuditEvent.cwd`,
    // а `chainHash` хэширует событие целиком.
    expect(prepareRecipe(NAME, recipeOf({}), matchersFor(), `/home/u/pr${LONE_HIGH}oj`).ok).toBe(false);
  });

  it('одиночный суррогат в имени рецепта — тоже', () => {
    // `asRecipeName` такое имя не пропустит, но `prepareRecipe` принимает брендированную
    // строку, а бренд — утверждение компилятора, не рантайм-проверка.
    const hostile = `run${LONE_HIGH}` as unknown as typeof NAME;
    expect(prepareRecipe(hostile, recipeOf({}), matchersFor(), DIR).ok).toBe(false);
  });
});

describe('prepareRecipe — текст проблем и неизвестный тип', () => {
  it('имя параметра в тексте проблемы экранировано: сырой суррогат до человека не доезжает', () => {
    // Единственное правило дельты, которое снималось при 110/110 зелёных: замена `quoted`
    // на identity не красила ничего, потому что на текст `problems` не смотрел ни один трейс.
    const recipe = recipeOf({ params: { [`f${LONE_HIGH}`]: { type: 'path', root: '/' } } });
    const result = prepareRecipe(NAME, recipe, matchersFor(), DIR);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Утверждается свойство, а не формулировка: весь текст обязан переживать канонизацию,
    // потому что E1 показывает его человеку и, вероятно, кладёт в диагностику загрузки.
    expect(isCanonicalizable(result.problems.join(' '))).toBe(true);
  });

  it('неизвестный тип параметра — отказ подготовки, а не молчаливое исчезновение', () => {
    // Замерено до правки: параметр с чужим `type` не попадал в `prepared.params`, подготовка
    // проходила, и запрос с ним получал `unknown-param` — след утверждал, что параметр не
    // объявлен, хотя он объявлен. Гейт компиляции этого не закрывает: `Recipe`, собранный
    // программно, минует загрузчик, а `Param` генерируется из схемы.
    const recipe = recipeOf({ params: { f: { type: 'weird' } as unknown as Param, ok: { type: 'boolean' } } });
    const result = prepareRecipe(NAME, recipe, matchersFor(), DIR);
    expect(result.ok).toBe(false);
  });
});

describe('prepareRecipe — форма выхода', () => {
  it('сохраняет порядок объявления параметров (R19)', () => {
    // Алфавитный порядок ПРОТИВОПОЛОЖЕН порядку объявления, поэтому обход по отсортированным
    // ключам не совпал бы случайно.
    const recipe = recipeOf({ params: { zebra: { type: 'boolean' }, alpha: { type: 'boolean' } } });
    const result = prepareRecipe(NAME, recipe, matchersFor(), DIR);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.params.map((one) => one.name)).toEqual(['zebra', 'alpha']);
  });

  it('нормализует отсутствующий шаблон argv в пустой массив', () => {
    const result = prepareRecipe(NAME, recipeOf({ params: { f: { type: 'boolean' } } }), matchersFor(), DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.params[0]?.argv).toEqual([]);
  });

  it('вычисляет cwd ровно здесь: без cwd рецепта — каталог манифеста (R18)', () => {
    const bare = prepareRecipe(NAME, recipeOf({}), matchersFor(), DIR);
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(bare.prepared.cwd).toBe(DIR);

    const relative = prepareRecipe(NAME, recipeOf({ cwd: './work' }), matchersFor(), DIR);
    expect(relative.ok).toBe(true);
    if (relative.ok) expect(relative.prepared.cwd).toBe('/home/u/proj/work');
  });

  it('резолвит root ветки path относительно каталога манифеста', () => {
    const result = prepareRecipe(NAME, recipeOf({ params: { f: { type: 'path', root: './logs' } } }), matchersFor(), DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const first = result.prepared.params[0];
    expect(first?.kind === 'path' ? first.root : null).toBe('/home/u/proj/logs');
  });
});

// ── Уровня типа. Тест «работает» только если удаление правила ломает СБОРКУ, а не прогон.

type StringBranch = Extract<PreparedParam, { kind: 'string' }>;
type PathBranch = Extract<PreparedParam, { kind: 'path' }>;

// Замкнутость формы: лишний ключ в ветке — ошибка компиляции. Рантайм-тест зелен и с ним.
type StringBranchExtraKeys = Exclude<keyof StringBranch, 'kind' | 'name' | 'required' | 'argv' | 'matcher' | 'maxLength'>;
const _stringBranchClosed: [StringBranchExtraKeys] extends [never] ? true : StringBranchExtraKeys = true;
void _stringBranchClosed;

type PathBranchExtraKeys = Exclude<keyof PathBranch, 'kind' | 'name' | 'required' | 'argv' | 'root'>;
const _pathBranchClosed: [PathBranchExtraKeys] extends [never] ? true : PathBranchExtraKeys = true;
void _pathBranchClosed;

// `matcher` не `| null`: иначе `validateParams` потребовал бы второй проверки, а ею была бы
// либо запрещённая R4 развилка, либо `matcher!`.
type MatcherNotNullable = null extends StringBranch['matcher'] ? never : true;
const _matcherNotNullable: MatcherNotNullable = true;
void _matcherNotNullable;

// Сырая схема рядом с матчером не компилируется. Появится поле `schema` — директива ниже
// станет неиспользованной, и сборка упадёт здесь же (TS2578), а не пройдёт молча.
const _noRawSchema: StringBranch = {
  kind: 'string',
  name: 'p',
  required: false,
  argv: [],
  matcher: okMatcher,
  maxLength: null,
  // @ts-expect-error — избыточное свойство в замкнутой форме
  schema: { type: 'string', pattern: '^x$' },
};
void _noRawSchema;

describe('prepareRecipe — confinement cwd под каталог манифеста (R34 E4)', () => {
  it('cwd вверх от каталога манифеста отвергается на подготовке', () => {
    const result = prepareRecipe(NAME, recipeOf({ cwd: '../../..' }), new Map(), DIR);
    expect(result.ok).toBe(false);
  });

  it('сосед с общим префиксом тоже отвергается — граница не строковая', () => {
    const result = prepareRecipe(NAME, recipeOf({ cwd: '../proj-evil' }), new Map(), DIR);
    expect(result.ok).toBe(false);
  });

  it('абсолютный cwd вне каталога манифеста отвергается', () => {
    const result = prepareRecipe(NAME, recipeOf({ cwd: '/etc' }), new Map(), DIR);
    expect(result.ok).toBe(false);
  });

  it('подкаталог проходит и доезжает до формы', () => {
    const result = prepareRecipe(NAME, recipeOf({ cwd: './packages/app' }), new Map(), DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.cwd).toBe('/home/u/proj/packages/app');
  });

  it('cwd, равный каталогу манифеста, проходит — root-itself не outside', () => {
    const result = prepareRecipe(NAME, recipeOf({ cwd: '.' }), new Map(), DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.cwd).toBe(DIR);
  });

  it('отсутствующий cwd остаётся каталогом манифеста', () => {
    const result = prepareRecipe(NAME, recipeOf({}), new Map(), DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.cwd).toBe(DIR);
  });
});
