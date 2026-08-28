import { describe, expect, it } from 'vitest';
import { APP_ORIGIN } from './protocol.js';
import { guarded, senderRejection, type SenderFacts } from './ipc.js';
import type { UiErrorCode } from '../shared/result.js';

const ORIGINS = new Set([APP_ORIGIN]);
const good: SenderFacts = { detached: false, parent: null, origin: APP_ORIGIN };

/**
 * Пять случаев целиком, а не выборка. Каждая причина отказа — отдельная атака, и разделены
 * они ровно затем, чтобы удаление одной проверки роняло один случай и называло, какая
 * защита исчезла. Общий код лишил бы тест этой способности.
 */
const CASES: ReadonlyArray<readonly [string, SenderFacts | null, UiErrorCode | null]> = [
  ['фрейма нет', null, 'sender-absent'],
  ['фрейм отцеплен', { ...good, detached: true }, 'sender-detached'],
  ['вложенный фрейм', { ...good, parent: {} }, 'sender-subframe'],
  ['чужой origin', { ...good, origin: 'file://' }, 'sender-origin'],
  ['всё в порядке', good, null],
];

describe('senderRejection', () => {
  it.each(CASES)('%s', (_name, frame, expected) => {
    expect(senderRejection(frame, ORIGINS)).toBe(expected);
  });

  /**
   * Единственный юнит сравнивал бы константу с самой собой, если бы множество origin было
   * захардкожено. Здесь проверяется, что множество действительно расширяемо: в разработке
   * рендерер грузится с dev-сервера, и без этого каждое сообщение там отклонялось бы.
   */
  it('принимает origin, добавленный в множество', () => {
    const dev = 'http://localhost:5173';
    expect(senderRejection({ ...good, origin: dev }, ORIGINS)).toBe('sender-origin');
    expect(senderRejection({ ...good, origin: dev }, new Set([APP_ORIGIN, dev]))).toBe(null);
  });
});

const eventWith = (frame: SenderFacts | null): Electron.IpcMainInvokeEvent =>
  ({ senderFrame: frame }) as unknown as Electron.IpcMainInvokeEvent;

describe('guarded', () => {
  it('не зовёт обработчик, когда отправитель отклонён', async () => {
    let called = false;
    const handler = guarded(() => {
      called = true;
      return { ok: true, value: { kind: 'accepted' } };
    }, ORIGINS);

    const result = await handler(eventWith({ ...good, detached: true }), { kind: 'hello' });

    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('sender-detached');
  });

  it('не зовёт обработчик, когда нагрузка не прошла разбор', async () => {
    let called = false;
    const handler = guarded(() => {
      called = true;
      return { ok: true, value: { kind: 'accepted' } };
    }, ORIGINS);

    const result = await handler(eventWith(good), { kind: 'нечто' });

    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('bad-payload');
  });

  it('передаёт разобранный запрос обработчику', async () => {
    const seen: unknown[] = [];
    const handler = guarded((request) => {
      seen.push(request);
      return { ok: true, value: { kind: 'accepted' } };
    }, ORIGINS);

    await handler(eventWith(good), { kind: 'player-command', command: { kind: 'step' } });

    expect(seen).toEqual([{ kind: 'player-command', command: { kind: 'step' } }]);
  });
});
