import { watch as fsWatch } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { StartedStore } from './store.js';

/**
 * Наблюдение за манифестом и lock.
 *
 * Живёт за интерфейсом (R5): продакшн-реализация — `fs.watch`, тестовая — ручной триггер.
 * Ни один тест E1 не ждёт настоящего события файловой системы по таймеру, поэтому
 * коалесценция вынесена отдельной чистой функцией и проверяется прямо на ней.
 *
 * **Наблюдается каталог, а не путь файла** (R5c). Замерено на macOS, Node 22: `fs.watch` по
 * пути файла пропустил обычную запись на месте и замолчал навсегда после первой же атомарной
 * подмены (`file=1` событие против `dir=6`), тогда как наблюдение за каталогом увидело все
 * изменения. А подмена — это наш собственный способ записи lock (`temp` + `rename`), и точно
 * так же сохраняют файл vim и VSCode: вотчер по пути файла умер бы при первом же запуске
 * команды `mcpproxy lock`.
 *
 * **Наблюдаются оба файла** (R5b). Иначе `mcpproxy lock` не расклинивает работающий демон:
 * команда пишет `mcpproxy.lock`, время правки `mcpproxy.yaml` не меняется, вотчер не
 * срабатывает, и `absent` в памяти остаётся навсегда.
 */

export interface PathWatcher {
  start(onChange: () => void): void;
  /** Без `stop` утекает дескриптор ФС, а вместе с ним — висящий таймер коалесценции. */
  stop(): void;
}

export interface Debounced {
  (): void;
  cancel(): void;
}

/**
 * Коалесценция событий. Одна атомарная подмена даёт на каталоге несколько событий (замерено:
 * три на первый `rename`), и каждое из них перечитывало бы файл заново.
 */
export function debounce(fn: () => void, ms: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  return Object.assign(
    (): void => {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, ms);
    },
    { cancel },
  );
}

/** Ровно та часть `fs.watch`, которой пользуется `dirWatcher`. Инъектируется ради теста R5c. */
export type WatchPrimitive = (
  dir: string,
  listener: (event: string, filename: string | null) => void,
) => { close(): void };

const nodeWatch: WatchPrimitive = (dir, listener) =>
  fsWatch(dir, (event, filename) => listener(event, typeof filename === 'string' ? filename : null));

/**
 * Вотчер одного файла, поставленный на его **каталог** с фильтром по имени.
 *
 * Примитив инъектируется, чтобы это свойство было под тестом, а не только под пробой: иначе
 * будущая правка тихо вернёт `fs.watch(filePath)` и сломает R5b/R5c, не уронив ничего.
 */
export function dirWatcher(filePath: string, debounceMs: number, watch: WatchPrimitive = nodeWatch): PathWatcher {
  const dir = dirname(filePath);
  const name = basename(filePath);
  let handle: { close(): void } | null = null;
  let coalesced: Debounced | null = null;

  return {
    start(onChange) {
      if (handle !== null) return;
      const fire = debounce(onChange, debounceMs);
      coalesced = fire;
      handle = watch(dir, (_event, filename) => {
        // `null` пропускается намеренно: на части платформ имя не сообщается, и трактовать
        // его как «не наше» значило бы потерять уведомление совсем. Ложное срабатывание
        // стоит одной лишней перезагрузки, пропущенное — вечного `absent`.
        if (filename !== null && filename !== name) return;
        fire();
      });
    },
    stop() {
      handle?.close();
      handle = null;
      coalesced?.cancel();
      coalesced = null;
    },
  };
}

export interface WatchPaths {
  readonly manifestPath: string;
  readonly lockPath: string;
}

export interface WatchOptions {
  readonly debounceMs: number;
  readonly make?: (filePath: string, ms: number) => PathWatcher;
}

/**
 * Связывает оба вотчера со снимком политики.
 *
 * Возвращает `{stop()}`, а не `PathWatcher`: он уже владеет `store` и сам делает перезагрузку,
 * поэтому `start(onChange)` у него смысла не имеет.
 *
 * Обновление lock не влечёт перечитку манифеста и наоборот: это разные файлы с разным
 * временем жизни (R5b).
 */
export function watchPolicy(store: StartedStore, paths: WatchPaths, options: WatchOptions): { stop(): void } {
  const make = options.make ?? ((filePath, ms) => dirWatcher(filePath, ms));
  const manifest = make(paths.manifestPath, options.debounceMs);
  const lock = make(paths.lockPath, options.debounceMs);

  // Результат перезагрузки здесь не разбирается намеренно: обе операции возвращают его
  // значением и не бросают, а разбирать его должен тот, кто может что-то сделать, — демон E4.
  manifest.start(() => void store.reloadManifest());
  lock.start(() => void store.reloadLock());

  return {
    stop() {
      manifest.stop();
      lock.stop();
    },
  };
}
