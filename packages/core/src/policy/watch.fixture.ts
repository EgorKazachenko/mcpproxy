import type { WatchPrimitive } from './watch.js';

/**
 * Ручной триггер вместо `fs.watch`.
 *
 * Существует, чтобы ни один тест E1 не ждал настоящего события файловой системы по таймеру
 * (R5): такой тест либо флакает, либо секундами держит прогон. В баррель пакета файл не входит.
 */

export interface ManualWatch {
  readonly primitive: WatchPrimitive;
  /** Каталоги, на которые поставили наблюдение, в порядке вызова. Наблюдаемое следа R5c. */
  readonly watched: readonly string[];
  readonly closed: () => number;
  /** Разослать событие всем открытым наблюдателям. */
  emit(event: string, filename: string | null): void;
}

export function manualWatch(): ManualWatch {
  const watched: string[] = [];
  const listeners = new Set<(event: string, filename: string | null) => void>();
  let closed = 0;

  const primitive: WatchPrimitive = (dir, listener) => {
    watched.push(dir);
    listeners.add(listener);
    return {
      close() {
        listeners.delete(listener);
        closed += 1;
      },
    };
  };

  return {
    primitive,
    watched,
    closed: () => closed,
    emit(event, filename) {
      for (const listener of [...listeners]) listener(event, filename);
    },
  };
}
