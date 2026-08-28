import { createServer, type Server } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asRecipeName } from '@mcpproxy/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { IpcClientError, connectIpc } from './client.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((one) => new Promise<void>((resolve) => one.close(() => resolve()))));
});

const socketAt = (): string => join(mkdtempSync(join(tmpdir(), 'mcpproxy-cli-')), 'd.sock');

/** Поддельный демон: отвечает по сценарию, чтобы проверять клиента, а не сервер. */
async function fake(react: (frame: Record<string, unknown>, send: (value: unknown) => void, socket: { destroy: () => void }) => void): Promise<string> {
  const path = socketAt();
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const at = buffer.indexOf('\n');
        if (at === -1) break;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (line.trim() === '') continue;
        react(JSON.parse(line) as Record<string, unknown>, (value) => socket.write(`${JSON.stringify(value)}\n`), socket);
      }
    });
    socket.on('error', () => socket.destroy());
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, () => resolve()));
  return path;
}

const welcoming = (send: (value: unknown) => void): void => send({ kind: 'welcome', sessionId: 'sess-1' });

describe('connectIpc', () => {
  it('недоступный демон отличается кодом от отвергнутого рукопожатия', async () => {
    await expect(connectIpc(socketAt(), 'токен', '2025-11-25')).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('разрыв на рукопожатии даёт rejected, а не unreachable', async () => {
    // Демон закрывает молча, и именно это клиент обязан назвать «не пустили».
    const path = await fake((_frame, _send, socket) => socket.destroy());
    await expect(connectIpc(path, 'не тот', '2025-11-25')).rejects.toMatchObject({ code: 'rejected' });
  });

  it('согласованная ревизия уезжает в рукопожатии', async () => {
    let seen: unknown = null;
    const path = await fake((frame, send) => {
      if (frame.kind === 'hello') {
        seen = frame.protocolVersion;
        welcoming(send);
      }
    });
    const client = await connectIpc(path, 'токен', '2025-06-18');
    expect(seen).toBe('2025-06-18');
    expect(client.sessionId).toBe('sess-1');
    client.close();
  });

  it('sessionId сессии подставляется в каждый запрос — клиент его не выдумывает', async () => {
    let request: Record<string, unknown> | null = null;
    const path = await fake((frame, send) => {
      if (frame.kind === 'hello') return welcoming(send);
      if (frame.kind === 'call') {
        request = frame.request as Record<string, unknown>;
        send({ kind: 'call-reply', id: frame.id, result: { ok: true, stdout: '', stderr: '', exitCode: 0, signal: null, truncated: false, violations: 0 } });
      }
    });
    const client = await connectIpc(path, 'токен', '2025-11-25');
    await client.call(asRecipeName('run_ok'), { a: 1 });
    expect(request).toEqual({ recipeName: 'run_ok', params: { a: 1 }, sessionId: 'sess-1' });
    client.close();
  });

  it('ответы соотносятся по id, а не по порядку прихода', async () => {
    const path = await fake((frame, send) => {
      if (frame.kind === 'hello') return welcoming(send);
      if (frame.kind === 'list') {
        // Отвечаем на второй запрос раньше первого.
        setTimeout(() => send({ kind: 'list-reply', id: frame.id, tools: [{ name: `t${String(frame.id)}` }] }), frame.id === 1 ? 40 : 5);
      }
    });
    const client = await connectIpc(path, 'токен', '2025-11-25');
    const [first, second] = await Promise.all([client.list(), client.list()]);
    expect(first[0]?.name).toBe('t1');
    expect(second[0]?.name).toBe('t2');
    client.close();
  });

  it('разрыв в середине вызова отклоняет ожидающий запрос, а не висит вечно', async () => {
    const path = await fake((frame, send, socket) => {
      if (frame.kind === 'hello') return welcoming(send);
      socket.destroy();
    });
    const client = await connectIpc(path, 'токен', '2025-11-25');
    await expect(client.call(asRecipeName('run_ok'), {})).rejects.toMatchObject({ code: 'closed' });
  });

  it('ошибка демона на запрос превращается в ошибку клиента, а не в молчание', async () => {
    const path = await fake((frame, send) => {
      if (frame.kind === 'hello') return welcoming(send);
      send({ kind: 'error', id: frame.id, code: 'bad-request', message: 'sessionId не совпадает' });
    });
    const client = await connectIpc(path, 'токен', '2025-11-25');
    await expect(client.call(asRecipeName('run_ok'), {})).rejects.toThrowError(IpcClientError);
    client.close();
  });

  it('tools-changed доезжает до подписчика', async () => {
    let notify: ((value: unknown) => void) | undefined;
    const path = await fake((frame, send) => {
      if (frame.kind === 'hello') {
        notify = send;
        welcoming(send);
      }
    });
    const client = await connectIpc(path, 'токен', '2025-11-25');
    const seen = new Promise<void>((resolve) => client.onToolsChanged(() => resolve()));
    notify?.({ kind: 'tools-changed' });
    expect(notify).toBeDefined();
    await expect(seen).resolves.toBeUndefined();
    client.close();
  });
});
