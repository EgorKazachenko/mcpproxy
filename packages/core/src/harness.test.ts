import { readdirSync } from 'node:fs';
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
});
