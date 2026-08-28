import { MCP_PROTOCOL_VERSION, type Tool } from '@mcpproxy/contracts';
import { describe, expect, it } from 'vitest';
import type { CallDenied, CallOk } from '../ipc/wire.js';
import type { IpcClient } from './client.js';
import { SERVER_INFO, createShim } from './serve.js';

const TOOL: Tool = {
  name: 'run_tests',
  description: 'Прогнать тесты',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: false, idempotentHint: true },
};

const OK: CallOk = { ok: true, stdout: 'зелено', stderr: '', exitCode: 0, signal: null, truncated: false, violations: 0 };

interface Rig {
  readonly sent: unknown[];
  readonly handle: (message: unknown) => Promise<void>;
  readonly seen: { version: string | null; calls: number };
}

function rig(result: CallOk | CallDenied = OK, tools: readonly Tool[] = [TOOL]): Rig {
  const sent: unknown[] = [];
  const seen = { version: null as string | null, calls: 0 };
  const shim = createShim({
    socketPath: '/нет',
    token: 'токен',
    send: (message) => sent.push(message),
    newNonce: () => 'n0',
    connect: async (_path, _token, version): Promise<IpcClient> => {
      seen.version = version;
      return {
        sessionId: 'sess-1',
        async list() {
          return tools;
        },
        async call() {
          seen.calls += 1;
          return result;
        },
        onToolsChanged() {},
        close() {},
      };
    },
  });
  return { sent, handle: (message) => shim.handle(message), seen };
}

const rpc = (method: string, params?: unknown, id: number | null = 1): unknown => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const result = (sent: readonly unknown[]): Record<string, unknown> => (sent.at(-1) as { result: Record<string, unknown> }).result;

describe('initialize', () => {
  it('согласует ревизию клиента и объявляет listChanged', async () => {
    const r = rig();
    await r.handle(rpc('initialize', { protocolVersion: '2025-06-18' }));
    expect(result(r.sent)).toMatchObject({
      protocolVersion: '2025-06-18',
      serverInfo: SERVER_INFO,
      capabilities: { tools: { listChanged: true } },
    });
  });

  it('незнакомая ревизия получает нашу предпочитаемую', async () => {
    const r = rig();
    await r.handle(rpc('initialize', { protocolVersion: '2001-01-01' }));
    expect(result(r.sent).protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  it('согласованная ревизия уезжает демону в рукопожатии', async () => {
    const r = rig();
    await r.handle(rpc('initialize', { protocolVersion: '2025-06-18' }));
    await r.handle(rpc('tools/list', undefined, 2));
    expect(r.seen.version).toBe('2025-06-18');
  });
});

describe('tools/list и tools/call', () => {
  it('список отдаётся с аннотациями', async () => {
    const r = rig();
    await r.handle(rpc('initialize', {}));
    await r.handle(rpc('tools/list', undefined, 2));
    expect(result(r.sent).tools).toEqual([TOOL]);
  });

  it('вывод приезжает в untrusted-обёртке', async () => {
    const r = rig();
    await r.handle(rpc('initialize', {}));
    await r.handle(rpc('tools/call', { name: 'run_tests', arguments: {} }, 2));
    const payload = result(r.sent);
    expect(payload.isError).toBe(false);
    const text = (payload.content as { text: string }[])[0]?.text ?? '';
    expect(text).toContain('<untrusted-output id="n0"');
    expect(text).toContain('зелено');
  });

  it('ненулевой код возврата помечает результат ошибкой, но вывод отдаёт', async () => {
    const r = rig({ ...OK, exitCode: 2, stderr: 'упало' });
    await r.handle(rpc('initialize', {}));
    await r.handle(rpc('tools/call', { name: 'run_tests', arguments: {} }, 2));
    expect(result(r.sent).isError).toBe(true);
    expect(JSON.stringify(result(r.sent))).toContain('упало');
  });

  it('отказ политики — результат с isError, а не транспортная ошибка JSON-RPC', async () => {
    // Модель должна увидеть, что инструмент отказал и почему, а не решить, что сломался канал.
    const r = rig({ ok: false, verdict: 'denied', denyReason: 'lock-drifted: манифест разошёлся с lock' });
    await r.handle(rpc('initialize', {}));
    await r.handle(rpc('tools/call', { name: 'run_tests', arguments: {} }, 2));
    const payload = result(r.sent);
    expect(payload.isError).toBe(true);
    const text = (payload.content as { text: string }[])[0]?.text ?? '';
    expect(text).toContain('[lock-drifted]');
    expect(text).toContain('манифест разошёлся с lock');
  });

  it('имя не по шаблону рецепта не доезжает до демона', async () => {
    const r = rig();
    await r.handle(rpc('initialize', {}));
    await r.handle(rpc('tools/call', { name: '../../etc/passwd', arguments: {} }, 2));
    expect((r.sent.at(-1) as { error: { code: number } }).error.code).toBe(-32602);
    expect(r.seen.calls).toBe(0);
  });
});

describe('прочие методы', () => {
  it('ping отвечает пустым результатом', async () => {
    const r = rig();
    await r.handle(rpc('ping', undefined, 3));
    expect(result(r.sent)).toEqual({});
  });

  it('неизвестный метод даёт -32601', async () => {
    const r = rig();
    await r.handle(rpc('resources/list', undefined, 4));
    expect((r.sent.at(-1) as { error: { code: number } }).error.code).toBe(-32601);
  });

  it('уведомление не получает ответа никогда', async () => {
    const r = rig();
    await r.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await r.handle({ jsonrpc: '2.0', method: 'неизвестное/уведомление' });
    expect(r.sent).toEqual([]);
  });
});
