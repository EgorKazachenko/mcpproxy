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

const EVENTS = [event(0), event(1), event(2), event(3), event(4), event(5)];

/**
 * Метки — как в настоящей фикстуре: **обе** ненулевые, и метка дорожки по умолчанию не первая.
 *
 * Прежние `{ seatbelt: 0, none: 2 }` структурно исключали единственную интересную ситуацию.
 * В `demo.jsonl` лог начинается с отказанных вызовов, которые не принадлежат ни одной
 * дорожке, поэтому метка `seatbelt` заведомо больше нуля — и именно там `replay()` резал
 * `slice(метка, позиция)` и отдавал пустоту на перезагрузке рендерера.
 */
const MARKS = { none: 2, seatbelt: 4 } as const;

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

  /**
   * Регрессия: со свежего старта прогон идёт с НАЧАЛА лога, а не с метки выбранной дорожки.
   *
   * Позиция стартовала нулём при дорожке, метка которой не ноль, и `replay()` срезал по метке —
   * то есть перезагрузка рендерера стирала уже показанный список. Событий до метки в логе не
   * бывает только в тесте; в фикстуре с них лог и начинается.
   */
  it('повтор со свежего старта отдаёт всё показанное, а не срез от метки дорожки', () => {
    const { player, seen, traces } = harness();
    player.apply({ kind: 'step' });
    player.apply({ kind: 'step' });
    expect(player.state().position).toBeLessThan(MARKS.seatbelt);

    seen.length = 0;
    player.replay();

    expect(traces()).toHaveLength(2);
  });

  /** А после смены дорожки повтор обязан идти уже от её метки — иначе он покажет чужой прогон. */
  it('после смены дорожки повтор идёт от её метки', () => {
    const { player, seen, traces } = harness();
    player.apply({ kind: 'select-track', track: 'none' });
    player.apply({ kind: 'step' });

    seen.length = 0;
    player.replay();

    expect(traces()).toHaveLength(1);
    expect(traces()[0]).toMatchObject({ event: { traceId: `t${MARKS.none}` } });
  });

  it('состояние сообщает длину трейса', () => {
    expect(harness().player.state().total).toBe(EVENTS.length);
  });

  /** Таймер снимается явной остановкой: закрытие окна не оставляет тикающий интервал. */
  it('stop снимает таймер воспроизведения', () => {
    const { player } = harness();
    player.apply({ kind: 'play', speed: 1 });
    expect(player.state().playing).toBe(true);

    player.stop();
    expect(player.state().playing).toBe(false);
  });
});
