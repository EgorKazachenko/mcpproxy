import { connect, type Socket } from 'node:net';
import type { IpcRequest, Tool } from '@mcpproxy/contracts';
import { createFrameDecoder, encodeFrame } from '../ipc/frame.js';
import type { CallDenied, CallOk, ServerFrame } from '../ipc/wire.js';

export class IpcClientError extends Error {
  readonly code: 'unreachable' | 'rejected' | 'closed' | 'protocol';
  constructor(code: IpcClientError['code'], message: string) {
    super(message);
    this.name = 'IpcClientError';
    this.code = code;
  }
}

export interface IpcClient {
  readonly sessionId: string;
  list(): Promise<readonly Tool[]>;
  call(recipeName: IpcRequest['recipeName'], params: Readonly<Record<string, unknown>>): Promise<CallOk | CallDenied>;
  onToolsChanged(listener: () => void): void;
  close(): void;
}

interface Pending {
  readonly resolve: (frame: ServerFrame) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Клиент внутреннего протокола. Рукопожатие обязательно и делается до первого запроса: токен
 * едет в конверте `hello`, а согласованная ревизия протокола — вместе с ним, потому что в
 * `IpcRequest` для неё места нет и быть не должно (И5).
 */
export async function connectIpc(path: string, token: string, protocolVersion: string): Promise<IpcClient> {
  const socket = await open(path);
  const decoder = createFrameDecoder();
  const pending = new Map<number, Pending>();
  const toolsChanged: (() => void)[] = [];
  let nextId = 1;
  let sessionId: string | null = null;
  let welcome: ((frame: ServerFrame) => void) | null = null;
  let failAll: ((error: Error) => void) | null = null;

  const rejectEverything = (error: Error): void => {
    for (const one of pending.values()) one.reject(error);
    pending.clear();
    failAll?.(error);
  };

  socket.on('data', (chunk) => {
    for (const outcome of decoder.push(chunk)) {
      if (outcome.kind !== 'frame') {
        rejectEverything(new IpcClientError('protocol', 'демон прислал неразбираемый кадр'));
        socket.destroy();
        return;
      }
      const frame = outcome.value as ServerFrame;
      if (frame.kind === 'welcome') {
        welcome?.(frame);
        continue;
      }
      if (frame.kind === 'tools-changed') {
        for (const listener of toolsChanged) listener();
        continue;
      }
      if (frame.kind === 'error' && frame.id === null) {
        rejectEverything(new IpcClientError('protocol', frame.message));
        continue;
      }
      const id = frame.kind === 'error' ? frame.id : frame.id;
      if (id === null) continue;
      const waiting = pending.get(id);
      if (waiting === undefined) continue;
      pending.delete(id);
      waiting.resolve(frame);
    }
  });

  socket.on('close', () => rejectEverything(new IpcClientError('closed', 'демон закрыл соединение')));
  socket.on('error', (error) => rejectEverything(new IpcClientError('closed', error.message)));

  const handshake = new Promise<string>((resolve, reject) => {
    welcome = (frame): void => {
      if (frame.kind === 'welcome') resolve(frame.sessionId);
    };
    failAll = reject;
    // Разрыв без ответа — штатный исход неверного токена: демон не подтверждает и не
    // опровергает, а закрывает. Поэтому «закрыли молча» здесь и означает «не пустили».
    socket.write(encodeFrame({ kind: 'hello', token, protocolVersion }));
  });

  try {
    sessionId = await handshake;
  } catch (error) {
    socket.destroy();
    throw new IpcClientError('rejected', `демон не принял рукопожатие: ${(error as Error).message}`);
  }
  failAll = null;

  const roundtrip = (write: (id: number) => void): Promise<ServerFrame> => {
    const id = nextId;
    nextId += 1;
    return new Promise<ServerFrame>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      write(id);
    });
  };

  const session = sessionId;

  return {
    sessionId: session,

    async list(): Promise<readonly Tool[]> {
      const frame = await roundtrip((id) => socket.write(encodeFrame({ kind: 'list', id })));
      if (frame.kind === 'list-reply') return frame.tools;
      throw new IpcClientError('protocol', frame.kind === 'error' ? frame.message : 'неожиданный ответ на list');
    },

    async call(recipeName, params): Promise<CallOk | CallDenied> {
      const frame = await roundtrip((id) =>
        socket.write(encodeFrame({ kind: 'call', id, request: { recipeName, params, sessionId: session } })),
      );
      if (frame.kind === 'call-reply') return frame.result;
      throw new IpcClientError('protocol', frame.kind === 'error' ? frame.message : 'неожиданный ответ на call');
    },

    onToolsChanged(listener: () => void): void {
      toolsChanged.push(listener);
    },

    close(): void {
      socket.destroy();
    },
  };
}

function open(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once('connect', () => {
      socket.removeListener('error', reject);
      resolve(socket);
    });
    socket.once('error', (error) => reject(new IpcClientError('unreachable', `демон недоступен на ${path}: ${error.message}`)));
  });
}
