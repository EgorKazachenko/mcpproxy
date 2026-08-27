import { appendFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEvent, ChainedEvent } from '@mcpproxy/contracts';
import { MCP_PROTOCOL_VERSION } from '@mcpproxy/contracts';
import { chainHash, unchain } from '@mcpproxy/contracts/audit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultAuditLogPath, openAuditLog, readLog, verifyLog } from './log.js';

// Только временные каталоги: чек-лист приватности, и заодно два прогона рядом не дерутся.
let dir: string;
let path: string;
const opened: { close: () => void }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcpproxy-audit-'));
  path = join(dir, 'audit.jsonl');
});
afterEach(() => {
  for (const log of opened.splice(0)) log.close();
});

const open = (): ReturnType<typeof openAuditLog> => {
  const log = openAuditLog({ path });
  opened.push(log);
  return log;
};

/** Обязательное ядро события — то, что существует на любой стадии, включая `received`. */
const event = (stage: AuditEvent['stage'] = 'received', toolName = 'run_tests'): AuditEvent => ({
  schema: 'mcpproxy.audit/1',
  operation: 'execute_tool',
  protocolVersion: MCP_PROTOCOL_VERSION,
  toolName,
  sessionId: 'session-1',
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: 'b7ad6b7169203331',
  parentSpanId: null,
  startTime: '2026-08-27T10:00:00.000000Z',
  endTime: '2026-08-27T10:00:00.009120Z',
  durationUs: 9120,
  stage,
  verdict: 'allowed',
  recipe: { name: toolName },
});

const lines = (): string[] => readFileSync(path, 'utf8').split('\n').filter((one) => one !== '');
const rewrite = (records: readonly unknown[]): void =>
  writeFileSync(path, `${records.map((one) => JSON.stringify(one)).join('\n')}\n`);

describe('запись', () => {
  it('первая запись — генезис: prev равен null', () => {
    const chained = open().append(event());
    expect(chained.chain.prev).toBeNull();
    expect(chained.chain.self).toHaveLength(64);
    expect(chained.chain.self).toMatch(/^[0-9a-f]{64}$/);
  });

  it('R15: self считается замороженной формулой E0, а не своей копией', () => {
    const chained = open().append(event());
    expect(chained.chain.self).toBe(chainHash(unchain(chained), null));
  });

  it('вторая запись ссылается на первую', () => {
    const log = open();
    const first = log.append(event('received'));
    const second = log.append(event('lock_check'));
    expect(second.chain.prev).toBe(first.chain.self);
  });

  it('одна запись — одна строка', () => {
    const log = open();
    log.append(event('received'));
    log.append(event('lock_check'));
    expect(lines()).toHaveLength(2);
  });

  it('строка оканчивается переводом строки, записанным тем же вызовом', () => {
    // Два `write` оставили бы окно, в котором запись лежит без `\n`, и параллельный читатель
    // видел бы её как оборванный хвост.
    open().append(event());
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
  });

  it('запись после close отвергается, а не уходит в никуда', () => {
    const log = openAuditLog({ path });
    log.append(event());
    log.close();
    expect(() => log.append(event('lock_check'))).toThrow(/закрыт/);
  });

  it('повторный close безвреден', () => {
    const log = openAuditLog({ path });
    log.close();
    expect(() => log.close()).not.toThrow();
  });
});

describe('R18: права', () => {
  it('файл создаётся с 0600', () => {
    open().append(event());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('каталог создаётся с 0700', () => {
    const nested = join(dir, 'deep', 'audit.jsonl');
    openAuditLog({ path: nested }).close();
    expect(statSync(join(dir, 'deep')).mode & 0o777).toBe(0o700);
  });
});

describe('R16: перезапуск демона', () => {
  it('дозапись продолжает цепочку, а не начинает новую', () => {
    const first = openAuditLog({ path });
    const genesis = first.append(event('received'));
    first.close();

    const second = openAuditLog({ path });
    const next = second.append(event('lock_check'));
    second.close();

    expect(next.chain.prev).toBe(genesis.chain.self);
    expect(verifyLog(readLog(path))).toEqual({ ok: true, count: 2 });
  });

  it('head после открытия существующего журнала — хэш последней записи', () => {
    const first = openAuditLog({ path });
    const last = first.append(event());
    first.close();

    const second = openAuditLog({ path });
    expect(second.head()).toBe(last.chain.self);
    second.close();
  });

  it('журнал, переживший три открытия, верифицируется целиком', () => {
    for (const stage of ['received', 'lock_check', 'validate'] as const) {
      const log = openAuditLog({ path });
      log.append(event(stage));
      log.close();
    }
    expect(verifyLog(readLog(path))).toEqual({ ok: true, count: 3 });
  });
});

describe('R21: верификация', () => {
  const seed = (count: number): void => {
    const log = open();
    for (let i = 0; i < count; i += 1) log.append(event('received', `tool_${i}`));
  };

  it('нетронутый журнал верифицируется', () => {
    seed(4);
    expect(verifyLog(readLog(path))).toEqual({ ok: true, count: 4 });
  });

  it('пустой журнал верифицируется и не притворяется сломанным', () => {
    expect(verifyLog(readLog(path))).toEqual({ ok: true, count: 0 });
  });

  it('грубая правка записи ломает цепочку на ней самой', () => {
    seed(4);
    const records = lines().map((line) => JSON.parse(line) as ChainedEvent);
    rewrite(records.map((one, i) => (i === 2 ? { ...one, cwd: '/подменено' } : one)));

    expect(verifyLog(readLog(path))).toEqual({ ok: false, brokenAt: 2, count: 4 });
  });

  it('S9: правка с ПЕРЕСЧЁТОМ self всплывает на следующей записи', () => {
    // Это и есть тезис демо. Формула публична, поэтому атакующий пересчитывает `self`
    // правленой записи — и та становится самосогласованной. Разрыв вылезает на записи 3,
    // чей `prev` всё ещё указывает на старый хэш. Реализация, проверяющая только
    // самосогласованность каждой записи, прошла бы этот файл как чистый.
    seed(4);
    const records = lines().map((line) => JSON.parse(line) as ChainedEvent);
    const forged = { ...records[2], cwd: '/подменено' } as ChainedEvent;
    const resealed: ChainedEvent = {
      ...forged,
      chain: { prev: forged.chain.prev, self: chainHash(unchain(forged), forged.chain.prev) },
    };
    rewrite(records.map((one, i) => (i === 2 ? resealed : one)));

    expect(verifyLog(readLog(path))).toEqual({ ok: false, brokenAt: 3, count: 4 });
  });

  it('подделка ПЕРВОЙ записи ловится, а не проваливается в ложный ноль', () => {
    seed(3);
    const records = lines().map((line) => JSON.parse(line) as ChainedEvent);
    rewrite(records.map((one, i) => (i === 0 ? { ...one, cwd: '/подменено' } : one)));

    const verdict = verifyLog(readLog(path));
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.brokenAt).toBe(0);
  });

  it('перестановка двух записей местами ловится', () => {
    seed(4);
    const records = lines().map((line) => JSON.parse(line) as ChainedEvent);
    rewrite([records[0], records[2], records[1], records[3]]);
    expect(verifyLog(readLog(path)).ok).toBe(false);
  });
});

describe('R19: оборванный хвост', () => {
  it('недописанная последняя строка помечается, а не считается разрывом', () => {
    const log = open();
    log.append(event('received'));
    log.append(event('lock_check'));
    appendFileSync(path, '{"schema":"mcpproxy.audit/1","operat');

    const result = readLog(path);
    expect(result.trailingPartial).toBe(true);
    expect(result.records).toHaveLength(2);
    // Падение демона, нарисованное залу как взлом, стоит доверия к бейджу целиком.
    expect(verifyLog(result)).toEqual({ ok: true, count: 2 });
  });

  it('целый файл оборванным хвостом не считается', () => {
    open().append(event());
    expect(readLog(path).trailingPartial).toBe(false);
  });

  it('пустая строка в конце — это конец файла, а не обрыв', () => {
    open().append(event());
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
    expect(readLog(path).trailingPartial).toBe(false);
  });
});

describe('неразобранная строка В СЕРЕДИНЕ', () => {
  it('останавливает чтение и роняет вердикт на ней', () => {
    // «Пропустить и читать дальше» дало бы согласованную цепочку на порченом файле:
    // последующие `prev` ссылались бы на запись, которой в разборе нет.
    const log = open();
    log.append(event('received'));
    log.close();
    appendFileSync(path, 'не json\n');
    const tail = openAuditLog({ path: join(dir, 'other.jsonl') });
    tail.close();

    const result = readLog(path);
    expect(result.malformedAt).toBe(1);
    expect(result.records).toHaveLength(1);
    expect(verifyLog(result)).toEqual({ ok: false, brokenAt: 1, count: 1 });
  });

  it('строка без блока chain — тоже порча, а не «событие без цепочки»', () => {
    rewrite([{ schema: 'mcpproxy.audit/1', toolName: 'run_tests' }]);
    expect(readLog(path).malformedAt).toBe(0);
  });

  it('пустой блок chain — порча, а не запись со сломанной цепочкой', () => {
    // Разница видна оператору: «файл порчен» и «журнал подделан» — разные события, и первое
    // не должно приезжать под вывеской второго.
    rewrite([{ ...event(), chain: {} }]);
    expect(readLog(path).malformedAt).toBe(0);
  });

  it('chain с полями не тех типов — тоже порча', () => {
    rewrite([{ ...event(), chain: { prev: 5, self: 7 } }]);
    expect(readLog(path).malformedAt).toBe(0);
  });

  it('chain.prev как строка на генезисе разбирается — это уже вопрос к цепочке, не к форме', () => {
    // Обратная сторона: форма верна, значение — нет. Такая запись обязана дойти до
    // верификации и упасть ТАМ, иначе предикат цепочки подменяется проверкой формы.
    const chained = { ...event(), chain: { prev: 'a'.repeat(64), self: 'b'.repeat(64) } };
    rewrite([chained]);
    expect(readLog(path).malformedAt).toBeNull();
    expect(verifyLog(readLog(path))).toEqual({ ok: false, brokenAt: 0, count: 1 });
  });

  it('дозапись в порченый журнал отвергается', () => {
    open().append(event());
    appendFileSync(path, 'не json\n');
    expect(() => openAuditLog({ path })).toThrow(/повреждён/);
  });
});

describe('R20: запись из будущего', () => {
  it('читается и помечается, а не бросает', () => {
    const log = open();
    const genesis = log.append(event('received'));
    log.close();

    // Запись новой версии формы, честно вписанная в цепочку.
    const fromFuture = {
      ...unchain(genesis),
      schema: 'mcpproxy.audit/2',
      stage: 'lock_check',
      somethingNew: { weDoNotKnow: true },
    };
    const self = chainHash(fromFuture as never, genesis.chain.self);
    appendFileSync(path, `${JSON.stringify({ ...fromFuture, chain: { prev: genesis.chain.self, self } })}\n`);

    const result = readLog(path);
    expect(result.future).toEqual([1]);
    expect(result.records).toHaveLength(2);
    expect(result.malformedAt).toBeNull();
  });

  it('и верифицируется наравне с остальными — цепочка не зависит от версии формы', () => {
    // `chainHash` хэширует событие ЦЕЛИКОМ через JCS, поэтому предикат работает над любым
    // валидным JSON. Одна запись из будущего не имеет права сделать нечитаемым весь
    // предшествующий лог, который перегенерировать нельзя.
    const log = open();
    const genesis = log.append(event('received'));
    log.close();

    const fromFuture = { ...unchain(genesis), schema: 'mcpproxy.audit/2', stage: 'lock_check' };
    const self = chainHash(fromFuture as never, genesis.chain.self);
    appendFileSync(path, `${JSON.stringify({ ...fromFuture, chain: { prev: genesis.chain.self, self } })}\n`);

    expect(verifyLog(readLog(path))).toEqual({ ok: true, count: 2 });
  });

  it('своя версия формы в future не попадает', () => {
    open().append(event());
    expect(readLog(path).future).toEqual([]);
  });
});

describe('честная граница: обрезание хвоста НЕ ловится', () => {
  it('удаление последних записей оставляет цепочку согласованной', () => {
    // Тест утверждает СЛАБОСТЬ, а не силу, и стоит здесь именно поэтому: `10-honest-limitations.md`
    // обещает tamper-evident без внешнего якоря, и если завтра кто-то решит, что обрезание
    // ловится, этот тест покраснеет и вернёт его к документу.
    const log = open();
    for (const stage of ['received', 'lock_check', 'validate', 'complete'] as const) log.append(event(stage));
    log.close();

    const kept = lines().slice(0, 2).map((line) => JSON.parse(line) as unknown);
    rewrite(kept);

    expect(verifyLog(readLog(path))).toEqual({ ok: true, count: 2 });
  });
});

describe('defaultAuditLogPath', () => {
  it('MCPPROXY_HOME перекрывает домашний каталог', () => {
    expect(defaultAuditLogPath({ MCPPROXY_HOME: '/tmp/mcp-home' })).toBe('/tmp/mcp-home/audit.jsonl');
  });

  it('без переменной ложится в ~/.mcpproxy', () => {
    expect(defaultAuditLogPath({})).toMatch(/[/\\]\.mcpproxy[/\\]audit\.jsonl$/);
  });
});
