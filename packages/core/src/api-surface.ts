import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Снимок публичной поверхности пакета (R26).
 *
 * Тот же приём, что в `contracts`, и по той же причине: `core/src/index.ts` — контрактная
 * поверхность в смысле `review-bc`, её импортируют E3, E4 и E7, и новый экспорт уезжает к
 * ним молча. Разница одна — файла схемы у `core` нет.
 *
 * Оба входа пакета попадают в снапшот: подпуть `./audit` тоже публичен и тоже заморожен.
 *
 * Модуль **не** экспортируется из `index.ts`: он инструмент гейта, а не контракт, и потому
 * в собственный снапшот не попадает. Обновляет снапшот только `scripts/update-api-surface.mjs`;
 * тест умеет лишь сверять. Гейт, способный одобрить сам себя из переменной окружения, гейтом
 * не является — в E0 это уже ловили.
 */

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
export const distRoot = resolve(packageRoot, 'dist');

const ENTRIES = ['index.d.ts', 'audit/index.d.ts'];

/**
 * Специфаеры `from '…'` и `import('…')`: es-module-lexer TS-синтаксис в `.d.ts` не разбирает.
 *
 * Экспортируется, чтобы `deps.test.ts` не держал третью копию этой регулярки. Модуль
 * намеренно вне `index.ts`, поэтому публичная поверхность и снапшот от экспорта не двигаются.
 */
export const specifiersOf = (source: string): string[] =>
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

export function currentApiSurface(): string {
  const files = new Set<string>();
  for (const entry of ENTRIES) for (const file of reachable(resolve(distRoot, entry))) files.add(file);

  const declarations = [...files].sort().map((file) => {
    const body = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('//# sourceMappingURL='))
      .join('\n')
      // Стиль кавычек в declaration emit не детерминирован: инкрементальная пересборка
      // переиспользует исходный узел, полная — синтезирует. В E0 это дало разный `.d.ts`
      // на двух подряд `tsc -b` при неизменном исходнике, то есть флакающий гейт.
      .replace(/"([^"\\\n]*)"/g, "'$1'")
      .trimEnd();
    return `// ==== ${relative(distRoot, file)} ====\n${body}`;
  });

  return `${declarations.join('\n\n')}\n`;
}

export const API_SURFACE_SNAPSHOT = resolve(packageRoot, 'api-surface.snapshot.txt');
export const API_SURFACE_ENTRIES = ENTRIES;
