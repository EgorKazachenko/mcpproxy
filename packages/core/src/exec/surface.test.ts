import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
});
