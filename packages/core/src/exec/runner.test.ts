import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Страховка от возврата в состояние, в котором пакет жил до E3: тест-раннера у `core` не
 * было вовсе, и корневой `yarn test` выходил для него с нулём, **не запустив ничего**.
 *
 * Форма — копия `packages/contracts/src/domain.test.ts:47-66`. Файлы читаются с диска
 * `readdirSync`, а не берутся у vitest: утверждение обязано быть независимо от того, что
 * нашёл раннер, иначе оно проверяет раннер его же собственными глазами.
 */
describe('раннер', () => {
  const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
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
