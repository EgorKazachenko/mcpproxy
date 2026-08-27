import { describe, expect, it, vi } from 'vitest';
import { MANIFEST_MAX_BYTES, normalizeDefaults, normalizeRecipe } from '@mcpproxy/contracts';
import type { LockEntry, LockFile, Manifest } from '@mcpproxy/contracts';
import { manifestHash, recipeHash } from '@mcpproxy/contracts/audit';
import { LOCK_MAX_BYTES, startStore } from './store.js';
import type { StartedStore, StoreDeps } from './store.js';

const MANIFEST_PATH = '/repo/mcpproxy.yaml';
const LOCK_PATH = '/repo/mcpproxy.lock';

const MANIFEST_YAML = `version: 1

defaults:
  timeout: 120s
  output:
    maxBytes: 65536
    redact: true
  env:
    allow: ["PATH", "HOME"]
  sandbox:
    read:
      deny: ["~/.ssh"]
      allow: ["."]
    write:
      allow: []
    network:
      allow: []

tools:
  run_tests:
    description: "Прогнать тесты проекта"
    exec: ["pnpm", "test"]
    cwd: "."
    annotations:
      readOnlyHint: false
      destructiveHint: false
      idempotentHint: true
      openWorldHint: false
    sandbox:
      write:
        allow: ["/tmp"]
      network:
        allow: []
`;

const CHANGED_YAML = MANIFEST_YAML.replace('Прогнать тесты проекта', 'Прогнать тесты и собрать покрытие');

/** Ошибка ФС в той форме, в какой её приносит `node:fs/promises`. */
const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: тестовая ошибка`), { code });

/**
 * Диск в памяти. Тесты загрузки не создают временных каталогов: R1a требует наблюдать
 * **порядок** `statSize` → `readFile`, а на настоящей ФС этот порядок не наблюдаем.
 */
function memoryDisk(files: Record<string, string>) {
  const disk = new Map(Object.entries(files));
  const sizeOverrides = new Map<string, number>();
  const failures = new Map<string, string>();
  const readFile = vi.fn(async (path: string) => {
    const text = disk.get(path);
    if (text === undefined) throw errno('ENOENT');
    return text;
  });
  const statSize = vi.fn(async (path: string) => {
    const failure = failures.get(path);
    if (failure !== undefined) throw errno(failure);
    const override = sizeOverrides.get(path);
    if (override !== undefined) return override;
    const text = disk.get(path);
    if (text === undefined) throw errno('ENOENT');
    return Buffer.byteLength(text, 'utf8');
  });

  return {
    deps: { statSize, readFile } satisfies StoreDeps,
    statSize,
    readFile,
    write: (path: string, text: string) => disk.set(path, text),
    /** Файл на месте, но `stat` по нему отказывает — форма, отличная от «файла нет». */
    fail: (path: string, code: string) => failures.set(path, code),
    pretendSize: (path: string, size: number) => sizeOverrides.set(path, size),
  };
}

/** Честный lock для уже загруженного манифеста — то, что записала бы команда `mcpproxy lock`. */
function lockTextFor(manifest: Manifest): string {
  const tools: Record<string, LockEntry> = {};
  for (const [name, recipe] of Object.entries(manifest.tools)) {
    const snapshot = normalizeRecipe(recipe, manifest.defaults);
    tools[name] = { recipeHash: recipeHash(snapshot), approvedAt: '2026-08-28T00:00:00.000Z', snapshot };
  }
  const lock: LockFile = {
    version: 2,
    manifestHash: manifestHash(manifest),
    defaults: normalizeDefaults(manifest.defaults),
    tools,
  };
  return JSON.stringify(lock, null, 2);
}

async function started(disk: ReturnType<typeof memoryDisk>): Promise<StartedStore> {
  const result = await startStore(MANIFEST_PATH, LOCK_PATH, disk.deps);
  if (result.outcome !== 'started') throw new Error(`ожидался старт, получено ${result.outcome}`);
  return result.store;
}

describe('startStore: отказ старта имеет форму', () => {
  it('манифест с диагностиками не даёт store вовсе', async () => {
    const disk = memoryDisk({ [MANIFEST_PATH]: 'version: 1\ndefaults: {}\ntools: {}\n' });
    const result = await startStore(MANIFEST_PATH, LOCK_PATH, disk.deps);

    expect(result.outcome).toBe('invalid-manifest');
    expect(result.outcome === 'invalid-manifest' && result.diagnostics.length).toBeGreaterThan(0);
  });

  it('нечитаемый манифест и несоответствующий отличаются тегом — иначе E4 не узнает причину', async () => {
    const disk = memoryDisk({});
    const result = await startStore(MANIFEST_PATH, LOCK_PATH, disk.deps);

    expect(result.outcome).toBe('unreadable-manifest');
    expect(result.outcome === 'unreadable-manifest' && result.code).toBe('ENOENT');
  });

  it('предел размера проверяется ДО чтения в память', async () => {
    const disk = memoryDisk({ [MANIFEST_PATH]: MANIFEST_YAML });
    disk.pretendSize(MANIFEST_PATH, MANIFEST_MAX_BYTES + 1);

    const result = await startStore(MANIFEST_PATH, LOCK_PATH, disk.deps);

    expect(result.outcome).toBe('invalid-manifest');
    expect(result.outcome === 'invalid-manifest' && result.diagnostics[0]?.code).toBe('size-limit');
    expect(disk.readFile).not.toHaveBeenCalled();
  });

  it('тот же предел стоит и у lock, и тоже до чтения', async () => {
    const disk = memoryDisk({ [MANIFEST_PATH]: MANIFEST_YAML, [LOCK_PATH]: '{}' });
    disk.pretendSize(LOCK_PATH, LOCK_MAX_BYTES + 1);

    const store = await started(disk);

    expect(store.current().lock).toEqual({
      present: false,
      reason: 'unreadable',
      code: 'ERR_SIZE_LIMIT',
      message: expect.stringContaining(String(LOCK_MAX_BYTES)) as unknown as string,
    });
    expect(disk.readFile).toHaveBeenCalledTimes(1);
    expect(disk.readFile).toHaveBeenCalledWith(MANIFEST_PATH);
  });
});

describe('startStore: манифест заморожен вглубь', () => {
  it('подмена exec после успешной валидации бросает, а не проходит молча', async () => {
    const store = await started(memoryDisk({ [MANIFEST_PATH]: MANIFEST_YAML }));
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
    const store = await started(memoryDisk({ [MANIFEST_PATH]: MANIFEST_YAML }));

    expect(store.current().lock).toEqual({ present: false, reason: 'missing' });
    expect(store.current().verdict.check.status).toBe('absent');
  });

  it('файл не читается — unreadable с кодом, а не missing', async () => {
    const disk = memoryDisk({ [MANIFEST_PATH]: MANIFEST_YAML });
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
    const disk = memoryDisk({ [MANIFEST_PATH]: MANIFEST_YAML });
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
    const disk = memoryDisk({ [MANIFEST_PATH]: MANIFEST_YAML });
    const store = await started(disk);
    const before = store.current().manifest.digest;

    disk.write(MANIFEST_PATH, 'version: 1\ndefaults: {}\ntools: {}\n');
    const result = await store.reloadManifest();

    expect(result.outcome).toBe('invalid');
    expect(result.outcome === 'invalid' && result.diagnostics.length).toBeGreaterThan(0);
    expect(store.current().manifest.digest).toBe(before);
    expect(store.reloadCount()).toBe(0);
  });

  it('нечитаемая перечитка отличается от несоответствующей', async () => {
    const disk = memoryDisk({ [MANIFEST_PATH]: MANIFEST_YAML });
    const store = await started(disk);
    disk.fail(MANIFEST_PATH, 'EACCES');

    const result = await store.reloadManifest();

    expect(result.outcome).toBe('unreadable');
    expect(result.outcome === 'unreadable' && result.code).toBe('EACCES');
  });

  it('успешная перечитка двигает снимок и пересчитывает вердикт', async () => {
    const disk = memoryDisk({ [MANIFEST_PATH]: MANIFEST_YAML });
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
    const disk = memoryDisk({ [MANIFEST_PATH]: MANIFEST_YAML });
    const store = await started(disk);
    const readsAfterStart = disk.readFile.mock.calls.length;

    disk.write(LOCK_PATH, lockTextFor(store.current().manifest.manifest));
    await store.reloadLock();

    const readsAfterLock = disk.readFile.mock.calls.slice(readsAfterStart).map(([path]) => path);
    expect(readsAfterLock).toEqual([LOCK_PATH]);
  });
});
