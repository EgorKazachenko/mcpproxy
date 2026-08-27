import { describe, expect, it } from 'vitest';
import { MANIFEST_MAX_BYTES } from '@mcpproxy/contracts';
import {
  BROKEN_YAML,
  CHANGED_YAML,
  LOCK_PATH,
  MANIFEST_PATH,
  MANIFEST_YAML,
  lockTextFor,
  memoryDisk,
  started,
} from './policy.fixture.js';
import { LOCK_MAX_BYTES, startStore } from './store.js';

describe('startStore: отказ старта имеет форму', () => {
  it('манифест с диагностиками не даёт store вовсе', async () => {
    const disk = memoryDisk({ [MANIFEST_PATH]: BROKEN_YAML });
    const result = await startStore(MANIFEST_PATH, LOCK_PATH, disk.deps);

    expect(result.outcome).toBe('invalid-manifest');
    expect(result.outcome === 'invalid-manifest' && result.diagnostics.length).toBeGreaterThan(0);
  });

  it('нечитаемый манифест и несоответствующий отличаются тегом — иначе E4 не узнает причину', async () => {
    const result = await startStore(MANIFEST_PATH, LOCK_PATH, memoryDisk({}).deps);

    expect(result.outcome).toBe('unreadable-manifest');
    expect(result.outcome === 'unreadable-manifest' && result.code).toBe('ENOENT');
  });

  it('предел размера манифеста проверяется ДО чтения в память', async () => {
    const disk = memoryDisk();
    disk.pretendSize(MANIFEST_PATH, MANIFEST_MAX_BYTES + 1);

    const result = await startStore(MANIFEST_PATH, LOCK_PATH, disk.deps);

    expect(result.outcome).toBe('invalid-manifest');
    expect(result.outcome === 'invalid-manifest' && result.diagnostics[0]?.code).toBe('size-limit');
    expect(disk.stats).toEqual([MANIFEST_PATH]);
    expect(disk.reads).toEqual([]);
  });

  it('тот же предел стоит и у lock, и тоже до чтения', async () => {
    const disk = memoryDisk({ [MANIFEST_PATH]: MANIFEST_YAML, [LOCK_PATH]: '{}' });
    disk.pretendSize(LOCK_PATH, LOCK_MAX_BYTES + 1);

    const store = await started(disk);

    expect(store.current().lock).toMatchObject({ present: false, reason: 'unreadable', code: 'ERR_SIZE_LIMIT' });
    expect(disk.reads).toEqual([MANIFEST_PATH]);
  });
});

describe('startStore: манифест заморожен вглубь', () => {
  it('подмена exec после успешной валидации бросает, а не проходит молча', async () => {
    const store = await started(memoryDisk());
    const recipe = store.current().manifest.manifest.tools.run_tests;

    expect(recipe).toBeDefined();
    expect(() => {
      if (recipe !== undefined) recipe.exec[0] = '/bin/sh';
    }).toThrow(TypeError);
    expect(store.current().manifest.manifest.tools.run_tests?.exec[0]).toBe('pnpm');
  });
});

describe('startStore: lock и его четыре формы', () => {
  it('файла нет — missing, и вызов упирается в denied', async () => {
    const store = await started(memoryDisk());

    expect(store.current().lock).toEqual({ present: false, reason: 'missing' });
    expect(store.current().verdict.check.status).toBe('absent');
  });

  it('файл не читается — unreadable с кодом, а не missing', async () => {
    const disk = memoryDisk();
    disk.fail(LOCK_PATH, 'EACCES');
    const store = await started(disk);

    expect(store.current().lock).toMatchObject({ present: false, reason: 'unreadable', code: 'EACCES' });
  });

  it('lock формы version: 1 читается как absent и отдаёт ДВЕ диагностики, а не исключение', async () => {
    const stale = JSON.stringify({ version: 1, manifestHash: 'a'.repeat(64), tools: {} });
    const store = await started(memoryDisk({ [MANIFEST_PATH]: MANIFEST_YAML, [LOCK_PATH]: stale }));
    const { lock, verdict } = store.current();

    expect(lock).toMatchObject({ present: false, reason: 'unparsed' });
    expect(verdict.check.status).toBe('absent');
    // Число измерено на настоящем `parseLockFile`: версия и отсутствующий слот `defaults`.
    // Без переноса диагностик в вердикт R17a не наблюдаем нигде.
    expect(verdict.diagnostics).toHaveLength(2);
    expect(verdict.diagnostics.every((one) => one.code === 'lock')).toBe(true);
  });

  it('честный lock даёт verified', async () => {
    const disk = memoryDisk();
    const store = await started(disk);
    disk.write(LOCK_PATH, lockTextFor(store.current().manifest.manifest));

    const reloaded = await store.reloadLock();

    expect(reloaded.outcome).toBe('reloaded');
    expect(store.current().verdict.check.status).toBe('verified');
    expect(store.current().verdict.denyReason).toBeNull();
  });
});

describe('startStore: перечитка', () => {
  it('неуспешная перечитка НЕ заменяет рабочий манифест и отдаёт диагностики', async () => {
    const disk = memoryDisk();
    const store = await started(disk);
    const before = store.current().manifest.digest;

    disk.write(MANIFEST_PATH, BROKEN_YAML);
    const result = await store.reloadManifest();

    expect(result.outcome).toBe('invalid');
    expect(result.outcome === 'invalid' && result.diagnostics.length).toBeGreaterThan(0);
    expect(store.current().manifest.digest).toBe(before);
    expect(store.reloadCount()).toBe(0);
  });

  it('нечитаемая перечитка отличается от несоответствующей', async () => {
    const disk = memoryDisk();
    const store = await started(disk);
    disk.fail(MANIFEST_PATH, 'EACCES');

    const result = await store.reloadManifest();

    expect(result.outcome).toBe('unreadable');
    expect(result.outcome === 'unreadable' && result.code).toBe('EACCES');
  });

  it('успешная перечитка двигает снимок и пересчитывает вердикт', async () => {
    const disk = memoryDisk();
    const store = await started(disk);
    disk.write(LOCK_PATH, lockTextFor(store.current().manifest.manifest));
    await store.reloadLock();
    expect(store.current().verdict.check.status).toBe('verified');

    disk.write(MANIFEST_PATH, CHANGED_YAML);
    const result = await store.reloadManifest();

    expect(result.outcome).toBe('reloaded');
    expect(store.current().verdict.check.status).toBe('drifted');
    expect(store.reloadCount()).toBe(2);
  });

  it('обновление lock не перечитывает манифест: это разные файлы с разным временем жизни', async () => {
    const disk = memoryDisk();
    const store = await started(disk);
    const readsAfterStart = disk.reads.length;

    disk.write(LOCK_PATH, lockTextFor(store.current().manifest.manifest));
    await store.reloadLock();

    expect(disk.reads.slice(readsAfterStart)).toEqual([LOCK_PATH]);
  });
});
