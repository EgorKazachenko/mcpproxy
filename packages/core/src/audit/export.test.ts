import { appendFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEvent } from '@mcpproxy/contracts';
import { MCP_PROTOCOL_VERSION } from '@mcpproxy/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ExportManifest, exportJsonl, exportOtlp } from './export.js';
import { openAuditLog, readLog } from './log.js';

let dir: string;
let path: string;
let dest: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcpproxy-export-'));
  path = join(dir, 'audit.jsonl');
  dest = join(dir, 'out');
});
afterEach(() => {
  /* временный каталог уносит ОС */
});

const event = (stage: AuditEvent['stage'] = 'received'): AuditEvent => ({
  schema: 'mcpproxy.audit/1',
  operation: 'execute_tool',
  protocolVersion: MCP_PROTOCOL_VERSION,
  toolName: 'run_tests',
  sessionId: 'session-1',
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: 'b7ad6b7169203331',
  parentSpanId: null,
  startTime: '2026-08-27T10:00:00.000000Z',
  endTime: '2026-08-27T10:00:00.009120Z',
  durationUs: 9120,
  stage,
  verdict: 'allowed',
  recipe: { name: 'run_tests' },
});

const seed = (stages: readonly AuditEvent['stage'][]): void => {
  const log = openAuditLog({ path });
  for (const stage of stages) log.append(event(stage));
  log.close();
};

const FROZEN = () => new Date('2026-08-27T12:00:00.000Z');
const manifestOf = (result: { manifestPath: string }): ExportManifest =>
  JSON.parse(readFileSync(result.manifestPath, 'utf8')) as ExportManifest;

describe('exportJsonl', () => {
  it('R22: кладёт журнал и сайдкар с вердиктом', () => {
    seed(['received', 'lock_check']);
    const result = exportJsonl(path, dest, { now: FROZEN });

    expect(result.manifest.verification).toEqual({ ok: true, count: 2 });
    expect(result.manifest.count).toBe(2);
    expect(manifestOf(result)).toEqual(result.manifest);
  });

  it('копия ПОБАЙТОВАЯ, а не пересериализация', () => {
    // Пересериализация прогнала бы записи через `JSON.stringify` этой версии кода: порядок
    // ключей мог бы поехать, а вместе с ним — дайджесты, которые получатель считает сам.
    seed(['received', 'lock_check', 'validate']);
    const result = exportJsonl(path, dest, { now: FROZEN });
    expect(readFileSync(result.logPath)).toEqual(readFileSync(path));
  });

  it('экспортированная копия верифицируется независимо', () => {
    // Смысл всей затеи: получателю не нужно верить сайдкару — у него есть файл и формула.
    seed(['received', 'lock_check']);
    const result = exportJsonl(path, dest, { now: FROZEN });
    expect(readLog(result.logPath).records).toHaveLength(2);
  });

  it('несёт оба конца цепочки', () => {
    seed(['received', 'lock_check', 'validate']);
    const records = readLog(path).records;
    const { manifest } = exportJsonl(path, dest, { now: FROZEN });

    expect(manifest.first).toBe(records[0]?.chain.self);
    expect(manifest.last).toBe(records[2]?.chain.self);
    expect(manifest.first).not.toBe(manifest.last);
  });

  it('verifiedAt берётся из инжектированных часов', () => {
    seed(['received']);
    expect(exportJsonl(path, dest, { now: FROZEN }).manifest.verifiedAt).toBe('2026-08-27T12:00:00.000Z');
  });

  it('вердикт по сломанному журналу экспортируется КАК ЕСТЬ, а не прячется', () => {
    // Экспорт — не место, где решают, показывать ли разрыв. Это ровно тот файл, который
    // понесут в тикет, и «экспорт отказался» там хуже, чем «экспорт говорит: разрыв на 1».
    seed(['received']);
    appendFileSync(path, 'не json\n');
    const { manifest } = exportJsonl(path, dest, { now: FROZEN });
    expect(manifest.verification).toEqual({ ok: false, brokenAt: 1, count: 1 });
  });

  it('оборванный хвост попадает в сайдкар отдельным полем, а не разрывом', () => {
    seed(['received']);
    appendFileSync(path, '{"schema":"mcpproxy.audit/1","oper');
    const { manifest } = exportJsonl(path, dest, { now: FROZEN });

    expect(manifest.trailingPartial).toBe(true);
    expect(manifest.verification).toEqual({ ok: true, count: 1 });
  });

  it('источник назван именем файла, а не полным путём', () => {
    // Полный путь несёт домашний каталог пользователя, а экспорт уходит наружу руками.
    seed(['received']);
    const { manifest } = exportJsonl(path, dest, { now: FROZEN });
    expect(manifest.source).toBe('audit.jsonl');
    expect(JSON.stringify(manifest)).not.toContain(dir);
  });

  it('пустой журнал экспортируется без вранья про содержимое', () => {
    openAuditLog({ path }).close();
    const { manifest } = exportJsonl(path, dest, { now: FROZEN });
    expect(manifest).toMatchObject({ count: 0, first: null, last: null, verification: { ok: true, count: 0 } });
  });

  it('R18: сайдкар создаётся с 0600, каталог — с 0700', () => {
    seed(['received']);
    const result = exportJsonl(path, dest, { now: FROZEN });
    expect(statSync(result.manifestPath).mode & 0o777).toBe(0o600);
    expect(statSync(dest).mode & 0o777).toBe(0o700);
  });
});

describe('exportOtlp', () => {
  it('отдаёт по спану на запись', () => {
    seed(['received', 'lock_check']);
    expect(exportOtlp(readLog(path).records)).toHaveLength(2);
  });

  it('R23: цепочка в спан не едет', () => {
    // Полная запись живёт в JSONL (ADR-0003). Спан — сводка, и `chain` в чужом
    // observability-стеке не нужен никому, а утверждение о неподделываемости — тем более.
    seed(['received']);
    const spans = exportOtlp(readLog(path).records);
    expect(JSON.stringify(spans)).not.toContain('chain');
  });

  it('спан несёт корреляцию, по которой запись находится в журнале', () => {
    seed(['received']);
    const span = exportOtlp(readLog(path).records)[0];
    expect(span?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(span?.spanId).toBe('b7ad6b7169203331');
  });

  it('пустой вход даёт пустой выход, а не падение', () => {
    expect(exportOtlp([])).toEqual([]);
  });
});
