import { stageOrder, type Stage } from '@mcpproxy/contracts';

/**
 * Три группы стадий для свёрнутой полосы в строке вызова.
 *
 * Живёт здесь, а не в дизайн-системе: та по собственному правилу отображает доменное
 * значение в **слово**, а не в другое доменное значение. Контракты заморожены и группировки
 * не несут, поэтому дом у неё один — общий слой этого приложения.
 */
export type StageGroup = 'checks' | 'setup' | 'execution';

const GROUPS: Readonly<Record<StageGroup, readonly Stage[]>> = {
  checks: ['received', 'lock_check', 'validate', 'resolve_paths', 'build_argv', 'classify_risk'],
  setup: ['approval', 'build_env', 'build_profile'],
  execution: ['spawn', 'violation', 'redact', 'complete'],
};

export const STAGE_GROUPS: readonly StageGroup[] = ['checks', 'setup', 'execution'];

const OF_STAGE = new Map<Stage, StageGroup>(
  STAGE_GROUPS.flatMap((group) => GROUPS[group].map((stage) => [stage, group] as const)),
);

export function stageGroup(stage: Stage): StageGroup {
  const group = OF_STAGE.get(stage);
  // WHY: `stageOrder` заморожен, и добавление стадии в контракте обязано ронять этот модуль,
  // а не молча ронять стадию из полосы. Отсюда бросок, а не значение по умолчанию.
  if (group === undefined) throw new Error(`стадия вне групп: ${stage}`);
  return group;
}

/** Все стадии контракта разложены по группам — проверяется тестом, а не подразумевается. */
export const stagesOf = (group: StageGroup): readonly Stage[] => GROUPS[group];

export const allGroupedStages = (): readonly Stage[] => stageOrder.filter((s) => OF_STAGE.has(s));
