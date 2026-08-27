import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Исполняемая проверка заморозки (R31, R23).
 *
 * «Контракт заморожен» без этого теста — фраза в документе: любой новый экспорт уезжает
 * в семь эпиков молча. Снапшот берётся с `.d.ts` **всех трёх входов** и с файла схемы,
 * потому что схема тоже публикуется через `exports` и тоже часть поверхности.
 *
 * Снапшот хранится текстом, а не хэшем: при расхождении важно видеть, ЧТО именно уехало.
 * Обновляется он вместе с бампом `CONTRACTS_VERSION` и явным решением владельца — правило
 * записано в `docs/07-contracts.md`.
 */

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const distRoot = resolve(packageRoot, 'dist');

const ENTRIES = ['index.d.ts', 'validate/index.d.ts', 'audit/index.d.ts'];

/** Специфаеры `from '…'` и `import('…')` — es-module-lexer TS-синтаксис в `.d.ts` не разбирает. */
const specifiersOf = (source: string): string[] =>
  [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .filter((one): one is string => one !== undefined);

/** Все `.d.ts`, достижимые из входа. Порядок детерминированный — иначе снапшот флакает. */
function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) continue;
      queue.push(resolve(dirname(file), specifier.replace(/\.js$/, '.d.ts')));
    }
  }
  return [...seen].sort();
}

function currentApiSurface(): string {
  const files = new Set<string>();
  for (const entry of ENTRIES) for (const file of reachable(resolve(distRoot, entry))) files.add(file);

  const declarations = [...files].sort().map((file) => {
    const body = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('//# sourceMappingURL='))
      .join('\n')
      // Стиль кавычек в declaration emit не детерминирован: инкрементальная пересборка
      // переиспользует исходный узел и печатает `'…'`, полная — синтезирует и печатает `"…"`.
      // Замер: два подряд `tsc -b` дали разный `mcp.d.ts` при неизменном исходнике. Без
      // нормализации снапшот флакает на пустом месте, а флакающий гейт первым делом отключают.
      .replace(/"([^"\\\n]*)"/g, "'$1'")
      .trimEnd();
    return `// ==== ${relative(distRoot, file)} ====\n${body}`;
  });

  const schema = readFileSync(resolve(packageRoot, 'schema', 'mcpproxy.schema.json'), 'utf8').trimEnd();

  return `${declarations.join('\n\n')}\n\n// ==== schema/mcpproxy.schema.json ====\n${schema}\n`;
}

const SNAPSHOT = resolve(packageRoot, 'api-surface.snapshot.txt');

describe('публичная поверхность', () => {
  it('собрана — снапшот с пустого графа был бы зелёным на пустоте', () => {
    for (const entry of ENTRIES) expect(existsSync(resolve(distRoot, entry))).toBe(true);
  });

  it('совпадает с замороженным снапшотом', () => {
    // Сравнение с файлом делается вручную, а не через `toMatchFileSnapshot`: тот пропускает
    // содержимое через форматтер и переписывает кавычки в объявлениях, из-за чего снапшот
    // расходится с настоящим `.d.ts` на первом же перезапуске. Здесь сравнивается байт в байт.
    //
    // Обновляется намеренно и заметно: `UPDATE_API_SURFACE=1 yarn workspace @mcpproxy/contracts test`,
    // и только вместе с явным решением владельца — см. `docs/07-contracts.md`.
    const current = currentApiSurface();
    if (process.env.UPDATE_API_SURFACE === '1') {
      writeFileSync(SNAPSHOT, current);
      return;
    }
    expect(current).toBe(readFileSync(SNAPSHOT, 'utf8'));
  });
});
