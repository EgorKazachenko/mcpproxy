import { asRecipeName, asSessionId, isRecipeName, type IpcRequest, type Tool } from '@mcpproxy/contracts';

/**
 * Кадры внутреннего протокола шим↔демон. MCP-транспортом он не является: JSON-RPC живёт
 * между клиентом и шимом, `jsonrpc.request.id` границу не пересекает, а корреляция идёт по
 * `traceId` (`07-contracts.md:349`).
 *
 * **Токен и согласованная ревизия протокола едут в конверте, а не внутри `IpcRequest`.** Это
 * и есть И5: форма запроса заморожена, и приписать к ней поле нельзя — ни argv, ни путь к
 * бинарю, ни транспортную метаинформацию. Конверт — не лазейка в И5, а обратная его сторона:
 * то, что не является запросом на исполнение, в запрос на исполнение и не кладётся.
 */
export interface HelloFrame {
  readonly kind: 'hello';
  readonly token: string;
  readonly protocolVersion: string;
}

export interface WelcomeFrame {
  readonly kind: 'welcome';
  /** Порождается демоном на соединение: одно соединение — один шим — одна сессия клиента. */
  readonly sessionId: string;
}

export interface ListFrame {
  readonly kind: 'list';
  readonly id: number;
}

export interface CallFrame {
  readonly kind: 'call';
  readonly id: number;
  readonly request: IpcRequest;
}

export interface ListReplyFrame {
  readonly kind: 'list-reply';
  readonly id: number;
  readonly tools: readonly Tool[];
}

export interface CallOk {
  readonly ok: true;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly truncated: boolean;
  readonly violations: number;
}

export interface CallDenied {
  readonly ok: false;
  readonly verdict: 'denied' | 'error';
  readonly denyReason: string;
}

export interface CallReplyFrame {
  readonly kind: 'call-reply';
  readonly id: number;
  readonly result: CallOk | CallDenied;
}

export interface ErrorFrame {
  readonly kind: 'error';
  readonly id: number | null;
  readonly code: string;
  readonly message: string;
}

/**
 * Единственный кадр, который демон шлёт сам, без запроса: манифест перечитан вотчером E1, и
 * список инструментов у клиента устарел. Без него подключение вотчера к демону — половина
 * работы: политика бы менялась, а модель продолжала звать снятый рецепт.
 */
export interface ToolsChangedFrame {
  readonly kind: 'tools-changed';
}

export type ClientFrame = HelloFrame | ListFrame | CallFrame;
export type ServerFrame = WelcomeFrame | ListReplyFrame | CallReplyFrame | ErrorFrame | ToolsChangedFrame;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export type ParsedClientFrame =
  | { readonly ok: true; readonly frame: ClientFrame }
  | { readonly ok: false; readonly problem: string };

/**
 * Разбор входящего кадра. Проверяется ФОРМА, а не тип: `IpcRequest` — это тип, а не рантайм-
 * гарантия, по сокету приходит произвольный JSON, и это записано требованием R29 эпика E2.
 *
 * `params` проверяется только на контейнер — что это объект, а не массив и не `null`. Что
 * лежит внутри, решает E2 на стадии `validate`: дублировать его словарь отказов здесь значило
 * бы завести второй, расходящийся.
 */
export function parseClientFrame(value: unknown): ParsedClientFrame {
  if (!isRecord(value)) return { ok: false, problem: 'кадр не является объектом' };
  const kind = value.kind;

  if (kind === 'hello') {
    if (typeof value.token !== 'string' || value.token === '') return { ok: false, problem: 'hello без токена' };
    if (typeof value.protocolVersion !== 'string' || value.protocolVersion === '') {
      return { ok: false, problem: 'hello без согласованной ревизии протокола' };
    }
    return { ok: true, frame: { kind: 'hello', token: value.token, protocolVersion: value.protocolVersion } };
  }

  if (kind === 'list') {
    if (typeof value.id !== 'number' || !Number.isInteger(value.id)) return { ok: false, problem: 'list без целого id' };
    return { ok: true, frame: { kind: 'list', id: value.id } };
  }

  if (kind === 'call') {
    if (typeof value.id !== 'number' || !Number.isInteger(value.id)) return { ok: false, problem: 'call без целого id' };
    const request = value.request;
    if (!isRecord(request)) return { ok: false, problem: 'call без объекта request' };

    const { recipeName, params, sessionId } = request;
    if (typeof recipeName !== 'string' || !isRecipeName(recipeName)) {
      return { ok: false, problem: 'recipeName не является именем рецепта' };
    }
    if (!isRecord(params)) return { ok: false, problem: 'params не является объектом' };
    if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, problem: 'sessionId пуст' };

    // Лишние ключи в запросе отвергаются, а не игнорируются: И5 обещает, что приписать к
    // форме `argv` нельзя, и обещание, которое держится только на том, что читатель не
    // смотрит на лишнее поле, не является структурным.
    for (const key of Object.keys(request)) {
      if (key !== 'recipeName' && key !== 'params' && key !== 'sessionId') {
        return { ok: false, problem: `лишнее поле в request: ${JSON.stringify(key)}` };
      }
    }

    return {
      ok: true,
      frame: {
        kind: 'call',
        id: value.id,
        request: { recipeName: asRecipeName(recipeName), params, sessionId: asSessionId(sessionId) },
      },
    };
  }

  return { ok: false, problem: `неизвестный вид кадра: ${JSON.stringify(kind)}` };
}
