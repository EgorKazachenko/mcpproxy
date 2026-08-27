import { asRecipeName, canonicalizeJcs, matcherKey, type Param, type PatternMatcher, type Recipe } from '@mcpproxy/contracts';
import { describe, expect, it } from 'vitest';
import { codePointLength, DENIALS_MAX, VALUE_MAX_CODE_POINTS } from './denial.js';
import { validateParams } from './params.js';
import { prepareRecipe, type PreparedRecipe } from './prepare.js';

const NAME = asRecipeName('run_tests');
const DIR = '/home/u/proj';
const LONE_HIGH = '\uD800';

/** Тот же паттерн, что у `run_tests.pattern` в демо-манифесте. Литерал, а не `new RegExp` (R3). */
const strict: PatternMatcher = { test: (value: string): boolean => /^[\w./-]{0,64}$/u.test(value) };

/**
 * Эмуляция ЗАКОННОГО, но слабого паттерна `^.{0,64}$`. Замерено (Ф12): RE2 компилирует его,
 * `parseManifest` принимает, и на одиночном суррогате он возвращает `true`. Именно этот
 * случай закрывает R28 — иначе значение доехало бы до argv, а `argsHash` бросил бы.
 */
const permissive: PatternMatcher = { test: (value: string): boolean => codePointLength(value) <= 64 };

function prepare(recipe: Recipe, matchers: ReadonlyMap<string, PatternMatcher>): PreparedRecipe {
  const result = prepareRecipe(NAME, recipe, matchers, DIR);
  if (!result.ok) throw new Error(`фикстура не подготовилась: ${result.problems.join('; ')}`);
  return result.prepared;
}

const ALL: Recipe = {
  description: 'опись',
  exec: ['/usr/bin/true'],
  params: {
    pattern: { type: 'string', pattern: '^[\\w./-]{0,64}$', required: true, maxLength: 12 },
    mode: { type: 'enum', values: ['fast', 'slow'] },
    count: { type: 'number', min: 1, max: 10, integer: true },
    verbose: { type: 'boolean' },
    file: { type: 'path', root: './logs' },
  },
};

const all = prepare(ALL, new Map([[matcherKey(NAME, 'pattern'), strict]]));
const codesOf = (result: ReturnType<typeof validateParams>): readonly string[] =>
  result.ok ? [] : result.denials.map((one) => one.code);

describe('validateParams — форма контейнера (R29)', () => {
  it('четыре не-объекта дают bad-params-container, а не TypeError', () => {
    // Четыре входа, а не один: бросает только `null` (`Object.keys(null)` — Ф13), а
    // `[]`/`'str'`/`42` дали бы неверный, но не падающий результат (`Object.keys('x')` = ['0']).
    const hostile: readonly unknown[] = [null, [], 'str', 42];
    for (const input of hostile) {
      const result = validateParams(all, input as Readonly<Record<string, unknown>>);
      expect(codesOf(result), JSON.stringify(input)).toEqual(['bad-params-container']);
    }
  });

  it('отказ контейнера несёт paramName: null — претензия к запросу, не к параметру', () => {
    const result = validateParams(all, null as unknown as Readonly<Record<string, unknown>>);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denials[0].paramName).toBeNull();
  });
});

describe('validateParams — неизвестные и отсутствующие ключи (R6, R7)', () => {
  it('лишний ключ — отказ, а не молчаливый пропуск', () => {
    // Утверждается список КОДОВ, а не длина массива: длина совпала бы и при любом другом коде.
    expect(codesOf(validateParams(all, { pattern: 'ok', evil: 1 }))).toEqual(['unknown-param']);
  });

  it('`constructor` из запроса — неизвестный ключ, а не значение с прототипа', () => {
    expect(codesOf(validateParams(all, { pattern: 'ok', constructor: 'x' }))).toEqual(['unknown-param']);
  });

  it('объявленный параметр с именем с прототипа не считается переданным', () => {
    // `Object.hasOwn`, а не `params[name] !== undefined`: иначе `toString` резолвился бы в
    // функцию с прототипа и поехал бы в проверку типа.
    // Каст нужен потому, что контекстный тип для ключа `toString` берётся у `Object.prototype`,
    // а не у индексной сигнатуры — то же свойство прототипа, которое и проверяется ниже.
    const recipe: Recipe = { description: 'о', exec: ['/usr/bin/true'], params: { toString: { type: 'boolean' } as Param } };
    const prepared = prepare(recipe, new Map());
    const result = validateParams(prepared, {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.has('toString')).toBe(false);
  });

  it('обязательный отсутствует — отказ; необязательный отсутствует — пропуск без значения', () => {
    expect(codesOf(validateParams(all, {}))).toEqual(['missing-required']);

    const result = validateParams(all, { pattern: 'ok' });
    expect(result.ok).toBe(true);
    if (result.ok) expect([...result.values.keys()]).toEqual(['pattern']);
  });

  it('порядок списка не задаётся порядком ключей атакующего', () => {
    const forward = codesOf(validateParams(all, { pattern: 'ok', bbb: 1, aaa: 2 }));
    const backward = validateParams(all, { pattern: 'ok', aaa: 2, bbb: 1 });
    expect(forward).toEqual(['unknown-param', 'unknown-param']);
    expect(backward.ok).toBe(false);
    if (backward.ok) return;
    expect(backward.denials.map((one) => one.paramName)).toEqual(['aaa', 'bbb']);
  });
});

describe('validateParams — тип до ограничений (R8, R12)', () => {
  it('null, массив и объект не проходят ни один гейт типа', () => {
    // `typeof null === 'object'` и `typeof [] === 'object'`: отдельной ветки под них не нужно,
    // и утверждение фиксирует это, чтобы оно не держалось на рассуждении.
    for (const value of [null, [1], { a: 1 }]) {
      expect(codesOf(validateParams(all, { pattern: value })), JSON.stringify(value)).toEqual(['wrong-type']);
    }
  });

  it('строка "true" не принимается за boolean', () => {
    expect(codesOf(validateParams(all, { pattern: 'ok', verbose: 'true' }))).toEqual(['wrong-type']);
  });

  it('слишком длинная строка в number-параметре даёт wrong-type, а не value-oversized', () => {
    // Гейты стоят ВНУТРИ функции своего типа: отдельный проход до диспетчеризации вернул бы
    // `value-oversized`, что противоречит R8 и ломает перепись «код ↔ вектор».
    const huge = 'a'.repeat(VALUE_MAX_CODE_POINTS + 1);
    expect(codesOf(validateParams(all, { pattern: 'ok', count: huge }))).toEqual(['wrong-type']);
  });
});

describe('validateParams — ограничения по типам (R9, R10, R11)', () => {
  it('границы числа включительны с обеих сторон', () => {
    const table: ReadonlyArray<readonly [number, boolean]> = [
      [0, false],
      [1, true],
      [2, true],
      [9, true],
      [10, true],
      [11, false],
    ];
    for (const [value, accepted] of table) {
      expect(validateParams(all, { pattern: 'ok', count: value }).ok, `count=${value}`).toBe(accepted);
    }
  });

  it('1e400 из JSON — Infinity, то есть отказ not-finite', () => {
    const parsed = JSON.parse('{"count": 1e400}') as Record<string, unknown>;
    expect(parsed['count']).toBe(Number.POSITIVE_INFINITY);
    expect(codesOf(validateParams(all, { pattern: 'ok', ...parsed }))).toEqual(['not-finite']);
  });

  it('дробное при integer: true — not-integer', () => {
    expect(codesOf(validateParams(all, { pattern: 'ok', count: 2.5 }))).toEqual(['not-integer']);
  });

  it('enum сравнивается точно', () => {
    expect(validateParams(all, { pattern: 'ok', mode: 'fast' }).ok).toBe(true);
    expect(codesOf(validateParams(all, { pattern: 'ok', mode: 'Fast' }))).toEqual(['not-in-enum']);
  });

  it('maxLength считается по кодовым точкам, а не по единицам UTF-16', () => {
    // maxLength = 12. Строка из 11 эмодзи — 11 кодовых точек и 22 единицы UTF-16: подсчёт по
    // `length` объявил бы её слишком длинной.
    const emoji = prepare(
      { description: 'о', exec: ['/usr/bin/true'], params: { s: { type: 'string', pattern: '^.*$', maxLength: 12 } } },
      new Map([[matcherKey(NAME, 's'), permissive]]),
    );
    const eleven = '\u{1F600}'.repeat(11);
    expect(eleven.length).toBe(22);
    expect(validateParams(emoji, { s: eleven }).ok).toBe(true);
    expect(codesOf(validateParams(emoji, { s: '\u{1F600}'.repeat(13) }))).toEqual(['too-long']);
  });

  it('паттерн отбивает корпус A1 и не пропускает метасимволы', () => {
    expect(codesOf(validateParams(all, { pattern: 'v1; rm -rf /' }))).toEqual(['pattern-mismatch']);
  });
});

describe('validateParams — значение не покидает стадию в тексте отказа (R25)', () => {
  it('причина не содержит значения параметра', () => {
    // Значение короче `maxLength`: иначе первым сработал бы `too-long`, и трейс проверял бы
    // не ту ветку. Оно нарушает именно паттерн — пробел и `;` вне `[\w./-]`.
    const result = validateParams(all, { pattern: 'ZZmark; x' });
    expect(codesOf(result)).toEqual(['pattern-mismatch']);
    if (result.ok) return;
    expect(result.denials.map((one) => one.reason).join()).not.toContain('ZZmark');
    // Причина обязана называть нарушенное ограничение — этого требует сценарий S3.
    expect(result.denials[0].reason).toContain('паттерн');
  });
});

describe('validateParams — гейт канонизируемости на УСПЕШНОМ пути (R28)', () => {
  const weak = prepare(
    { description: 'о', exec: ['/usr/bin/true'], params: { p: { type: 'string', pattern: '^.{0,64}$' } } },
    new Map([[matcherKey(NAME, 'p'), permissive]]),
  );

  it('законный паттерн пропускает одиночный суррогат — гейт обязан его отвергнуть', () => {
    // Пара утверждений, потому что каждое по отдельности зелено при половинчатой правке:
    // сперва матчер действительно пропускает, потом гейт действительно отказывает.
    expect(permissive.test(`ab${LONE_HIGH}c`)).toBe(true);
    expect(codesOf(validateParams(weak, { p: `ab${LONE_HIGH}c` }))).toEqual(['not-canonicalizable']);
  });

  it('вердикт не зависит от строгости автора манифеста: строгий паттерн даёт тот же код', () => {
    // Матчер отвергает это значение сам, но код обязан остаться `not-canonicalizable`:
    // гейты стоят ДО `matcher.test`, иначе на слабом паттерне значение проехало бы в argv,
    // а на строгом отказ назывался бы не той причиной. Это и есть порядок из Ф12.
    expect(strict.test(`ab${LONE_HIGH}c`)).toBe(false);
    expect(codesOf(validateParams(all, { pattern: `ab${LONE_HIGH}c` }))).toEqual(['not-canonicalizable']);
  });

  it('успешный результат канонизируется — иначе вызов разрешён, а событие записать нельзя', () => {
    const result = validateParams(weak, { p: 'обычное значение' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => canonicalizeJcs(Object.fromEntries(result.values))).not.toThrow();
  });
});

describe('validateParams — абсолютный потолок длины (R30)', () => {
  // По вектору на КАЖДЫЙ тип, принимающий строку: потолок живёт в трёх функциях независимо,
  // и общий трейс на одном `string`-параметре пропустил бы `path` — ровно тот тип, ради
  // которого R30 и написан (у `PathParam` нет ни `pattern`, ни `maxLength`).
  const long = 'a'.repeat(VALUE_MAX_CODE_POINTS + 1);
  const wide = prepare(
    {
      description: 'о',
      exec: ['/usr/bin/true'],
      params: {
        s: { type: 'string', pattern: '^.*$' },
        m: { type: 'enum', values: ['fast'] },
        f: { type: 'path', root: './logs' },
      },
    },
    new Map([[matcherKey(NAME, 's'), permissive]]),
  );

  it('строка длиннее потолка отвергается в string, enum и path', () => {
    for (const key of ['s', 'm', 'f']) {
      expect(codesOf(validateParams(wide, { [key]: long })), key).toEqual(['value-oversized']);
    }
  });
});

describe('validateParams — потолок на список отказов (R30а)', () => {
  it('запрос с DENIALS_MAX + 50 неизвестными ключами даёт ограниченный список', () => {
    const many: Record<string, unknown> = { pattern: 'ok' };
    for (let i = 0; i < DENIALS_MAX + 50; i += 1) many[`k${String(i).padStart(4, '0')}`] = 1;

    const result = validateParams(all, many);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.denials).toHaveLength(DENIALS_MAX + 1);
    expect(result.denials.at(-1)?.code).toBe('denials-truncated');
    expect(result.denials.at(-1)?.reason).toContain(String(DENIALS_MAX + 50));
  });

  it('имя параметра из запроса усечено', () => {
    const key = 'k'.repeat(VALUE_MAX_CODE_POINTS * 2);
    const result = validateParams(all, { pattern: 'ok', [key]: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codePointLength(result.denials[0].paramName ?? '')).toBeLessThanOrEqual(VALUE_MAX_CODE_POINTS);
  });
});
