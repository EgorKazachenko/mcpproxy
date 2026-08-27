import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * R34: до этой задачи у пакета не было ключа `test` вовсе, а корневой скрипт —
 * `yarn workspaces foreach -Ap run test`, то есть воркспейс без `test` пропускался **молча**
 * и любой зелёный прогон по `core` ничего не значил. Утверждения ниже ловят возврат в это
 * состояние: пустой набор файлов и файл, положенный мимо `include`.
 */
describe('раннер', () => {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const IGNORED = new Set(['node_modules', 'dist', '.git']);

  const testFiles = readdirSync(packageRoot, { recursive: true, encoding: 'utf8' })
    .map((entry) => entry.split('/'))
    .filter((parts) => !parts.some((part) => IGNORED.has(part)))
    .filter((parts) => parts.at(-1)?.endsWith('.test.ts') === true);

  it('обнаружил хотя бы один тестовый файл', () => {
    expect(testFiles.length).toBeGreaterThan(0);
  });

  it('не имеет тестов за пределами `src/`, куда не смотрит include', () => {
    const outside = testFiles.filter((parts) => parts[0] !== 'src').map((parts) => parts.join('/'));
    expect(outside).toEqual([]);
  });

  it('каждый файл на диске попадает хотя бы под один шаблон include из vitest.config.ts', () => {
    // Утверждение выше ловит только перенос файла ВЫШЕ `src/`. Сужение самого шаблона внутри
    // `src/` оно не видит, потому что строка `src/` вписана в тест руками: замерено, что
    // `include: ['src/validate/**/*.test.ts']` даёт 7 файлов и 87 тестов, код возврата 0, —
    // молча исчезают и этот сторож, и `deps.test.ts`, то есть весь гейт границ пакета.
    // Поэтому граница берётся из самого конфига, а не дублируется здесь.
    //
    // Конфиг читается как текст, а не импортируется: он лежит вне `rootDir: src`, и импорт
    // вынес бы его в сборку пакета.
    const config = readFileSync(new URL('../vitest.config.ts', import.meta.url), 'utf8');
    const includeBlock = /include:\s*\[([^\]]*)\]/.exec(config);
    expect(includeBlock, 'в vitest.config.ts не найден include').not.toBeNull();

    const patterns = [...(includeBlock?.[1] ?? '').matchAll(/'([^']+)'/g)].map((one) => one[1] ?? '');
    expect(patterns.length).toBeGreaterThan(0);

    // Достаточный для этих шаблонов перевод глоба в регулярку: `**/` — любой префикс каталогов,
    // `*` — сегмент без разделителя.
    const matches = (pattern: string, path: string): boolean => {
      const source = pattern
        .split('**/')
        .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
        .join('(?:.*/)?');
      return new RegExp(`^${source}$`).test(path);
    };

    const uncovered = testFiles
      .map((parts) => parts.join('/'))
      .filter((path) => !patterns.some((pattern) => matches(pattern, path)));
    expect(uncovered).toEqual([]);
  });
});
