import { realpathSync } from 'node:fs';
import type { FilesystemConfig, SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import type { NormalizedDefaults, SandboxMode, SandboxViolation } from '@mcpproxy/contracts';
import { buildEnv } from '../env.js';
import type { ExecEvent, EventSink } from '../events.js';
import { measure } from '../events.js';
import { DEFAULT_GRACE_MS, runProcess, toStreamOutcome } from '../limits.js';
import type { ProcessLimits } from '../limits.js';
import { assertDomainPatterns } from '../netpolicy.js';
import { buildProfile, policyHash, toSandboxProfile } from '../profile.js';
import type { ResolvedSandboxPolicy } from '../profile.js';
import { DISPOSED_MESSAGE, srt } from '../srt-manager.js';
import type { NetworkPolicy } from '../srt-manager.js';
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
  injectedEnv(request: ExecRequest): NodeJS.ProcessEnv;
  /**
   * Какая сетевая политика реально применяется (D2). В `seatbelt` это списки рецепта; в
   * `none` — `['*']`, потому что baseline обязан **наблюдать**, а не запрещать.
   */
  networkPolicy(effective: NormalizedDefaults): NetworkPolicy;
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

  await srt.ensureInitialized(baseSrtConfig());

  // Стадия 1 — окружение. Событие несёт только ИМЕНА (R25): форма `AuditEvent.env` это и
  // позволяет, а значения не покидают процесс демона.
  const env = measure(() => buildEnv(effective.env.allow, process.env, behaviour.injectedEnv(request)));
  emit({ stage: 'build_env', durationUs: env.durationUs, env: { allowed: [...effective.env.allow] } });

  // Стадия 2 — профиль. `sandbox.profile` — **сырой** `SandboxProfile` манифеста (R36), а
  // `mode` обязателен всегда, когда присутствует `sandbox` (R33).
  const profile = measure(() => buildProfile(effective.sandbox, request.recipeCwd));
  emit({
    stage: 'build_profile',
    durationUs: profile.durationUs,
    sandbox: { mode: behaviour.mode, profile: toSandboxProfile(effective.sandbox) },
  });

  // Перепроверка перед принуждением, и она стоит ПОСЛЕ двух событий намеренно (R32):
  // вызов, остановленный отказом, обязан оставить в аудите след того, что успел решить.
  assertDomainPatterns(effective.sandbox.network.allow, effective.sandbox.network.deny);

  const classify: ClassifyPolicy = {
    // ТА ЖЕ величина, что уехала в `write.deny` профиля, а не посчитанная второй раз по
    // независимо собранному входу: два счёта разошлись бы молча, и бейдж S6 перестал бы
    // соответствовать реальной политике — а тест классификации строит `mandatoryPaths`
    // руками и такого расхождения не увидел бы.
    mandatoryPaths: profile.value.mandatory,
    // `realpathSync.native` инжектируется здесь, а не зовётся из `violation.ts`: иначе
    // модуль грамматики был бы нечист, а его тест требовал бы настоящих путей на диске.
    resolvePath: (path) => realpathSync.native(path),
  };

  // Хэш считает **применённую** политику (R47), а не манифестную: в `none` они расходятся,
  // и хэш, врущий про сеть, бесполезен ровно там, где решение человека важнее всего.
  const network = behaviour.networkPolicy(effective);

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
      // Событие стадии `spawn` отправляется, как только ребёнок запущен, а НЕ после того,
      // как он отработал. Причин две, и обе жёсткие.
      //
      // Порядок: нарушения стримятся, пока процесс жив (R29), а замороженный `stageOrder`
      // (`domain.ts:26-40`) кладёт `spawn` перед `violation`. Событие после выхода дало бы
      // потребителю `violation` раньше `spawn` — S5 отрисовал бы нарушение процесса, о
      // запуске которого лог ещё не сказал.
      //
      // Полнота: если `toArgv` или сам `spawn` бросили (нет `exec[0]` на диске, нет
      // оболочки), стадия обязана оставить событие всё равно — «событие на каждой стадии,
      // включая отказ» (R32).
      const started = process.hrtime.bigint();
      const emitSpawn = (): void => {
        emit({
          stage: 'spawn',
          durationUs: Number((process.hrtime.bigint() - started) / 1_000n),
          sandbox: { mode: behaviour.mode },
        });
      };

      let spawnEmitted = false;
      try {
        const argv = await behaviour.toArgv(request, profile.value);
        const raw = await runProcess(argv, {
          ...limitsFor(effective, env.value, request.recipeCwd),
          onSpawn: () => {
            spawnEmitted = true;
            emitSpawn();
          },
        });
        return { value: raw, groupDrained: raw.groupDrained };
      } catch (error) {
        if (!spawnEmitted) emitSpawn();
        throw error;
      }
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
    attributionMissing: result.attributionMissing,
    attributionForeign: result.attributionForeign,
    unrecognizedLines: result.unrecognizedLines,
    suppressedLines: result.suppressedLines,
    consumerFailures: result.consumerFailures,
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
    networkPolicy: (effective) => ({
      allowedDomains: effective.sandbox.network.allow,
      deniedDomains: effective.sandbox.network.deny,
    }),
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

  return makeSandbox(behaviour);
}

/**
 * Обвязка жизненного цикла, общая для обоих режимов.
 *
 * Флаг «эта песочница мертва» живёт **здесь, в экземпляре**, а не в синглтоне, и различие
 * несущее (R50). Требование — чтобы `run()` бросал у **освобождённой** песочницы: вызов
 * после `dispose()` пошёл бы со старым конфигом и `getProxyPort() === undefined`, то есть
 * сеть оказалась бы тихо открыта в `none` и тихо мертва в `seatbelt`.
 *
 * Процессным этот флаг делать нельзя: тогда E5, освободив обе песочницы после демо, не смог
 * бы переключить режим на слайде S5 — `createSandbox` бросал бы до конца жизни процесса, а
 * `reset()` у srt чистит `initializationPromise`, и переподъём совершенно безопасен.
 *
 * Ссылка отпускается **один раз**, сколько бы раз ни позвали `dispose()`: иначе одна
 * песочница, освобождённая дважды, увела бы счётчик ниже нуля и утащила бы за собой чужой
 * прокси — а прокси один на демон.
 */
export function makeSandbox(behaviour: ModeBehaviour): Sandbox {
  srt.retain();
  let disposed = false;

  return {
    mode: behaviour.mode,
    run: async (request, onViolation, onEvent) => {
      if (disposed) throw new Error(DISPOSED_MESSAGE);
      return runInMode(behaviour, request, onViolation, onEvent);
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await srt.dispose();
    },
  };
}
