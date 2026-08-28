import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEvent, ChainedEvent } from '@mcpproxy/contracts';
import { ExecError, buildLock, startStore, writeLock, type ExecOutcome, type Sandbox } from '@mcpproxy/core';
import { AuditLogError, type AuditLog } from '@mcpproxy/core/audit';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config.js';
import { startDaemon, type Daemon, type DaemonOptions } from './server.js';

const MANIFEST = `version: 1
defaults:
  timeout: 30s
  output:
    maxBytes: 65536
    redact: true
  env:
    allow: ["PATH"]
  sandbox:
    read:
      allow: ["."]
    write:
      allow: []
    network:
      allow: []
tools:
  run_ok:
    description: "Тихий рецепт"
    exec: ["./scripts/ok.sh"]
    annotations:
      readOnlyHint: true
`;

const OUTCOME: ExecOutcome = {
  termination: 'exited',
  exit: { code: 0, signal: null },
  stdout: { text: 'готово', bytes: 6, truncated: false },
  stderr: { text: '', bytes: 0, truncated: false },
  violations: [],
  violationsLost: 0,
  attributionMissing: 0,
  attributionForeign: 0,
  unrecognizedLines: 0,
  suppressedLines: 0,
  consumerFailures: 0,
  bodyCountFailures: 0,
  lateUnattributed: 0,
  policyHash: 'p'.repeat(64),
};

const quietSandbox = (run?: Sandbox['run']): Sandbox => ({
  mode: 'none',
  run: run ?? (async (): Promise<ExecOutcome> => OUTCOME),
  async dispose() {},
});

const daemons: Daemon[] = [];
afterEach(async () => {
  await Promise.all(daemons.splice(0).map((one) => one.close()));
});

async function fixture(): Promise<{ dir: string; options: DaemonOptions }> {
  const dir = mkdtempSync(join(tmpdir(), 'mcpproxy-srv-'));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'scripts/ok.sh'), '#!/bin/sh\necho готово\n');
  chmodSync(join(dir, 'scripts/ok.sh'), 0o755);
  const manifestPath = join(dir, 'mcpproxy.yaml');
  const lockPath = join(dir, 'mcpproxy.lock');
  writeFileSync(manifestPath, MANIFEST);
  const started = await startStore(manifestPath, lockPath);
  if (started.outcome !== 'started') throw new Error('манифест не загрузился');
  await writeLock(lockPath, buildLock(started.store.current().manifest, '2026-08-28T00:00:00.000Z'));

  return {
    dir,
    options: {
      manifestPath,
      lockPath,
      runtimeDir: dir,
      socketPath: join(dir, 'd.sock'),
      tokenPath: join(dir, 'd.token'),
      auditPath: join(dir, 'audit.jsonl'),
      debounceMs: 20,
      config: { ...DEFAULT_CONFIG, sandboxMode: 'none' },
      makeSandbox: () => quietSandbox(),
    },
  };
}

async function up(over: Partial<DaemonOptions> = {}): Promise<Daemon> {
  const { options } = await fixture();
  const result = await startDaemon({ ...options, ...over });
  if (!result.ok) throw new Error(`демон не стартовал: ${result.code} ${result.message}`);
  daemons.push(result.daemon);
  return result.daemon;
}

/** Сырое соединение: рукопожатие руками, чтобы проверять протокол, а не клиента. */
function raw(path: string): {
  send: (value: unknown) => void;
  next: () => Promise<Record<string, unknown>>;
  nextOf: (kind: string) => Promise<Record<string, unknown>>;
  seen: (kind: string) => number;
  closed: () => Promise<void>;
  destroy: () => void;
} {
  const socket = connect(path);
  const queue: Record<string, unknown>[] = [];
  const waiters: ((value: Record<string, unknown>) => void)[] = [];
  let buffer = '';
  let onClose: (() => void) | null = null;
  let isClosed = false;
  const counts = new Map<string, number>();

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const at = buffer.indexOf('\n');
      if (at === -1) break;
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line.trim() === '') continue;
      const value = JSON.parse(line) as Record<string, unknown>;
      const kind = String(value.kind);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      const waiter = waiters.shift();
      if (waiter === undefined) queue.push(value);
      else waiter(value);
    }
  });
  socket.on('close', () => {
    isClosed = true;
    onClose?.();
  });
  socket.on('error', () => {
    isClosed = true;
    onClose?.();
  });

  const next = (): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      const ready = queue.shift();
      if (ready !== undefined) resolve(ready);
      else waiters.push(resolve);
    });

  return {
    send: (value) => socket.write(`${JSON.stringify(value)}\n`),
    next,
    /**
     * Читает до кадра нужного вида, а не строго следующий. Демон шлёт `tools-changed` сам,
     * без запроса, и `fs.watch` на одну запись файла выдаёт события не по одному — ждать
     * ответ строго на своей позиции значит писать тест, зелёный только на тихой машине.
     */
    nextOf: async (kind: string): Promise<Record<string, unknown>> => {
      for (let guard = 0; guard < 16; guard += 1) {
        const frame = await next();
        if (frame.kind === kind) return frame;
      }
      throw new Error(`кадр вида ${kind} не пришёл за 16 кадров`);
    },
    seen: (kind: string): number => counts.get(kind) ?? 0,
    closed: () =>
      new Promise((resolve) => {
        if (isClosed) resolve();
        else onClose = resolve;
      }),
    destroy: () => socket.destroy(),
  };
}

async function greeted(daemon: Daemon): Promise<ReturnType<typeof raw> & { sessionId: string }> {
  const link = raw(daemon.socketPath);
  link.send({ kind: 'hello', token: daemon.token, protocolVersion: '2025-11-25' });
  const welcome = await link.nextOf('welcome');
  return Object.assign(link, { sessionId: welcome.sessionId as string });
}

describe('отказы старта — каждый fail-closed и со своим кодом', () => {
  it('манифест, не прошедший загрузку, не даёт демону подняться', async () => {
    const { options } = await fixture();
    writeFileSync(options.manifestPath, 'version: 1\ntools: не объект\n');
    const result = await startDaemon(options);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Причина сужается по тегу, а не по тексту: E1 отдаёт двум отказам разные исходы.
    expect(result.code).toBe('invalid-manifest');
    expect(result.diagnostics?.length ?? 0).toBeGreaterThan(0);
  });

  it('отсутствующий манифест отличается от невалидного', async () => {
    const { options } = await fixture();
    const result = await startDaemon({ ...options, manifestPath: join(options.runtimeDir, 'нет.yaml') });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).not.toBe('invalid-manifest');
    expect(result.diagnostics).toBeUndefined();
  });

  it('журнал аудита не открылся — демон не стартует: нет аудита, нет исполнения', async () => {
    const { options } = await fixture();
    const result = await startDaemon({
      ...options,
      openLog: () => {
        throw new AuditLogError('corrupt', options.auditPath ?? '', 'цепочка повреждена');
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('corrupt');
  });

  it('каталог, доступный группе, отвергается до всего остального', async () => {
    const { options } = await fixture();
    chmodSync(options.runtimeDir, 0o755);
    const result = await startDaemon(options);
    chmodSync(options.runtimeDir, 0o700);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('insecure-directory');
  });

  it('слишком длинный путь сокета — явный отказ, а не падение позже', async () => {
    const { options } = await fixture();
    const result = await startDaemon({ ...options, socketPath: `${options.runtimeDir}/${'d'.repeat(120)}.sock` });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('socket-path-too-long');
  });
});

describe('граница соединения', () => {
  it('sessionId из запроса сверяется с сессией СОЕДИНЕНИЯ', async () => {
    // Без сверки журнал говорил бы то, что назвал отправитель, — а это единственный
    // криминалистический артефакт при украденном токене (A5).
    const daemon = await up();
    const link = await greeted(daemon);
    link.send({ kind: 'call', id: 1, request: { recipeName: 'run_ok', params: {}, sessionId: 'чужая-сессия' } });
    const reply = await link.nextOf('error');
    expect(reply.kind).toBe('error');
    expect(String(reply.message)).toContain('sessionId');
    link.destroy();
  });

  it('свой sessionId проходит', async () => {
    const daemon = await up();
    const link = await greeted(daemon);
    link.send({ kind: 'call', id: 1, request: { recipeName: 'run_ok', params: {}, sessionId: link.sessionId } });
    const reply = await link.nextOf('call-reply');
    expect(reply.kind).toBe('call-reply');
    expect((reply.result as { ok: boolean }).ok).toBe(true);
    link.destroy();
  });

  it('повторное рукопожатие на том же соединении разрывает его', async () => {
    const daemon = await up();
    const link = await greeted(daemon);
    link.send({ kind: 'hello', token: daemon.token, protocolVersion: '2025-11-25' });
    await expect(link.closed()).resolves.toBeUndefined();
  });

  it('кадр сверх потолка разрывает соединение, а не разбирается', async () => {
    const daemon = await up();
    const link = await greeted(daemon);
    link.send({ kind: 'list', id: 1, junk: 'ж'.repeat(1_100_000) });
    await expect(link.closed()).resolves.toBeUndefined();
  });

  it('битый JSON не роняет соединение — отвечает ошибкой и живёт дальше', async () => {
    const daemon = await up();
    const link = await greeted(daemon);
    link.send({ kind: 'list', id: 7 });
    expect((await link.nextOf('list-reply')).kind).toBe('list-reply');
    link.destroy();
  });
});

describe('решения, у которых иначе не было бы исполняемой ветки', () => {
  it('падение журнала на вызове останавливает демон целиком', async () => {
    // Журнал падает РОВНО ОДИН раз, а дальше исправен. Если бы он падал всегда, второй вызов
    // отказывался бы и без пометки демона, и тест был бы зелен при снятом страже — проверено
    // мутацией, именно так первая редакция этого теста и не ловила ничего.
    let appended = 0;
    let calls = 0;
    const log: AuditLog = {
      path: 'память',
      repairedTornTail: false,
      append: (event: AuditEvent): ChainedEvent => {
        appended += 1;
        if (appended === 2) throw new AuditLogError('short-write', 'память', 'запись не дошла');
        return { ...event, chain: { prev: null, self: 's'.repeat(64) } };
      },
      head: () => null,
      close: () => undefined,
    };

    const daemon = await up({
      openLog: () => log,
      makeSandbox: () =>
        quietSandbox(async () => {
          calls += 1;
          return OUTCOME;
        }),
    });
    const link = await greeted(daemon);

    link.send({ kind: 'call', id: 1, request: { recipeName: 'run_ok', params: {}, sessionId: link.sessionId } });
    const first = await link.nextOf('call-reply');
    expect((first.result as { ok: boolean }).ok).toBe(false);
    expect((first.result as { denyReason: string }).denyReason).toContain('audit-unavailable');

    // И следующий вызов тоже: «нет аудита — нет исполнения» относится к демону, а не к вызову.
    // Журнал к этому моменту снова исправен, поэтому зелёный второй вызов означал бы, что
    // демон продолжает исполнять после того, как одна запись потерялась.
    link.send({ kind: 'call', id: 2, request: { recipeName: 'run_ok', params: {}, sessionId: link.sessionId } });
    const second = await link.nextOf('call-reply');
    expect((second.result as { ok: boolean }).ok).toBe(false);
    expect((second.result as { denyReason: string }).denyReason).toContain('audit-unavailable');
    expect(calls).toBe(0);
    link.destroy();
  });

  it('терминальное отравление песочницы снимает демон с обслуживания', async () => {
    let calls = 0;
    const daemon = await up({
      makeSandbox: () =>
        quietSandbox(async () => {
          calls += 1;
          throw new ExecError('poisoned', 'группа процессов не слита');
        }),
    });
    const link = await greeted(daemon);

    link.send({ kind: 'call', id: 1, request: { recipeName: 'run_ok', params: {}, sessionId: link.sessionId } });
    const first = await link.nextOf('call-reply');
    expect((first.result as { verdict: string }).verdict).toBe('error');
    expect((first.result as { denyReason: string }).denyReason).toContain('poisoned');

    link.send({ kind: 'call', id: 2, request: { recipeName: 'run_ok', params: {}, sessionId: link.sessionId } });
    const second = await link.nextOf('call-reply');
    expect((second.result as { denyReason: string }).denyReason).toContain('poisoned');
    // До песочницы второй вызов уже не дошёл: отравление терминально.
    expect(calls).toBe(1);
    link.destroy();
  });

  it('отказ политики НЕ снимает демон: invalid-domain — решение о рецепте, а не сбой', async () => {
    let calls = 0;
    const daemon = await up({
      makeSandbox: () =>
        quietSandbox(async () => {
          calls += 1;
          if (calls === 1) throw new ExecError('invalid-domain', 'домен не принимается валидатором');
          return OUTCOME;
        }),
    });
    const link = await greeted(daemon);

    link.send({ kind: 'call', id: 1, request: { recipeName: 'run_ok', params: {}, sessionId: link.sessionId } });
    expect(((await link.nextOf('call-reply')).result as { verdict: string }).verdict).toBe('denied');

    link.send({ kind: 'call', id: 2, request: { recipeName: 'run_ok', params: {}, sessionId: link.sessionId } });
    expect(((await link.nextOf('call-reply')).result as { ok: boolean }).ok).toBe(true);
    expect(calls).toBe(2);
    link.destroy();
  });
});

describe('вотчер E1 подключён к демону', () => {
  it('перечитка манифеста рассылает tools-changed и меняет список', async () => {
    const { options } = await fixture();
    const result = await startDaemon(options);
    if (!result.ok) throw new Error(result.message);
    daemons.push(result.daemon);
    const link = await greeted(result.daemon);

    link.send({ kind: 'list', id: 1 });
    expect(((await link.nextOf('list-reply')).tools as unknown[]).length).toBe(1);

    writeFileSync(
      options.manifestPath,
      MANIFEST.replace('tools:', 'tools:\n  second:\n    description: "Второй"\n    exec: ["./scripts/ok.sh"]\n'),
    );

    // Опрос, а не ожидание одного кадра. В этой фикстуре каталог манифеста совпадает с
    // рабочим каталогом демона, поэтому вотчер E1 будит перечитку и на запись файла токена:
    // ждать «следующий tools-changed» значит поймать чужой, пришедший до правки манифеста.
    let count = 0;
    const deadline = Date.now() + 4_000;
    while (count !== 2 && Date.now() < deadline) {
      link.send({ kind: 'list', id: 2 });
      count = ((await link.nextOf('list-reply')).tools as unknown[]).length;
      if (count !== 2) await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(count).toBe(2);
    // И уведомление действительно рассылалось — без него клиент не узнал бы о смене списка.
    expect(link.seen('tools-changed')).toBeGreaterThan(0);
    link.destroy();
  });
});
