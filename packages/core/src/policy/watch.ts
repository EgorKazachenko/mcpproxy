import { watch as fsWatch } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { ReloadResult, StartedStore } from './store.js';

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
  onError: (error: unknown) => void,
) => { close(): void };

/**
 * `FSWatcher` — это `EventEmitter`, и его документированное событие `'error'` (каталог удалён
 * или переименован, EPERM, исчерпан лимит наблюдателей) **без слушателя бросается наверх и
 * убивает процесс**. Для долгоживущего демона это отказ обслуживания из операции над каталогом
 * репозитория, поэтому слушатель обязателен, а не желателен.
 */
/** Ровно та часть `fs.watch`, которую использует `nodeWatch`. Параметр — ради теста ниже. */
export interface WatcherLike {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  close(): void;
}

export type WatchFactory = (dir: string, listener: (event: string, filename: unknown) => void) => WatcherLike;

const fsWatchFactory: WatchFactory = (dir, listener) => fsWatch(dir, listener);

export const nodeWatchWith =
  (factory: WatchFactory): WatchPrimitive =>
  (dir, listener, onError) => {
    const watcher = factory(dir, (event, filename) =>
      listener(event, typeof filename === 'string' ? filename : null),
    );
    watcher.on('error', (error) => {
      // Вотчер после ошибки мёртв: закрываем его сами, чтобы `stop()` был идемпотентен, и
      // сообщаем наверх — иначе политика молча замерла бы на последнем загруженном значении.
      watcher.close();
      onError(error);
    });
    return { close: () => watcher.close() };
  };

const nodeWatch: WatchPrimitive = nodeWatchWith(fsWatchFactory);

/**
 * Вотчер одного файла, поставленный на его **каталог** с фильтром по имени.
 *
 * Примитив инъектируется, чтобы это свойство было под тестом, а не только под пробой: иначе
 * будущая правка тихо вернёт `fs.watch(filePath)` и сломает R5b/R5c, не уронив ничего.
 */
export function dirWatcher(
  filePath: string,
  debounceMs: number,
  watch: WatchPrimitive = nodeWatch,
  onError: (error: unknown) => void = () => undefined,
): PathWatcher {
  const dir = dirname(filePath);
  const name = basename(filePath);
  let handle: { close(): void } | null = null;
  let coalesced: Debounced | null = null;

  return {
    start(onChange) {
      if (handle !== null) return;
      const fire = debounce(onChange, debounceMs);
      coalesced = fire;
      handle = watch(
        dir,
        (_event, filename) => {
          // `null` пропускается намеренно: на части платформ имя не сообщается, и трактовать
          // его как «не наше» значило бы потерять уведомление совсем. Ложное срабатывание
          // стоит одной лишней перезагрузки, пропущенное — вечного `absent`.
          if (filename !== null && filename !== name) return;
          fire();
        },
        (error) => {
          handle = null;
          coalesced?.cancel();
          onError(error);
        },
      );
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

/** Что именно перечитывалось. Без этого получатель не знает, к какому файлу относится исход. */
export type ReloadSource = 'manifest' | 'lock';

export interface WatchOptions {
  readonly debounceMs: number;
  readonly make?: (filePath: string, ms: number) => PathWatcher;
  /**
   * Исход каждой перезагрузки.
   *
   * **Обязателен по смыслу, а не по типу.** `watchPolicy` — единственная продакшн-проводка
   * `reloadManifest`/`reloadLock`, и без этого шва она уничтожала результат: `current()` по R4
   * остаётся прежним, `reloadCount()` растёт только на успехе, диагностики выбрасывались, — то
   * есть «перечитка не удалась» и «перечитка удалась, ничего не изменилось» были наблюдаемо
   * неразличимы. Ровно это состояние R2a называет fail-open на пути решения: оператор правит
   * манифест с опечаткой и получает прокси, вечно обслуживающий устаревшую политику без единой
   * записи о том, что файл на диске перестал быть политикой.
   *
   * Сюда же приходят ошибки самого наблюдения (`outcome: 'unreadable'`, код `EWATCH`).
   */
  readonly onReload?: (source: ReloadSource, result: ReloadResult) => void;
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
  const report = options.onReload ?? (() => undefined);
  const failed = (source: ReloadSource, error: unknown): void =>
    report(source, {
      outcome: 'unreadable',
      code: 'EWATCH',
      message: `наблюдение за ${source} прекращено: ${error instanceof Error ? error.message : String(error)}`,
    });

  const make =
    options.make ??
    ((filePath: string, ms: number) =>
      dirWatcher(filePath, ms, undefined, (error) =>
        failed(filePath === paths.lockPath ? 'lock' : 'manifest', error),
      ));

  const manifest = make(paths.manifestPath, options.debounceMs);
  const lock = make(paths.lockPath, options.debounceMs);

  // `.catch` обязателен, а не декоративен: Node 22 завершает процесс на необработанном
  // отклонении, и загрузка, которая когда-нибудь всё же бросит, унесла бы с собой демон.
  // Результат при этом не выбрасывается — он уезжает в `onReload`.
  const reload = (source: ReloadSource, run: () => Promise<ReloadResult>): void => {
    void run().then(
      (result) => report(source, result),
      (error: unknown) => failed(source, error),
    );
  };

  manifest.start(() => reload('manifest', () => store.reloadManifest()));
  try {
    lock.start(() => reload('lock', () => store.reloadLock()));
  } catch (error) {
    // Иначе уже запущенный вотчер манифеста утекает: ручки наружу ещё нет, закрыть его
    // вызывающему нечем.
    manifest.stop();
    throw error;
  }

  return {
    stop() {
      manifest.stop();
      lock.stop();
    },
  };
}
