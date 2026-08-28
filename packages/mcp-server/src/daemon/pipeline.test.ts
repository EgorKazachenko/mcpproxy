import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEvent, ChainedEvent, Stage } from '@mcpproxy/contracts';
import { asRecipeName, asSessionId } from '@mcpproxy/contracts';
import {
  buildLock,
  createBroker,
  createRedactor,
  startStore,
  writeLock,
  type ApprovalPort,
  type Broker,
  type ExecOutcome,
  type Sandbox,
  type StartedStore,
} from '@mcpproxy/core';
import type { ApprovalRequest, ApprovalVerdict } from '@mcpproxy/contracts';
import type { AuditLog } from '@mcpproxy/core/audit';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type DaemonConfig } from '../config.js';
import { parseDenyReason } from '../deny.js';
import { createPipeline, type Pipeline } from './pipeline.js';

const MANIFEST = `version: 1
defaults:
  timeout: 30s
  output:
    maxBytes: 65536
    redact: true
  env:
    allow: ["PATH"]
  sandbox:
    read:
      allow: ["."]
    write:
      allow: []
    network:
      allow: []
tools:
  run_ok:
    description: "Тихий рецепт"
    exec: ["./scripts/ok.sh"]
    params:
      pattern:
        type: string
        required: false
        pattern: "^[\\\\w.-]{0,32}$"
        argv: ["--filter", "{}"]
    annotations:
      readOnlyHint: false
      destructiveHint: false
      idempotentHint: true
      openWorldHint: false
  publish:
    description: "Опасный рецепт"
    exec: ["./scripts/ok.sh"]
    annotations:
      readOnlyHint: false
      destructiveHint: true
      idempotentHint: false
      openWorldHint: true
  outsider:
    description: "Бинарь вне манифеста и вне списка"
    exec: ["curl"]
    annotations:
      readOnlyHint: true
`;

const OUTCOME: ExecOutcome = {
  termination: 'exited',
  exit: { code: 0, signal: null },
  stdout: { text: 'готово', bytes: 6, truncated: false },
  stderr: { text: '', bytes: 0, truncated: false },
  violations: [],
  violationsLost: 0,
  attributionMissing: 0,
  attributionForeign: 0,
  unrecognizedLines: 0,
  suppressedLines: 0,
  consumerFailures: 0,
  bodyCountFailures: 0,
  lateUnattributed: 0,
  policyHash: 'p'.repeat(64),
};

interface Harness {
  readonly dir: string;
  readonly store: StartedStore;
  readonly events: AuditEvent[];
  readonly pipeline: Pipeline;
}

async function harness(config: DaemonConfig = DEFAULT_CONFIG, outcome: ExecOutcome = OUTCOME, approvals?: Broker): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'mcpproxy-pipeline-'));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'scripts/ok.sh'), '#!/bin/sh\necho готово\n');
  chmodSync(join(dir, 'scripts/ok.sh'), 0o755);
  const manifestPath = join(dir, 'mcpproxy.yaml');
  const lockPath = join(dir, 'mcpproxy.lock');
  writeFileSync(manifestPath, MANIFEST);

  const started = await startStore(manifestPath, lockPath);
  if (started.outcome !== 'started') throw new Error(`манифест не загрузился: ${started.outcome}`);
  const store = started.store;
  await writeLock(lockPath, buildLock(store.current().manifest, '2026-08-28T00:00:00.000Z'));
  await store.reloadLock();

  const events: AuditEvent[] = [];
  const log: AuditLog = {
    path: join(dir, 'audit.jsonl'),
    repairedTornTail: false,
    append: (event): ChainedEvent => {
      events.push(event);
      return { ...event, chain: { prev: null, self: 's'.repeat(64) } };
    },
    head: () => null,
    close: () => undefined,
  };

  const sandbox: Sandbox = {
    mode: 'none',
    async run(_request, _onViolation, onEvent) {
      onEvent?.({ stage: 'build_env', durationUs: 100, env: { allowed: ['PATH'] } });
      onEvent?.({ stage: 'build_profile', durationUs: 100, sandbox: { mode: 'none' } });
      onEvent?.({ stage: 'spawn', durationUs: 100, sandbox: { mode: 'none' } });
      return outcome;
    },
    async dispose() {},
  };

  const pipeline = createPipeline({
    store,
    log,
    redactor: createRedactor(),
    sandbox,
    config,
    manifestDir: dir,
    ...(approvals === undefined ? {} : { approvals }),
  });

  return { dir, store, events, pipeline };
}

const stages = (events: readonly AuditEvent[]): readonly Stage[] => events.map((one) => one.stage);
const call = (h: Harness, name: string, params: Record<string, unknown> = {}) =>
  h.pipeline.call({
    request: { recipeName: asRecipeName(name), params, sessionId: asSessionId('sess-1') },
    protocolVersion: '2025-06-18',
  });

let h: Harness;
beforeEach(async () => {
  h = await harness();
});

describe('счастливый путь', () => {
  it('проходит стадии в порядке stageOrder', async () => {
    const outcome = await call(h, 'run_ok');
    expect(outcome.kind).toBe('allowed');
    expect(stages(h.events)).toEqual([
      'received', 'lock_check', 'validate', 'resolve_paths', 'build_argv',
      'classify_risk', 'approval', 'build_env', 'build_profile', 'spawn', 'redact', 'complete',
    ]);
  });

  it('violation при нуле нарушений НЕ эмитится — контракт говорит «может быть много»', () => {
    expect(stages(h.events)).not.toContain('violation');
  });

  it('approval эмитится и на medium: запись отличает «решения не требовалось» от «забыли спросить»', async () => {
    await call(h, 'run_ok');
    const approval = h.events.find((one) => one.stage === 'approval');
    expect(approval?.verdict).toBe('allowed');
    expect(approval?.risk?.tier).toBe('medium');
  });

  it('согласованная ревизия протокола едет в каждое событие, а не константа сборки', async () => {
    await call(h, 'run_ok');
    expect(h.events.every((one) => one.protocolVersion === '2025-06-18')).toBe(true);
  });

  it('received — корневой спан, остальные его дети', async () => {
    await call(h, 'run_ok');
    const [root, ...rest] = h.events;
    expect(root?.parentSpanId).toBeNull();
    expect(rest.every((one) => one.parentSpanId === root?.spanId)).toBe(true);
    expect(new Set(h.events.map((one) => one.traceId)).size).toBe(1);
  });

  it('complete несёт evidence песочницы и оверхед', async () => {
    await call(h, 'run_ok');
    const complete = h.events.at(-1);
    expect(complete?.stage).toBe('complete');
    expect(complete?.sandbox?.evidence?.policyHash).toBe(OUTCOME.policyHash);
    expect(complete?.sandbox?.evidence?.violationsLost).toBe(0);
    expect(typeof complete?.duration?.overheadMs).toBe('number');
  });

  it('argv появляется на build_argv и не раньше', async () => {
    await call(h, 'run_ok', { pattern: 'auth' });
    const before = h.events.filter((one) => ['received', 'lock_check', 'validate'].includes(one.stage));
    expect(before.every((one) => !Object.hasOwn(one, 'argv'))).toBe(true);
    const built = h.events.find((one) => one.stage === 'build_argv');
    // `realpathSync` в ожидании не для красоты: на macOS `/var` — симлинк на `/private/var`,
    // а резолв бинаря идёт через realpath именно затем, чтобы список сверялся с настоящей целью.
    expect(built?.argv).toEqual([join(realpathSync(h.dir), 'scripts/ok.sh'), '--filter', 'auth']);
  });
});

describe('отказы — событие пишется, но выдуманных полей не несёт', () => {
  it('неизвестный рецепт отказывается на validate', async () => {
    const outcome = await call(h, 'no_such');
    expect(outcome).toMatchObject({ kind: 'refused', verdict: 'denied' });
    expect(stages(h.events)).toEqual(['received', 'lock_check', 'validate']);
    if (outcome.kind !== 'refused') return;
    expect(parseDenyReason(outcome.denyReason)?.code).toBe('unknown-recipe');
  });

  it('отказ параметра останавливает на validate и НЕ несёт cwd', async () => {
    const outcome = await call(h, 'run_ok', { pattern: 'нельзя пробел' });
    expect(outcome.kind).toBe('refused');
    const last = h.events.at(-1);
    expect(last?.stage).toBe('validate');
    // Вызов, остановленный до резолва, не имеет права нести рабочий каталог.
    expect(Object.hasOwn(last as object, 'cwd')).toBe(false);
    expect(Object.hasOwn(last as object, 'argv')).toBe(false);
  });

  it('high-risk без подключённого канала отказывается: headless есть отказ (R44)', async () => {
    const outcome = await call(h, 'publish');
    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') return;
    expect(parseDenyReason(outcome.denyReason)?.code).toBe('approval-unavailable');
    expect(h.events.at(-1)?.stage).toBe('approval');
    expect(h.events.at(-1)?.risk?.tier).toBe('high');
    expect(stages(h.events)).not.toContain('spawn');
  });

  it('бинарь вне allowlist отказывается на build_argv', async () => {
    const outcome = await call(h, 'outsider');
    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') return;
    expect(parseDenyReason(outcome.denyReason)?.code).toBe('binary-not-allowed');
    expect(h.events.at(-1)?.stage).toBe('build_argv');
  });

  it('голое имя проходит, если названо в allowlist', async () => {
    const withList = await harness({ ...DEFAULT_CONFIG, binaryAllowlist: ['/usr/bin/curl'] });
    const outcome = await call(withList, 'outsider');
    // Рецепт readOnly → low, апрув не нужен; дальше исполняет поддельная песочница.
    expect(outcome.kind).toBe('allowed');
    expect(withList.events.find((one) => one.stage === 'build_argv')?.argv?.[0]).toBe('/usr/bin/curl');
  });

  it('каждый отказ несёт машиночитаемый код в denyReason', async () => {
    for (const [name, params] of [['no_such', {}], ['run_ok', { pattern: '  ' }], ['publish', {}], ['outsider', {}]] as const) {
      const fresh = await harness();
      const outcome = await call(fresh, name, params as Record<string, unknown>);
      if (outcome.kind !== 'refused') continue;
      expect(parseDenyReason(outcome.denyReason)).not.toBeNull();
      expect(fresh.events.at(-1)?.denyReason).toBe(outcome.denyReason);
    }
  });
});

describe('lock — жёсткий стоп, а не апрув', () => {
  it('расхождение манифеста с lock отказывает на lock_check без argv', async () => {
    writeFileSync(join(h.dir, 'mcpproxy.yaml'), MANIFEST.replace('Тихий рецепт', 'Подменённое описание'));
    const reloaded = await h.store.reloadManifest();
    expect(reloaded.outcome).toBe('reloaded');
    h.pipeline.invalidate();

    const outcome = await call(h, 'run_ok');
    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') return;
    expect(parseDenyReason(outcome.denyReason)?.code).toBe('lock-drifted');
    expect(stages(h.events)).toEqual(['received', 'lock_check']);
    expect(Object.hasOwn(h.events.at(-1) as object, 'argv')).toBe(false);
  });
});

describe('стадия approval — E5', () => {
  /** Окно, подменённое портом: сам порт живёт в другом процессе, решение — здесь. */
  const port = (reply: (req: ApprovalRequest) => ApprovalVerdict | null): ApprovalPort & { seen: ApprovalRequest[] } => {
    const seen: ApprovalRequest[] = [];
    return {
      channel: 'electron',
      seen,
      async ask(request) {
        seen.push(request);
        return reply(request);
      },
    };
  };

  const ok = (request: ApprovalRequest): ApprovalVerdict => ({
    requestId: request.requestId,
    sessionId: request.sessionId,
    channel: 'electron',
    decision: 'approved',
    scope: 'once',
    expiresAt: null,
  });

  it('одобренный high-risk идёт дальше, и запись вердикта лежит в событии стадии', async () => {
    const electron = port(ok);
    const local = await harness(DEFAULT_CONFIG, OUTCOME, createBroker({ ports: [electron] }));
    const outcome = await call(local, 'publish');

    expect(outcome.kind).toBe('allowed');
    expect(stages(local.events)).toContain('spawn');
    const approval = local.events.find((one) => one.stage === 'approval');
    expect(approval?.approval).toMatchObject({ channel: 'electron', decision: 'approved', scope: 'once' });
    // Обе части ключа дублируются в запись: append-only строку читают отдельно от события.
    expect(approval?.approval?.sessionId).toBe('sess-1');
    expect(approval?.approval?.argsHash).toHaveLength(64);
  });

  it('отказ человека останавливает вызов и остаётся записью, а не молчанием', async () => {
    const electron = port((request) => ({ ...ok(request), decision: 'denied' as const }));
    const local = await harness(DEFAULT_CONFIG, OUTCOME, createBroker({ ports: [electron] }));
    const outcome = await call(local, 'publish');

    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') return;
    expect(parseDenyReason(outcome.denyReason)?.code).toBe('approval-denied');
    expect(local.events.at(-1)?.approval?.decision).toBe('denied');
    expect(stages(local.events)).not.toContain('spawn');
  });

  it('окну достаётся отредактированный argv и cwd целиком — не усечённые (ADR-0005)', async () => {
    const electron = port(ok);
    const local = await harness(DEFAULT_CONFIG, OUTCOME, createBroker({ ports: [electron] }));
    await call(local, 'publish');

    const shown = electron.seen[0];
    const built = local.events.find((one) => one.stage === 'build_argv');
    // Тот же массив, что лёг в событие: индексы `argvFromParams` обязаны указывать в то,
    // что человек видит, а не в другую копию команды.
    expect(shown?.argv).toEqual(built?.argv);
    expect(shown?.cwd).toBe(built?.cwd);
    expect(shown?.tier).toBe('high');
    // Профиль — ЭФФЕКТИВНЫЙ: собственный блок рецепта молчит о запретах из `defaults`.
    expect(shown?.profile.read?.allow).toEqual(['.']);
  });

  it('стадия на medium проходит БЕЗ записи вердикта: решения не требовалось', async () => {
    await call(h, 'run_ok');
    const approval = h.events.find((one) => one.stage === 'approval');
    expect(approval?.verdict).toBe('allowed');
    expect(Object.hasOwn(approval as object, 'approval')).toBe(false);
  });
});

describe('argvFromParams — расписка WORK.md закрыта', () => {
  it('индексы едут в событие build_argv и указывают на значения параметров', async () => {
    await call(h, 'run_ok', { pattern: 'auth' });
    const built = h.events.find((one) => one.stage === 'build_argv');
    // argv: [бинарь, '--filter', 'auth'] — из параметра пришёл только третий элемент.
    // `--filter` в индексы не попадает: его текст — константа манифеста.
    expect(built?.argvFromParams).toEqual([2]);
    expect((built?.argv ?? [])[2]).toBe('auth');
  });

  it('вызов без параметров индексов не несёт КЛЮЧОМ, а не пустым массивом', async () => {
    await call(h, 'run_ok');
    const built = h.events.find((one) => one.stage === 'build_argv');
    expect(Object.hasOwn(built as object, 'argvFromParams')).toBe(false);
  });
});
