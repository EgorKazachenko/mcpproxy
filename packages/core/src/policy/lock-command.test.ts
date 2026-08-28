import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LockFile } from '@mcpproxy/contracts';
import type { LockApprovalRequest, LockApprovalVerdict } from './approve.js';
import { LockWriteError } from './lock-write.js';
import type { WriteResult } from './lock-write.js';
import { mainLockCommand, runLockCommand } from './lock-command.js';
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
import type { MemoryDisk } from './policy.fixture.js';
import type { StartedStore } from './store.js';

const NOW = '2026-08-28T00:00:00.000Z';

/** `confirm`, который записывает, о чём его спросили, и отвечает заданным решением. */
function human(decision: 'approved' | 'denied', before?: () => void) {
  const asked: LockApprovalRequest[] = [];
  const shown: string[] = [];

  const confirm = async (request: LockApprovalRequest, rendered: string): Promise<LockApprovalVerdict> => {
    asked.push(request);
    shown.push(rendered);
    before?.();
    return { manifestHash: request.manifestHash, decision, decidedAt: NOW };
  };

  return { confirm, asked, shown };
}

/** Запись в тот же диск в памяти, чтобы «файл создан» было наблюдаемым. */
function writer(disk: MemoryDisk, fail?: Error) {
  const written: LockFile[] = [];
  return {
    written,
    write: async (lockPath: string, lock: LockFile): Promise<WriteResult> => {
      if (fail !== undefined) throw fail;
      written.push(lock);
      disk.write(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
      return { durable: true };
    },
  };
}

async function approvedStore(): Promise<{ store: StartedStore; disk: MemoryDisk }> {
  const disk = memoryDisk();
  const store = await started(disk);
  disk.write(LOCK_PATH, lockTextFor(store.current().manifest.manifest));
  await store.reloadLock();
  return { store, disk };
}

describe('runLockCommand: писать нечего', () => {
  it('на verified команда не спрашивает и не пишет', async () => {
    const { store, disk } = await approvedStore();
    const asker = human('approved');
    const sink = writer(disk);

    const outcome = await runLockCommand(store, asker.confirm, null, { lockPath: LOCK_PATH, now: () => NOW, write: sink.write });

    expect(outcome).toEqual({ kind: 'up-to-date' });
    expect(asker.asked).toEqual([]);
    expect(sink.written).toEqual([]);
  });
});

describe('runLockCommand: беззвучных веток не осталось', () => {
  it('дрифт показывается, и отказ человека ничего не пишет', async () => {
    const { store, disk } = await approvedStore();
    disk.write(MANIFEST_PATH, CHANGED_YAML);
    await store.reloadManifest();
    const asker = human('denied');
    const sink = writer(disk);

    const outcome = await runLockCommand(store, asker.confirm, null, { lockPath: LOCK_PATH, now: () => NOW, write: sink.write });

    expect(asker.asked.map((one) => one.kind)).toEqual(['drift']);
    expect(outcome).toEqual({ kind: 'refused', why: 'denied' });
    expect(sink.written).toEqual([]);
  });

  it('«файла нет» тоже показывается, и при отказе файл не создаётся', async () => {
    // Удалить lock дешевле, чем испортить: беззвучная ветка здесь закрепила бы отравленный
    // манифест, ни разу его не показав.
    const disk = memoryDisk();
    const store = await started(disk);
    const asker = human('denied');
    const sink = writer(disk);

    const outcome = await runLockCommand(store, asker.confirm, null, { lockPath: LOCK_PATH, now: () => NOW, write: sink.write });

    expect(asker.asked.map((one) => one.kind)).toEqual(['first']);
    expect(outcome).toEqual({ kind: 'refused', why: 'denied' });
    expect(sink.written).toEqual([]);
  });

  it('битый lock спрашивает ветвью unusable, а не пишет молча', async () => {
    const stale = JSON.stringify({ version: 1, manifestHash: 'a'.repeat(64), tools: {} });
    const disk = memoryDisk();
    disk.write(LOCK_PATH, stale);
    const store = await started(disk);
    const asker = human('denied');
    const sink = writer(disk);

    const outcome = await runLockCommand(store, asker.confirm, null, { lockPath: LOCK_PATH, now: () => NOW, write: sink.write });

    expect(asker.asked.map((one) => one.kind)).toEqual(['unusable']);
    expect(outcome).toEqual({ kind: 'refused', why: 'denied' });
    expect(sink.written).toEqual([]);
  });
});

describe('runLockCommand: успешный путь', () => {
  it('подтверждение при неизменившемся манифесте ПИШЕТ', async () => {
    // След на успех, а не только на отказ: без него реализация, не умеющая писать вообще
    // никогда, проходила бы все остальные утверждения этого файла.
    const { store, disk } = await approvedStore();
    disk.write(MANIFEST_PATH, CHANGED_YAML);
    await store.reloadManifest();
    const asker = human('approved');
    const sink = writer(disk);

    const outcome = await runLockCommand(store, asker.confirm, null, { lockPath: LOCK_PATH, now: () => NOW, write: sink.write });

    expect(outcome).toEqual({ kind: 'written', durable: true });
    expect(sink.written).toHaveLength(1);
    expect(sink.written[0]?.manifestHash).toBe(store.current().manifest.digest);
  });

  it('и записанное действительно сверяется как verified', async () => {
    const { store, disk } = await approvedStore();
    disk.write(MANIFEST_PATH, CHANGED_YAML);
    await store.reloadManifest();
    const sink = writer(disk);

    await runLockCommand(store, human('approved').confirm, null, { lockPath: LOCK_PATH, now: () => NOW, write: sink.write });
    await store.reloadLock();

    expect(store.current().verdict.check.status).toBe('verified');
  });

  it('первый lock появляется по этой команде и чинит denied (absent)', async () => {
    const disk = memoryDisk();
    const store = await started(disk);
    expect(store.current().verdict.check.status).toBe('absent');
    const sink = writer(disk);

    const outcome = await runLockCommand(store, human('approved').confirm, null, { lockPath: LOCK_PATH, now: () => NOW, write: sink.write });
    await store.reloadLock();

    expect(outcome).toEqual({ kind: 'written', durable: true });
    expect(store.current().verdict.check.status).toBe('verified');
  });
});

describe('runLockCommand: окно CVE-2025-54136', () => {
  it('правка манифеста между показом и ответом отвергается как устаревшая', async () => {
    // Человек читает дифф в T₀, атакующий правит манифест в T₁. Сравнение снимка, взятого до
    // показа, с самим собой прошло бы здесь всегда — это тавтология, а не проверка.
    const { store, disk } = await approvedStore();
    disk.write(MANIFEST_PATH, CHANGED_YAML);
    await store.reloadManifest();

    const attacked = MANIFEST_YAML_WITH('Отравлено');
    const asker = human('approved', () => disk.write(MANIFEST_PATH, attacked));
    const sink = writer(disk);

    const outcome = await runLockCommand(store, asker.confirm, null, { lockPath: LOCK_PATH, now: () => NOW, write: sink.write });

    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.why).toBe('stale');
    // Улика, а не тег: оператор должен увидеть, что одобрял и что лежит на диске.
    expect(outcome.kind === 'refused' && outcome.why === 'stale' && outcome.approved).not.toBe(
      outcome.kind === 'refused' && outcome.why === 'stale' && outcome.onDisk,
    );
    expect(sink.written).toEqual([]);
  });

  it('перечитка, вернувшая диагностики, тоже отказ, а не тихая запись', async () => {
    const { store, disk } = await approvedStore();
    disk.write(MANIFEST_PATH, CHANGED_YAML);
    await store.reloadManifest();

    const asker = human('approved', () => disk.write(MANIFEST_PATH, BROKEN_YAML));
    const sink = writer(disk);

    const outcome = await runLockCommand(store, asker.confirm, null, { lockPath: LOCK_PATH, now: () => NOW, write: sink.write });

    expect(outcome.kind === 'refused' && outcome.why).toBe('reload-failed');
    expect(outcome.kind === 'refused' && outcome.why === 'reload-failed' && outcome.diagnostics.length).toBeGreaterThan(0);
    expect(sink.written).toEqual([]);
  });
});

describe('runLockCommand: expectDigest связывает процессы', () => {
  it('чужой дайджест отвергается ДО показа', async () => {
    const disk = memoryDisk();
    const store = await started(disk);
    const asker = human('approved');
    const sink = writer(disk);

    const outcome = await runLockCommand(store, asker.confirm, 'f'.repeat(64), { lockPath: LOCK_PATH, now: () => NOW, write: sink.write });

    expect(outcome.kind === 'refused' && outcome.why).toBe('expect-mismatch');
    expect(outcome.kind === 'refused' && outcome.why === 'expect-mismatch' && outcome.expected).toBe('f'.repeat(64));
    expect(asker.asked).toEqual([]);
    expect(sink.written).toEqual([]);
  });

  it('свой дайджест пропускает', async () => {
    const disk = memoryDisk();
    const store = await started(disk);
    const sink = writer(disk);

    const outcome = await runLockCommand(store, human('approved').confirm, store.current().manifest.digest, {
      lockPath: LOCK_PATH,
      now: () => NOW,
      write: sink.write,
    });

    expect(outcome).toEqual({ kind: 'written', durable: true });
  });
});

describe('runLockCommand: отказ записи — свой исход, а не отказ человека', () => {
  it('ошибка записи не улетает исключением и не притворяется отказом', async () => {
    // До правки исключение уходило в top-level await скрипта и давало код 1 — тот же, что и
    // «человек сказал нет», то есть EACCES и осознанный отказ были неразличимы для CI.
    const disk = memoryDisk();
    const store = await started(disk);
    const sink = writer(disk, new LockWriteError('ERR_LOCK_TOO_LARGE', 'lock занял бы слишком много'));

    const outcome = await runLockCommand(store, human('approved').confirm, null, {
      lockPath: LOCK_PATH,
      now: () => NOW,
      write: sink.write,
    });

    expect(outcome).toEqual({
      kind: 'write-failed',
      code: 'ERR_LOCK_TOO_LARGE',
      message: 'lock занял бы слишком много',
    });
  });

  it('несинхронизированный каталог — предупреждение, а не отказ: файл уже записан', async () => {
    const disk = memoryDisk();
    const store = await started(disk);

    const outcome = await runLockCommand(store, human('approved').confirm, null, {
      lockPath: LOCK_PATH,
      now: () => NOW,
      write: async () => ({ durable: false, reason: 'EPERM' }),
    });

    expect(outcome).toEqual({ kind: 'written', durable: false, reason: 'EPERM' });
  });
});

describe('mainLockCommand: контракт кодов выхода', () => {
  it('сломанный манифест — код 2 и никакого lock', async () => {
    // Единственная ветка `mainLockCommand`, не требующая stdin, — и она же охраняет R3:
    // сломанный манифест есть отказ, а не повод записать lock. `return 0`, просочившийся сюда,
    // уехал бы зелёным без этого утверждения.
    const dir = mkdtempSync(join(tmpdir(), 'mcpproxy-main-'));
    try {
      writeFileSync(join(dir, 'mcpproxy.yaml'), BROKEN_YAML);
      expect(await mainLockCommand([], dir)).toBe(2);
      expect(existsSync(join(dir, 'mcpproxy.lock'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('битый --expect отказывает ДО загрузки и не пишет ничего', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpproxy-main-'));
    try {
      writeFileSync(join(dir, 'mcpproxy.yaml'), MANIFEST_YAML);
      expect(await mainLockCommand(['--expect'], dir)).toBe(2);
      expect(existsSync(join(dir, 'mcpproxy.lock'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function MANIFEST_YAML_WITH(description: string): string {
  return CHANGED_YAML.replace('Прогнать тесты и собрать покрытие', description);
}
