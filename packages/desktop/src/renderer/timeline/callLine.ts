import type { SandboxMode, SandboxViolation } from '@mcpproxy/contracts';
import { violationRole, type Role } from '@mcpproxy/design';
import type { Call } from '../../shared/call.js';
import type { CallOutcome } from '../../shared/callOutcome.js';
import { STAGE_GROUPS, stageGroup, stagesOf, type StageGroup } from '../../shared/stageGroup.js';

export interface CallLine {
  readonly role: Role;
  readonly outcome: CallOutcome;
  readonly sandbox: SandboxMode | undefined;
  /**
   * Бейдж вердикта глушится, когда у вызова есть нарушение с ролью `danger`.
   *
   * Это ВТОРАЯ ось, а не следствие исхода: вызов при этом остаётся разрешённым, и зелёное
   * «разрешено» оказалось бы самым ярким пятном на строке катастрофы. Правило берётся из
   * макета, и оно шире, чем «нарушение прошло насквозь»: у пары persistence + отбито ничего
   * не прошло, но строка красная, и зелёный бейдж рядом спорил бы сам с собой.
   */
  readonly verdictMuted: boolean;
  readonly worst: SandboxViolation | undefined;
  readonly others: number;
}

const RANK: Readonly<Record<Role, number>> = { ok: 0, muted: 0, info: 1, human: 1, warn: 2, danger: 3 };

const violationsOf = (call: Call): readonly SandboxViolation[] =>
  call.stages.flatMap((event) => event.sandbox?.violations ?? []);

const sandboxOf = (call: Call): SandboxMode | undefined =>
  call.stages.reduce<SandboxMode | undefined>((mode, event) => event.sandbox?.mode ?? mode, undefined);

/** Роль вызова: худшее из вердикта и исходов нарушений. */
function roleOf(call: Call, violations: readonly SandboxViolation[]): Role {
  if (call.verdict === 'error') return 'danger';
  const worstViolation = violations
    .map((v) => violationRole(v.type, v.action))
    .reduce<Role>((worst, role) => (RANK[role] > RANK[worst] ? role : worst), 'ok');
  if (RANK[worstViolation] > 0) return worstViolation;
  if (call.verdict === 'denied') return 'warn';
  if (call.verdict === 'pending_approval') return 'info';
  return 'ok';
}

function outcomeOf(call: Call, violations: readonly SandboxViolation[]): CallOutcome {
  if (call.verdict === 'denied') return 'denied';
  if (call.verdict === 'pending_approval') return 'awaiting';
  if (violations.some((v) => v.action === 'allowed')) return 'passed';
  if (violations.length > 0) return 'blocked';
  return call.open ? 'running' : 'clean';
}

export function callLine(call: Call): CallLine {
  const violations = violationsOf(call);
  const worst = violations
    .slice()
    .sort((a, b) => RANK[violationRole(b.type, b.action)] - RANK[violationRole(a.type, a.action)])[0];

  return {
    role: roleOf(call, violations),
    outcome: outcomeOf(call, violations),
    sandbox: sandboxOf(call),
    verdictMuted: violations.some((v) => violationRole(v.type, v.action) === 'danger'),
    worst,
    others: Math.max(0, violations.length - 1),
  };
}

export interface GroupBar {
  readonly group: StageGroup;
  readonly reached: number;
  readonly total: number;
  readonly role: Role;
}

const stageRole = (verdict: string): Role =>
  verdict === 'denied' ? 'warn' : verdict === 'error' ? 'danger' : 'ok';

/**
 * Свёрнутая полоса из трёх групп.
 *
 * Возвращает счётчики, а не одну роль: макет рисует полосу пропорционально и оставляет рельс
 * под недостигнутые стадии, и одной ролью на группу это не выражается.
 *
 * Группа красится по **худшему** исходу внутри себя, а не по первому: у стадии `violation` в
 * одном вызове бывает несколько записей с разными ролями.
 */
export function groupBar(call: Call): readonly GroupBar[] {
  return STAGE_GROUPS.map((group) => {
    const stages = stagesOf(group);
    const role = call.stages
      .filter((event) => stageGroup(event.stage) === group)
      .flatMap((event): Role[] =>
        event.stage === 'violation'
          ? (event.sandbox?.violations ?? []).map((v) => violationRole(v.type, v.action))
          : [stageRole(event.verdict)],
      )
      .reduce<Role>((worst, next) => (RANK[next] > RANK[worst] ? next : worst), 'ok');

    return {
      group,
      reached: stages.filter((stage) => call.reached.has(stage)).length,
      total: stages.length,
      role,
    };
  });
}
