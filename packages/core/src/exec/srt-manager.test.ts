import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { encodeSandboxedCommand } from '@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js';
import { newCommandId } from './sandbox.js';
import { STORE_RING_SIZE, advanceCursor, redactUrlForTarget, telemetryRecord } from './srt-manager.js';

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

  /**
   * Сверка с **исходником вендора**, а не с литералом строкой выше.
   *
   * `expect(STORE_RING_SIZE).toBe(100)` сравнивало константу с её же значением: продакшен
   * этой константы не использует вовсе (живой код передаёт `available: all.length`), она
   * существует только чтобы задать фикстуру ветки потери. Бамп `maxSize` у вендора делал бы
   * эту фикстуру нерепрезентативной молча — и интеграционный тест на 250 отказах, на
   * который ссылался прежний комментарий, при БОЛЬШЕМ кольце остался бы зелёным, что тот же
   * комментарий и признавал.
   *
   * Форма — та же, что у детектора порядка deny/allow в `netpolicy.test.ts`: читаем вендора
   * и краснеем в обе стороны.
   */
  it('совпадает с maxSize в исходнике вендорского стора', () => {
    const require_ = createRequire(import.meta.url);
    const storePath = require_.resolve('@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-violation-store.js');
    const source = readFileSync(storePath, 'utf8');
    const match = /this\.maxSize\s*=\s*(\d+)/.exec(source);

    expect(match).not.toBeNull();
    expect(STORE_RING_SIZE).toBe(Number(match?.[1]));
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

/**
 * Сведение URL до того, как он станет `target` нарушения (и уедет в цепочку аудита).
 *
 * Вендор режет query на своём пути violation дословно по этой причине
 * (`sandbox-manager.js:170-190`): query-строки рутинно несут `api_key=`, `access_token=` и
 * подписанные URL, которых не было в контексте модели. Наш колбэк получает URL целиком —
 * это цена `tlsTerminate` (D12), — и без сведения секрет лёг бы открытым текстом в
 * append-only лог, откуда его уже не убрать.
 */
describe('redactUrlForTarget', () => {
  it('оставляет origin и путь, а параметры сводит к маркеру', () => {
    expect(redactUrlForTarget('https://api.example.com/v1/x?api_key=СЕКРЕТ&b=2')).toBe(
      'https://api.example.com/v1/x?…',
    );
    expect(redactUrlForTarget('https://api.example.com/v1/x')).toBe('https://api.example.com/v1/x');
  });

  it('роняет userinfo вместе с origin', () => {
    // `URL.origin` не содержит `user:pass@`, поэтому пара учётных данных в самом URL тоже
    // не доезжает — это то же свойство, на которое опирается вендор.
    //
    // Фикстура собрана из частей, а не литералом: строка этой формы поднимает сканеры
    // секретов, включая наш собственный (`redact/repo-clean.test.ts`). Идиома — из корпуса
    // E6 (`redact/secret-samples.ts`): такой строки на диске просто не существует.
    const withUserinfo = ['https://user', ':', 'пароль', '@', 'api.example.com/x'].join('');
    expect(redactUrlForTarget(withUserinfo)).toBe('https://api.example.com/x');
  });

  it('на неразбираемом URL режет всё после вопросительного знака, а не рискует', () => {
    expect(redactUrlForTarget('не-url?api_key=СЕКРЕТ')).toBe('не-url?…');
    expect(redactUrlForTarget('не-url')).toBe('не-url');
  });

  it('ни в одном случае не оставляет значения параметра', () => {
    const CASES = [
      'https://a.example.com/p?token=СЕКРЕТ',
      'http://a.example.com/p?x=1&token=СЕКРЕТ',
      'сломанный?token=СЕКРЕТ',
    ];
    for (const url of CASES) expect(redactUrlForTarget(url)).not.toContain('СЕКРЕТ');
  });
});

/**
 * Инвариант один: сбой счётчика байт уносит **байты**, а не запрос.
 *
 * Ветка недостижима чёрным ящиком — чтобы `countBody` бросил, нужно уже прочитанное тело, а
 * вендор отдаёт свежую ветку tee, — поэтому она вынесена сюда и подаётся литералом. Пока
 * запись строилась внутри того же `try`, отказ счётчика уносил из аудита сам запрос: в
 * режиме `none` это ровно тот запрос эксфильтрации, ради показа которого существует S5, и
 * исчезал он бесследно.
 */
describe('telemetryRecord', () => {
  it('при сбое счётчика запись остаётся, а байты становятся нулём', () => {
    const { violation, countFailed } = telemetryRecord('https://api.example.com/x?token=СЕКРЕТ', { ok: false });
    expect(violation).toEqual({
      type: 'network',
      target: 'https://api.example.com/x?…',
      action: 'allowed',
      bytes: 0,
    });
    expect(countFailed).toBe(true);
  });

  it('при удачном счёте байты доезжают, а сбой не объявляется', () => {
    const { violation, countFailed } = telemetryRecord('http://a.example.com/p', { ok: true, bytes: 1234 });
    expect(violation).toMatchObject({ action: 'allowed', bytes: 1234, target: 'http://a.example.com/p' });
    expect(countFailed).toBe(false);
  });

  it('и в обоих случаях запись существует — это и есть инвариант', () => {
    for (const count of [{ ok: true, bytes: 0 } as const, { ok: false } as const]) {
      expect(telemetryRecord('http://a.example.com/', count).violation.action).toBe('allowed');
    }
  });
});
