import { randomBytes } from 'node:crypto';
import {
  asRequestId,
  deriveRiskTier,
  normalizeRecipe,
  overheadMs,
  type ApprovalRequest,
  type AuditEvent,
  type ChainedEvent,
  type IpcRequest,
  type Recipe,
  type RecipeName,
  type NormalizedRecipe,
  type SandboxProfile,
  type SandboxViolation,
  type Stage,
  type Verdict,
} from '@mcpproxy/contracts';
import { argsHash } from '@mcpproxy/contracts/audit';
import {
  ExecError,
  createBroker,
  newCommandId,
  prepareRecipe,
  redactInbound,
  redactOutput,
  validateCall,
  type ExecEvent,
  type PreparedRecipe,
  type Broker,
  type Redactor,
  type Sandbox,
  type StartedStore,
} from '@mcpproxy/core';
import type { AuditLog } from '@mcpproxy/core/audit';
import type { DaemonConfig } from '../config.js';
import { denyReason, verdictOfExecError, type DenyCode } from '../deny.js';
import { resolveBinary } from '../binary.js';

/**
 * Конвейер вызова: тринадцать стадий из замороженного `stageOrder`, сшитые из четырёх
 * эпиков, которые до E4 не вызывали друг друга ни разу.
 *
 * **Событие пишется на каждой ПРОЙДЕННОЙ стадии, включая отказ.** Обязанность передана сюда
 * явно (`07-contracts.md:375`, спека E2). Обратная сторона правила: стадия, до которой вызов
 * не дошёл, события не имеет — и поля, которых на этой стадии ещё нет, отсутствуют КЛЮЧОМ, а
 * не лежат как `null`. Вызов, остановленный на `lock_check`, не имеет права понести
 * выдуманный `argv: []`: UI отрисовал бы его как настоящую пустую команду.
 */
export interface PipelineDeps {
  readonly store: StartedStore;
  readonly log: AuditLog;
  readonly redactor: Redactor;
  readonly sandbox: Sandbox;
  readonly config: DaemonConfig;
  readonly manifestDir: string;
  /**
   * Брокер подтверждений (E5). Отсутствие — **headless**: брокер без каналов, который
   * отказывает любому `high` кодом `approval-unavailable`. Дефолт именно такой, а не
   * «пропускать»: отсутствующий канал подтверждения есть отсутствующее подтверждение.
   */
  readonly approvals?: Broker;
  readonly clock?: () => Date;
  readonly monotonic?: () => bigint;
  readonly newId?: (bytes: number) => string;
}

export interface CallInput {
  readonly request: IpcRequest;
  /** Ревизия, СОГЛАСОВАННАЯ шимом с клиентом. Константа сборки сюда не подставляется (R12b E1). */
  readonly protocolVersion: string;
}

export interface AllowedOutcome {
  readonly kind: 'allowed';
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly truncated: boolean;
  readonly violations: number;
}

export interface RefusedOutcome {
  readonly kind: 'refused';
  readonly verdict: Extract<Verdict, 'denied' | 'error'>;
  readonly denyReason: string;
}

export type CallOutcome = AllowedOutcome | RefusedOutcome;

interface PreparedEntry {
  readonly digest: string;
  readonly prepared: PreparedRecipe;
  readonly recipe: Recipe;
}

export interface Pipeline {
  call(input: CallInput): Promise<CallOutcome>;
  /** Сбрасывается при перечитке манифеста: подготовка привязана к конкретной редакции. */
  invalidate(): void;
}

/**
 * Нормализованный профиль -> `SandboxProfile` формы подтверждения.
 *
 * Копия, а не ссылка, и **эффективный** профиль, а не собственный блок рецепта: ADR-0005
 * требует показывать человеку то, под чем команда действительно пойдёт, а собственный блок
 * рецепта молчит обо всём, что пришло из `defaults` — в том числе о запретах на `~/.ssh`.
 * Сокращать показанное нельзя: спека MCP трактует усечение как обман.
 */
function profileOf(sandbox: NormalizedRecipe['effective']['sandbox']): SandboxProfile {
  return {
    read: { allow: [...sandbox.read.allow], deny: [...sandbox.read.deny] },
    write: { allow: [...sandbox.write.allow], deny: [...sandbox.write.deny] },
    network: { allow: [...sandbox.network.allow], deny: [...sandbox.network.deny] },
  };
}

export function createPipeline(deps: PipelineDeps): Pipeline {
  const clock = deps.clock ?? ((): Date => new Date());
  const monotonic = deps.monotonic ?? ((): bigint => process.hrtime.bigint());
  const newId = deps.newId ?? ((bytes: number): string => randomBytes(bytes).toString('hex'));
  const cache = new Map<string, PreparedEntry>();
  const approvals = deps.approvals ?? createBroker({ ports: [], clock });

  const prepared = (name: RecipeName, recipe: Recipe, digest: string): PreparedEntry | null => {
    const hit = cache.get(name);
    if (hit !== undefined && hit.digest === digest) return hit;
    const policy = deps.store.current().manifest;
    const result = prepareRecipe(name, recipe, policy.matchers, deps.manifestDir);
    if (!result.ok) return null;
    const entry: PreparedEntry = { digest, prepared: result.prepared, recipe };
    cache.set(name, entry);
    return entry;
  };

  return {
    invalidate(): void {
      cache.clear();
    },

    async call(input: CallInput): Promise<CallOutcome> {
      const { request: request, protocolVersion } = input;
      const toolName = request.recipeName;
      const traceId = newId(16);
      const rootSpanId = newId(8);

      let started = monotonic();
      let stageStartedAt = clock();
      const durations = new Map<Stage, number>();

      /**
       * Одно событие = один спан. `received` — корневой (`parentSpanId: null`), остальные
       * стадии — его дети: иначе тринадцать записей одного вызова не собираются в трассу.
       */
      const emit = (
        stage: Stage,
        verdict: Verdict,
        extra: Omit<Partial<AuditEvent>, 'stage' | 'verdict'> = {},
        overrideUs?: number,
      ): ChainedEvent => {
        const endedAt = clock();
        const measuredUs = Number((monotonic() - started) / 1_000n);
        const durationUs = overrideUs ?? measuredUs;
        durations.set(stage, durationUs);

        const event: AuditEvent = {
          schema: 'mcpproxy.audit/1',
          operation: 'execute_tool',
          protocolVersion,
          toolName,
          sessionId: request.sessionId,
          traceId,
          spanId: stage === 'received' ? rootSpanId : newId(8),
          parentSpanId: stage === 'received' ? null : rootSpanId,
          startTime: stageStartedAt.toISOString(),
          endTime: endedAt.toISOString(),
          durationUs,
          stage,
          verdict,
          recipe: { name: toolName },
          ...extra,
        };

        started = monotonic();
        stageStartedAt = clock();
        return deps.log.append(event);
      };

      /**
       * Стадии E2 и E3 приносят СВОИ длительности, и `emit` берёт их через `overrideUs`. Но
       * настенное время, прошедшее с прошлого `emit`, при этом никуда не девается: оно ложится
       * на следующую стадию, которую меряю я сам.
       *
       * Для `redact` это означало бы, что в неё попадает всё ожидание дочернего процесса —
       * а `redact` НЕ входит в `OVERHEAD_EXCLUDED_STAGES`, то есть длительность работы
       * пользовательской команды уезжала бы в публикуемый оверхед прокси. Замерено на живом
       * прогоне: `redact` 444 893 us, `overheadMs` 446 при работе скрипта в те же ~440 мс.
       */
      const resetStageClock = (): void => {
        started = monotonic();
        stageStartedAt = clock();
      };

      const refuse = (stage: Stage, verdict: 'denied' | 'error', code: DenyCode, text: string, extra: Omit<Partial<AuditEvent>, 'stage' | 'verdict'> = {}): RefusedOutcome => {
        const reason = denyReason(code, text);
        emit(stage, verdict, { ...extra, denyReason: reason });
        return { kind: 'refused', verdict, denyReason: reason };
      };

      // ── 1. received ────────────────────────────────────────────────────────────────────
      emit('received', 'allowed');

      // ── 2. lock_check ──────────────────────────────────────────────────────────────────
      const policy = deps.store.current();
      const digest = policy.manifest.recipeDigests.get(toolName);
      const lockExtra = digest === undefined ? {} : { recipe: { name: toolName, hash: digest } };
      if (policy.verdict.denyCode !== null) {
        // Расхождение с lock в тир НЕ отображается: это жёсткий стоп, а не high-risk апрув.
        return refuse('lock_check', 'denied', policy.verdict.denyCode, policy.verdict.denyReason ?? 'lock не подтверждён', lockExtra);
      }
      emit('lock_check', 'allowed', lockExtra);

      // ── 3. validate / resolve_paths / build_argv ───────────────────────────────────────
      const recipe = policy.manifest.manifest.tools[toolName];
      if (recipe === undefined) {
        // Отказ ложится на `validate`, а не на `received`: вопрос «есть ли такой рецепт»
        // задаётся к содержимому запроса, и на `received` ещё не с чем было сверять.
        return refuse('validate', 'denied', 'unknown-recipe', 'рецепт не объявлен в манифесте', lockExtra);
      }

      const entry = prepared(toolName, recipe, digest ?? '');
      if (entry === null) {
        return refuse('validate', 'error', 'recipe-unprepared', 'рецепт не проходит подготовку', lockExtra);
      }

      const validated = validateCall(entry.prepared, request.params);
      const timingOf = (stage: Stage): number | undefined =>
        validated.timings.find((one) => one.stage === stage)?.durationUs;

      if (!validated.ok) {
        const first = validated.denials[0];
        // Стадии ДО отказавшей проходятся как пройденные: их измерил E2, и молчание о них
        // сделало бы таймлайн короче реального пути.
        if (first.stage === 'resolve_paths') {
          emit('validate', 'allowed', lockExtra, timingOf('validate'));
        }
        const cwdExtra = validated.cwd === undefined ? {} : { cwd: validated.cwd };
        return refuse(first.stage, 'denied', first.code, first.reason, { ...lockExtra, ...cwdExtra });
      }

      emit('validate', 'allowed', lockExtra, timingOf('validate'));
      emit('resolve_paths', 'allowed', { ...lockExtra, cwd: validated.cwd }, timingOf('resolve_paths'));

      // A4 — PATH hijack. Резолв `exec[0]` и сверка с allowlist: «дело демона» по контракту.
      const binary = resolveBinary(entry.prepared.exec[0] ?? '', {
        allowlist: deps.config.binaryAllowlist,
        manifestDir: deps.manifestDir,
      });
      if (!binary.ok) {
        return refuse('build_argv', 'denied', binary.code, binary.text, { ...lockExtra, cwd: validated.cwd });
      }

      const argv: readonly string[] = [binary.path, ...validated.argv.slice(1)];
      // В событие едет ОТРЕДАКТИРОВАННЫЙ argv, в песочницу — настоящий: секрет, приехавший
      // параметром, иначе лёг бы в append-only журнал дословно (R9 E6).
      const inbound = redactInbound(deps.redactor, { argv, env: {} });
      // Индексы приезжают из E2 ПЕРЕНОСОМ, а не пересчётом по значениям: расписка `WORK.md`
      // и `R63`. Редакция заменяет текст внутри элемента и длины массива не меняет, поэтому
      // индексы указывают в ту же безопасную копию, которая легла в событие.
      const argvFromParams = validated.argvFromParams;
      const argvExtra = {
        ...lockExtra,
        cwd: validated.cwd,
        argv: inbound.argv,
        ...(argvFromParams.length > 0 ? { argvFromParams } : {}),
        ...(inbound.redactions.length > 0 ? { redactions: inbound.redactions } : {}),
      };
      emit('build_argv', 'allowed', argvExtra, timingOf('build_argv'));

      // ── 4. classify_risk ───────────────────────────────────────────────────────────────
      const normalized = normalizeRecipe(recipe, policy.manifest.manifest.defaults);
      const annotations = recipe.annotations ?? {};
      const tier = deriveRiskTier(annotations);
      const riskExtra = { ...lockExtra, cwd: validated.cwd, risk: { tier, annotations } };
      emit('classify_risk', 'allowed', riskExtra);

      // ── 5. approval ────────────────────────────────────────────────────────────────────
      // Стадия эмитится ВСЕГДА, а не только при поднятой модалке: она фиксирует принятое
      // решение, и вызов, где решения «не требовалось», отличается от вызова, где его забыли
      // спросить, только этой записью.
      const approvalRequest: ApprovalRequest = {
        requestId: asRequestId(newId(16)),
        sessionId: request.sessionId,
        recipeName: toolName,
        // Хэш по значениям ПОСЛЕ валидации и резолва: скоуп `recipe_and_args` обязан считать
        // `./logs/a.log` и `/abs/logs/a.log` одним вызовом (`contracts/audit/args.ts`).
        argsHash: argsHash(toolName, validated.params),
        tier,
        // В форму едет та же ОТРЕДАКТИРОВАННАЯ копия, что и в событие: человек не должен
        // читать секрет в окне подтверждения, а индексы обязаны указывать в то, что он видит.
        argv: inbound.argv,
        ...(argvFromParams.length > 0 ? { argvFromParams } : {}),
        cwd: validated.cwd,
        profile: profileOf(normalized.effective.sandbox),
      };

      const decision = await approvals.decide(approvalRequest, tier);
      if (decision.kind === 'refused') {
        return refuse('approval', 'denied', decision.code, decision.reason, {
          ...riskExtra,
          ...(decision.record === undefined ? {} : { approval: decision.record }),
        });
      }
      // Пройденная стадия БЕЗ `ApprovalRecord` означает «решения не требовалось». Вызов, где
      // спрашивать было незачем, отличается от вызова, где спросить забыли, ровно этим.
      emit('approval', 'allowed', {
        ...riskExtra,
        ...(decision.kind === 'granted' ? { approval: decision.record } : {}),
      });

      // ── 6. build_env / build_profile / spawn / violation ───────────────────────────────
      const commandId = newCommandId();
      const violations: SandboxViolation[] = [];
      const execEvents: ExecEvent[] = [];

      const onViolation = (violation: SandboxViolation): void => {
        violations.push(violation);
        emit('violation', 'allowed', { ...riskExtra, sandbox: { mode: deps.sandbox.mode, violations: [violation] } });
      };

      const onEvent = (event: ExecEvent): void => {
        execEvents.push(event);
        const extra: Omit<Partial<AuditEvent>, 'stage' | 'verdict'> = {
          ...riskExtra,
          ...(event.env === undefined ? {} : { env: event.env }),
          ...(event.sandbox === undefined ? {} : { sandbox: event.sandbox }),
        };
        emit(event.stage, 'allowed', extra, event.durationUs);
      };

      let outcome;
      try {
        outcome = await deps.sandbox.run(
          {
            recipeName: toolName,
            command: [argv[0] as string, ...argv.slice(1)],
            recipeCwd: validated.cwd,
            effective: normalized.effective,
            commandId,
          },
          onViolation,
          onEvent,
        );
        resetStageClock();
      } catch (error) {
        resetStageClock();
        if (error instanceof ExecError) {
          // Отказ политики — штатный исход решения, а не сбой прокси (D6 E3). Без этого
          // отображения безопасным дефолтом стал бы `error`, и заблокированный политикой
          // вызов лёг бы в журнал как флакующий.
          const verdict = verdictOfExecError(error.code);
          const stage: Stage = error.code === 'invalid-domain' ? 'build_profile' : 'spawn';
          return refuse(stage, verdict, error.code, error.message, riskExtra);
        }
        throw error;
      }

      // ── 7. redact ──────────────────────────────────────────────────────────────────────
      // Редакция ДО обрезки — порядок заморожен (`10-honest-limitations.md:27`).
      const redacted = redactOutput(
        deps.redactor,
        { stdout: outcome.stdout.text, stderr: outcome.stderr.text },
        normalized.effective.output,
      );
      emit('redact', 'allowed', {
        ...riskExtra,
        output: redacted.output,
        ...(redacted.redactions.length > 0 ? { redactions: redacted.redactions } : {}),
      });

      // ── 8. complete ────────────────────────────────────────────────────────────────────
      const completeUs = Number((monotonic() - started) / 1_000n);
      durations.set('complete', completeUs);
      emit('complete', 'allowed', {
        ...riskExtra,
        exit: outcome.exit,
        output: redacted.output,
        sandbox: {
          mode: deps.sandbox.mode,
          ...(violations.length > 0 ? { violations } : {}),
          evidence: {
            policyHash: outcome.policyHash,
            violationsLost: outcome.violationsLost,
            attributionMissing: outcome.attributionMissing,
            attributionForeign: outcome.attributionForeign,
            unrecognizedLines: outcome.unrecognizedLines,
            suppressedLines: outcome.suppressedLines,
            consumerFailures: outcome.consumerFailures,
            bodyCountFailures: outcome.bodyCountFailures,
            lateUnattributed: outcome.lateUnattributed,
          },
        },
        duration: { overheadMs: overheadMs(durations) },
      }, completeUs);

      return {
        kind: 'allowed',
        stdout: redacted.stdout,
        stderr: redacted.stderr,
        exitCode: outcome.exit.code,
        signal: outcome.exit.signal,
        truncated: redacted.output.truncated,
        violations: violations.length,
      };
    },
  };
}
