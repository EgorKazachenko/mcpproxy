import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, parse } from 'es-module-lexer';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateCall } from './validate/index.js';
import type { PreparedRecipe } from './validate/index.js';

/**
 * Исполняемые границы пакета (R1, R3, R5, R35).
 *
 * Обход именно графа, а не списка файлов: `tsc` эмитит пофайлово, и `dist/` содержит модули,
 * до которых из корневого входа не дойти ни одним импортом. Заявление касается достижимости.
 */

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const distRoot = resolve(packageRoot, 'dist');
const validateSrc = resolve(packageRoot, 'src', 'validate');

/**
 * БЕЛЫЙ список, а не чёрный (R1). Чёрный здесь не работает: обход записывает голый специфаер
 * и внутрь пакета не заходит, поэтому правдоподобный регресс
 * `import … from '@mcpproxy/contracts/validate'` (тянущий `ajv`, `yaml`, `re2`) не попал бы ни
 * под одно запрещённое имя. Белый закрывает и это, и `electron`, и любую будущую зависимость
 * одним утверждением.
 */
const ALLOWED = new Set(['@mcpproxy/contracts', 'node:path', 'node:fs']);

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
  return [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .filter((n): n is string => n !== undefined);
}

describe('граф зависимостей корневого входа (R1)', () => {
  beforeAll(async () => {
    await init;
  });

  it('собран — иначе тест проходит на пустом графе', () => {
    // Позитивный контроль. Без него обход вернул бы пустое множество, то есть тест был бы
    // зелёным ровно тогда, когда проверять нечего, — дефект, который в E0 уже чинили.
    expect(existsSync(resolve(distRoot, 'index.js'))).toBe(true);
    const { files, bare } = walk(resolve(distRoot, 'index.js'), '.js');
    expect(files.length).toBeGreaterThan(1);
    expect(bare).toContain('@mcpproxy/contracts');
  });

  it('рантайм-граф — подмножество белого списка', () => {
    const { bare } = walk(resolve(distRoot, 'index.js'), '.js');
    expect(bare.filter((one) => !ALLOWED.has(one))).toEqual([]);
  });

  it('граф деклараций тоже собран — иначе проверка ниже пуста', () => {
    // У `.js`-половины контроль на непустоту есть, у `.d.ts`-половины извлечение специфаеров
    // своё — регулярка, а не es-module-lexer, — и без контроля обход посещал бы один файл.
    expect(walk(resolve(distRoot, 'index.d.ts'), '.d.ts').files.length).toBeGreaterThan(1);
  });

  it('граф деклараций — тоже подмножество белого списка', () => {
    // Потребитель обязан компилироваться: тип, протёкший в декларацию, ломает сборку так же,
    // как импорт в рантайме.
    const { bare } = walk(resolve(distRoot, 'index.d.ts'), '.d.ts');
    expect(bare.filter((one) => !ALLOWED.has(one))).toEqual([]);
  });

  it('в графе нет re2, ajv, yaml и Electron — следствие белого списка, названное явно', () => {
    const js = walk(resolve(distRoot, 'index.js'), '.js').bare;
    const dts = walk(resolve(distRoot, 'index.d.ts'), '.d.ts').bare;
    for (const forbidden of ['re2', 'ajv', 'yaml', 'electron', '@mcpproxy/contracts/validate']) {
      expect([...js, ...dts], forbidden).not.toContain(forbidden);
    }
  });
});

/**
 * Комментарии срезаются до скана: объяснение «почему здесь НЕ вызывается конструктор» —
 * ценный текст, и запрещать его значит запрещать документацию правила вместо самого нарушения.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('сорс-скан: конструктор регулярных выражений (R3, исполняемая часть)', () => {
  // Блоклист импортов этого не ловит: имя, о котором речь, — глобал, а не импорт.
  const files = readdirSync(validateSrc, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => resolve(validateSrc, entry));

  const CONSTRUCTOR_CALL = /\bnew\s+RegExp\b|\bRegExp\s*\(/;

  it('обход действительно что-то видит', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('срезалка комментариев работает — иначе скан ниже зелен на чём угодно', () => {
    // Позитивный контроль самой срезалки: в коде находим, в комментарии — нет.
    expect(CONSTRUCTOR_CALL.test(withoutComments('const r = new RegExp("x");'))).toBe(true);
    expect(CONSTRUCTOR_CALL.test(withoutComments('// не вызываем new RegExp здесь'))).toBe(false);
    expect(CONSTRUCTOR_CALL.test(withoutComments('/** тут про new RegExp */'))).toBe(false);
  });

  it('ни один модуль validate не вызывает конструктор — только литеральные регулярки', () => {
    const offenders = files.filter((file) => CONSTRUCTOR_CALL.test(withoutComments(readFileSync(file, 'utf8'))));
    expect(offenders.map((one) => one.slice(packageRoot.length))).toEqual([]);
  });
});

// ── Уровня типа: форма входа E2 (R5, И5).

// `validateCall` принимает ровно два аргумента. Третьего, которым можно было бы передать
// каталог, argv, бинарь или профиль, не существует.
type CallArgs = Parameters<typeof validateCall>;
type ExactlyTwo = CallArgs['length'] extends 2 ? true : never;
const _twoArguments: ExactlyTwo = true;
void _twoArguments;

// `PreparedRecipe` не несёт поля `sandbox` вовсе — третий член R22 вакуумен по построению:
// подставить в профиль нечего и неоткуда.
type PreparedExtraKeys = Exclude<keyof PreparedRecipe, 'recipeName' | 'params' | 'cwd' | 'exec'>;
const _preparedClosed: [PreparedExtraKeys] extends [never] ? true : PreparedExtraKeys = true;
void _preparedClosed;
