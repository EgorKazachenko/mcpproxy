import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, parse } from 'es-module-lexer';
import { beforeAll, describe, expect, it } from 'vitest';
import { specifiersOf as declarationSpecifiers } from './api-surface.js';

/**
 * R27 — исполняемая проверка двух архитектурных заявлений о `core`:
 *
 * 1. **Electron сюда не заезжает** (ADR-0001). Ядро обязано работать в демоне без GUI;
 *    транзитивный `electron` в графе превращает headless-запуск в падение при старте.
 * 2. **Второй точки загрузки манифеста в ядре нет.**
 *
 *    В редакции E6 это правило было записано как «`@mcpproxy/contracts/validate` сюда не
 *    заезжает», и до прихода E1 формулировка совпадала со смыслом. С приходом E1 — перестала:
 *    E1 и ЕСТЬ загрузчик манифеста, санкционированный R1, и валидатор ему нужен по существу.
 *    Оставь мы запрет по букве — он потребовал бы либо спрятать E1 из корневого входа, либо
 *    завести загрузку мимо `parseManifest`, то есть ровно ту вторую точку, против которой
 *    правило и написано.
 *
 *    Поэтому запрет **сужен до своего смысла**: валидатор в графе разрешён, а «загрузка ровно
 *    одна» держится исполняемым сканом `policy/boundary.test.ts` — `parseManifest` не
 *    вызывается нигде в `core/src` вне `policy/store.ts`, и `JSON.parse` над текстом lock не
 *    появляется в `policy/**` и `bin/**`. Это сильнее прежней проверки: та запрещала импорт,
 *    эта запрещает вызов, включая вызов через уже разрешённый импорт.
 *
 *    `ajv` и `yaml` остаются запрещёнными: их ядро не импортирует напрямую ни при каком
 *    сценарии — они приезжают внутрь `@mcpproxy/contracts/validate`, за его границей.
 *
 * Обходится **граф достижимости**, а не список файлов: `tsc` эмитит пофайлово, и в `dist/`
 * лежат модули, до которых из входа не дойти ни одним импортом. Заявление — про достижимость.
 */

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const distRoot = resolve(packageRoot, 'dist');

const FORBIDDEN = ['electron', 'ajv', 'yaml'];

/**
 * R24 — у ядра нет сетевых зависимостей вовсе.
 *
 * Проверка стоит именно тут, а не рядом с экспортом: «экспорт ничего не отправляет» —
 * утверждение о графе, а не о теле одной функции. Тест на функцию доказывал бы, что ОНА не
 * шлёт, и молчал бы про модуль, который кто-то добавит рядом. Журнал аудита — самый
 * привлекательный кандидат на «а давайте сразу в SIEM», и это должно быть заметным решением.
 */
const NETWORK = ['node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram', 'http', 'https', 'net'];

function walk(entry: string, extension: '.js' | '.d.ts'): { files: string[]; bare: string[] } {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);

    for (const specifier of specifiersOf(readFileSync(file, 'utf8'), extension)) {
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
  // Регулярка не набирается здесь в третий раз — она одна, в `api-surface.ts`.
  return declarationSpecifiers(source);
}

describe('граф зависимостей core', () => {
  beforeAll(async () => {
    await init;
  });

  it('собран — иначе проверки ниже зелены на пустом множестве', () => {
    expect(existsSync(resolve(distRoot, 'index.js'))).toBe(true);
    expect(walk(resolve(distRoot, 'index.js'), '.js').files.length).toBeGreaterThan(5);
  });

  it('не тянет Electron и зависимости валидатора напрямую', () => {
    const { bare } = walk(resolve(distRoot, 'index.js'), '.js');
    expect(bare.filter((one) => FORBIDDEN.includes(one))).toEqual([]);
  });

  it('валидатор в графе есть — и это работа E1, а не вторая точка загрузки', () => {
    // Положительный контроль к сужению выше: если вход перестанет тянуть валидатор, значит
    // загрузка манифеста уехала из ядра или пошла мимо `parseManifest`, и об этом надо знать.
    const { bare } = walk(resolve(distRoot, 'index.js'), '.js');
    expect(bare).toContain('@mcpproxy/contracts/validate');
  });

  it('граф деклараций тоже собран — извлечение специфаеров там своё', () => {
    // У `.js`-половины лексер, у `.d.ts`-половины регулярка. В E0 отсутствие этой проверки
    // означало, что подмена той ветки на `return []` не роняла ничего.
    expect(walk(resolve(distRoot, 'index.d.ts'), '.d.ts').files.length).toBeGreaterThan(5);
  });

  it('и в .d.ts тоже не ссылается на них', () => {
    const { bare } = walk(resolve(distRoot, 'index.d.ts'), '.d.ts');
    expect(bare.filter((one) => FORBIDDEN.includes(one))).toEqual([]);
  });

  it('зато тянет то, что обязан, — иначе запрет выше ничего не значит', () => {
    // Пустой список запрещённого совпадает с пустым графом. Положительный контроль
    // утверждает, что обход действительно доходит до внешних специфаеров.
    const { bare } = walk(resolve(distRoot, 'index.js'), '.js');
    expect(bare).toContain('re2');
    expect(bare).toContain('@mcpproxy/contracts/audit');
    expect(bare).toContain('node:fs');
  });

  it('R24: сетевых модулей в графе нет — экспорт пишет файлы, отправляет человек', () => {
    const { bare } = walk(resolve(distRoot, 'index.js'), '.js');
    expect(bare.filter((one) => NETWORK.includes(one))).toEqual([]);
  });

  it('B2: вход ./audit НЕ тянет нативный re2 — ради этого он и заведён', () => {
    // Потребителю журнала (вкладка аудита E7; человек, проверяющий вердикт чужого экспорта)
    // нужны `readLog`/`verifyLog`, а не движок редакции. `re2` собран под ABI Node, и в
    // Electron тот же бинарь не загрузится без `electron-rebuild`.
    const { bare } = walk(resolve(distRoot, 'audit', 'index.js'), '.js');
    expect(bare).not.toContain('re2');
    expect(bare).toContain('@mcpproxy/contracts/audit');
  });

  it('B2: а корневой вход re2 тянет — иначе проверка выше зелена по другой причине', () => {
    expect(walk(resolve(distRoot, 'index.js'), '.js').bare).toContain('re2');
  });

  it('re2 не уезжает в декларации — потребителю он не нужен для компиляции', () => {
    const { bare } = walk(resolve(distRoot, 'index.d.ts'), '.d.ts');
    expect(bare).not.toContain('re2');
  });
});
