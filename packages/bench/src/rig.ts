import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from '@mcpproxy/contracts';
import { asRecipeName } from '@mcpproxy/contracts';
import { buildLock, startStore, writeLock } from '@mcpproxy/core';
import {
  DEFAULT_CONFIG,
  connectIpc,
  createShim,
  startDaemon,
  type Daemon,
  type IpcClient,
  type Shim,
} from '@mcpproxy/mcp-server';
import { MANIFEST, materialize, type DemoRepo } from './repo.js';
import type { BenchMode, CallOutcome, RunCtx, WrappedCall } from './types.js';

/**
 * Стенд одного прогона: демо-репозиторий, демон, IPC-клиент и шим. Ровно тот путь, которым
 * ходит настоящий клиент, — иначе корпус мерил бы поведение отдельных модулей, а не системы.
 *
 * **Клиент типизированный, а не текст MCP-ответа.** Шим отдаёт `isError: true` и на отказ
 * политики, и на ненулевой код возврата, то есть по MCP-ответу «заблокировано» и «скрипт
 * упал» неразличимы. Для метрики это разница между блоком атаки и ошибкой стенда, поэтому
 * оракулы ходят через `IpcClient`, у которого исход — размеченное объединение. Шим остаётся
 * там, где защитой служит именно он: обёртка `<untrusted-output>` класса A8.
 */
export interface Rig extends RunCtx {
  readonly daemon: Daemon;
  readonly repo: DemoRepo;
  readonly root: string;
  close(): Promise<void>;
}

export interface RigOptions {
  readonly mode: BenchMode;
  readonly manifest?: (base: string) => string;
  readonly listener?: string | null;
  /** Пауза вотчера манифеста. Мелкая — A6 правит манифест и ждёт перечитки. */
  readonly debounceMs?: number;
}

export class RigStartError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RigStartError';
  }
}

const PROTOCOL_VERSION = '2025-11-25';

export async function startRig(options: RigOptions): Promise<Rig> {
  const root = mkdtempSync(join(tmpdir(), 'mcpproxy-bench-'));
  const repo = materialize(root, options.manifest === undefined ? MANIFEST : options.manifest(MANIFEST));
  const started = await startStore(repo.manifestPath, repo.lockPath);
  if (started.outcome !== 'started') {
    rmSync(root, { recursive: true, force: true });
    throw new RigStartError('manifest-rejected', `манифест не загрузился: ${started.outcome}`);
  }
  await writeLock(repo.lockPath, buildLock(started.store.current().manifest, '2026-08-28T00:00:00.000Z'));

  const auditPath = join(root, 'audit.jsonl');
  const result = await startDaemon({
    manifestPath: repo.manifestPath,
    lockPath: repo.lockPath,
    runtimeDir: root,
    socketPath: join(root, 'd.sock'),
    tokenPath: join(root, 'd.token'),
    auditPath,
    debounceMs: options.debounceMs ?? 20,
    config: { ...DEFAULT_CONFIG, sandboxMode: options.mode },
  });
  if (!result.ok) {
    rmSync(root, { recursive: true, force: true });
    throw new RigStartError(result.code, result.message);
  }
  const daemon = result.daemon;

  let client: IpcClient | null = null;
  const ensure = async (): Promise<IpcClient> => {
    if (client === null) client = await connectIpc(daemon.socketPath, daemon.token, PROTOCOL_VERSION);
    return client;
  };

  let shim: Shim | null = null;
  const sent: unknown[] = [];
  const ensureShim = async (): Promise<Shim> => {
    if (shim === null) {
      shim = createShim({ socketPath: daemon.socketPath, token: daemon.token, send: (m) => sent.push(m) });
      await shim.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION } });
    }
    return shim;
  };

  let nextId = 1;

  return {
    mode: options.mode,
    dir: repo.dir,
    home: repo.home,
    socketPath: daemon.socketPath,
    token: daemon.token,
    auditPath,
    listener: options.listener ?? null,
    daemon,
    repo,
    root,

    async call(recipe, params = {}): Promise<CallOutcome> {
      return (await ensure()).call(asRecipeName(recipe), params);
    },

    async callWrapped(recipe, params = {}): Promise<WrappedCall> {
      const instance = await ensureShim();
      const id = (nextId += 1);
      await instance.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: recipe, arguments: params } });
      const reply = sent.at(-1) as { result?: { isError?: boolean; content?: { text?: string }[] } };
      const content = reply.result?.content ?? [];
      return { text: content[0]?.text ?? '', isError: reply.result?.isError === true };
    },

    async list(): Promise<readonly Tool[]> {
      return (await ensure()).list();
    },

    async close(): Promise<void> {
      client?.close();
      shim?.close();
      await daemon.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
