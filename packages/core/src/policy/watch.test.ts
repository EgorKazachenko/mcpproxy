import { basename, dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCK_PATH, MANIFEST_PATH, lockTextFor, memoryDisk, settle, started } from './policy.fixture.js';
import { debounce, dirWatcher, watchPolicy } from './watch.js';
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
