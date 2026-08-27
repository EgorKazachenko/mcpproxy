import { describe, expect, expectTypeOf, it } from 'vitest';
import { argsHash } from './audit/args.js';
import { isoToUnixNano } from './otlp.js';
import type { ApprovalRecord, ApprovalRequest, ApprovalVerdict } from './approval.js';
import type { AuditEvent } from './event.js';
import { asRecipeName, asRequestId, asSessionId, type IpcRequest, type RequestId, type SessionId } from './ipc.js';

const requestId = asRequestId('req-7f3a');
const sessionId = asSessionId('sess-1');
const recipeName = asRecipeName('publish_release');

describe('argsHash — замороженная формула', () => {
  it('64 строчных hex без префикса', () => {
    expect(argsHash(recipeName, { tag: 'v1.0.0' })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('recipeName входит в дайджест', () => {
    // Иначе скоуп recipe_and_args переносится между рецептами с одинаковыми аргументами.
    expect(argsHash('publish_release', { tag: 'v1.0.0' })).not.toBe(argsHash('run_tests', { tag: 'v1.0.0' }));
  });

  it('порядок ключей params на дайджест не влияет — их сортирует JCS', () => {
    expect(argsHash(recipeName, { a: 1, b: 2 })).toBe(argsHash(recipeName, { b: 2, a: 1 }));
  });

  it('незаданный необязательный параметр отсутствует как ключ, а не приезжает как null', () => {
    // JCS различает их побайтово, и подтверждение «того же вызова» иначе не совпадёт.
    expect(argsHash(recipeName, { tag: 'v1' })).not.toBe(argsHash(recipeName, { tag: 'v1', channel: null }));
  });

  it('резолвнутый путь и относительный — разные вызовы до резолва и один после', () => {
    // Контракт говорит: params хэшируются ПОСЛЕ валидации и резолва путей.
    expect(argsHash(recipeName, { file: './logs/a.log' })).not.toBe(argsHash(recipeName, { file: '/p/logs/a.log' }));
    expect(argsHash(recipeName, { file: '/p/logs/a.log' })).toBe(argsHash(recipeName, { file: '/p/logs/a.log' }));
  });
});

describe('формы подтверждения', () => {
  const request: ApprovalRequest = {
    requestId,
    sessionId,
    recipeName,
    argsHash: argsHash(recipeName, { tag: 'v1.0.0' }),
    tier: 'high',
    argv: ['/bin/sh', './scripts/publish.sh', 'v1.0.0'],
    cwd: '/p',
    profile: { network: { allow: ['registry.npmjs.org'] } },
  };

  it('argsHash покрывает ту же пару «рецепт + аргументы», что показали человеку', () => {
    // Прежние два утверждения перечисляли поля объявленного тут же литерала: ни одна строка
    // продакшена, будучи удалённой, их не роняла. Формы держит `tsc -b` — он видит и
    // `*.test.ts`, — а исполняемого здесь ровно одно: дайджест обязан меняться и от
    // аргументов, и от имени рецепта, иначе апрув можно предъявить к другому вызову.
    expect(argsHash(recipeName, { tag: 'v1.0.0' })).toBe(request.argsHash);
    expect(argsHash(recipeName, { tag: 'v1.0.1' })).not.toBe(request.argsHash);
    expect(argsHash(asRecipeName('run_tests'), { tag: 'v1.0.0' })).not.toBe(request.argsHash);
  });

  it('requestId брендирован и не принимает SessionId', () => {
    expectTypeOf<ApprovalVerdict['requestId']>().toEqualTypeOf<RequestId>();
    expectTypeOf<SessionId>().not.toExtend<RequestId>();
  });

  it('вердикт со скоупом until несёт абсолютное время, а не TTL', () => {
    const verdict: ApprovalVerdict = {
      requestId,
      sessionId,
      channel: 'electron',
      decision: 'approved',
      scope: 'until',
      expiresAt: '2026-08-27T10:10:00.000Z',
    };
    // `new Date('')` возвращает Invalid Date, а не бросает, — прежняя проверка «не бросает»
    // не могла покраснеть никогда. Осмысленно здесь только то, что время АБСОЛЮТНОЕ: оно
    // разбирается, несёт зону и не является длительностью. Последнее и есть суть R26 —
    // относительный TTL в вердикте выражать нечем.
    expect(Number.isNaN(Date.parse(verdict.expiresAt ?? ''))).toBe(false);
    expect(verdict.expiresAt).toMatch(/Z$|[+-]\d{2}:\d{2}$/);
    // Исполнимая пара к строке ниже: относительный TTL этой формой невыразим не потому, что
    // так написано в литерале теста, а потому что экспортёр его не принимает.
    expect(() => isoToUnixNano('600s')).toThrow(TypeError);
    // И то же время, поданное экспортёру, — законная метка, а не отвергаемая форма:
    // связь между двумя замороженными формами держится тестом, а не совпадением.
    expect(() => isoToUnixNano(verdict.expiresAt ?? '')).not.toThrow();
  });

  it('истечение и отмена выражаются отсутствием вердикта, а не третьим решением', () => {
    expectTypeOf<ApprovalVerdict['decision']>().toEqualTypeOf<'approved' | 'denied'>();
  });

  it('approval.sessionId в событии равен sessionId события', () => {
    // Иначе подтверждение со скоупом until оказывается неявно действительным во всех
    // сессиях, включая ту, которую человеку никогда не показывали (И8).
    const approval: ApprovalRecord = {
      channel: 'electron',
      decision: 'approved',
      scope: 'until',
      expiresAt: '2026-08-27T10:10:00.000Z',
      argsHash: request.argsHash,
      sessionId,
    };
    const event: AuditEvent = {
      schema: 'mcpproxy.audit/1',
      operation: 'execute_tool',
      protocolVersion: '2025-11-25',
      toolName: 'publish_release',
      sessionId,
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      parentSpanId: null,
      startTime: '2026-08-27T10:00:00.000Z',
      endTime: '2026-08-27T10:00:00.001Z',
      durationUs: 1_000,
      stage: 'approval',
      verdict: 'allowed',
      recipe: { name: 'publish_release' },
      approval,
    };
    expect(event.approval?.sessionId).toBe(event.sessionId);
  });
});

describe('IpcRequest', () => {
  it('несёт только имя рецепта, параметры и сессию', () => {
    const request: IpcRequest = { recipeName, params: { tag: 'v1.0.0' }, sessionId };
    expect(Object.keys(request).sort()).toEqual(['params', 'recipeName', 'sessionId']);
  });

  it('argv, путь к бинарю, cwd и профиль в этой форме невыразимы', () => {
    // Структурная проверка: лишний ключ — ошибка компиляции, а не принятый запрос.
    // @ts-expect-error argv не является частью контракта IPC
    const smuggled: IpcRequest = { recipeName, params: {}, sessionId, argv: ['/bin/sh', '-c', 'id'] };
    expect(Object.keys(smuggled)).toContain('argv');
  });

  it('перестановка идентификаторов — ошибка компиляции', () => {
    // @ts-expect-error sessionId не является RecipeName
    const swapped: IpcRequest = { recipeName: sessionId, params: {}, sessionId };
    expect(swapped.recipeName).toBe('sess-1');
  });
});
