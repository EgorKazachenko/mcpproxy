import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Снапшот публичной поверхности `@mcpproxy/core`.
 *
 * `packages/contracts` держит свою поверхность так же (`api-surface.test.ts`) и краснеет на
 * любом новом экспорте. После E3 `core` стал вторым пакетом с **намеренно выбранной**
 * поверхностью — `exec/index.ts` перечисляет символы поимённо и называет потребителя для
 * каждого, — но без этого теста случайный `export *` или лишний символ проехали бы молча, и
 * поверхность росла бы там, где её как раз выбирали.
 *
 * Список литеральный, а не выведенный из `index.d.ts`: сверять файл с самим собой
 * бессмысленно. Изоляцию вендора проверяет отдельный обход графа в `events.test.ts` — это
 * разные вопросы: там «не протёк ли чужой тип», здесь «не вырос ли наш».
 */
const EXPECTED_SURFACE = [
  'asCommandId',
  'assertModeSupported',
  'isModeSupported',
  'ExecError',
  'ExecErrorCode',
  'ExecErrorContext',
  'typeForOperation',
  'buildProfile',
  'classify',
  'collapseOutput',
  'createSandbox',
  'isWeakened',
  'newCommandId',
  'parseAndClassify',
  'parseLine',
  'policyHash',
  // Типы — в одном списке со значениями: для потребителя разницы нет, ломает его любое.
  'ClassifyPolicy',
  'CommandId',
  'EventSink',
  'ExecEvent',
  'ExecOutcome',
  'ExecRequest',
  'ParsedLine',
  'RawViolationRecord',
  'ResolvedSandboxPolicy',
  'Sandbox',
  'StreamOutcome',
  'Termination',
].sort();

describe('публичная поверхность core', () => {
  const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
  const entry = resolve(packageRoot, 'dist', 'exec', 'index.d.ts');

  it('собрана — иначе снапшот сверяется с пустотой', () => {
    expect(existsSync(entry)).toBe(true);
  });

  it('состоит ровно из символов, у каждого из которых назван потребитель', () => {
    const source = readFileSync(entry, 'utf8');
    const exported = new Set<string>();
    for (const match of source.matchAll(/^export (?:type )?\{([^}]*)\}/gm)) {
      for (const raw of (match[1] ?? '').split(',')) {
        const name = raw.trim().split(/\s+as\s+/).at(-1)?.trim();
        if (name !== undefined && name !== '') exported.add(name);
      }
    }

    expect([...exported].sort()).toEqual(EXPECTED_SURFACE);
  });

  it('корневой вход пакета отдаёт ровно эту поверхность и ничего сверх', () => {
    const rootEntry = resolve(packageRoot, 'dist', 'index.d.ts');
    expect(readFileSync(rootEntry, 'utf8')).toContain("export * from './exec/index.js'");
  });

  /**
   * Второй вход — чистая половина без вендора (`@mcpproxy/core/policy`).
   *
   * Помодульная чистота, которую обещают `netpolicy.ts` и `violation.ts`, на КОРНЕВОМ входе
   * неверна: он тянет `createSandbox`, тот — режимы, режимы — вендорский SDK. Значит E7,
   * импортирующий `isWeakened` ради бейджа, грузил бы `@anthropic-ai/sandbox-runtime` на
   * любой платформе. Граница держится входом, как в `packages/contracts` с его `./validate`
   * и `./audit`, — и проверяется тем же обходом графа, что и изоляция вендора.
   */
  it('вход ./policy не тянет вендора в граф деклараций', () => {
    const policyEntry = resolve(packageRoot, 'dist', 'exec', 'policy.d.ts');
    expect(existsSync(policyEntry)).toBe(true);

    const seen = new Set<string>();
    const bare = new Set<string>();
    const queue = [policyEntry];
    while (queue.length > 0) {
      const file = queue.pop();
      if (file === undefined || seen.has(file) || !existsSync(file)) continue;
      seen.add(file);
      for (const match of readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const specifier = match[1];
        if (specifier === undefined) continue;
        if (!specifier.startsWith('.')) {
          bare.add(specifier);
          continue;
        }
        queue.push(resolve(dirname(file), specifier.replace(/\.js$/, '.d.ts')));
      }
    }

    expect(seen.size).toBeGreaterThan(3);
    expect([...bare].filter((one) => one.includes('sandbox-runtime'))).toEqual([]);
  });
});
