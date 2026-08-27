/**
 * Доменные типы. Владелец — contracts, а не design и не core.
 *
 * Правило: тип, который встречается и в ядре, и в UI, живёт здесь.
 * Как он выглядит — дело design; что он значит — дело contracts.
 */

/** Вердикт вызова. */
export type Verdict = 'allowed' | 'denied' | 'pending_approval' | 'error';

/** Стадии вызова. Порядок значим — см. `stageOrder`. */
export type Stage =
  | 'received'
  | 'lock_check'
  | 'validate'
  | 'resolve_paths'
  | 'build_argv'
  | 'classify_risk'
  | 'approval'
  | 'build_env'
  | 'build_profile'
  | 'spawn'
  | 'violation'
  | 'redact'
  | 'complete';

/** Порядок в таймлайне. `violation` может повторяться. */
export const stageOrder: readonly Stage[] = [
  'received',
  'lock_check',
  'validate',
  'resolve_paths',
  'build_argv',
  'classify_risk',
  'approval',
  'build_env',
  'build_profile',
  'spawn',
  'violation',
  'redact',
  'complete',
] as const;

/** Тир риска. Выводится из аннотаций, не задаётся в манифесте напрямую. */
export type RiskTier = 'low' | 'medium' | 'high';

export type SandboxMode = 'none' | 'seatbelt' | 'container';

export type ViolationType =
  | 'network'
  | 'file-read'
  | 'file-write'
  | 'mandatory-deny'
  | 'process';

/** Аннотации инструмента из спецификации MCP. Дефолты пессимистичные. */
export type AnnotationKey =
  | 'readOnlyHint'
  | 'destructiveHint'
  | 'idempotentHint'
  | 'openWorldHint';
