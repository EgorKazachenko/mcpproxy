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

/**
 * Группа стадии. Незнакомая стадия уезжает в `execution`, а не роняет отрисовку.
 *
 * Прежде здесь был бросок «чтобы добавление стадии в контракте роняло модуль». Цель верная,
 * место — нет: `stageGroup` зовётся из рендера, error boundary над таймлайном нет, и одно
 * событие из более новой сборки гасило бы весь экран. Контракт при этом прямо требует
 * обратного: неизвестное значение — «читаемая запись с пометкой „форма новее меня“, а не
 * исключение», и `trace.ts`, `stageDetail.ts` и `call.ts` этому уже следуют.
 *
 * Цель никуда не делась — её держит тест полноты плюс тип `Record<StageGroup, …>`: новая
 * стадия роняет СБОРКУ, а не пользователя. Это и есть правильное время падения.
 */
export function stageGroup(stage: Stage): StageGroup {
  return OF_STAGE.get(stage) ?? 'execution';
}

/** Все стадии контракта разложены по группам — проверяется тестом, а не подразумевается. */
export const stagesOf = (group: StageGroup): readonly Stage[] => GROUPS[group];

export const allGroupedStages = (): readonly Stage[] => stageOrder.filter((s) => OF_STAGE.has(s));
