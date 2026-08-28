import { basename, dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BROKEN_YAML, LOCK_PATH, MANIFEST_PATH, lockTextFor, memoryDisk, settle, started } from './policy.fixture.js';
import { debounce, dirWatcher, nodeWatchWith, watchPolicy } from './watch.js';
import type { ReloadSource, WatcherLike } from './watch.js';
import type { ReloadResult } from './store.js';
import { manualWatch } from './watch.fixture.js';

const DEBOUNCE_MS = 50;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('debounce', () => {
  it('схлопывает пачку событий в один вызов', () => {
    const fn = vi.fn();
    const coalesced = debounce(fn, DEBOUNCE_MS);

    coalesced();
    coalesced();
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('две разнесённые пачки дают два вызова', () => {
    const fn = vi.fn();
    const coalesced = debounce(fn, DEBOUNCE_MS);

    coalesced();
    vi.advanceTimersByTime(DEBOUNCE_MS);
    coalesced();
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('cancel гасит висящий таймер — без него `stop` оставляет отложенную перезагрузку', () => {
    const fn = vi.fn();
    const coalesced = debounce(fn, DEBOUNCE_MS);

    coalesced();
    coalesced.cancel();
    vi.advanceTimersByTime(DEBOUNCE_MS * 10);

    expect(fn).not.toHaveBeenCalled();
  });
});

describe('dirWatcher: наблюдение ставится на каталог', () => {
  it('примитив зовётся с каталогом файла, а не с путём файла', () => {
    const manual = manualWatch();
    dirWatcher(LOCK_PATH, DEBOUNCE_MS, manual.primitive).start(() => {});

    expect(manual.watched).toEqual([dirname(LOCK_PATH)]);
    expect(manual.watched).not.toContain(LOCK_PATH);
  });

  it('чужое имя в каталоге не будит вотчер', () => {
    const manual = manualWatch();
    const onChange = vi.fn();
    dirWatcher(LOCK_PATH, DEBOUNCE_MS, manual.primitive).start(onChange);

    manual.emit('change', 'other.txt');
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(onChange).not.toHaveBeenCalled();
  });

  it('своё имя будит', () => {
    const manual = manualWatch();
    const onChange = vi.fn();
    dirWatcher(LOCK_PATH, DEBOUNCE_MS, manual.primitive).start(onChange);

    manual.emit('rename', basename(LOCK_PATH));
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('событие без имени файла будит: пропущенное уведомление дороже лишней перезагрузки', () => {
    const manual = manualWatch();
    const onChange = vi.fn();
    dirWatcher(LOCK_PATH, DEBOUNCE_MS, manual.primitive).start(onChange);

    manual.emit('change', null);
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('stop закрывает дескриптор', () => {
    const manual = manualWatch();
    const watcher = dirWatcher(LOCK_PATH, DEBOUNCE_MS, manual.primitive);
    watcher.start(() => {});
    watcher.stop();

    expect(manual.closed()).toBe(1);
  });
});

describe('nodeWatch: у наблюдателя есть слушатель error', () => {
  it('ошибка вотчера доезжает наверх и закрывает его, а не убивает процесс', () => {
    // `FSWatcher` — `EventEmitter`, и документированное событие `error` (каталог удалён или
    // переименован, EPERM, исчерпан лимит наблюдателей) БЕЗ слушателя бросается наверх и
    // завершает процесс. Для долгоживущего демона это отказ обслуживания из операции над
    // каталогом репозитория.
    let emit: ((error: unknown) => void) | null = null;
    let closed = 0;
    const fake: WatcherLike = {
      on: (_event, listener) => void (emit = listener),
      close: () => void (closed += 1),
    };

    const seen: unknown[] = [];
    nodeWatchWith(() => fake)('/repo', () => {}, (error) => void seen.push(error));

    expect(emit).not.toBeNull();
    (emit as unknown as (error: unknown) => void)(new Error('EPERM'));

    expect(seen).toHaveLength(1);
    expect(closed).toBe(1);
  });
});

describe('watchPolicy: наблюдаются оба файла', () => {
  it('правка одного только lock расклинивает демон', async () => {
    // Без наблюдения за lock команда `mcpproxy lock` не помогает работающему демону: она
    // пишет `mcpproxy.lock`, время правки `mcpproxy.yaml` не меняется, и `absent` в памяти
    // остаётся навсегда.
    const disk = memoryDisk();
    const store = await started(disk);
    const manual = manualWatch();
    const watching = watchPolicy(store, { manifestPath: MANIFEST_PATH, lockPath: LOCK_PATH }, {
      debounceMs: DEBOUNCE_MS,
      make: (filePath, ms) => dirWatcher(filePath, ms, manual.primitive),
    });

    expect(store.current().verdict.check.status).toBe('absent');

    disk.write(LOCK_PATH, lockTextFor(store.current().manifest.manifest));
    manual.emit('rename', basename(LOCK_PATH));
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();

    expect(store.current().verdict.check.status).toBe('verified');
    watching.stop();
  });

  it('исход КАЖДОЙ перезагрузки уезжает наружу — иначе сломанный манифест невидим', async () => {
    // R2a наизнанку: без этого шва «перечитка не удалась» и «перечитка удалась, ничего не
    // изменилось» наблюдаемо неразличимы. `current()` по R4 остаётся прежним, `reloadCount()`
    // растёт только на успехе, диагностики выбрасывались — оператор правил бы манифест с
    // опечаткой и получал прокси, вечно обслуживающий устаревшую политику, без единой записи.
    const disk = memoryDisk();
    const store = await started(disk);
    const manual = manualWatch();
    const seen: Array<{ source: ReloadSource; result: ReloadResult }> = [];

    const watching = watchPolicy(store, { manifestPath: MANIFEST_PATH, lockPath: LOCK_PATH }, {
      debounceMs: DEBOUNCE_MS,
      make: (filePath, ms) => dirWatcher(filePath, ms, manual.primitive),
      onReload: (source, result) => void seen.push({ source, result }),
    });

    disk.write(MANIFEST_PATH, BROKEN_YAML);
    manual.emit('change', basename(MANIFEST_PATH));
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.source).toBe('manifest');
    expect(seen[0]?.result.outcome).toBe('invalid');
    expect(seen[0]?.result.outcome === 'invalid' && seen[0]?.result.diagnostics.length).toBeGreaterThan(0);
    // И снимок при этом не заменён — прежняя политика продолжает действовать (R4).
    expect(store.current().manifest.digest).toBeTruthy();
    watching.stop();
  });

  it('успешная перезагрузка тоже сообщается, иначе отличить её от неудачи нечем', async () => {
    const disk = memoryDisk();
    const store = await started(disk);
    const manual = manualWatch();
    const seen: Array<{ source: ReloadSource; result: ReloadResult }> = [];

    const watching = watchPolicy(store, { manifestPath: MANIFEST_PATH, lockPath: LOCK_PATH }, {
      debounceMs: DEBOUNCE_MS,
      make: (filePath, ms) => dirWatcher(filePath, ms, manual.primitive),
      onReload: (source, result) => void seen.push({ source, result }),
    });

    disk.write(LOCK_PATH, lockTextFor(store.current().manifest.manifest));
    manual.emit('rename', basename(LOCK_PATH));
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await settle();

    expect(seen.map((one) => [one.source, one.result.outcome])).toEqual([['lock', 'reloaded']]);
    watching.stop();
  });

  it('stop гасит отложенную перезагрузку, а не только дескрипторы', async () => {
    const disk = memoryDisk();
    const store = await started(disk);
    const manual = manualWatch();
    const watching = watchPolicy(store, { manifestPath: MANIFEST_PATH, lockPath: LOCK_PATH }, {
      debounceMs: DEBOUNCE_MS,
      make: (filePath, ms) => dirWatcher(filePath, ms, manual.primitive),
    });

    manual.emit('change', basename(LOCK_PATH));
    watching.stop();
    vi.advanceTimersByTime(DEBOUNCE_MS * 10);
    await settle();

    expect(store.reloadCount()).toBe(0);
    expect(manual.closed()).toBe(2);
  });
});
