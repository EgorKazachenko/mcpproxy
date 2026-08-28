import { chmodSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { asRecipeName, toTool, type Diagnostic, type Tool } from '@mcpproxy/contracts';
import {
  assertModeSupported,
  createRedactor,
  createSandbox,
  ExecError,
  startStore,
  watchPolicy,
  type Sandbox,
  type StartedStore,
} from '@mcpproxy/core';
import { AuditLogError, openAuditLog, type AuditLog } from '@mcpproxy/core/audit';
import type { DaemonConfig } from '../config.js';
import { denyReason, isExecCode, isTerminal, parseDenyReason } from '../deny.js';
import { createFrameDecoder, encodeFrame } from '../ipc/frame.js';
import { assertSocketPathFits, clearStaleSocket, ensureRuntimeDir, issueToken, tokenMatches } from '../ipc/endpoint.js';
import { parseClientFrame, type ServerFrame } from '../ipc/wire.js';
import { createPipeline, type Pipeline } from './pipeline.js';

export interface DaemonOptions {
  readonly manifestPath: string;
  readonly lockPath: string;
  readonly socketPath: string;
  readonly tokenPath: string;
  readonly runtimeDir: string;
  readonly config: DaemonConfig;
  readonly auditPath?: string;
  readonly debounceMs?: number;
  readonly onDiagnostic?: (text: string) => void;
  /**
   * Швы для проверки решений, у которых иначе нет исполняемой ветки: «нет аудита — нет
   * исполнения» и «после отравления демон не выдаёт вызовов». Воспроизвести их настоящими
   * журналом и песочницей нечем — нужен процесс, переживший SIGKILL, и полный диск.
   */
  readonly openLog?: () => AuditLog;
  readonly makeSandbox?: (mode: DaemonConfig['sandboxMode']) => Sandbox;
}

export interface Daemon {
  readonly socketPath: string;
  readonly token: string;
  close(): Promise<void>;
}

export type StartDaemonResult =
  | { readonly ok: true; readonly daemon: Daemon }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly diagnostics?: readonly Diagnostic[] };

const WATCH_DEBOUNCE_MS = 150;

/**
 * Старт демона — цепочка отказов, а не набор проверок. Каждое звено fail-closed, и каждое
 * имеет причину быть именно отказом СТАРТА, а не отказом вызова:
 *
 * - каталог доступен группе → чужой процесс может подменить сокет;
 * - журнал аудита не открывается → исполнять без аудита нельзя (нет аудита — нет исполнения);
 * - манифест не грузится → политики не существует, и вызов в этом состоянии невозможен по
 *   построению, а не по проверке (R6b E1: значение производит E1, процесс завершает E4);
 * - правила редакции не компилируются → секреты уехали бы в лог дословно;
 * - режим песочницы недоступен на этой машине → исполнять было бы нечем.
 */
export async function startDaemon(options: DaemonOptions): Promise<StartDaemonResult> {
  try {
    ensureRuntimeDir(options.runtimeDir);
  } catch (error) {
    return { ok: false, code: (error as { code?: string }).code ?? 'runtime-dir', message: (error as Error).message };
  }

  // Проверка сокета идёт ПЕРЕД открытием журнала и загрузкой политики, а не после: это
  // единственный шаг, отвечающий на вопрос «а не работает ли уже другой демон», и делать до
  // него что-либо с побочными эффектами значит наполовину поднять второй демон на чужом
  // хозяйстве. Внутри одного процесса второй `openAuditLog` отсекся бы сам (`already-open`),
  // но два НАСТОЯЩИХ процесса этого стража не встретят — их разводит только сокет.
  try {
    assertSocketPathFits(options.socketPath);
    await clearStaleSocket(options.socketPath);
  } catch (error) {
    return { ok: false, code: (error as { code?: string }).code ?? 'socket', message: (error as Error).message };
  }

  let log: AuditLog;
  try {
    log =
      options.openLog !== undefined
        ? options.openLog()
        : options.auditPath === undefined
          ? openAuditLog()
          : openAuditLog({ path: options.auditPath });
  } catch (error) {
    if (error instanceof AuditLogError) {
      return { ok: false, code: error.code, message: `журнал аудита не открыт: ${error.message}` };
    }
    throw error;
  }

  const started = await startStore(options.manifestPath, options.lockPath);
  if (started.outcome === 'invalid-manifest') {
    log.close();
    return { ok: false, code: 'invalid-manifest', message: 'манифест не проходит загрузку', diagnostics: started.diagnostics };
  }
  if (started.outcome === 'unreadable-manifest') {
    log.close();
    return { ok: false, code: started.code, message: started.message };
  }
  const store: StartedStore = started.store;

  let redactor;
  try {
    redactor = createRedactor();
  } catch (error) {
    log.close();
    return { ok: false, code: 'redaction-rules', message: (error as Error).message };
  }

  try {
    assertModeSupported(options.config.sandboxMode);
  } catch (error) {
    log.close();
    return { ok: false, code: error instanceof ExecError ? error.code : 'mode-unsupported', message: (error as Error).message };
  }

  const sandbox = (options.makeSandbox ?? createSandbox)(options.config.sandboxMode);
  const pipeline = createPipeline({
    store,
    log,
    redactor,
    sandbox,
    config: options.config,
    manifestDir: dirname(options.manifestPath),
  });

  const token = issueToken(options.tokenPath);
  const connections = new Set<Socket>();
  let terminal: string | null = null;

  const server = createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    attach(socket);
  });

  const notifyToolsChanged = (): void => {
    for (const socket of connections) socket.write(encodeFrame({ kind: 'tools-changed' } satisfies ServerFrame));
  };

  const watcher = watchPolicy(store, { manifestPath: options.manifestPath, lockPath: options.lockPath }, {
    debounceMs: options.debounceMs ?? WATCH_DEBOUNCE_MS,
    onReload: (source, result) => {
      // Результат перечитки ПОТРЕБЛЯЕТСЯ, а не выбрасывается. Молчаливая неудачная перечитка
      // — это fail-open: политика на диске изменилась, демон продолжает работать по старой, и
      // никто об этом не знает.
      if (result.outcome === 'reloaded') {
        pipeline.invalidate();
        notifyToolsChanged();
        return;
      }
      const detail = result.outcome === 'invalid' ? `${result.diagnostics.length} диагностик` : `${result.code}: ${result.message}`;
      options.onDiagnostic?.(`перечитка ${source} не удалась, продолжаю по прежней политике — ${detail}`);
    },
  });

  /** Вызовы сериализуются целиком, а не только на исполнении: иначе две трассы в append-only
   * журнале перемежаются, и таймлайн одного вызова перестаёт быть непрерывным. Семафор E3
   * всё равно сериализует spawn — очередь здесь ничего не замедляет, а запись выпрямляет. */
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = async <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  function currentTools(): readonly Tool[] {
    const manifest = store.current().manifest.manifest;
    // `asRecipeName` не бросит: имена в манифесте уже прошли `propertyNames` схемы на
    // загрузке. Зовётся именно он, а не приведение типа, — приведение молча пережило бы день,
    // когда рецепты начнут приходить откуда-то ещё.
    return Object.entries(manifest.tools).map(([name, recipe]) => toTool(asRecipeName(name), recipe));
  }

  function attach(socket: Socket): void {
    const decoder = createFrameDecoder();
    let sessionId: string | null = null;
    let protocolVersion: string | null = null;

    const send = (frame: ServerFrame): void => {
      socket.write(encodeFrame(frame));
    };

    socket.on('data', (chunk) => {
      for (const outcome of decoder.push(chunk)) {
        if (outcome.kind === 'oversized') {
          socket.destroy();
          return;
        }
        if (outcome.kind === 'malformed') {
          send({ kind: 'error', id: null, code: 'bad-request', message: 'кадр не разбирается как JSON' });
          continue;
        }

        const parsed = parseClientFrame(outcome.value);
        if (!parsed.ok) {
          send({ kind: 'error', id: null, code: 'bad-request', message: parsed.problem });
          continue;
        }
        const frame = parsed.frame;

        if (frame.kind === 'hello') {
          // Неверный токен закрывает соединение БЕЗ ответа: ответ «неверный токен» — это
          // оракул, отличающий «не тот токен» от «демон не слушает».
          if (sessionId !== null || !tokenMatches(token, frame.token)) {
            socket.destroy();
            return;
          }
          sessionId = `sess-${issueSessionId()}`;
          protocolVersion = frame.protocolVersion;
          send({ kind: 'welcome', sessionId });
          continue;
        }

        if (sessionId === null || protocolVersion === null) {
          socket.destroy();
          return;
        }

        if (frame.kind === 'list') {
          send({ kind: 'list-reply', id: frame.id, tools: currentTools() });
          continue;
        }

        // `sessionId` из запроса сверяется с сессией СОЕДИНЕНИЯ. Без этой сверки запись в
        // журнале говорила бы то, что назвал отправитель, — а именно она и есть единственный
        // криминалистический артефакт при украденном токене (A5).
        if (frame.request.sessionId !== sessionId) {
          send({ kind: 'error', id: frame.id, code: 'bad-request', message: 'sessionId не совпадает с сессией соединения' });
          continue;
        }

        const id = frame.id;
        const version = protocolVersion;
        void serialize(async () => {
          if (terminal !== null) {
            send({ kind: 'call-reply', id, result: { ok: false, verdict: 'error', denyReason: terminal } });
            return;
          }
          try {
            const outcomeOfCall = await pipeline.call({ request: frame.request, protocolVersion: version });
            if (outcomeOfCall.kind === 'allowed') {
              send({
                kind: 'call-reply',
                id,
                result: {
                  ok: true,
                  stdout: outcomeOfCall.stdout,
                  stderr: outcomeOfCall.stderr,
                  exitCode: outcomeOfCall.exitCode,
                  signal: outcomeOfCall.signal,
                  truncated: outcomeOfCall.truncated,
                  violations: outcomeOfCall.violations,
                },
              });
              return;
            }
            if (outcomeOfCall.verdict === 'error') markTerminalIfNeeded(outcomeOfCall.denyReason);
            send({ kind: 'call-reply', id, result: { ok: false, verdict: outcomeOfCall.verdict, denyReason: outcomeOfCall.denyReason } });
          } catch (error) {
            if (error instanceof AuditLogError) {
              // Нет аудита — нет исполнения. Демон перестаёт принимать вызовы целиком: запись
              // о вызове и есть то, ради чего прокси стоит в разрыве.
              terminal = denyReason('audit-unavailable', `журнал аудита недоступен: ${error.code}`);
              options.onDiagnostic?.(terminal);
              send({ kind: 'call-reply', id, result: { ok: false, verdict: 'error', denyReason: terminal } });
              return;
            }
            const message = error instanceof Error ? error.message : String(error);
            send({ kind: 'error', id, code: 'internal', message });
          }
        });
      }
    });

    socket.on('error', () => socket.destroy());
  }

  function markTerminalIfNeeded(reason: string): void {
    const parsed = parseDenyReason(reason);
    if (parsed !== null && isExecCode(parsed.code) && isTerminal(parsed.code) && terminal === null) {
      terminal = reason;
      options.onDiagnostic?.(`демон больше не выдаёт вызовов: ${reason}`);
    }
  }

  await listen(server, options.socketPath);
  // `0600` ставится ПОСЛЕ `listen`: до него файла ещё нет, а `process.umask` мог бы оставить
  // сокет доступным группе на те миллисекунды, что отделяют создание от chmod.
  //
  // Неудача здесь — отказ старта, а не исключение наружу: сокет уже слушает, и оставить его
  // с правами по умолчанию значит открыть границу, ради которой всё это и стоит.
  try {
    chmodSync(options.socketPath, 0o600);
  } catch (error) {
    watcher.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await sandbox.dispose();
    log.close();
    return { ok: false, code: 'socket-unprotected', message: `права сокета не выставлены: ${(error as Error).message}` };
  }

  return {
    ok: true,
    daemon: {
      socketPath: options.socketPath,
      token,
      async close(): Promise<void> {
        watcher.stop();
        for (const socket of connections) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await sandbox.dispose();
        log.close();
      },
    },
  };
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

let sessionCounter = 0;
function issueSessionId(): string {
  sessionCounter += 1;
  return `${process.pid}-${sessionCounter}`;
}
