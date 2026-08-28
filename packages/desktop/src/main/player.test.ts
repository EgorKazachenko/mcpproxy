import type { ChainedEvent } from '@mcpproxy/contracts';
import { describe, expect, it } from 'vitest';
import type { UiEvent } from '../shared/channel.js';
import { createPlayer } from './player.js';

const event = (n: number): ChainedEvent =>
  ({
    schema: 'mcpproxy.audit/1',
    operation: 'execute_tool',
    protocolVersion: '2025-11-25',
    toolName: 'run_tests',
    sessionId: 's',
    traceId: `t${n}`,
    spanId: `sp${n}`,
    parentSpanId: null,
    startTime: '2026-08-27T10:00:00.000000Z',
    endTime: '2026-08-27T10:00:00.001000Z',
    durationUs: 1000,
    stage: 'received',
    verdict: 'allowed',
    recipe: { name: 'run_tests' },
    chain: { prev: null, self: 'x'.repeat(64) },
  }) as ChainedEvent;

const EVENTS = [event(0), event(1), event(2), event(3)];
const MARKS = { seatbelt: 0, none: 2 } as const;

/** Приёмник — обычная функция, поэтому IPC для проверки не нужен. */
function harness() {
  const seen: UiEvent[] = [];
  const player = createPlayer(EVENTS, MARKS, (e) => seen.push(e));
  return { player, seen, traces: () => seen.filter((e) => e.kind === 'trace-event') };
}

describe('createPlayer', () => {
  it('шаг отдаёт одно событие и двигает позицию', () => {
    const { player, traces } = harness();
    player.apply({ kind: 'step' });

    expect(traces()).toHaveLength(1);
    expect(player.state().position).toBe(1);
  });

  /**
   * Два утверждения различают две независимые ошибки: выдача без движения позиции и движение
   * без выдачи. Одного из них не хватило бы, чтобы сказать, что именно сломалось.
   */
  it('шаг за последним событием ничего не добавляет', () => {
    const { player, traces } = harness();
    for (let i = 0; i < EVENTS.length + 3; i += 1) player.apply({ kind: 'step' });

    expect(traces()).toHaveLength(EVENTS.length);
    expect(player.state().position).toBe(EVENTS.length);
  });

  /**
   * Смена дорожки перематывает позицию, а не подменяет источник: оба прогона сценария S5
   * лежат в одном логе, и подмена файла разорвала бы пару соседних строк.
   */
  it('смена дорожки перематывает позицию к её началу', () => {
    const { player } = harness();
    player.apply({ kind: 'select-track', track: 'none' });

    expect(player.state()).toMatchObject({ track: 'none', position: MARKS.none });
  });

  /**
   * Без явного сброса рендереру пришлось бы ВЫВОДИТЬ недействительность накопленного из
   * гонки состояния с событиями.
   */
  it('смена дорожки объявляет сброс до новых событий', () => {
    const { player, seen } = harness();
    player.apply({ kind: 'select-track', track: 'none' });

    expect(seen[0]).toEqual({ kind: 'trace-reset', track: 'none' });
  });

  it('сброс объявляется и при команде reset', () => {
    const { player, seen } = harness();
    player.apply({ kind: 'reset' });

    expect(seen.some((e) => e.kind === 'trace-reset')).toBe(true);
  });

  /**
   * Рендерер подписывается позже, чем main начинает работу. Без повтора первая отрисовка
   * показала бы пустой список при непустом трейсе.
   */
  it('повтор отдаёт уже показанные события заново', () => {
    const { player, seen, traces } = harness();
    player.apply({ kind: 'step' });
    player.apply({ kind: 'step' });
    const before = traces().length;

    seen.length = 0;
    player.replay();

    expect(traces()).toHaveLength(before);
    expect(seen[0]).toEqual({ kind: 'trace-reset', track: 'seatbelt' });
  });

  it('состояние сообщает длину трейса', () => {
    expect(harness().player.state().total).toBe(EVENTS.length);
  });
});
