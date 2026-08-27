import { describe, expect, it } from 'vitest';
import { encodeSandboxedCommand } from '@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js';
import { newCommandId } from './sandbox.js';
import { STORE_RING_SIZE, advanceCursor } from './srt-manager.js';

/**
 * Чистая половина синглтона. Всё, что требует живого прокси и seatbelt, живёт в
 * `modes/seatbelt.test.ts`: там ему место, потому что там его можно наблюдать, а здесь —
 * ветки, которые в продакшене почти недостижимы и потому легко пишутся неправильно.
 */

describe('advanceCursor (R44, R45)', () => {
  it('ведёт курсор по монотонному тоталу, а не по индексу в отданном массиве', () => {
    expect(advanceCursor({ totalCount: 5, lastSeen: 0, available: 5 })).toEqual({ lost: 0, take: 5, lastSeen: 5 });
    expect(advanceCursor({ totalCount: 7, lastSeen: 5, available: 7 })).toEqual({ lost: 0, take: 2, lastSeen: 7 });
  });

  /**
   * Ветка потери — синтетическим скачком, а не воспроизведением гонки: `notifyListeners`
   * синхронен внутри `addViolation`, и в продакшене эта ветка почти недостижима. Именно
   * поэтому её легко написать неправильно и не узнать.
   */
  it('считает потерянное, когда кольцо вытеснило больше, чем держит', () => {
    expect(advanceCursor({ totalCount: 400, lastSeen: 100, available: STORE_RING_SIZE })).toEqual({
      lost: 200,
      take: 100,
      lastSeen: 400,
    });
  });

  it('насыщение массива на сотне не останавливает курсор', () => {
    // Индексный курсор здесь замер бы: массив перестаёт расти, а тотал продолжает.
    const first = advanceCursor({ totalCount: 100, lastSeen: 0, available: 100 });
    expect(first).toEqual({ lost: 0, take: 100, lastSeen: 100 });
    const second = advanceCursor({ totalCount: 150, lastSeen: 100, available: 100 });
    expect(second).toEqual({ lost: 0, take: 50, lastSeen: 150 });
  });

  it('повторное уведомление без новых записей не отдаёт ничего дважды', () => {
    expect(advanceCursor({ totalCount: 10, lastSeen: 10, available: 10 })).toEqual({ lost: 0, take: 0, lastSeen: 10 });
  });

  it('кольцо у вендора — сто записей, и константа это утверждает, а не предполагает', () => {
    // Значение скопировано из `sandbox-violation-store.js` (`maxSize = 100`). Копия без
    // сверки устаревает молча — сверку держит первый интеграционный тест на 250 отказах:
    // при большем кольце он остался бы зелёным, при меньшем — покраснел бы.
    expect(STORE_RING_SIZE).toBe(100);
  });
});

describe('newCommandId (R48)', () => {
  it('тысяча вызовов даёт тысячу разных значений', () => {
    expect(new Set(Array.from({ length: 1000 }, newCommandId)).size).toBe(1000);
  });

  it('энтропия лежит в первых ста символах — дальше идентификатор обрезается', () => {
    // srt сравнивает ключи по первым 100 символам (`sandbox-manager.d.ts`), поэтому
    // счётчик с общим префиксом атрибутировал бы нарушения чужому вызову.
    const ids = Array.from({ length: 200 }, () => newCommandId().slice(0, 100));
    expect(new Set(ids).size).toBe(200);
  });

  it('переживает вендорское кодирование ключа без коллизий', () => {
    // `encodeSandboxedCommand` режет до ста символов и кодирует base64 — если бы энтропия
    // лежала за границей, здесь две тысячи ключей схлопнулись бы в один.
    const encoded = Array.from({ length: 200 }, () => encodeSandboxedCommand(newCommandId()));
    expect(new Set(encoded).size).toBe(200);
  });
});
