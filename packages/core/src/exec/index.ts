/**
 * Публичная поверхность E3.
 *
 * Реэкспортируется **поимённо**, а не `export *` по всем модулям: `srt-manager.ts` и
 * `modes/` держат вендорские типы в своих сигнатурах, и звёздочка утащила бы их в граф
 * деклараций пакета — то есть ADR-0002 («изолируем за своим интерфейсом `Sandbox`») перестал
 * бы выполняться молча. Проверяет это обход графа `.d.ts` в `events.test.ts` (R1), но
 * список ниже — первая линия.
 *
 * `createSandbox` — единственный вход в исполнение. Всё остальное здесь есть потому, что
 * его зовёт другой эпик: `buildProfile` и `policyHash` нужны E5 для модалки согласия (D10),
 * `collapseOutput` — E6 при схлопывании двух потоков в пару события (R20), парсер
 * нарушений — E8 при разборе корпуса.
 */

export { assertModeSupported, asCommandId, createSandbox, newCommandId } from './sandbox.js';
export type {
  CommandId,
  ExecOutcome,
  ExecRequest,
  Sandbox,
  StreamOutcome,
  Termination,
} from './sandbox.js';

export { EXEC_STAGES, collapseOutput, measure, measureAsync } from './events.js';
export type { EventSink, ExecEvent, ExecStage } from './events.js';

export {
  MANDATORY_DENY_DIRECTORIES,
  MANDATORY_DENY_FILES,
  MANDATORY_DENY_GIT_PATHS,
  buildProfile,
  mandatoryDenyGlobs,
  policyHash,
  resolveProfilePath,
  toSandboxProfile,
} from './profile.js';
export type { ResolvedSandboxPolicy } from './profile.js';

export { assertDomainPatterns, isValidDomainPattern, isWeakened } from './netpolicy.js';

export { MINIMAL_PATH, buildEnv } from './env.js';

export { SUPPRESSED_OPERATIONS, classify, parseAndClassify, parseLine } from './violation.js';
export type { ClassifyPolicy, ParsedLine, RawViolationRecord } from './violation.js';

export { DEFAULT_GRACE_MS, truncateToBytes } from './limits.js';
