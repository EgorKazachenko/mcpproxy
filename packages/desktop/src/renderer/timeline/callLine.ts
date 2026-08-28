import type { SandboxMode, SandboxViolation } from '@mcpproxy/contracts';
import { stageLabel, violationLabel, violationRole, type Role } from '@mcpproxy/design';
import type { Call } from '../../shared/call.js';
import type { CallOutcome } from '../../shared/callOutcome.js';
import { STAGE_GROUPS, stageGroup, stagesOf, type StageGroup } from '../../shared/stageGroup.js';
import { STRINGS } from '../strings.js';

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

  /**
   * Остаток строки после слова диспозиции — то, ЧТО именно случилось.
   *
   * Прежде здесь не было ничего, а `CallList` печатал только «тип: цель». Макет
   * (`mockup.html`, функция `callLine`) даёт остаток во всех четырёх случаях, и по `R49` он
   * источник истины для строк. Потери были не косметические: у отказанного вызова пропадала
   * причина и стадия, у выполненного — код выхода и оверхед, у нарушения — объём в байтах и
   * счётчик остальных. На строке, по которой человек и решает, куда смотреть, объём в байтах
   * это и есть ответ на вопрос сценария S5 «ушли ли данные и сколько».
   */
  readonly rest: string;
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
  // WHY: ветка `error` обязана стоять здесь так же, как она стоит в `roleOf`. Без неё
  // `error` доходил до последней строки и — поскольку `error` терминален, а значит `open`
  // ложно — давал исход `clean`, то есть слово «Выполнено» на красной строке. `R15` требует
  // ровно обратного: слово читается раньше цвета, поэтому спорить с цветом оно не имеет права.
  if (call.verdict === 'error') return 'failed';
  if (call.verdict === 'pending_approval') return 'awaiting';
  if (violations.some((v) => v.action === 'allowed')) return 'passed';
  if (violations.length > 0) return 'blocked';
  return call.open ? 'running' : 'clean';
}

/** Остаток строки. Порядок веток — тот же, что в макете: отказ, ожидание, нарушения, чистый. */
function restOf(call: Call, violations: readonly SandboxViolation[], worst: SandboxViolation | undefined): string {
  if (call.verdict === 'denied') {
    const denied = call.stages.find((event) => event.denyReason !== undefined && event.denyReason !== null);
    const at = denied ?? call.stages[call.stages.length - 1];
    return STRINGS.calls.deniedBecause(denied?.denyReason ?? '', stageLabel[at?.stage ?? 'received']);
  }
  if (call.verdict === 'pending_approval') return STRINGS.calls.awaitingNote;

  if (worst !== undefined) {
    const sent = worst.action === 'allowed' && worst.bytes > 0 ? STRINGS.calls.sent(worst.bytes) : '';
    const more = violations.length > 1 ? STRINGS.calls.andMore(violations.length - 1) : '';
    return `${violationLabel[worst.type]}: ${worst.target}${sent}${more}`;
  }

  const exit = call.stages.reduce<{ code: number | null } | undefined>((found, e) => e.exit ?? found, undefined);
  const overhead = call.stages.reduce<number | undefined>((found, e) => e.duration?.overheadMs ?? found, undefined);
  if (exit === undefined || overhead === undefined) return '';
  return STRINGS.calls.completed(exit.code, overhead);
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
    rest: restOf(call, violations, worst),
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
