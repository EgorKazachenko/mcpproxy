/**
 * `@mcpproxy/bench` — E8: корпус легитимных задач, корпус атак, метрики и отчёт.
 * Методология и определения метрик — `docs/09-metrics-and-eval.md`.
 *
 * Одна реализация, два входа (правило 5): CLI `mcpproxy-bench` и вкладка «Red team» в E7,
 * которая берёт `toJson`.
 */
export { runBench, LIMITS } from './run.js';
export type { BenchRun, RunOptions } from './run.js';

export { formatReport, toJson } from './report.js';

export { attackMetrics, journalMetrics, percentiles, utilityMetrics } from './metrics.js';
export type { AttackMetrics, DirectComparison, JournalMetrics, ModeReport, Percentiles, UtilityMetrics } from './metrics.js';

export { attackCases } from './corpus/attacks.js';
export { utilityCases } from './corpus/legit.js';

export { startRig, RigStartError } from './rig.js';
export type { Rig, RigOptions } from './rig.js';

export { startListener } from './listener.js';
export type { Listener } from './listener.js';

export { CANARY, materialize, MANIFEST } from './repo.js';
export type { DemoRepo } from './repo.js';

export { ATTACK_CLASSES, UTILITY_CLASSES } from './types.js';
export type {
  AttackCase,
  AttackClass,
  AttackProbe,
  BenchMode,
  CaseResult,
  CaseStatus,
  RunCtx,
  UtilityCase,
  UtilityClass,
  UtilityProbe,
} from './types.js';
