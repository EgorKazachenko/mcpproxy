import { describe, expect, it } from 'vitest';
import { parseUiRequest, sanitize } from './parse.js';
import { SPEED_MAX, SPEED_MIN } from './playerCommand.js';

describe('sanitize', () => {
  /**
   * Проверяется объявленное свойство, а не симптом. Обход цепочки прототипов матчером —
   * деталь его реализации, и безопасность границы не может на ней держаться.
   */
  it('возвращает объект с нулевым прототипом', () => {
    expect(Object.getPrototypeOf(sanitize({ a: 1 }))).toBe(null);
  });

  it('не проносит унаследованное свойство', () => {
    const polluted = Object.create({ isAdmin: true }) as Record<string, unknown>;
    polluted['kind'] = 'hello';
    const clean = sanitize(polluted);

    expect(Object.hasOwn(clean, 'isAdmin')).toBe(false);
    expect(clean['isAdmin']).toBeUndefined();
  });

  /**
   * Копия мелкая, и это осознанно: обе полезные нагрузки плоские. Утверждение фиксирует
   * границу гарантии, чтобы третье сообщение с вложенным объектом не проехало на прежней.
   */
  it('копия мелкая — вложенный объект сохраняет свой прототип', () => {
    const nested = Object.create({ evil: true }) as Record<string, unknown>;
    const clean = sanitize({ nested });

    expect(Object.getPrototypeOf(clean['nested'])).not.toBe(null);
  });

  it('не падает на не-объекте', () => {
    expect(sanitize(null)).toEqual({});
    expect(sanitize(42)).toEqual({});
  });
});

describe('parseUiRequest', () => {
  it('принимает hello без полей', () => {
    expect(parseUiRequest({ kind: 'hello' })).toEqual({ ok: true, value: { kind: 'hello' } });
  });

  /**
   * Лишнее поле у `hello` означает отправителя, который считает форму иначе. На границе
   * безопасности это отказ, а не «проигнорируем незнакомое».
   */
  it('отклоняет hello с лишним полем', () => {
    expect(parseUiRequest({ kind: 'hello', extra: 1 }).ok).toBe(false);
  });

  it.each(['step', 'pause', 'reset'])('принимает команду %s', (kind) => {
    const parsed = parseUiRequest({ kind: 'player-command', command: { kind } });
    expect(parsed).toEqual({ ok: true, value: { kind: 'player-command', command: { kind } } });
  });

  /**
   * Неограниченное число из рендерера уезжает прямо в таймер, и модель угроз, где рендерер
   * считается компрометируемым, покупала бы главному процессу занятый цикл.
   */
  it.each([Number.POSITIVE_INFINITY, Number.NaN, 0, -1, SPEED_MAX + 1])(
    'отклоняет скорость %s',
    (speed) => {
      expect(parseUiRequest({ kind: 'player-command', command: { kind: 'play', speed } }).ok).toBe(false);
    },
  );

  it.each([SPEED_MIN, 1, SPEED_MAX])('принимает скорость %s', (speed) => {
    expect(parseUiRequest({ kind: 'player-command', command: { kind: 'play', speed } }).ok).toBe(true);
  });

  it('отклоняет неизвестную дорожку', () => {
    const parsed = parseUiRequest({ kind: 'player-command', command: { kind: 'select-track', track: 'нечто' } });
    expect(parsed.ok).toBe(false);
  });

  it('принимает известную дорожку', () => {
    const parsed = parseUiRequest({ kind: 'player-command', command: { kind: 'select-track', track: 'none' } });
    expect(parsed.ok).toBe(true);
  });

  it.each([{ kind: 'нечто' }, {}, null, 'строка'])('отклоняет неизвестный вид запроса: %s', (payload) => {
    expect(parseUiRequest(payload).ok).toBe(false);
  });

  /**
   * Разбор снимает прототип и с вложенной команды тоже: иначе объект с подконтрольным
   * прототипом проехал бы границу внутри разобранного запроса.
   */
  it('снимает прототип с вложенной команды', () => {
    const command = Object.create({ evil: true }) as Record<string, unknown>;
    command['kind'] = 'step';
    const parsed = parseUiRequest({ kind: 'player-command', command });

    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.kind === 'player-command') {
      expect(Object.hasOwn(parsed.value.command, 'evil')).toBe(false);
    }
  });
});
