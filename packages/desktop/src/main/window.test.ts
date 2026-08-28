import { describe, expect, it } from 'vitest';
import { webPreferencesFor, type WindowRole } from './window.js';

const ROLES: readonly WindowRole[] = ['main'];

describe('webPreferencesFor', () => {
  /**
   * Сравнение целиком, а не `toMatchObject`: второй игнорирует лишние ключи, и добавленный
   * позже `webviewTag: true` прошёл бы молча. Инвариант И8 называет провал здесь провалом
   * всего продукта, поэтому проверяется весь возвращаемый объект.
   *
   * Того, что окно создано именно с этими настройками, тест не доказывает — фабрика чистая и
   * про место вызова ничего не знает. Это отдельная проверка в смоуке.
   */
  it.each(ROLES)('для роли %s возвращает ровно четыре флага И8 плюс preload', (role) => {
    expect(webPreferencesFor(role, '/p/preload.cjs')).toEqual({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      preload: '/p/preload.cjs',
    });
  });
});
