import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * R25 — проверка, что тесты вообще запускаются.
 *
 * У `core` до этого эпика не было ни `vitest.config.ts`, ни скрипта `test`, поэтому корневой
 * `yarn test` (`workspaces foreach -Ap run test`) пропускал пакет молча, а `build-test`
 * докладывал зелёный ни на чём. Этот файл превращает «тесты есть» в утверждение.
 */

const srcRoot = fileURLToPath(new URL('.', import.meta.url));
const packageRoot = resolve(srcRoot, '..');

/**
 * Модули, у которых теста нет по существу, а не по недосмотру.
 *
 * Список **сверяется в обе стороны**: имя, которого на диске нет, роняет тест. Иначе он
 * протухает — `api-surface.ts` лежал здесь при живом `api-surface.test.ts`, то есть удаление
 * этого теста гейт покрытия не заметил бы.
 */
const WITHOUT_TEST = new Map<string, string>([
  ['index.ts', 'баррель корневого входа: его содержимое утверждают снапшот поверхности и deps.test.ts'],
  ['audit/index.ts', 'баррель входа ./audit: то же самое, плюс отдельная проверка отсутствия re2'],
]);

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = resolve(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const files = walk(srcRoot).map((file) => relative(srcRoot, file).split('\\').join('/'));

/**
 * Шаблоны `include` берутся ИЗ КОНФИГА, а не повторяются здесь.
 *
 * Прошлая версия этого теста утверждала «ни один путь не начинается с `..`» — тавтология,
 * истинная по построению `relative()`. При сужении `include` до одного каталога тихо терялся
 * бы 151 тест из 166, а файл оставался бы зелёным: гейт «тесты запускаются» не читал
 * `vitest.config.ts` вовсе.
 */
const includeGlobs = (): string[] => {
  const config = readFileSync(resolve(packageRoot, 'vitest.config.ts'), 'utf8');
  const block = /include:\s*\[([^\]]*)\]/.exec(config)?.[1] ?? '';
  return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]).filter((one): one is string => one !== undefined);
};

/** `src/**\/*.test.ts` → регулярка. Поддержаны ровно те конструкции, что есть в конфиге. */
const globToRegExp = (glob: string): RegExp => {
  const source = glob
    .split('/')
    .map((segment) => {
      if (segment === '**') return '(?:.*)';
      return segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    })
    .join('/')
    .replace(/\(\?:\.\*\)\//g, '(?:.*/)?');
  return new RegExp(`^${source}$`);
};

describe('покрытие пакета тестами', () => {
  it('исходники вообще найдены — обход по пустому каталогу зелёный на пустоте', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('у каждого модуля есть файл теста рядом', () => {
    const modules = files.filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'));
    const uncovered = modules
      .filter((file) => !WITHOUT_TEST.has(file))
      .filter((file) => !files.includes(file.replace(/\.ts$/, '.test.ts')));

    expect(uncovered).toEqual([]);
  });

  it('исключения перечислены поимённо, существуют и НЕ имеют теста', () => {
    for (const [name] of WITHOUT_TEST) {
      expect(files, `${name} в списке исключений, но на диске его нет`).toContain(name);
      expect(
        files.includes(name.replace(/\.ts$/, '.test.ts')),
        `${name} в списке исключений, хотя тест у него есть — список протух`,
      ).toBe(false);
    }
  });

  it('T1: include из vitest.config.ts покрывает КАЖДЫЙ тест на диске', () => {
    const globs = includeGlobs();
    expect(globs.length).toBeGreaterThan(0);

    const patterns = globs.map(globToRegExp);
    const tests = files.filter((file) => file.endsWith('.test.ts'));
    expect(tests.length).toBeGreaterThan(5);

    const missed = tests.filter((file) => !patterns.some((pattern) => pattern.test(`src/${file}`)));
    expect(missed).toEqual([]);
  });

  it('T1: и сама эта проверка способна покраснеть — сужённый include теряет тесты', () => {
    // Положительный контроль. Без него «ни один тест не потерялся» неотличимо от
    // «сопоставление всегда истинно», а это ровно тот дефект, который тут и был.
    const narrow = globToRegExp('src/env/*.test.ts');
    const tests = files.filter((file) => file.endsWith('.test.ts'));
    expect(tests.some((file) => !narrow.test(`src/${file}`))).toBe(true);
    expect(tests.some((file) => narrow.test(`src/${file}`))).toBe(true);
  });
});
