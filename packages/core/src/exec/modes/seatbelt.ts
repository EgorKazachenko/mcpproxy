import { realpathSync } from 'node:fs';
import type { FilesystemConfig, SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import type { NormalizedDefaults, SandboxMode, SandboxViolation } from '@mcpproxy/contracts';
import { buildEnv } from '../env.js';
import type { ExecEvent, EventSink } from '../events.js';
import { measure, measureAsync } from '../events.js';
import { DEFAULT_GRACE_MS, runProcess, toStreamOutcome } from '../limits.js';
import type { ProcessLimits } from '../limits.js';
import { assertDomainPatterns } from '../netpolicy.js';
import { buildProfile, mandatoryDenyGlobs, policyHash, resolveProfilePath, toSandboxProfile } from '../profile.js';
import type { ResolvedSandboxPolicy } from '../profile.js';
import { srt } from '../srt-manager.js';
import type { ExecOutcome, ExecRequest, Sandbox } from '../sandbox.js';
import type { ClassifyPolicy } from '../violation.js';

/**
 * Режим `seatbelt` — основной. Здесь и только здесь `ResolvedSandboxPolicy` отображается в
 * словарь вендора, и здесь стоит единственное тайп-левел утверждение против настоящего
 * `SandboxRuntimeConfig`: дрейф формы вендора тогда краснеет в одном месте, а не в семи.
 */

/**
 * Запас сверх потолка вывода (D13, R19). Величина — **решение с объявленным остаточным
 * риском**, а не вывод: длина самого длинного правила редакции E6 неизвестна, пока E6 не
 * написан. 256 байт с запасом перекрывают любой известный формат токена (AWS, GitHub PAT,
 * JWT-заголовок), и если правило E6 окажется длиннее, секрет на границе снова разрежется —
 * поэтому число живёт константой демона, а не спрятано в выражении.
 */
export const REDACTION_HOLD_BACK_BYTES = 256;

const MODE: SandboxMode = 'seatbelt';

/**
 * Отображение узлов профиля в **пользовательские** имена конфига srt (R6):
 * `read.deny → filesystem.denyRead`, `read.allow → filesystem.allowRead`,
 * `write.allow → filesystem.allowWrite`, `write.deny → filesystem.denyWrite`.
 *
 * Возврат типизирован вендорским `FilesystemConfig` намеренно — это и есть то самое
 * тайп-левел утверждение: переименование поля у вендора ломает сборку здесь.
 *
 * Сети в отображении нет: `customConfig.network` не действует вовсе (проба П5), и её
 * принуждает `updateConfig` под семафором (D11).
 */
export function toFilesystemConfig(policy: ResolvedSandboxPolicy): FilesystemConfig {
  return {
    denyRead: [...policy.read.deny],
    allowRead: [...policy.read.allow],
    allowWrite: [...policy.write.allow],
    denyWrite: [...policy.write.deny],
  };
}

/**
 * Базовый конфиг демона. Доменные списки здесь пусты: идловое состояние allowlist — пустой
 * список (R52), а политику вызова ставит `updateConfig` под семафором.
 *
 * `strictAllowlist: true` (R43) обязателен: без него deny-by-default держится лишь на том,
 * что колбэк апрува не зарегистрирован, — и как только E5 повесит свой, неизвестный хост
 * начнёт **спрашивать** вместо отказа.
 *
 * `tlsTerminate` включён **только ради байт** S5 (D12). Принуждение на него не опирается,
 * поэтому сломанный пиннинг или mTLS ухудшают телеметрию, а не границу.
 */
export function baseSrtConfig(): SandboxRuntimeConfig {
  return {
    network: {
      allowedDomains: [],
      deniedDomains: [],
      strictAllowlist: true,
      tlsTerminate: {},
      filterRequest: srt.buildFilterRequest(),
    },
    filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
  };
}

/**
 * Кавычки для строки, которую ждёт `wrapWithSandbox`. Вендор принимает **строку**, а E2
 * отдаёт argv, и склейка пробелами отдала бы аргумент с пробелом как два.
 *
 * Одинарные кавычки, потому что внутри них POSIX-оболочка не интерпретирует ничего вообще;
 * единственный особый случай — сама одинарная кавычка, и он закрывается закрытием строки.
 */
export function quoteArgv(argv: readonly string[]): string {
  return argv.map((one) => `'${one.split("'").join(`'\\''`)}'`).join(' ');
}

const limitsFor = (effective: NormalizedDefaults, env: NodeJS.ProcessEnv, cwd: string): ProcessLimits => ({
  timeoutMs: effective.timeoutMs,
  graceMs: DEFAULT_GRACE_MS,
  maxBytes: effective.output.maxBytes,
  holdBackBytes: REDACTION_HOLD_BACK_BYTES,
  env,
  cwd,
});

/**
 * Общее тело обоих режимов. Отличаются они ровно двумя вещами — какие переменные вливаются
 * ребёнку и оборачивается ли команда seatbelt-профилем, — и обе вынесены в параметры.
 *
 * Вынесено, потому что всё остальное обязано совпадать: порядок стадий, поток нарушений,
 * порядок «редакция раньше обрезки», семафор. Две копии этого тела разъехались бы в первый
 * же баг-фикс, и `none` перестал бы быть сравнимым baseline'ом для S5.
 */
export interface ModeBehaviour {
  readonly mode: SandboxMode;
  /** Переменные, которые режим вливает ребёнку мимо allowlist (R24, R31). */
  injectedEnv(): NodeJS.ProcessEnv;
  /** Как команда превращается в argv: обёрнутой профилем или как есть. */
  toArgv(
    request: ExecRequest,
    policy: ResolvedSandboxPolicy,
  ): Promise<readonly [string, ...string[]]>;
}

export async function runInMode(
  behaviour: ModeBehaviour,
  request: ExecRequest,
  onViolation: (violation: SandboxViolation) => void,
  onEvent?: EventSink,
): Promise<ExecOutcome> {
  const emit = (event: ExecEvent): void => {
    onEvent?.(event);
  };
  const effective = request.effective;

  await srt.initialize(baseSrtConfig());

  // Стадия 1 — окружение. Событие несёт только ИМЕНА (R25): форма `AuditEvent.env` это и
  // позволяет, а значения не покидают процесс демона.
  const env = measure(() => buildEnv(effective.env.allow, process.env, behaviour.injectedEnv()));
  emit({ stage: 'build_env', durationUs: env.durationUs, env: { allowed: [...effective.env.allow] } });

  // Стадия 2 — профиль. `sandbox.profile` — **сырой** `SandboxProfile` манифеста (R36), а
  // `mode` обязателен всегда, когда присутствует `sandbox` (R33).
  const writeRoots = effective.sandbox.write.allow;
  const profile = measure(() => buildProfile(effective.sandbox, writeRoots, request.recipeCwd));
  emit({
    stage: 'build_profile',
    durationUs: profile.durationUs,
    sandbox: { mode: behaviour.mode, profile: toSandboxProfile(effective.sandbox) },
  });

  // Перепроверка перед принуждением, и она стоит ПОСЛЕ двух событий намеренно (R32):
  // вызов, остановленный отказом, обязан оставить в аудите след того, что успел решить.
  assertDomainPatterns(effective.sandbox.network.allow, effective.sandbox.network.deny);

  const classify: ClassifyPolicy = {
    mandatoryPaths: mandatoryDenyGlobs(writeRoots.map((one) => resolveProfilePath(one, request.recipeCwd))),
    // `realpathSync.native` инжектируется здесь, а не зовётся из `violation.ts`: иначе
    // модуль грамматики был бы нечист, а его тест требовал бы настоящих путей на диске.
    resolvePath: (path) => realpathSync.native(path),
  };

  const network = {
    allowedDomains: effective.sandbox.network.allow,
    deniedDomains: effective.sandbox.network.deny,
  };

  const result = await srt.withNetworkPolicy({
    commandId: request.commandId,
    policy: network,
    classify,
    onViolation: (violation) => {
      const handled = measure(() => {
        onViolation(violation);
      });
      emit({
        stage: 'violation',
        durationUs: handled.durationUs,
        sandbox: { mode: behaviour.mode, violations: [violation] },
      });
    },
    body: async () => {
      const argv = await behaviour.toArgv(request, profile.value);
      const spawned = await measureAsync(() =>
        runProcess(argv, limitsFor(effective, env.value, request.recipeCwd)),
      );
      emit({ stage: 'spawn', durationUs: spawned.durationUs, sandbox: { mode: behaviour.mode } });
      return { value: spawned.value, groupDrained: spawned.value.groupDrained };
    },
  });

  const raw = result.value;
  return {
    termination: raw.termination,
    exit: raw.exit,
    stdout: toStreamOutcome(raw.stdout),
    stderr: toStreamOutcome(raw.stderr),
    violations: result.violations,
    violationsLost: result.violationsLost,
    attributionMismatches: result.attributionMismatches,
    policyHash: policyHash(profile.value, network),
  };
}

export function createSeatbeltSandbox(): Sandbox {
  const behaviour: ModeBehaviour = {
    mode: MODE,
    // В `seatbelt` прокси-переменные вшиты srt прямо в строку команды (факт Ф7:
    // `wrapWithSandboxArgv` возвращает `env` нетронутым), поэтому вливать нечего — и
    // наивная замена env лишила бы ребёнка прокси, то есть тихо сломала бы сеть (R24).
    injectedEnv: () => ({}),
    toArgv: async (request, policy) => {
      const wrapped = await srt.wrap(
        quoteArgv(request.command),
        { filesystem: toFilesystemConfig(policy) },
        request.commandId,
        request.recipeCwd,
      );
      const [head, ...rest] = wrapped.argv;
      if (head === undefined) throw new Error('srt вернул пустой argv');
      return [head, ...rest];
    },
  };

  return {
    mode: MODE,
    run: (request, onViolation, onEvent) => runInMode(behaviour, request, onViolation, onEvent),
    dispose: () => srt.dispose(),
  };
}
