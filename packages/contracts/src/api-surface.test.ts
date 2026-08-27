import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_SURFACE_ENTRIES, API_SURFACE_SNAPSHOT, currentApiSurface, distRoot } from './api-surface.js';

/**
 * Исполняемая проверка заморозки (R31, R23).
 *
 * Снимает поверхность `api-surface.ts`, а сверяет здесь. Разделение не косметическое:
 * пока обновление снапшота жило внутри теста за `if (process.env.UPDATE_API_SURFACE === '1')`,
 * гейт умел одобрить сам себя из окружения — переменная, выставленная один раз в шелле или
 * в CI-джобе, переписывала снапшот под то, чем поверхность стала, и докладывала зелёный.
 * Тест, который `return`ит, ничего не утверждая, у vitest проходит. Теперь обновляет
 * снапшот только `node scripts/update-api-surface.mjs`, до которого `vitest run` не дотянется.
 */

describe('публичная поверхность', () => {
  it('собрана — снапшот с пустого графа был бы зелёным на пустоте', () => {
    for (const entry of API_SURFACE_ENTRIES) expect(existsSync(resolve(distRoot, entry))).toBe(true);
  });

  it('совпадает с замороженным снапшотом', () => {
    // Сравнение с файлом делается вручную, а не через `toMatchFileSnapshot`: тот пропускает
    // содержимое через форматтер и переписывает кавычки в объявлениях, из-за чего снапшот
    // расходится с настоящим `.d.ts` на первом же перезапуске. Здесь сравнивается байт в байт.
    expect(currentApiSurface()).toBe(readFileSync(API_SURFACE_SNAPSHOT, 'utf8'));
  });
});
