import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { LOCK_MAX_BYTES, readBounded, startStore } from './store.js';

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

  it('readBounded отказывает на превышении, а не отдаёт усечённое', async () => {
    // Наблюдаемое — поведение самого чтения, а не код диагностики: предел внутри `parseYaml`
    // даёт ровно тот же `size-limit` на уже прочитанной строке, поэтому по диагностике две
    // реализации неразличимы. Здесь же видно то единственное, что важно: сколько байт вообще
    // разрешено втянуть в память.
    const dir = mkdtempSync(join(tmpdir(), 'mcpproxy-bounded-'));
    try {
      const file = join(dir, 'big.txt');
      writeFileSync(file, 'x'.repeat(1000));

      await expect(readBounded(file, 999)).rejects.toMatchObject({ code: 'ERR_SIZE_LIMIT' });
      await expect(readBounded(file, 1000)).resolves.toHaveLength(1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('чтение ограничено сверху НА САМОМ ФАЙЛЕ: солгавший stat не даёт прочитать больше', async () => {
    // Ровно окно между `statSize` и `readFile`: атакующий держит файл маленьким на момент
    // проверки и подменяет его большим до чтения. Порядок вызовов этого не закрывает —
    // закрывает предел, переданный в само чтение. Проверяется на настоящей ФС, потому что
    // защищаемое поведение принадлежит продакшн-реализации `readFile`, а не фикстуре.
    const dir = mkdtempSync(join(tmpdir(), 'mcpproxy-toctou-'));
    try {
      const manifestPath = join(dir, 'mcpproxy.yaml');
      writeFileSync(manifestPath, `# ${'ю'.repeat(MANIFEST_MAX_BYTES)}\n${MANIFEST_YAML}`);

      // `statSize` лжёт, будто файл крошечный: предел «до чтения» пропускает его.
      const result = await startStore(manifestPath, join(dir, 'mcpproxy.lock'), { statSize: async () => 10 });

      expect(result.outcome).toBe('invalid-manifest');
      expect(result.outcome === 'invalid-manifest' && result.diagnostics[0]?.code).toBe('size-limit');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('отклонение не-объектом не превращается в TypeError изнутри собственного catch', async () => {
    // `StoreDeps` публичен, поэтому отклониться `null` может реализация из E4. Модуль,
    // объявивший «никогда не бросает», обязан выдержать и это.
    const result = await startStore(MANIFEST_PATH, LOCK_PATH, {
      statSize: async () => {
        throw null;
      },
    });

    expect(result.outcome).toBe('unreadable-manifest');
    expect(result.outcome === 'unreadable-manifest' && result.code).toBe('UNKNOWN');
  });

  it('предел lock выведен из замера, а не из красивого множителя', () => {
    // Прежнее `4 *` лежало ниже честного отношения манифест→lock (замерено 4.5x на минимальных
    // умолчаниях и 6.9x на реалистичных), и законный манифест давал lock, который эта же сборка
    // объявляла непригодным. Соотношение под тестом, а не число: `MANIFEST_MAX_BYTES` приходит
    // из контрактов, то есть из-за границы пакета.
    expect(LOCK_MAX_BYTES).toBe(16 * MANIFEST_MAX_BYTES);
    expect(LOCK_MAX_BYTES / MANIFEST_MAX_BYTES).toBeGreaterThan(6.94);
  });

  it('чтение ограничено сверху, поэтому подмена между stat и read не даёт прочитать больше', async () => {
    // `statSize` → `readFile` — две операции по пути, который правит в том числе атакующий.
    // Порядок вызовов этого не закрывает: закрывает предел, переданный в само чтение.
    const disk = memoryDisk();
    const store = await started(disk);
    const limits: number[] = [];
    const observing = {
      statSize: disk.deps.statSize,
      readFile: async (path: string, limit: number) => {
        limits.push(limit);
        return disk.deps.readFile(path, limit);
      },
    };

    const again = await startStore(MANIFEST_PATH, LOCK_PATH, observing);
    expect(again.outcome).toBe('started');
    expect(limits).toEqual([MANIFEST_MAX_BYTES]);
    expect(store.current().manifest.digest).toBeTruthy();
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

describe('startStore: параллельные перечитки', () => {
  const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it('обновление не теряется, когда две перечитки идут внахлёст', async () => {
    // Номер поколения берётся ДО чтения, а порядок завершения чтений ему не подчинён. Пока
    // перечитки не были выстроены в очередь, перечитка, стартовавшая позже и успевшая
    // прочитать СТАРОЕ содержимое, побеждала ту, что прочитала новое, — и `current()`
    // оставался старее диска навсегда. Найдено в E4 при подключении вотчера к демону.
    let content = MANIFEST_YAML;
    let manifestReads = 0;
    const deps = {
      statSize: async (path: string): Promise<number> =>
        Buffer.byteLength(path === MANIFEST_PATH ? content : '', 'utf8'),
      readFile: async (path: string): Promise<string> => {
        if (path !== MANIFEST_PATH) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        manifestReads += 1;
        // Перечитка A читает ПОСЛЕ правки файла, B — до неё.
        if (manifestReads === 2) await tick(30);
        return content;
      },
    };

    const start = await startStore(MANIFEST_PATH, LOCK_PATH, deps);
    expect(start.outcome).toBe('started');
    if (start.outcome !== 'started') return;
    const store = start.store;
    const before = store.current().manifest.digest;

    const a = store.reloadManifest();
    await tick(5);
    const b = store.reloadManifest();
    await tick(5);
    content = CHANGED_YAML;
    await Promise.all([a, b]);

    expect(store.current().manifest.digest).not.toBe(before);
  });
});
