import { readdirSync } from 'node:fs';
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

/** Модули, у которых теста нет по существу, а не по недосмотру. */
const WITHOUT_TEST = new Set(['index.ts', 'api-surface.ts']);

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = resolve(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const files = walk(srcRoot).map((file) => relative(srcRoot, file).split('\\').join('/'));

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

  it('исключения из правила перечислены поимённо и существуют', () => {
    // Иначе список пополняется удалённым файлом и тихо разрешает следующий непокрытый модуль.
    for (const name of WITHOUT_TEST) expect(files).toContain(name);
  });

  it('каждый тест попадает под include из vitest.config.ts', () => {
    // Шаблон один — `src/**/*.test.ts`. Тест, положенный мимо, исчезает без единого слова.
    const tests = files.filter((file) => file.endsWith('.test.ts'));
    expect(tests.length).toBeGreaterThan(5);
    expect(tests.filter((file) => file.startsWith('..'))).toEqual([]);
  });
});
