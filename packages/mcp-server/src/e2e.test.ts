import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Stage } from '@mcpproxy/contracts';
import { buildLock, startStore, writeLock } from '@mcpproxy/core';
import { readLog, verifyLog } from '@mcpproxy/core/audit';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './config.js';
import { startDaemon, type Daemon } from './daemon/server.js';
import { createShim } from './shim/serve.js';

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
  run_tests:
    description: "Прогнать тесты проекта"
    exec: ["./scripts/run-tests.sh"]
    params:
      pattern:
        type: string
        required: false
        pattern: "^[\\\\w.-]{0,32}$"
        argv: ["--filter", "{}"]
    annotations:
      readOnlyHint: false
      destructiveHint: false
      idempotentHint: true
      openWorldHint: false
`;

const daemons: Daemon[] = [];
afterEach(async () => {
  await Promise.all(daemons.splice(0).map((one) => one.close()));
});

interface Rig {
  readonly dir: string;
  readonly daemon: Daemon;
  readonly sent: unknown[];
  readonly handle: (message: unknown) => Promise<void>;
  readonly close: () => void;
  readonly auditPath: string;
}

async function rig(sandboxMode: 'none' | 'seatbelt' = 'none'): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'mcpproxy-e2e-'));
  mkdirSync(join(dir, 'scripts'));
  // Секрет в выводе — чтобы редакция была видна на настоящем пути, а не только в юните.
  writeFileSync(
    join(dir, 'scripts/run-tests.sh'),
    // `sleep` здесь несущий: он делает время РАБОТЫ команды заметно больше всего, что
    // прокси тратит на себя, и потому отличает верный подсчёт оверхеда от неверного.
    '#!/bin/sh\nsleep 0.4\necho "тесты зелены $*"\necho "token=ghp_0123456789abcdefghijklmnopqrstuvwxyzA"\n',
  );
  chmodSync(join(dir, 'scripts/run-tests.sh'), 0o755);

  const manifestPath = join(dir, 'mcpproxy.yaml');
  const lockPath = join(dir, 'mcpproxy.lock');
  writeFileSync(manifestPath, MANIFEST);

  const started = await startStore(manifestPath, lockPath);
  if (started.outcome !== 'started') throw new Error('манифест не загрузился');
  await writeLock(lockPath, buildLock(started.store.current().manifest, '2026-08-28T00:00:00.000Z'));

  const auditPath = join(dir, 'audit.jsonl');
  const result = await startDaemon({
    manifestPath,
    lockPath,
    runtimeDir: dir,
    socketPath: join(dir, 'mcpproxyd.sock'),
    tokenPath: join(dir, 'mcpproxyd.token'),
    auditPath,
    config: { ...DEFAULT_CONFIG, sandboxMode },
  });
  if (!result.ok) throw new Error(`демон не стартовал: ${result.code} ${result.message}`);
  daemons.push(result.daemon);

  const sent: unknown[] = [];
  const shim = createShim({
    socketPath: result.daemon.socketPath,
    token: result.daemon.token,
    send: (message) => sent.push(message),
  });

  return { dir, daemon: result.daemon, sent, handle: (m) => shim.handle(m), close: () => shim.close(), auditPath };
}

const rpc = (method: string, params: unknown, id: number): unknown => ({ jsonrpc: '2.0', id, method, params });
const lastResult = (sent: readonly unknown[]): Record<string, unknown> => (sent.at(-1) as { result: Record<string, unknown> }).result;

describe('e2e — один рецепт проходит весь путь', () => {
  it('от tools/call клиента до записи в hash-chain', async () => {
    const r = await rig();
    await r.handle(rpc('initialize', { protocolVersion: '2025-11-25' }, 1));
    await r.handle(rpc('tools/list', {}, 2));

    const tools = lastResult(r.sent).tools as { name: string; description: string; annotations: unknown }[];
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('run_tests');
    expect(tools[0]?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });

    await r.handle(rpc('tools/call', { name: 'run_tests', arguments: { pattern: 'auth' } }, 3));
    const payload = lastResult(r.sent);
    expect(payload.isError).toBe(false);
    const text = (payload.content as { text: string }[])[0]?.text ?? '';

    // Настоящий процесс отработал, и его вывод приехал в метке недоверенности.
    expect(text).toContain('тесты зелены --filter auth');
    expect(text).toMatch(/^<untrusted-output id="[0-9a-f]{16}"/u);
    // Редакция сработала на настоящем пути: токен в лог и в контекст модели не уехал.
    expect(text).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyzA');
    expect(text).toContain('[redacted:');

    r.close();

    const log = readLog(r.auditPath);
    const verified = verifyLog(log);
    expect(verified.ok).toBe(true);

    const stages = log.records.map((one) => one.stage as Stage);
    expect(stages).toEqual([
      'received', 'lock_check', 'validate', 'resolve_paths', 'build_argv',
      'classify_risk', 'approval', 'build_env', 'build_profile', 'spawn', 'redact', 'complete',
    ]);

    const complete = log.records.at(-1);
    expect(complete?.verdict).toBe('allowed');
    expect(complete?.exit?.code).toBe(0);
    expect(complete?.sandbox?.evidence?.policyHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(complete?.redactions ?? []).toEqual([]);

    // Оверхед прокси НЕ включает работу дочернего процесса. Скрипт спит 400 мс; стадии
    // `spawn` и `complete` исключены формулой, а `redact` — нет, поэтому неверный сброс
    // часов стадии утащил бы эти 400 мс в публикуемую метрику (`09-metrics-and-eval.md`).
    const redactUs = log.records.find((one) => one.stage === 'redact')?.durationUs ?? 0;
    expect(redactUs).toBeLessThan(100_000);
    expect(complete?.duration?.overheadMs ?? 0).toBeLessThan(200);
    expect(log.records.find((one) => one.stage === 'redact')?.redactions?.length).toBeGreaterThan(0);

    // Одна сессия и одна трасса на весь вызов — иначе журнал не скажет, какая IPC-сессия
    // сделала вызов, а это единственный криминалистический артефакт при украденном токене.
    expect(new Set(log.records.map((one) => one.sessionId)).size).toBe(1);
    expect(new Set(log.records.map((one) => one.traceId)).size).toBe(1);
    expect(log.records.every((one) => one.protocolVersion === '2025-11-25')).toBe(true);
  });

  it('сокет и токен лежат с правами 0600', async () => {
    const r = await rig();
    expect(statSync(r.daemon.socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(r.dir, 'mcpproxyd.token')).mode & 0o777).toBe(0o600);
    expect(statSync(r.dir).mode & 0o077).toBe(0);
  });

  it('неверный токен закрывает соединение без ответа', async () => {
    const r = await rig();
    const closed = await new Promise<string>((resolve) => {
      const socket = connect(r.daemon.socketPath, () => {
        socket.write(`${JSON.stringify({ kind: 'hello', token: 'не тот', protocolVersion: '2025-11-25' })}\n`);
      });
      socket.on('data', () => resolve('ответил'));
      socket.on('close', () => resolve('закрыл'));
      socket.on('error', () => resolve('закрыл'));
    });
    // Ответ «неверный токен» был бы оракулом, отличающим «не тот токен» от «демон не слушает».
    expect(closed).toBe('закрыл');
  });

  it('вызов без рукопожатия закрывает соединение', async () => {
    const r = await rig();
    const closed = await new Promise<string>((resolve) => {
      const socket = connect(r.daemon.socketPath, () => {
        socket.write(`${JSON.stringify({ kind: 'list', id: 1 })}\n`);
      });
      socket.on('data', () => resolve('ответил'));
      socket.on('close', () => resolve('закрыл'));
      socket.on('error', () => resolve('закрыл'));
    });
    expect(closed).toBe('закрыл');
  });

  it('второй демон на том же сокете не поднимается', async () => {
    const r = await rig();
    const second = await startDaemon({
      manifestPath: join(r.dir, 'mcpproxy.yaml'),
      lockPath: join(r.dir, 'mcpproxy.lock'),
      runtimeDir: r.dir,
      socketPath: r.daemon.socketPath,
      tokenPath: join(r.dir, 'mcpproxyd.token'),
      auditPath: r.auditPath,
      config: { ...DEFAULT_CONFIG, sandboxMode: 'none' },
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('socket-busy');
  });
});

describe('e2e под настоящей песочницей', () => {
  it('тот же путь проходит в режиме seatbelt — режиме по умолчанию', async () => {
    // Прогон в `none` доказывает конвейер, но пользователю по умолчанию достаётся `seatbelt`,
    // и шов с E3 — профиль, атрибуция, синглтон srt — виден только здесь.
    const r = await rig('seatbelt');
    await r.handle(rpc('initialize', { protocolVersion: '2025-11-25' }, 1));
    await r.handle(rpc('tools/call', { name: 'run_tests', arguments: { pattern: 'auth' } }, 2));

    const payload = lastResult(r.sent);
    expect(payload.isError).toBe(false);
    expect((payload.content as { text: string }[])[0]?.text ?? '').toContain('тесты зелены --filter auth');
    r.close();

    const log = readLog(r.auditPath);
    expect(verifyLog(log).ok).toBe(true);
    expect(log.records.map((one) => one.stage)).toEqual([
      'received', 'lock_check', 'validate', 'resolve_paths', 'build_argv',
      'classify_risk', 'approval', 'build_env', 'build_profile', 'spawn', 'redact', 'complete',
    ]);

    const spawned = log.records.find((one) => one.stage === 'spawn');
    expect(spawned?.sandbox?.mode).toBe('seatbelt');
    // Профиль песочницы приезжает в событие на своей стадии, а не додумывается потребителем.
    expect(log.records.find((one) => one.stage === 'build_profile')?.sandbox).toBeDefined();
    // Разрешённые переменные окружения — тоже: allowlist E6 виден в записи.
    expect(log.records.find((one) => one.stage === 'build_env')?.env?.allowed).toContain('PATH');
  });
});
