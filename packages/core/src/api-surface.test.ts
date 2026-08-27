import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_SURFACE_ENTRIES, API_SURFACE_SNAPSHOT, currentApiSurface, distRoot } from './api-surface.js';

describe('публичная поверхность core', () => {
  it('собрана — снапшот с пустого графа был бы зелёным на пустоте', () => {
    for (const entry of API_SURFACE_ENTRIES) expect(existsSync(resolve(distRoot, entry))).toBe(true);
  });

  it('граф не выродился в один файл', () => {
    // Без этого утверждения регрессия «обход перестал ходить по относительным импортам»
    // даёт снапшот из одного `index.d.ts`, совпадающий сам с собой, и гейт умирает молча.
    expect(currentApiSurface().split('// ==== ').length - 1).toBeGreaterThan(5);
  });

  it('совпадает с записанным снапшотом', () => {
    // Побайтово, а не через `toMatchFileSnapshot`: тот прогоняет содержимое через форматтер
    // и переписывает кавычки, из-за чего снапшот расходится с настоящим `.d.ts`.
    expect(currentApiSurface()).toBe(readFileSync(API_SURFACE_SNAPSHOT, 'utf8'));
  });

  it('re2 не протекает в декларации — потребитель компилируется без него', () => {
    expect(currentApiSurface()).not.toContain("from 're2'");
  });
});
