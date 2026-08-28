import {
  asRecipeName,
  asRequestId,
  asSessionId,
  type ApprovalChannel,
  type ApprovalRequest,
  type ApprovalVerdict,
} from '@mcpproxy/contracts';
import { describe, expect, it } from 'vitest';
import { createBroker, type ApprovalPort } from './broker.js';
import { createGrantStore } from './grants.js';

const NOW = new Date('2026-08-28T12:00:00.000Z');
const LATER = new Date('2026-08-28T12:10:00.000Z');
const MUCH_LATER = new Date('2026-08-28T13:00:00.000Z');

const request = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  requestId: asRequestId('req-1'),
  sessionId: asSessionId('session-a'),
  recipeName: asRecipeName('publish_release'),
  argsHash: 'a'.repeat(64),
  tier: 'high',
  argv: ['/usr/bin/npm', 'publish'],
  cwd: '/repo',
  profile: {},
  ...over,
});

/** Порт, который отвечает заранее заданным вердиктом и считает, сколько раз его спросили. */
function stubPort(channel: ApprovalChannel, reply: (req: ApprovalRequest) => ApprovalVerdict | null): ApprovalPort & { asked: number } {
  const port = {
    channel,
    asked: 0,
    async ask(req: ApprovalRequest): Promise<ApprovalVerdict | null> {
      port.asked += 1;
      return reply(req);
    },
  };
  return port;
}

const approve = (over: Partial<ApprovalVerdict> = {}) => (req: ApprovalRequest): ApprovalVerdict => ({
  requestId: req.requestId,
  sessionId: req.sessionId,
  channel: 'electron',
  decision: 'approved',
  scope: 'once',
  expiresAt: null,
  ...over,
});

describe('Broker — маршрут по тиру (ADR-0005)', () => {
  it('low не спрашивают вовсе, и записи вердикта нет', () => {
    const electron = stubPort('electron', approve());
    return createBroker({ ports: [electron], clock: () => NOW })
      .decide(request({ tier: 'low' }), 'low')
      .then((outcome) => {
        expect(outcome.kind).toBe('not_required');
        expect(electron.asked).toBe(0);
      });
  });

  it('medium автоматичен, пока мягкий канал не подключён', async () => {
    const outcome = await createBroker({ ports: [], clock: () => NOW }).decide(request({ tier: 'medium' }), 'medium');
    expect(outcome.kind).toBe('not_required');
  });

  it('medium идёт в elicitation, если он есть', async () => {
    const soft = stubPort('elicitation', approve({ channel: 'elicitation' }));
    const outcome = await createBroker({ ports: [soft], clock: () => NOW }).decide(request({ tier: 'medium' }), 'medium');
    expect(outcome.kind).toBe('granted');
    expect(soft.asked).toBe(1);
    if (outcome.kind !== 'granted') return;
    expect(outcome.record.channel).toBe('elicitation');
  });

  it('high НЕ спрашивают через elicitation — это и есть ASI09', async () => {
    const soft = stubPort('elicitation', approve({ channel: 'elicitation' }));
    const outcome = await createBroker({ ports: [soft], clock: () => NOW }).decide(request(), 'high');
    // Elicitation идёт через клиента и модель, то есть по каналу, который модель угрозы
    // считает скомпрометированным. Подключённый мягкий канал high-вызов не спасает.
    expect(soft.asked).toBe(0);
    expect(outcome).toMatchObject({ kind: 'refused', code: 'approval-unavailable' });
  });

  it('headless — отказ, а не ожидание (R44)', async () => {
    const outcome = await createBroker({ ports: [], clock: () => NOW }).decide(request(), 'high');
    expect(outcome).toMatchObject({ kind: 'refused', code: 'approval-unavailable' });
    if (outcome.kind !== 'refused') return;
    // Записи вердикта нет: человека не спрашивали, и выдумывать за него `denied` нельзя.
    expect(outcome.record).toBeUndefined();
  });
});

describe('Broker — вердикт и его сопоставление', () => {
  it('одобрение даёт запись с обеими частями ключа', async () => {
    const electron = stubPort('electron', approve());
    const outcome = await createBroker({ ports: [electron], clock: () => NOW }).decide(request(), 'high');
    expect(outcome.kind).toBe('granted');
    if (outcome.kind !== 'granted') return;
    expect(outcome.record).toEqual({
      channel: 'electron',
      decision: 'approved',
      scope: 'once',
      expiresAt: null,
      argsHash: 'a'.repeat(64),
      sessionId: 'session-a',
    });
    expect(outcome.reused).toBe(false);
  });

  it('молчание канала — отказ без записи', async () => {
    const electron = stubPort('electron', () => null);
    const outcome = await createBroker({ ports: [electron], clock: () => NOW }).decide(request(), 'high');
    expect(outcome).toMatchObject({ kind: 'refused', code: 'approval-no-verdict' });
    if (outcome.kind !== 'refused') return;
    expect(outcome.record).toBeUndefined();
  });

  it('отказ человека — запись есть, вызов не идёт', async () => {
    const electron = stubPort('electron', approve({ decision: 'denied' }));
    const outcome = await createBroker({ ports: [electron], clock: () => NOW }).decide(request(), 'high');
    expect(outcome).toMatchObject({ kind: 'refused', code: 'approval-denied' });
    if (outcome.kind !== 'refused') return;
    expect(outcome.record?.decision).toBe('denied');
  });

  it('чужой requestId не одобряет ожидающий вызов (R43)', async () => {
    const electron = stubPort('electron', (req) => ({ ...approve()(req), requestId: asRequestId('req-2') }));
    const outcome = await createBroker({ ports: [electron], clock: () => NOW }).decide(request(), 'high');
    expect(outcome).toMatchObject({ kind: 'refused', code: 'approval-mismatched' });
  });

  it('чужой sessionId не одобряет вызов этой сессии (R43)', async () => {
    const electron = stubPort('electron', (req) => ({ ...approve()(req), sessionId: asSessionId('session-b') }));
    const outcome = await createBroker({ ports: [electron], clock: () => NOW }).decide(request(), 'high');
    expect(outcome).toMatchObject({ kind: 'refused', code: 'approval-mismatched' });
  });

  it('`until` с прошедшим сроком — отказ, а не тихое сведение к `once`', async () => {
    const electron = stubPort('electron', approve({ scope: 'until', expiresAt: '2020-01-01T00:00:00.000Z' }));
    const outcome = await createBroker({ ports: [electron], clock: () => NOW }).decide(request(), 'high');
    // Переписать выбор человека в более широкий значило бы записать в журнал не то решение,
    // которое он принял.
    expect(outcome).toMatchObject({ kind: 'refused', code: 'approval-expired' });
  });
});

describe('Broker — повторный вызов', () => {
  it('`once` не переживает вызов: спрашивают снова', async () => {
    const electron = stubPort('electron', approve());
    const broker = createBroker({ ports: [electron], clock: () => NOW });
    await broker.decide(request(), 'high');
    await broker.decide(request({ requestId: asRequestId('req-2') }), 'high');
    expect(electron.asked).toBe(2);
  });

  it('`recipe_and_args` переиспользуется и канал в записи — тот, которым спросили', async () => {
    const electron = stubPort('electron', approve({ scope: 'recipe_and_args' }));
    const broker = createBroker({ ports: [electron], clock: () => NOW });
    await broker.decide(request(), 'high');
    const second = await broker.decide(request({ requestId: asRequestId('req-2') }), 'high');

    expect(electron.asked).toBe(1);
    expect(second.kind).toBe('granted');
    if (second.kind !== 'granted') return;
    expect(second.reused).toBe(true);
    expect(second.record.channel).toBe('electron');
    expect(second.record.scope).toBe('recipe_and_args');
  });

  it('`until` перестаёт действовать после срока — спрашивают заново', async () => {
    const electron = stubPort('electron', approve({ scope: 'until', expiresAt: LATER.toISOString() }));
    let now = NOW;
    const broker = createBroker({ ports: [electron], grants: createGrantStore(), clock: () => now });

    await broker.decide(request(), 'high');
    now = MUCH_LATER;
    const after = await broker.decide(request({ requestId: asRequestId('req-2') }), 'high');

    expect(electron.asked).toBe(2);
    // Второй вопрос вернул тот же истёкший срок — и второй раз это тоже отказ.
    expect(after).toMatchObject({ kind: 'refused', code: 'approval-expired' });
  });

  it('другие аргументы того же рецепта спрашиваются заново', async () => {
    const electron = stubPort('electron', approve({ scope: 'recipe_and_args' }));
    const broker = createBroker({ ports: [electron], clock: () => NOW });
    await broker.decide(request(), 'high');
    await broker.decide(request({ requestId: asRequestId('req-2'), argsHash: 'b'.repeat(64) }), 'high');
    expect(electron.asked).toBe(2);
  });
});
