import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Сверяет `include` из `vitest.config.ts` с тем, что лежит на диске (R34).
 *
 * Это НЕ тест, и это существенно. Утверждение внутри `*.test.ts` такую проверку выразить не
 * может по построению: сужение `include` первым делом уносит сам файл со сторожем. Замерено —
 * `include: ['src/validate/**\/*.test.ts']` даёт 99 зелёных тестов и код возврата 0, молча
 * потеряв `harness.test.ts` и `deps.test.ts`, то есть весь исполняемый гейт границ пакета.
 * Поэтому сторож стоит ДО vitest, в самой команде `test`, где сужением шаблона его не достать.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IGNORED = new Set(['node_modules', 'dist', '.git', 'scripts']);

const config = readFileSync(resolve(packageRoot, 'vitest.config.ts'), 'utf8');
const block = /include:\s*\[([^\]]*)\]/.exec(config);
const patterns = block === null ? [] : [...block[1].matchAll(/'([^']+)'/g)].map((one) => one[1]);

const testFiles = readdirSync(packageRoot, { recursive: true, encoding: 'utf8' })
  .map((entry) => entry.split('/'))
  .filter((parts) => !parts.some((part) => IGNORED.has(part)))
  .filter((parts) => parts.at(-1)?.endsWith('.test.ts') === true)
  .map((parts) => parts.join('/'));

/** Достаточный для этих шаблонов перевод глоба: `**​/` — любой префикс каталогов, `*` — сегмент. */
const matches = (pattern, path) => {
  const source = pattern
    .split('**/')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('(?:.*/)?');
  return new RegExp(`^${source}$`).test(path);
};

const problems = [];
// Позитивный контроль: без него проверка зелена на пустоте — ровно тот дефект, ради которого
// она и существует.
if (patterns.length === 0) problems.push('в vitest.config.ts не найден непустой include');
if (testFiles.length === 0) problems.push('на диске не найдено ни одного *.test.ts');

const uncovered = testFiles.filter((path) => !patterns.some((pattern) => matches(pattern, path)));
for (const path of uncovered) problems.push(`${path} не попадает ни под один шаблон include — тест исчез бы молча`);

if (problems.length > 0) {
  console.error('check-test-include: прогон неполон');
  for (const one of problems) console.error(`  - ${one}`);
  process.exit(1);
}
console.log(`check-test-include: ${testFiles.length} файл(ов) покрыты шаблонами [${patterns.join(', ')}]`);
