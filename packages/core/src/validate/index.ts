import { buildArgv } from './argv.js';
import type { Denial, E2Stage, ParamValue } from './denial.js';
import { validateParams } from './params.js';
import { resolvePaths } from './paths.js';
import type { PreparedRecipe } from './prepare.js';

/**
 * Фасад трёх стадий E2. Чистые функции: ни часов кроме измерения, ни ввода-вывода кроме
 * `realpath`, ни записи событий (R23, D3). `AuditEvent` собирает E4 — и обязанность «событие
 * пишется на каждой стадии, включая отказ» переходит к нему, поэтому здесь наружу отдаётся
 * всё, что ему для этого нужно.
 */

export interface StageTiming {
  readonly stage: E2Stage;
  readonly durationUs: number;
}

export type CallResult =
  | {
      ok: true;
      argv: readonly string[];
      cwd: string;
      /**
       * Проверенные значения ПОСЛЕ валидации и резолва — вход `argsHash` (R31). Без них E4
       * посчитал бы хэш по сырым `params`, и `{file: './logs/a.log'}` и
       * `{file: '/abs/logs/a.log'}` перестали бы быть одним вызовом.
       */
      params: Readonly<Record<string, ParamValue>>;
      timings: readonly StageTiming[];
    }
  | {
      ok: false;
      /** Непустой кортеж: ветка отказа не может оказаться пустой. */
      denials: readonly [Denial, ...Denial[]];
      /**
       * Присутствует, если стадия `resolve_paths` была достигнута, — в том числе при отказе
       * на ней. При отказе на `validate` ключ ОТСУТСТВУЕТ, а не равен `null`:
       * `packages/contracts/src/event.ts:90` объявляет `readonly cwd?: string` без `null`.
       */
      cwd?: string;
      timings: readonly StageTiming[];
    };

/**
 * Помощника для измерения в контрактах нет — единственное упоминание `hrtime` там внутри
 * теста. `process.hrtime.bigint` монотонен и не зависит от NTP.
 */
function timed<T>(stage: E2Stage, timings: StageTiming[], run: () => T): T {
  const start = process.hrtime.bigint();
  const result = run();
  timings.push({ stage, durationUs: Number((process.hrtime.bigint() - start) / 1000n) });
  return result;
}

/**
 * Третьего аргумента нет: `manifestDir` доехал до `prepared` на подготовке (R2). Каталог,
 * определяющий `cwd` и границы confinement, в сигнатуре отсутствует — как и argv, путь к
 * бинарю и профиль песочницы (R5, И5).
 */
export function validateCall(prepared: PreparedRecipe, params: Readonly<Record<string, unknown>>): CallResult {
  const timings: StageTiming[] = [];

  // Проводка явная и однозначная, и имена двух карт разные, потому что разные и их типы:
  // передать в `buildArgv` дорезолвную карту — то есть сырую строку пользователя прямо в
  // argv — теперь ошибка компиляции, а не то, что ловит один рантайм-трейс.
  const validated = timed('validate', timings, () => validateParams(prepared, params));
  // Остановка на первой стадии, давшей отказ; `timings` содержит и её саму — E4 не может
  // написать то, чего ему не отдали.
  if (!validated.ok) return { ok: false, denials: validated.denials, timings };

  const resolved = timed('resolve_paths', timings, () => resolvePaths(prepared, validated.values));
  if (!resolved.ok) return { ok: false, denials: resolved.denials, cwd: prepared.cwd, timings };

  const argv = timed('build_argv', timings, () => buildArgv(prepared, resolved.values));

  return { ok: true, argv, cwd: prepared.cwd, params: Object.fromEntries(resolved.values), timings };
}

// Публичная форма E2. Реэкспорт собран здесь, а не в корневом barrel, чтобы у модуля был
// один вход и корневой файл оставался картой пакета.
export { prepareRecipe } from './prepare.js';
export type { PreparedParam, PreparedRecipe, PrepareResult } from './prepare.js';
export { validateParams } from './params.js';
export type { ValidateParamsResult } from './params.js';
export { resolvePaths } from './paths.js';
export type { ResolvePathsResult } from './paths.js';
export { buildArgv } from './argv.js';
export { DENIAL_CODES, DENIAL_STAGES, DENIALS_MAX, E2_STAGES, VALUE_MAX_CODE_POINTS } from './denial.js';
export type {
  Denial,
  DenialCode,
  DenialStage,
  E2Stage,
  ParamValue,
  ResolvedValues,
  ValidatedValues,
} from './denial.js';

/**
 * E4 — confinement рабочего каталога рецепта под каталог манифеста (A4 и R34). Поднят в
 * поверхность именно затем, чтобы у границы был ОДИН вычислитель: в этом же репозитории уже
 * записано границей, что копия предиката в `contracts` и копия в `core` ничем не сверяются,
 * и третья копия в `mcp-server` продолжила бы ряд.
 */
export { confinementOf } from './confinement.js';
export type { Confinement } from './confinement.js';
