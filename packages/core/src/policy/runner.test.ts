import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Порт `packages/contracts/src/domain.test.ts:47` (R21).
 *
 * До этой задачи у `packages/core` не было ни скрипта `test`, ни конфига vitest, поэтому
 * корневой `yarn test` гонял только `contracts`, а гейт `build-test` был зелен на пустоте.
 * Утверждения ниже ловят возврат в это состояние — пустой набор файлов и файл, положенный
 * мимо `include`. Число файлов не хардкодится: оно растёт каждой задачей E1.
 */

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const IGNORED = new Set(['node_modules', 'dist', '.git']);

const testFiles = readdirSync(packageRoot, { recursive: true, encoding: 'utf8' })
  .map((entry) => entry.split('/'))
  .filter((parts) => !parts.some((part) => IGNORED.has(part)))
  .filter((parts) => parts.at(-1)?.endsWith('.test.ts') === true);

describe('раннер', () => {
  it('обнаружил хотя бы один тестовый файл', () => {
    expect(testFiles.length).toBeGreaterThan(0);
  });

  it('не имеет тестов за пределами `src/`, куда не смотрит include', () => {
    const outside = testFiles.filter((parts) => parts[0] !== 'src').map((parts) => parts.join('/'));
    expect(outside).toEqual([]);
  });
});
