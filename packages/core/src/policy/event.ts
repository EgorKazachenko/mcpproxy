import type { AuditEvent, RecipeName, SessionId } from '@mcpproxy/contracts';
import type { LockVerdict } from './lock-check.js';

/**
 * Событие стадии `lock_check`.
 *
 * Пишется **всегда, включая отказ** (R12): отказ без записи в аудит контракт называет багом.
 * Событие остановленного здесь вызова не несёт `argv` — ключ **отсутствует**, а не равен
 * `null`: JCS различает это побайтово, и обе формы попадают внутрь `chain.self`, то есть
 * выдуманный `argv: []` был бы ложным утверждением в доказательстве, а UI отрисовал бы его
 * как настоящую пустую команду.
 *
 * Сам вызов ничего не считает: вердикт уже произведён на изменении файлов и читается полем.
 */

export interface LockCheckEventInput {
  readonly verdict: LockVerdict;
  /** Идёт и в `toolName`, и в `recipe.name`: у `AuditEvent` это два обязательных поля. */
  readonly recipeName: RecipeName;
  /** `undefined` — имени нет в манифесте, значит и дайджеста у него нет. */
  readonly recipeDigest: string | undefined;
  /**
   * Ревизия MCP, **согласованная в этой сессии** (R12b). Константа сборки сюда не годится:
   * контракт называет запись собственной константы вместо согласованного значения ложным
   * утверждением в доказательстве, а поле попадает в `chain.self`.
   */
  readonly protocolVersion: string;
  readonly sessionId: SessionId;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly startTime: string;
  readonly endTime: string;
  readonly durationUs: number;
}

export function lockCheckEvent(input: LockCheckEventInput): AuditEvent {
  const allowed = input.verdict.check.status === 'verified';

  return {
    schema: 'mcpproxy.audit/1',
    operation: 'execute_tool',
    protocolVersion: input.protocolVersion,
    toolName: input.recipeName,
    sessionId: input.sessionId,
    traceId: input.traceId,
    spanId: input.spanId,
    parentSpanId: input.parentSpanId,
    startTime: input.startTime,
    endTime: input.endTime,
    durationUs: input.durationUs,
    stage: 'lock_check',
    verdict: allowed ? 'allowed' : 'denied',
    // Условный спред, а не `hash: input.recipeDigest`: поле объявлено `hash?: string` внутри
    // обязательного `recipe`, и `{ hash: undefined }` под `exactOptionalPropertyTypes` не
    // присваивается — но это ловит компилятор, а вот следующие два случая он не ловит.
    recipe: {
      name: input.recipeName,
      ...(input.recipeDigest === undefined ? {} : { hash: input.recipeDigest }),
    },
    // `denyReason?: string | null` **допускает** `null` значением, поэтому прямой перенос
    // записал бы ключ в каждое `allowed`-событие, и он уехал бы в `chain.self`. Здесь тип не
    // спасает — спасает условный спред (R12a).
    ...(input.verdict.denyReason === null ? {} : { denyReason: input.verdict.denyReason }),
  };
}
