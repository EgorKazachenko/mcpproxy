import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, parse } from 'es-module-lexer';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Исполняемая проверка архитектурного заявления: корневой вход не тянет валидатор и
 * `node:crypto` в рантайм, а его декларации не ссылаются на чужие типы (R3, Ф6).
 *
 * Обход именно графа, а не списка файлов: `tsc` эмитит пофайлово, и `dist/` содержит модули,
 * до которых из корневого входа не дойти ни одним импортом. Заявление касается достижимости.
 */

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const distRoot = resolve(packageRoot, 'dist');

const FORBIDDEN_IN_ROOT = ['ajv', 'yaml', 're2', 'node:crypto', '@modelcontextprotocol/sdk'];

/** Достижимые из входа файлы и голые (не относительные) специфаеры, которые они импортируют. */
function walk(entry: string, extension: '.js' | '.d.ts'): { files: string[]; bare: string[] } {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);

    const source = readFileSync(file, 'utf8');
    for (const specifier of specifiersOf(source, extension)) {
      if (!specifier.startsWith('.')) {
        bare.add(specifier);
        continue;
      }
      const target = resolve(dirname(file), specifier.replace(/\.js$/, extension));
      if (existsSync(target)) queue.push(target);
    }
  }

  return { files: [...seen], bare: [...bare] };
}

function specifiersOf(source: string, extension: '.js' | '.d.ts'): string[] {
  if (extension === '.js') {
    const [imports] = parse(source);
    return imports.map((one) => one.n).filter((n): n is string => n !== undefined);
  }
  // `.d.ts` es-module-lexer не разбирает: там живёт TS-синтаксис, которого он не знает.
  // Регулярка снимает ровно то, что интересно, — специфаеры `from '…'` и `import('…')`.
  return [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .filter((n): n is string => n !== undefined);
}

describe('граф зависимостей корневого входа', () => {
  beforeAll(async () => {
    await init;
  });

  it('собран — иначе тест проходит на пустом графе', () => {
    // На чистом клоне `dist/` нет, и без этого утверждения обход вернул бы пустое множество,
    // то есть тест был бы зелёным ровно тогда, когда проверять нечего.
    expect(existsSync(resolve(distRoot, 'index.js'))).toBe(true);
    expect(walk(resolve(distRoot, 'index.js'), '.js').files.length).toBeGreaterThan(1);
  });

  it('не тянет ajv, yaml, re2 и node:crypto в рантайм', () => {
    const { bare } = walk(resolve(distRoot, 'index.js'), '.js');
    expect(bare.filter((one) => FORBIDDEN_IN_ROOT.includes(one))).toEqual([]);
  });

  it('не ссылается на них и в .d.ts', () => {
    // Потребитель, не установивший валидатор, обязан компилироваться: одного лишь чистого
    // рантайм-графа для этого мало — тип, протёкший в декларацию, ломает сборку так же.
    const { bare } = walk(resolve(distRoot, 'index.d.ts'), '.d.ts');
    expect(bare.filter((one) => FORBIDDEN_IN_ROOT.includes(one))).toEqual([]);
  });

  it('вход ./validate, наоборот, обязан их тянуть — иначе проверка выше ничего не значит', () => {
    const { bare } = walk(resolve(distRoot, 'validate', 'index.js'), '.js');
    expect(bare).toContain('yaml');
    expect(bare).toContain('re2');
    expect(bare.some((one) => one.startsWith('ajv'))).toBe(true);
  });

  it('вход ./audit тянет node:crypto — и только его', () => {
    // Правило размещения из Task 8: функция, которой нужен node:crypto, живёт в ./audit.
    // Утверждение «и только его» держит границу с другой стороны: валидатор сюда не заезжает.
    const { bare } = walk(resolve(distRoot, 'audit', 'index.js'), '.js');
    expect(bare).toEqual(['node:crypto']);
  });
});
