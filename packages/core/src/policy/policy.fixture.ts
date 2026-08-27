import { normalizeDefaults, normalizeRecipe } from '@mcpproxy/contracts';
import type { LockEntry, LockFile, Manifest } from '@mcpproxy/contracts';
import { manifestHash, recipeHash } from '@mcpproxy/contracts/audit';
import { startStore } from './store.js';
import type { StartedStore, StoreDeps } from './store.js';

/**
 * Общая оснастка тестов политики: диск в памяти и честный lock.
 *
 * Диск именно в памяти, а не временный каталог: R1a требует наблюдать **порядок**
 * `statSize` → `readFile`, а на настоящей ФС этот порядок не наблюдаем. Тем же приёмом
 * тесты вотчера получают детерминированную перезагрузку без единого настоящего события ФС.
 *
 * Счётчики вызовов — обычные массивы, а не `vi.fn`: файл лежит в `src` и компилируется в
 * `dist`, а тянуть тестовый раннер в отгружаемый пакет незачем.
 *
 * В баррель пакета файл не входит.
 */

export const MANIFEST_PATH = '/repo/mcpproxy.yaml';
export const LOCK_PATH = '/repo/mcpproxy.lock';

export const MANIFEST_YAML = `version: 1

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

export const CHANGED_YAML = MANIFEST_YAML.replace('Прогнать тесты проекта', 'Прогнать тесты и собрать покрытие');

export const BROKEN_YAML = 'version: 1\ndefaults: {}\ntools: {}\n';

/** Ошибка ФС в той форме, в какой её приносит `node:fs/promises`. */
export const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: тестовая ошибка`), { code });

export interface MemoryDisk {
  readonly deps: StoreDeps;
  /** Пути, по которым спрашивали размер, в порядке вызова. */
  readonly stats: readonly string[];
  /** Пути, которые действительно читали, в порядке вызова. */
  readonly reads: readonly string[];
  write(path: string, text: string): void;
  /** Файл на месте, но `stat` по нему отказывает — форма, отличная от «файла нет». */
  fail(path: string, code: string): void;
  pretendSize(path: string, size: number): void;
}

export function memoryDisk(files: Record<string, string> = { [MANIFEST_PATH]: MANIFEST_YAML }): MemoryDisk {
  const disk = new Map(Object.entries(files));
  const sizeOverrides = new Map<string, number>();
  const failures = new Map<string, string>();

  const stats: string[] = [];
  const reads: string[] = [];

  const readFile = async (path: string): Promise<string> => {
    reads.push(path);
    const text = disk.get(path);
    if (text === undefined) throw errno('ENOENT');
    return text;
  };
  const statSize = async (path: string): Promise<number> => {
    stats.push(path);
    const failure = failures.get(path);
    if (failure !== undefined) throw errno(failure);
    const override = sizeOverrides.get(path);
    if (override !== undefined) return override;
    const text = disk.get(path);
    if (text === undefined) throw errno('ENOENT');
    return Buffer.byteLength(text, 'utf8');
  };

  return {
    deps: { statSize, readFile },
    stats,
    reads,
    write: (path, text) => void disk.set(path, text),
    fail: (path, code) => void failures.set(path, code),
    pretendSize: (path, size) => void sizeOverrides.set(path, size),
  };
}

/** Честный lock для уже загруженного манифеста — то, что записала бы команда `mcpproxy lock`. */
export function lockTextFor(manifest: Manifest): string {
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

export async function started(disk: MemoryDisk): Promise<StartedStore> {
  const result = await startStore(MANIFEST_PATH, LOCK_PATH, disk.deps);
  if (result.outcome !== 'started') throw new Error(`ожидался старт, получено ${result.outcome}`);
  return result.store;
}

/**
 * Прокрутка микрозадач. Вотчер вызывает перезагрузку, ничего не возвращая, поэтому дождаться
 * её можно только исчерпав очередь; на диске в памяти каждый `await` резолвится немедленно.
 */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}
