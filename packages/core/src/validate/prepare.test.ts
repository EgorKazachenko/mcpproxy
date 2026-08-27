import { asRecipeName, matcherKey, type PatternMatcher, type Recipe } from '@mcpproxy/contracts';
import { describe, expect, it } from 'vitest';
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
  ];

  it('каждый из четырёх нарушенных инвариантов даёт ok: false', () => {
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

  it('одиночный суррогат в имени рецепта — тоже', () => {
    // `asRecipeName` такое имя не пропустит, но `prepareRecipe` принимает брендированную
    // строку, а бренд — утверждение компилятора, не рантайм-проверка.
    const hostile = `run${LONE_HIGH}` as unknown as typeof NAME;
    expect(prepareRecipe(hostile, recipeOf({}), matchersFor(), DIR).ok).toBe(false);
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
