import { randomUUID } from 'node:crypto';
import { open as fsOpen, rename as fsRename, unlink as fsUnlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { normalizeDefaults, normalizeRecipe } from '@mcpproxy/contracts';
import type { LockEntry, LockFile } from '@mcpproxy/contracts';
import { recipeHash } from '@mcpproxy/contracts/audit';
import type { LoadedManifest } from './lock-check.js';

/**
 * Сборка и запись `mcpproxy.lock`.
 *
 * `buildLock` берёт `LoadedManifest`, а не `Manifest`: предусловие «манифест прошёл
 * `parseManifest`» держится типом, поэтому `durationToMs` внутри `normalizeRecipe` не
 * встретит непроверенный текст и не бросит на пути записи.
 *
 * `recipeHash` считается **от того же значения**, которое ложится в `snapshot`. Именно эту
 * пару потом сверяет `verifyLockEntries`, и выводя обе стороны из одного `snapshot`, мы
 * делаем инвариант истинным по построению, а не по дисциплине.
 */

export function buildLock(loaded: LoadedManifest, approvedAt: string): LockFile {
  const { manifest } = loaded;
  const tools: Record<string, LockEntry> = {};

  for (const [name, recipe] of Object.entries(manifest.tools)) {
    const snapshot = normalizeRecipe(recipe, manifest.defaults);
    tools[name] = { recipeHash: recipeHash(snapshot), approvedAt, snapshot };
  }

  // Дайджест — тот, что посчитала загрузка по канонической форме. Печать его не двигает.
  return { version: 2, manifestHash: loaded.digest, defaults: normalizeDefaults(manifest.defaults), tools };
}

export interface FileHandleLike {
  write(text: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface WriteDeps {
  /** Полный путь временного файла. Обязан лежать в том же каталоге, что и lock. */
  readonly tempPath: (lockPath: string) => string;
  readonly open: (path: string, flags: string) => Promise<FileHandleLike>;
  readonly rename: (from: string, to: string) => Promise<void>;
}

/**
 * Временный файл — **в том же каталоге** (иначе `rename` через границу ФС не атомарен) и с
 * уникальным именем: два одновременных запуска команды не должны писать в один и тот же путь.
 */
const nodeTempPath = (lockPath: string): string =>
  join(dirname(lockPath), `.${basename(lockPath)}.${process.pid}.${randomUUID()}.tmp`);

const nodeOpen = async (path: string, flags: string): Promise<FileHandleLike> => {
  const handle = await fsOpen(path, flags);
  return {
    write: async (text) => void (await handle.write(text, null, 'utf8')),
    sync: () => handle.sync(),
    close: () => handle.close(),
  };
};

const defaultWriteDeps: WriteDeps = { tempPath: nodeTempPath, open: nodeOpen, rename: fsRename };

/**
 * Атомарная запись: временный файл в том же каталоге, `fsync`, затем `rename`.
 *
 * Флаг `wx`, а не `w`: имя уникально, и столкновение означает, что рядом работает второй
 * процесс, — это ошибка, а не повод перезаписать чужой файл.
 *
 * Содержимое сбрасывается на диск **до** `rename`. `rename` атомарен по видимости, но не по
 * долговечности: обрыв питания после него оставляет lock нулевой длины. Это не дыра — пустой
 * lock читается как `absent` и даёт отказ, — но он уничтожает запись об одобрении и заставляет
 * человека одобрять заново. По той же причине после `rename` синхронизируется и каталог: сама
 * запись в каталог тоже не долговечна.
 *
 * Печать — с отступом: файл читают глазами в ревью гита. Хэши к этому моменту уже посчитаны
 * `buildLock` по канонической форме и от печатных байтов не зависят.
 */
export async function writeLock(lockPath: string, lock: LockFile, deps: Partial<WriteDeps> = {}): Promise<void> {
  const resolved: WriteDeps = { ...defaultWriteDeps, ...deps };
  const temp = resolved.tempPath(lockPath);

  let handle: FileHandleLike | null = null;
  try {
    handle = await resolved.open(temp, 'wx');
    await handle.write(`${JSON.stringify(lock, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await resolved.rename(temp, lockPath);
  } catch (error) {
    // При любой ошибке временный файл удаляется: иначе каждая неудача оставляет мусор рядом
    // с lock, а уникальное имя гарантирует, что мусор не переиспользуется.
    if (handle !== null) await handle.close().catch(() => undefined);
    await fsUnlink(temp).catch(() => undefined);
    throw error;
  }

  const directory = await resolved.open(dirname(lockPath), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
