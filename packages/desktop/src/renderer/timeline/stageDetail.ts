import type { ChainedEvent, Stage } from '@mcpproxy/contracts';
import { riskLabel, violationLabel } from '@mcpproxy/design';
import { STRINGS } from '../strings.js';

/**
 * Строка деталей стадии.
 *
 * Свободного текста стадии `AuditEvent` не несёт и нести не должен: фраза собирается из полей
 * события по таблице шаблонов на **все тринадцать** стадий. Таблица на двенадцать дала бы
 * пустую строку на тринадцатой, и заметить это без утверждения о полноте нечем.
 */
type Template = (event: ChainedEvent) => string;

const bytes = (n: number): string => `${n} ${STRINGS.stage.bytes}`;

export const STAGE_TEMPLATES: Readonly<Record<Stage, Template>> = {
  received: (e) => STRINGS.stage.received(e.sessionId),
  lock_check: (e) =>
    e.verdict === 'denied' ? (e.denyReason ?? STRINGS.stage.lockDrift) : STRINGS.stage.lockMatch,
  validate: (e) => (e.verdict === 'denied' ? (e.denyReason ?? STRINGS.stage.validateFail) : STRINGS.stage.validateOk),
  resolve_paths: (e) =>
    e.verdict === 'denied' ? (e.denyReason ?? STRINGS.stage.pathFail) : STRINGS.stage.pathOk(e.cwd ?? ''),
  build_argv: (e) => STRINGS.stage.buildArgv(e.argv?.length ?? 0, e.argvFromParams?.length ?? 0),
  classify_risk: (e) => (e.risk === undefined ? STRINGS.stage.riskUnknown : riskLabel[e.risk.tier]),
  approval: (e) => (e.approval === undefined ? STRINGS.stage.approvalPending : STRINGS.stage.approvalDone),
  build_env: (e) => (e.env?.allowed ?? []).join(' ') || STRINGS.stage.envEmpty,
  build_profile: (e) =>
    e.sandbox?.mode === 'none' ? STRINGS.stage.profileSkipped : STRINGS.stage.profileApplied,
  // WHY: `argv` впервые появляется на `build_argv` и на событии `spawn` может не
  // повторяться. Без запасной строки шаблон отдавал бы пустоту, и строка стадии молча
  // исчезала бы с экрана — это нашёл тест полноты, а не чтение.
  spawn: (e) => (e.argv === undefined ? STRINGS.stage.spawned : e.argv.join(' ')),
  violation: (e) => {
    const violation = e.sandbox?.violations?.[0];
    if (violation === undefined) return STRINGS.stage.violationUnknown;
    return STRINGS.stage.violation(violationLabel[violation.type], violation.target, bytes(violation.bytes));
  },
  redact: (e) =>
    (e.redactions ?? []).length === 0
      ? STRINGS.stage.redactNone
      : (e.redactions ?? []).map((r) => STRINGS.stage.redaction(r.rule, r.count, r.stream)).join(', '),
  complete: (e) => STRINGS.stage.complete(e.exit?.code ?? null),
};

export function stageDetail(event: ChainedEvent): string {
  const template = STAGE_TEMPLATES[event.stage];
  // WHY: стадия вне таблицы означает, что контракт расширился, а этот модуль не заметил.
  // Пустая строка спрятала бы это, поэтому подпись режима — заметная заглушка.
  return template === undefined ? STRINGS.stage.unknown : template(event);
}
