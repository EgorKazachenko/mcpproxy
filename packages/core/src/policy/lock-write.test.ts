import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { manifestHash } from '@mcpproxy/contracts/audit';
import { parseLockFile } from '@mcpproxy/contracts/validate';
import { LOCK_PATH, memoryDisk, started } from './policy.fixture.js';
import { buildLock, writeLock } from './lock-write.js';
import type { FileHandleLike, WriteDeps } from './lock-write.js';
import type { LoadedManifest } from './lock-check.js';

const APPROVED_AT = '2026-08-28T00:00:00.000Z';

let loaded: LoadedManifest;
let dir: string;

beforeEach(async () => {
  loaded = (await started(memoryDisk())).current().manifest;
  dir = mkdtempSync(join(tmpdir(), 'mcpproxy-lock-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Записывает порядок вызовов: ради него `open`, `sync` и `rename` и инъектируются. */
function recorder(over: Partial<WriteDeps> = {}) {
  const calls: string[] = [];
  const opens: Array<{ path: string; flags: string }> = [];

  const handle = (): FileHandleLike => ({
    write: async () => void calls.push('write'),
    sync: async () => void calls.push('sync'),
    close: async () => void calls.push('close'),
  });

  const deps: Partial<WriteDeps> = {
    open: async (path, flags) => {
      opens.push({ path, flags });
      calls.push('open');
      return handle();
    },
    rename: async () => void calls.push('rename'),
    ...over,
  };

  return { calls, opens, deps };
}

describe('buildLock', () => {
  it('форма файла — та, которую читает parseLockFile', () => {
    const lock = buildLock(loaded, APPROVED_AT);
    const parsed = parseLockFile(JSON.stringify(lock, null, 2));

    expect(parsed.ok).toBe(true);
    expect(lock.version).toBe(2);
    expect(lock.tools.run_tests?.approvedAt).toBe(APPROVED_AT);
  });

  it('manifestHash — дайджест канонической формы, а не печатных байтов', () => {
    const lock = buildLock(loaded, APPROVED_AT);

    expect(lock.manifestHash).toBe(manifestHash(loaded.manifest));
    // Контраст: другой манифест — другой дайджест. Без него утверждение выше прошло бы и у
    // реализации, всегда возвращающей одну и ту же строку.
    const other = { ...loaded.manifest, defaults: { ...loaded.manifest.defaults, timeout: '300s' } };
    expect(lock.manifestHash).not.toBe(manifestHash(other));
  });

  it('снапшот и его дайджест выведены из одного значения — verifyLockEntries доволен', async () => {
    const { verifyLockEntries } = await import('@mcpproxy/contracts/audit');
    expect(verifyLockEntries(buildLock(loaded, APPROVED_AT))).toEqual({ ok: true });
  });
});

describe('writeLock: атомарность', () => {
  it('временный файл лежит в том же каталоге, что и lock', async () => {
    // `tempPath` здесь НЕ инъектируется: наблюдаемое — путь, который строит умолчание.
    // Подставив свой, тест проверял бы собственную лямбду, а `os.tmpdir()` в реализации
    // проехал бы мимо — а `rename` через границу файловых систем не атомарен.
    const { opens, deps } = recorder();
    const lockPath = join(dir, 'mcpproxy.lock');
    await writeLock(lockPath, buildLock(loaded, APPROVED_AT), deps);

    expect(opens[0]?.path).not.toBe(lockPath);
    expect(dirname(opens[0]?.path as string)).toBe(dir);
  });

  it('имя временного файла уникально: два запуска не пишут в один путь', async () => {
    const lockPath = join(dir, 'mcpproxy.lock');
    const first = recorder();
    const second = recorder();
    await writeLock(lockPath, buildLock(loaded, APPROVED_AT), first.deps);
    await writeLock(lockPath, buildLock(loaded, APPROVED_AT), second.deps);

    expect(first.opens[0]?.path).not.toBe(second.opens[0]?.path);
  });

  it('открывается эксклюзивно: wx, а не w', async () => {
    const { opens, deps } = recorder();
    await writeLock(join(dir, 'mcpproxy.lock'), buildLock(loaded, APPROVED_AT), deps);

    expect(opens[0]?.flags).toBe('wx');
  });

  it('сброс на диск идёт ДО rename, а каталог синхронизируется после', async () => {
    const { calls, deps } = recorder();
    await writeLock(join(dir, 'mcpproxy.lock'), buildLock(loaded, APPROVED_AT), deps);

    expect(calls.indexOf('sync')).toBeLessThan(calls.indexOf('rename'));
    expect(calls).toEqual(['open', 'write', 'sync', 'close', 'rename', 'open', 'sync', 'close']);
  });

  it('при ошибке временный файл удаляется', async () => {
    const lockPath = join(dir, 'mcpproxy.lock');
    writeFileSync(lockPath, '{}');
    const failing: Partial<WriteDeps> = {
      rename: async () => {
        throw new Error('rename упал');
      },
    };

    await expect(writeLock(lockPath, buildLock(loaded, APPROVED_AT), failing)).rejects.toThrow('rename упал');
    expect(readdirSync(dir)).toEqual(['mcpproxy.lock']);
  });
});

describe('writeLock: настоящая запись', () => {
  it('записанный файл читается parseLockFile и печатается с отступом', async () => {
    const lockPath = join(dir, 'mcpproxy.lock');
    await writeLock(lockPath, buildLock(loaded, APPROVED_AT), {});

    const text = readFileSync(lockPath, 'utf8');
    expect(text).toContain('\n  "version": 2');
    expect(parseLockFile(text).ok).toBe(true);
    expect(readdirSync(dir)).toEqual(['mcpproxy.lock']);
  });

  it('запись поверх существующего lock проходит через временный файл и не оставляет мусора', async () => {
    const lockPath = join(dir, 'mcpproxy.lock');
    writeFileSync(lockPath, 'старое содержимое');
    await writeLock(lockPath, buildLock(loaded, APPROVED_AT), {});

    expect(readdirSync(dir)).toEqual(['mcpproxy.lock']);
    expect(readFileSync(lockPath, 'utf8')).not.toContain('старое содержимое');
  });

  it('lock, записанный этой парой, сверяется как verified', async () => {
    const disk = memoryDisk();
    const store = await started(disk);
    const lockPath = join(dir, 'mcpproxy.lock');
    await writeLock(lockPath, buildLock(store.current().manifest, APPROVED_AT), {});

    disk.write(LOCK_PATH, readFileSync(lockPath, 'utf8'));
    await store.reloadLock();

    expect(store.current().verdict.check.status).toBe('verified');
  });
});
