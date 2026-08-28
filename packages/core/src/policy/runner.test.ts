import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Порт `packages/contracts/src/domain.test.ts:47` (R21).
 *
 * До этой задачи у `packages/core` не было ни скрипта `test`, ни конфига vitest, поэтому
 * корневой `yarn test` гонял только `contracts`, а гейт `build-test` был зелен на пустоте.
 *
 * Утверждение «обнаружен хотя бы один тестовый файл» из первой редакции было **декорацией**:
 * список строит `readdirSync` в этом же файле, и файл сам под него подходит, поэтому оно
 * истинно всегда, когда исполняется, и не ложно никогда. Измерено: удаление строки `include` из
 * `vitest.config.ts` — ровно того, что R21 объявляет поставкой, — оставляло все тесты
 * зелёными, потому что умолчание vitest совпадает по шаблону. Поэтому здесь проверяется сам
 * конфиг, а не пересказ его последствий. Число файлов по-прежнему не хардкодится.
 */

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const IGNORED = new Set(['node_modules', 'dist', '.git']);

const testFiles = readdirSync(packageRoot, { recursive: true, encoding: 'utf8' })
  .map((entry) => entry.split('/'))
  .filter((parts) => !parts.some((part) => IGNORED.has(part)))
  .filter((parts) => parts.at(-1)?.endsWith('.test.ts') === true);

// Конфиг читается текстом, а не импортируется: `rootDir` пакета — это `src`, и `tsc -b` не
// компилирует файл, лежащий выше. Утверждение всё равно падает ровно на той мутации, ради
// которой существует, — на удалении строки `include`.
const configText = readFileSync(fileURLToPath(new URL('../../vitest.config.ts', import.meta.url)), 'utf8');

describe('раннер', () => {
  it('include объявлен явно и покрывает весь src', () => {
    expect(configText).toMatch(/include:\s*\['src\/\*\*\/\*\.test\.ts'\]/);
  });

  it('не имеет тестов за пределами `src/`, куда не смотрит include', () => {
    const outside = testFiles.filter((parts) => parts[0] !== 'src').map((parts) => parts.join('/'));
    expect(outside).toEqual([]);
  });
});
