import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deriveRiskTier } from './annotations.js';
import { asRecipeName } from './ipc.js';
import { toTool } from './tool.js';
import { parseManifest } from './validate/index.js';

const path = fileURLToPath(new URL('../recipes/mcpproxy.yaml', import.meta.url));
const result = parseManifest(readFileSync(path, 'utf8'), { path });

/**
 * Сужение через БРОСОК, а не через ранний `return`.
 *
 * Пока каждый кейс открывался `if (!result.ok) return;`, поломка `recipes/mcpproxy.yaml` —
 * или регрессия в `parseManifest`, `refine`, схеме — давала **один** красный тест и шесть
 * молча зелёных: тест, вернувшийся не утвердив ничего, у vitest проходит. То есть дефект,
 * обнуляющий весь контракт заглушек, докладывался как 1/184, а шесть кейсов, несущих
 * собственно инварианты (И2, таблица тиров, единственный high-risk, карта матчеров,
 * проекция в Tool), рапортовали успех, не выполнив ни одного `expect`.
 */
function loaded(): Extract<typeof result, { ok: true }> {
  if (!result.ok) {
    throw new Error(result.diagnostics.map((one) => `${one.pointer} [${one.code}]: ${one.message}`).join('\n'));
  }
  return result;
}

describe('рецепты-заглушки', () => {
  it('грузятся через parseManifest без единой диагностики', () => {
    expect(loaded().ok).toBe(true);
  });

  it('это ровно четыре объявленных рецепта', () => {
    expect(Object.keys(loaded().manifest.tools).sort()).toEqual([
      'analyze_logs',
      'build_project',
      'publish_release',
      'run_tests',
    ]);
  });

  it('argv параметра pattern — два отдельных элемента, а не одна склеенная строка', () => {
    // Инвариант И2. Без теста он держится только на внимательности читающего YAML.
    expect(loaded().manifest.tools.run_tests?.params?.pattern?.argv).toEqual(['--testPathPattern', '{}']);
  });

  it('тиры риска — те, ради которых набор и собран', () => {
    const tiers = Object.fromEntries(
      Object.entries(loaded().manifest.tools).map(([name, recipe]) => [name, deriveRiskTier(recipe.annotations ?? {})]),
    );
    expect(tiers).toEqual({
      run_tests: 'medium',
      build_project: 'medium',
      analyze_logs: 'low',
      publish_release: 'high',
    });
  });

  it('high-risk ровно один — иначе сценарию S8 нечего показывать', () => {
    const high = Object.entries(loaded().manifest.tools).filter(
      ([, recipe]) => deriveRiskTier(recipe.annotations ?? {}) === 'high',
    );
    expect(high.map(([name]) => name)).toEqual(['publish_release']);
  });

  it('матчеры собраны для обоих строковых параметров', () => {
    expect(loaded().matchers.get('tools.run_tests.params.pattern')?.test('auth')).toBe(true);
    expect(loaded().matchers.get('tools.publish_release.params.tag')?.test('v1.2.3')).toBe(true);
    expect(loaded().matchers.get('tools.publish_release.params.tag')?.test('latest')).toBe(false);
  });

  it('каждый проецируется в Tool без потери имени', () => {
    for (const [name, recipe] of Object.entries(loaded().manifest.tools)) {
      expect(toTool(asRecipeName(name), recipe).name).toBe(name);
    }
  });
});
