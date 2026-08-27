import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deriveRiskTier } from './annotations.js';
import { asRecipeName } from './ipc.js';
import { toTool } from './tool.js';
import { parseManifest } from './validate/index.js';

const path = fileURLToPath(new URL('../recipes/mcpproxy.yaml', import.meta.url));
const result = parseManifest(readFileSync(path, 'utf8'), { path });

describe('рецепты-заглушки', () => {
  it('грузятся через parseManifest без единой диагностики', () => {
    if (!result.ok) throw new Error(result.diagnostics.map((one) => `${one.pointer}: ${one.message}`).join('\n'));
    expect(result.ok).toBe(true);
  });

  it('это ровно четыре объявленных рецепта', () => {
    if (!result.ok) return;
    expect(Object.keys(result.manifest.tools).sort()).toEqual([
      'analyze_logs',
      'build_project',
      'publish_release',
      'run_tests',
    ]);
  });

  it('argv параметра pattern — два отдельных элемента, а не одна склеенная строка', () => {
    // Инвариант И2. Без теста он держится только на внимательности читающего YAML.
    if (!result.ok) return;
    expect(result.manifest.tools.run_tests?.params?.pattern?.argv).toEqual(['--testPathPattern', '{}']);
  });

  it('тиры риска — те, ради которых набор и собран', () => {
    if (!result.ok) return;
    const tiers = Object.fromEntries(
      Object.entries(result.manifest.tools).map(([name, recipe]) => [name, deriveRiskTier(recipe.annotations ?? {})]),
    );
    expect(tiers).toEqual({
      run_tests: 'medium',
      build_project: 'medium',
      analyze_logs: 'low',
      publish_release: 'high',
    });
  });

  it('high-risk ровно один — иначе сценарию S8 нечего показывать', () => {
    if (!result.ok) return;
    const high = Object.entries(result.manifest.tools).filter(
      ([, recipe]) => deriveRiskTier(recipe.annotations ?? {}) === 'high',
    );
    expect(high.map(([name]) => name)).toEqual(['publish_release']);
  });

  it('матчеры собраны для обоих строковых параметров', () => {
    if (!result.ok) return;
    expect(result.matchers.get('tools.run_tests.params.pattern')?.test('auth')).toBe(true);
    expect(result.matchers.get('tools.publish_release.params.tag')?.test('v1.2.3')).toBe(true);
    expect(result.matchers.get('tools.publish_release.params.tag')?.test('latest')).toBe(false);
  });

  it('каждый проецируется в Tool без потери имени', () => {
    if (!result.ok) return;
    for (const [name, recipe] of Object.entries(result.manifest.tools)) {
      expect(toTool(asRecipeName(name), recipe).name).toBe(name);
    }
  });
});
