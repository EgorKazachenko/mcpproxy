import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asRecipeName, type PatternMatcher, type Recipe } from '@mcpproxy/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedValues } from './denial.js';
import { buildArgv, buildArgvWithOrigin } from './argv.js';
import { validateParams } from './params.js';
import { resolvePaths } from './paths.js';
import { prepareRecipe, type PreparedRecipe } from './prepare.js';

const NAME = asRecipeName('run_tests');
const DIR = '/home/u/proj';
const NO_MATCHERS: ReadonlyMap<string, PatternMatcher> = new Map();

function prepare(recipe: Recipe, matchers: ReadonlyMap<string, PatternMatcher> = NO_MATCHERS): PreparedRecipe {
  const result = prepareRecipe(NAME, recipe, matchers, DIR);
  if (!result.ok) throw new Error(`фикстура не подготовилась: ${result.problems.join('; ')}`);
  return result.prepared;
}

/** Прогон всех трёх стадий: карты `ValidatedValues` и `ResolvedValues` чеканят только они. */
function argvOf(prepared: PreparedRecipe, params: Readonly<Record<string, unknown>>): readonly string[] {
  const validated = validateParams(prepared, params);
  if (!validated.ok) throw new Error(`validate: ${validated.denials.map((one) => one.code).join()}`);
  const resolved = resolvePaths(prepared, validated.values);
  if (!resolved.ok) throw new Error(`resolve_paths: ${resolved.denials.map((one) => one.code).join()}`);
  return buildArgv(prepared, resolved.values);
}

describe('buildArgv — значение отдельным элементом (R20)', () => {
  const prepared = prepare({
    description: 'о',
    exec: ['/usr/bin/true'],
    params: { s: { type: 'enum', values: ['a b'], argv: ['--flag', '{}'] } },
  });

  it('элементы шаблона не склеиваются в одну строку', () => {
    // Утверждаются ОБА элемента по отдельности, а не `join(' ')`: склеенная строка и
    // правильная пара дают одинаковый `join`, и трейс на нём не сработал бы ни при какой мутации.
    const argv = argvOf(prepared, { s: 'a b' });
    expect(argv).toHaveLength(3);
    expect(argv.at(-2)).toBe('--flag');
    expect(argv.at(-1)).toBe('a b');
  });
});

describe('buildArgv — порядок объявления (R19)', () => {
  it('обход идёт по объявлению, а не по алфавиту', () => {
    // Алфавитный порядок ПРОТИВОПОЛОЖЕН порядку объявления, поэтому сортировка ключей не
    // совпала бы случайно. Утверждается позиция каждого.
    const prepared = prepare({
      description: 'о',
      exec: ['/usr/bin/true'],
      params: {
        zebra: { type: 'enum', values: ['z'], argv: ['--zebra={}'] },
        alpha: { type: 'enum', values: ['a'], argv: ['--alpha={}'] },
      },
    });

    expect(argvOf(prepared, { zebra: 'z', alpha: 'a' })).toEqual(['/usr/bin/true', '--zebra=z', '--alpha=a']);
  });
});

describe('buildArgv — в exec не подставляется ничего (R22, И2)', () => {
  it('слот в exec возвращается дословно', () => {
    // `prepareRecipe` такой рецепт отвергает, поэтому `PreparedRecipe` здесь собран руками:
    // трейс проверяет поведение `buildArgv` на нарушенном входе, а не чужой инвариант.
    // Каст здесь — И ЕСТЬ предмет трейса: `PreparedRecipe` брендирован, и собрать его мимо
    // `prepareRecipe` можно только явно объявив, что правило обходится намеренно.
    const hostile = {
      recipeName: NAME,
      params: [{ kind: 'enum', name: 's', required: false, argv: ['--s={}'], values: ['v'] }],
      cwd: DIR,
      exec: ['sh', '-c', '{}'],
    } as unknown as PreparedRecipe;
    const values = new Map([['s', 'v']]) as unknown as ResolvedValues;

    const argv = buildArgv(hostile, values);
    expect(argv.slice(0, 3)).toEqual(['sh', '-c', '{}']);
    expect(argv.at(-1)).toBe('--s=v');
  });
});

describe('buildArgv — boolean раскрывается присутствием (R21)', () => {
  const prepared = prepare({
    description: 'о',
    exec: ['/usr/bin/true'],
    params: { verbose: { type: 'boolean', argv: ['--verbose'] } },
  });

  it('true добавляет элементы, false не добавляет ничего, отсутствие — тоже', () => {
    expect(argvOf(prepared, { verbose: true })).toEqual(['/usr/bin/true', '--verbose']);
    expect(argvOf(prepared, { verbose: false })).toEqual(['/usr/bin/true']);
    expect(argvOf(prepared, {})).toEqual(['/usr/bin/true']);
  });
});

describe('buildArgv — строковое представление числа', () => {
  const prepared = prepare({
    description: 'о',
    exec: ['/usr/bin/true'],
    params: { n: { type: 'number', argv: ['--n={}'] } },
  });

  it('целое не уезжает в экспоненциальную запись', () => {
    // `String(1e21)` даёт `'1e+21'` (Ф13) — скрипт получил бы экспоненту вместо числа.
    expect(String(1e21)).toBe('1e+21');
    expect(argvOf(prepared, { n: 1e21 }).at(-1)).toBe('--n=1000000000000000000000');
  });

  it('-0 и дробное сохраняют кратчайшее round-trip-представление', () => {
    expect(argvOf(prepared, { n: -0 }).at(-1)).toBe('--n=0');
    expect(argvOf(prepared, { n: 0.1 + 0.2 }).at(-1)).toBe('--n=0.30000000000000004');
  });
});

describe('buildArgv — подстановка не интерпретирует подставляемое (R20а)', () => {
  let base = '';
  let root = '';
  let prepared: PreparedRecipe;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'e2-argv-'));
    root = join(base, 'logs');
    mkdirSync(root);
    // Законные имена файлов: у `path`-параметра нет ни `pattern`, ни `maxLength`, так что
    // `$` в имени не фильтрует никто. Дефект проявляется на ЗАКОННОМ имени, а не как вектор.
    writeFileSync(join(root, "a$'b.log"), 'x');
    writeFileSync(join(root, 'a$`b.log'), 'x');

    prepared = prepare({
      description: 'о',
      exec: ['/usr/bin/wc'],
      params: { file: { type: 'path', root, argv: ['--file={}'] } },
    });
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("файл a$'b.log попадает в argv резолвнутым путём байт в байт", () => {
    // С наивным `replace` argv несёт `ab.log` — другой и несуществующий путь (Ф17).
    const argv = argvOf(prepared, { file: "a$'b.log" });
    expect(argv.at(-1)).toBe(`--file=${realpathSync(join(root, "a$'b.log"))}`);
  });

  it('файл a$`b.log — тоже, и это ДРУГАЯ порча', () => {
    // Наивная подстановка вклеивает в значение сам префикс `--file=`: `$\`` означает
    // «текст до совпадения». Оба вектора нужны — трейс на одном пропустил бы другой.
    const argv = argvOf(prepared, { file: 'a$`b.log' });
    expect(argv.at(-1)).toBe(`--file=${realpathSync(join(root, 'a$`b.log'))}`);
    expect(argv.at(-1)).not.toContain('--file=--file=');
  });
});

describe('buildArgvWithOrigin — происхождение элементов команды (AuditEvent.argvFromParams)', () => {
  /** Тот же прогон трёх стадий, но с сохранённым происхождением. */
  function builtOf(prepared: PreparedRecipe, params: Readonly<Record<string, unknown>>) {
    const validated = validateParams(prepared, params);
    if (!validated.ok) throw new Error(`validate: ${validated.denials.map((one) => one.code).join()}`);
    const resolved = resolvePaths(prepared, validated.values);
    if (!resolved.ok) throw new Error(`resolve_paths: ${resolved.denials.map((one) => one.code).join()}`);
    return buildArgvWithOrigin(prepared, resolved.values);
  }

  const prepared = prepare({
    description: 'о',
    exec: ['/usr/bin/true', 'test'],
    params: {
      pattern: { type: 'enum', values: ['auth'], argv: ['--filter', '{}'] },
      update: { type: 'boolean', argv: ['-u'] },
    },
  });

  it('индекс указывает на ЗНАЧЕНИЕ, а не на флаг рядом с ним', () => {
    const built = builtOf(prepared, { pattern: 'auth' });
    expect(built.argv).toEqual(['/usr/bin/true', 'test', '--filter', 'auth']);
    // Флаг `--filter` написан автором рецепта и накрыт хэшем lock; снаружи пришло только `auth`.
    expect(built.fromParams).toEqual([3]);
  });

  it('булев параметр индексов не даёт: текст его элементов целиком из манифеста', () => {
    const built = builtOf(prepared, { update: true });
    expect(built.argv).toEqual(['/usr/bin/true', 'test', '-u']);
    expect(built.fromParams).toEqual([]);
  });

  it('вызов без подстановок даёт пустой список, а не отсутствие поля', () => {
    expect(builtOf(prepared, {}).fromParams).toEqual([]);
  });

  it('индексы удовлетворяют инварианту контракта на СВОЁМ argv', () => {
    const built = builtOf(prepared, { pattern: 'auth', update: true });
    expect(new Set(built.fromParams).size).toBe(built.fromParams.length);
    for (const index of built.fromParams) {
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(built.argv.length);
    }
  });

  it('buildArgv — та же команда, что и у версии с происхождением', () => {
    expect(buildArgv(prepared, resolvePathsFor(prepared, { pattern: 'auth' }))).toEqual(
      builtOf(prepared, { pattern: 'auth' }).argv,
    );
  });

  /** Карта резолва для сверки двух входов: считать её дважды в одном тесте незачем. */
  function resolvePathsFor(one: PreparedRecipe, params: Readonly<Record<string, unknown>>): ResolvedValues {
    const validated = validateParams(one, params);
    if (!validated.ok) throw new Error('фикстура не прошла валидацию');
    const resolved = resolvePaths(one, validated.values);
    if (!resolved.ok) throw new Error('фикстура не прошла резолв');
    return resolved.values;
  }
});
