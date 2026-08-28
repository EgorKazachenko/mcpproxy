import { asRecipeName, asRequestId, asSessionId, type ApprovalRequest } from '@mcpproxy/contracts';
import { describe, expect, it } from 'vitest';
import { dangerousToken } from './token.js';

const request = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  requestId: asRequestId('req-1'),
  sessionId: asSessionId('session-a'),
  recipeName: asRecipeName('publish_release'),
  argsHash: 'a'.repeat(64),
  tier: 'high',
  argv: ['/usr/bin/npm', 'publish', '--tag', 'latest'],
  cwd: '/repo',
  profile: {},
  ...over,
});

describe('dangerousToken — правило вычислимо из формы (R41, R63)', () => {
  it('берётся ПЕРВЫЙ подставленный из параметров элемент', () => {
    const token = dangerousToken(request({ argvFromParams: [3, 1] }));
    // Порядок argv следует порядку объявления параметров (R19) — значит, «первый» стабилен
    // между вызовами, а «самый длинный» менялся бы от значения к значению.
    expect(token).toEqual({ index: 1, token: 'publish', fromParams: true });
  });

  it('пустой подставленный элемент пропускается: набирать нечего', () => {
    const token = dangerousToken(request({ argv: ['/usr/bin/npm', '', 'latest'], argvFromParams: [1, 2] }));
    expect(token).toEqual({ index: 2, token: 'latest', fromParams: true });
  });

  it('индексы вне диапазона и повторы не выбираются', () => {
    // Инвариант объявлен в контракте, но форма приезжает из другого процесса: выход за
    // диапазон дал бы `undefined` токеном, то есть окно, которое невозможно подтвердить.
    const token = dangerousToken(request({ argvFromParams: [99, -1, 1.5, 3, 3] }));
    expect(token).toEqual({ index: 3, token: 'latest', fromParams: true });
  });

  it('без индексов берётся хвост, и это помечено', () => {
    const token = dangerousToken(request({ argvFromParams: [] }));
    // Не `argv[0]`: путь к бинарю одинаков у всех вызовов рецепта и про этот вызов не
    // сообщает ничего. `fromParams: false` — обещание «вы набрали то, чем управляет модель»
    // здесь не даётся, и окно обязано их различать.
    expect(token).toEqual({ index: 3, token: 'latest', fromParams: false });
  });

  it('поле отсутствует целиком — тот же хвост', () => {
    expect(dangerousToken(request())?.fromParams).toBe(false);
  });

  it('пустой argv даёт null, а не пустой токен', () => {
    expect(dangerousToken(request({ argv: [], argvFromParams: [] }))).toBeNull();
    expect(dangerousToken(request({ argv: ['', ''] }))).toBeNull();
  });
});
