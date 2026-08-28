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

// Разделитель `/` жёсткий — как и всюду в этом дереве. Спека Windows не обещает, но здесь
// цена ограничения выше: падение этой проверки роняет команду `test` целиком, а не один тест.

/**
 * Комментарии срезаются ДО разбора, и это не украшение.
 *
 * Замерено на слиянии: комментарий в `vitest.config.ts`, объясняющий, что сужение `include`
 * до одного каталога уносит половину сюиты, содержит этот шаблон **как пример**, — и наивный
 * разбор вытащил пример вместо настоящего значения, объявив потерянными двадцать тестов E1
 * и E6. Сторож, который читает свою же документацию как конфиг, — не сторож.
 *
 * Срезка идёт ПОСТРОЧНО и трогает только строки, которые целиком являются комментарием.
 * Регулярка по всему тексту здесь неприменима, и это тоже замерено: `/**\/` внутри шаблона
 * `'src/**\/*.test.ts'` — синтаксически валидный блочный комментарий, и общая срезка
 * превращала значение в `'src*.test.ts'`, то есть ломала ровно ту строку, ради которой
 * читается файл.
 */
const withoutComments = (source) => {
  let inBlock = false;
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (inBlock) {
        if (trimmed.endsWith('*/')) inBlock = false;
        return false;
      }
      if (trimmed.startsWith('/*')) {
        inBlock = !trimmed.endsWith('*/');
        return false;
      }
      return !trimmed.startsWith('//');
    })
    .join('\n');
};

const config = withoutComments(readFileSync(resolve(packageRoot, 'vitest.config.ts'), 'utf8'));

// Обе формы кавычек: одинарные — стиль этого дерева, но конфиг с двойными валиден, и падение
// сторожа на нём выглядело бы как падение тестов. Замерено — так и было.
const listOf = (key) => {
  const block = new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`).exec(config);
  return block === null ? null : [...block[1].matchAll(/['"]([^'"]+)['"]/g)].map((one) => one[1]);
};

const patterns = listOf('include') ?? [];
// `exclude` читается по той же причине, по которой читается `include`: замерено, что одна
// строка `exclude: ['src/deps.test.ts', 'src/harness.test.ts']` при неизменном `include`
// уносит весь гейт границ пакета — 7 файлов вместо 9, код возврата 0 и у сторожа, и у vitest.
// Сторож, закрывающий одну дверь из двух, обещает больше, чем даёт.
const excluded = listOf('exclude') ?? [];

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
// Контроль самой срезалки: в коде значение видно, в комментарии — нет.
if (!/include/.test(withoutComments("export default { test: { include: ['x'] } };"))) {
  problems.push('срезалка комментариев съедает сам конфиг');
}
if (/include/.test(withoutComments("// пример: include: ['src/validate/**/*.test.ts']"))) {
  problems.push('срезалка комментариев не срезает комментарии — разбор возьмёт пример за значение');
}

const uncovered = testFiles.filter((path) => !patterns.some((pattern) => matches(pattern, path)));
for (const path of uncovered) problems.push(`${path} не попадает ни под один шаблон include — тест исчез бы молча`);

const dropped = testFiles.filter((path) => excluded.some((pattern) => matches(pattern, path)));
for (const path of dropped) problems.push(`${path} отсекается шаблоном exclude — тест исчез бы молча`);

if (problems.length > 0) {
  console.error('check-test-include: прогон неполон');
  for (const one of problems) console.error(`  - ${one}`);
  process.exit(1);
}
console.log(
  `check-test-include: ${testFiles.length} файл(ов) покрыты шаблонами [${patterns.join(', ')}]` +
    (excluded.length > 0 ? `, ни один не отсекается exclude [${excluded.join(', ')}]` : ''),
);
