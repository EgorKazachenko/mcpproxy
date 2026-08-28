import { describe, expect, it } from 'vitest';
import type { AuditEvent, ChainedEvent } from '../event.js';
import { chainHash, DIGEST_HEX_LENGTH, unchain, verifyChain } from './chain.js';

const event = (index: number): AuditEvent => ({
  schema: 'mcpproxy.audit/1',
  operation: 'execute_tool',
  protocolVersion: '2025-11-25',
  toolName: 'run_tests',
  sessionId: 'sess-1',
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  spanId: `00f067aa0ba902${String(index).padStart(2, '0')}`,
  parentSpanId: null,
  startTime: '2026-08-27T10:00:00.000000Z',
  endTime: '2026-08-27T10:00:00.009120Z',
  durationUs: 9_120,
  stage: 'complete',
  verdict: 'allowed',
  recipe: { name: 'run_tests' },
  output: { bytes: 100 + index, truncated: false },
});

/** Честно построенная цепочка: каждая запись ссылается на `self` предыдущей. */
function chainOf(count: number): ChainedEvent[] {
  const out: ChainedEvent[] = [];
  let prev: string | null = null;
  for (let i = 0; i < count; i += 1) {
    const body = event(i);
    const self = chainHash(body, prev);
    out.push({ ...body, chain: { prev, self } });
    prev = self;
  }
  return out;
}

describe('chainHash — замороженная формула', () => {
  it('дайджест — 64 строчных hex-символа без префикса sha256:', () => {
    const hash = chainHash(event(0), null);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toHaveLength(DIGEST_HEX_LENGTH);
    expect(hash.startsWith('sha256:')).toBe(false);
  });

  it('фиксированное событие даёт фиксированный дайджест', () => {
    // Вектор кодировки: если кто-то поменяет форму `{prev, event}`, порядок ключей или
    // кодировку дайджеста, эта строка разойдётся, а не «просто станет другой».
    expect(chainHash(event(0), null)).toBe('ba1bb478e1fdf5f060043b7fc368f6bd4c15d271a7a56d7b87d5f2fccba0c98b');
  });

  it('prev входит внутрь каноничной формы, а не приписывается снаружи', () => {
    // Без этого возможна реализация sha256(jcs(event)), где цепочки нет вовсе.
    expect(chainHash(event(0), null)).not.toBe(chainHash(event(0), 'a'.repeat(64)));
  });

  it('префикс sha256: в prev дал бы другой дайджест — поэтому кодировка заморожена', () => {
    const bare = 'a'.repeat(64);
    expect(chainHash(event(0), bare)).not.toBe(chainHash(event(0), `sha256:${bare}`));
  });
});

describe('unchain', () => {
  it('возвращает новый объект без ключа chain', () => {
    const [chained] = chainOf(1);
    if (chained === undefined) throw new Error('фикстура пуста');
    const bare = unchain(chained);
    expect('chain' in bare).toBe(false);
    expect(bare).not.toBe(chained);
    expect(chained.chain).toBeDefined();
  });
});

describe('verifyChain', () => {
  it('честная цепочка проходит', () => {
    expect(verifyChain(chainOf(5))).toEqual({ ok: true });
    expect(verifyChain([])).toEqual({ ok: true });
  });

  it('компетентный атакующий: правка записи 3 с пересчётом её self ловится на записи 4', () => {
    // Единственная фальсификация, отбраковывающая целый класс неверных реализаций.
    // «Самосогласованность» — проверка каждой записи в одиночку — возвращает {ok:true}:
    // запись 3 проходит обе половины предиката, её prev не тронут, её self пересчитан верно.
    // Расхождение всплывает на записи 4, чей prev хранит СТАРЫЙ self записи 3.
    const events = chainOf(6);
    const target = events[3];
    if (target === undefined) throw new Error('фикстура пуста');

    const tampered = { ...target, output: { bytes: 999_999, truncated: false } };
    events[3] = { ...tampered, chain: { prev: target.chain.prev, self: chainHash(unchain(tampered), target.chain.prev) } };

    expect(verifyChain(events)).toEqual({ ok: false, brokenAt: 4 });
  });

  it('правка байта без пересчёта ловится на самой записи', () => {
    const events = chainOf(4);
    const target = events[2];
    if (target === undefined) throw new Error('фикстура пуста');
    events[2] = { ...target, output: { bytes: 42, truncated: false } };

    expect(verifyChain(events)).toEqual({ ok: false, brokenAt: 2 });
  });

  it('подделка ПЕРВОЙ записи даёт brokenAt: 0, а не ложное «всё хорошо»', () => {
    // Форма возврата размеченная именно поэтому: `number | null` сделал бы 0 ложным.
    const events = chainOf(3);
    const target = events[0];
    if (target === undefined) throw new Error('фикстура пуста');
    events[0] = { ...target, output: { bytes: 7, truncated: false } };

    expect(verifyChain(events)).toEqual({ ok: false, brokenAt: 0 });
  });

  // Оба кейса ниже пересчитывают `self` под подменённый `prev`. Без пересчёта краснела
  // вторая половина предиката — самосогласованность записи, — то есть тест проходил бы
  // мимо правила, которое назван проверять: сведя предикат к самосогласованности, оба
  // оставались зелёными. Теперь красным их делает ТОЛЬКО правило связи.
  it('генезис обязан иметь prev: null', () => {
    const events = chainOf(2);
    const target = events[0];
    if (target === undefined) throw new Error('фикстура пуста');
    const forged = 'b'.repeat(64);
    events[0] = { ...target, chain: { prev: forged, self: chainHash(unchain(target), forged) } };

    expect(verifyChain(events)).toEqual({ ok: false, brokenAt: 0 });
  });

  it('перестановка prev двух соседних записей ловится', () => {
    const events = chainOf(4);
    const first = events[1];
    const second = events[2];
    if (first === undefined || second === undefined) throw new Error('фикстура пуста');
    events[1] = { ...first, chain: { prev: second.chain.prev, self: chainHash(unchain(first), second.chain.prev) } };
    events[2] = { ...second, chain: { prev: first.chain.prev, self: chainHash(unchain(second), first.chain.prev) } };

    expect(verifyChain(events)).toEqual({ ok: false, brokenAt: 1 });
  });
});

describe('sandbox.evidence — добавлено аддитивно (E4)', () => {
  const withEvidence = (): AuditEvent => ({
    ...event(0),
    sandbox: {
      mode: 'seatbelt',
      evidence: {
        policyHash: 'c'.repeat(64),
        violationsLost: 0,
        attributionMissing: 0,
        attributionForeign: 0,
        unrecognizedLines: 0,
        suppressedLines: 0,
        consumerFailures: 0,
        bodyCountFailures: 0,
        lateUnattributed: 0,
      },
    },
  });

  it('событие без поля даёт тот же дайджест, что и до добавления поля', () => {
    // Тот же вектор, что и выше по файлу. Он и есть доказательство аддитивности: если бы
    // необязательное поле как-то входило в каноничную форму отсутствующим, эта строка ушла бы,
    // и уже записанные цепочки перестали бы верифицироваться.
    expect(chainHash(event(0), null)).toBe('ba1bb478e1fdf5f060043b7fc368f6bd4c15d271a7a56d7b87d5f2fccba0c98b');
    expect(Object.hasOwn(event(0), 'sandbox')).toBe(false);
  });

  it('событие с полем даёт другой дайджест — иначе поле не доказывало бы ничего', () => {
    expect(chainHash(withEvidence(), null)).not.toBe(chainHash(event(0), null));
  });

  it('нулевые счётчики — не то же самое, что отсутствие evidence', () => {
    const { sandbox } = withEvidence();
    const withoutEvidence: AuditEvent = { ...event(0), sandbox: { mode: sandbox!.mode } };
    expect(chainHash(withEvidence(), null)).not.toBe(chainHash(withoutEvidence, null));
  });
});
