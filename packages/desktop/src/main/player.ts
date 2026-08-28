import type { ChainedEvent } from '@mcpproxy/contracts';
import type { UiEvent } from '../shared/channel.js';
import type { PlayerCommand, PlayerState, TrackId } from '../shared/playerCommand.js';

export interface Player {
  readonly apply: (command: PlayerCommand) => void;
  readonly state: () => PlayerState;
  /** Повторяет уже отданные события. Нужен `hello`: рендерер подписывается позже, чем main начинает. */
  readonly replay: () => void;
}

/** Позиции начала прогонов в общем массиве событий. */
export type TrackMarks = Readonly<Record<TrackId, number>>;

const TICK_MS = 400;

/**
 * Проигрыватель записанного трейса.
 *
 * Трейс **один**, и оба прогона сценария S5 лежат в нём: переключатель режима перематывает
 * позицию, а не подменяет файл. Два файла разорвали бы пару соседних строк, на смежности
 * которых держится весь сценарий, а цепочку хэшей разбили бы на две с разными генезисами.
 *
 * Приёмник — аргумент, а не спрятанный внутри модуля побочный эффект: иначе тип умалчивает,
 * куда уходят события, и ни рендерер, ни тест не могут их увидеть.
 */
export function createPlayer(
  events: readonly ChainedEvent[],
  marks: TrackMarks,
  emit: (event: UiEvent) => void,
): Player {
  let track: TrackId = 'seatbelt';
  let position = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const state = (): PlayerState => ({ track, position, total: events.length, playing: timer !== null });

  const announce = (): void => emit({ kind: 'player-state', state: state() });

  const step = (): void => {
    const event = events[position];
    if (event === undefined) {
      pause();
      return;
    }
    position += 1;
    emit({ kind: 'trace-event', event });
    announce();
  };

  function pause(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
      announce();
    }
  }

  const play = (speed: number): void => {
    pause();
    timer = setInterval(step, TICK_MS / speed);
    announce();
  };

  const reset = (to: TrackId): void => {
    pause();
    track = to;
    position = marks[to];
    // WHY: обе команды делают накопленный рендерером массив недействительным. Без явного
    // сообщения рендереру пришлось бы ВЫВОДИТЬ сброс из гонки состояния с событиями.
    emit({ kind: 'trace-reset', track });
    announce();
  };

  const apply = (command: PlayerCommand): void => {
    switch (command.kind) {
      case 'step':
        step();
        return;
      case 'pause':
        pause();
        return;
      case 'play':
        play(command.speed);
        return;
      case 'reset':
        reset(track);
        return;
      case 'select-track':
        reset(command.track);
        return;
    }
  };

  const replay = (): void => {
    emit({ kind: 'trace-reset', track });
    for (const event of events.slice(marks[track], position)) emit({ kind: 'trace-event', event });
    announce();
  };

  return { apply, state, replay };
}
