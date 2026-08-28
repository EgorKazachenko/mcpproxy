import { asRecipeName, isRecipeName, type Tool } from '@mcpproxy/contracts';
import { parseDenyReason } from '../deny.js';
import { IpcClientError, connectIpc, type IpcClient } from './client.js';
import { negotiate } from './protocol.js';
import { wrapUntrusted } from './untrusted.js';

/**
 * MCP-поверхность. JSON-RPC живёт между клиентом и шимом и границу IPC не пересекает:
 * `jsonrpc.request.id` во внутренний протокол не едет, корреляция идёт по `traceId`.
 *
 * Реализовано вручную, без `@modelcontextprotocol/sdk`. Не из принципа: SDK в этом
 * репозитории уже запрещён исполняемым тестом (`packages/contracts/src/deps.test.ts`), чтобы
 * его типы не протекли в `.d.ts` контрактов, а поверхность здесь — пять методов, из которых
 * четыре тривиальны. Зависимость, которую пришлось бы держать поодаль от контрактов, ради
 * пяти методов не окупается.
 */
export const SERVER_INFO = { name: 'mcpproxy', version: '0.0.0' } as const;

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

export interface ShimDeps {
  readonly socketPath: string;
  readonly token: string;
  readonly send: (message: unknown) => void;
  readonly connect?: typeof connectIpc;
  readonly newNonce?: () => string;
}

export interface Shim {
  handle(message: unknown): Promise<void>;
  close(): void;
}

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function createShim(deps: ShimDeps): Shim {
  const open = deps.connect ?? connectIpc;
  let client: IpcClient | null = null;
  let version: string | null = null;

  const ensureClient = async (): Promise<IpcClient> => {
    if (client !== null) return client;
    if (version === null) throw new IpcClientError('protocol', 'вызов до initialize');
    const fresh = await open(deps.socketPath, deps.token, version);
    fresh.onToolsChanged(() => {
      deps.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    });
    client = fresh;
    return fresh;
  };

  const reply = (id: string | number | null, result: unknown): void => {
    deps.send({ jsonrpc: '2.0', id, result } satisfies JsonRpcResponse);
  };

  const fail = (id: string | number | null, code: number, message: string): void => {
    deps.send({ jsonrpc: '2.0', id, error: { code, message } } satisfies JsonRpcResponse);
  };

  return {
    close(): void {
      client?.close();
    },

    async handle(message: unknown): Promise<void> {
      if (!isRecord(message)) return;
      const method = message.method;
      if (typeof method !== 'string') return;
      const rawId = message.id;
      const id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;
      // Уведомление — сообщение без `id`. Ответа не получает никогда, включая ответ об ошибке.
      const isNotification = rawId === undefined;

      if (method === 'initialize') {
        const params = isRecord(message.params) ? message.params : {};
        const agreed = negotiate(params.protocolVersion);
        version = agreed.version;
        reply(id, {
          protocolVersion: agreed.version,
          serverInfo: SERVER_INFO,
          capabilities: {
            // `listChanged` объявляется потому, что вотчер манифеста E1 подключён к демону и
            // перечитка действительно рассылает уведомление. Объявленная и не исполняемая
            // возможность хуже необъявленной: клиент перестаёт перечитывать список сам.
            tools: { listChanged: true },
          },
        });
        return;
      }

      if (isNotification) return;

      if (method === 'ping') {
        reply(id, {});
        return;
      }

      if (method === 'tools/list') {
        try {
          const tools = await (await ensureClient()).list();
          reply(id, { tools: tools as readonly Tool[] });
        } catch (error) {
          fail(id, INTERNAL_ERROR, describe(error));
        }
        return;
      }

      if (method === 'tools/call') {
        const params = isRecord(message.params) ? message.params : {};
        const name = params.name;
        if (typeof name !== 'string' || !isRecipeName(name)) {
          fail(id, INVALID_PARAMS, 'name не является именем рецепта');
          return;
        }
        const args = isRecord(params.arguments) ? params.arguments : {};

        try {
          const outcome = await (await ensureClient()).call(asRecipeName(name), args);
          if (!outcome.ok) {
            const parsed = parseDenyReason(outcome.denyReason);
            // Отказ политики — это РЕЗУЛЬТАТ вызова с `isError`, а не транспортная ошибка
            // JSON-RPC: модель должна увидеть, что инструмент отказал и почему, а не решить,
            // что сломался канал.
            reply(id, {
              isError: true,
              content: [
                {
                  type: 'text',
                  text:
                    parsed === null
                      ? outcome.denyReason
                      : `mcpproxy ${outcome.verdict}: ${parsed.text} [${parsed.code}]`,
                },
              ],
            });
            return;
          }

          const body = outcome.stderr === '' ? outcome.stdout : `${outcome.stdout}\n${outcome.stderr}`;
          const wrapped = wrapUntrusted(
            name,
            body,
            { exitCode: outcome.exitCode, truncated: outcome.truncated, violations: outcome.violations },
            deps.newNonce,
          );
          reply(id, {
            isError: outcome.exitCode !== 0,
            content: [{ type: 'text', text: wrapped.text }],
          });
        } catch (error) {
          fail(id, INTERNAL_ERROR, describe(error));
        }
        return;
      }

      fail(id, METHOD_NOT_FOUND, `метод не поддерживается: ${method}`);
    },
  };
}

function describe(error: unknown): string {
  if (error instanceof IpcClientError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
