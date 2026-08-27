/**
 * Формы подтверждения (R26). Объявлены целиком в E0, а не дорисованы в E5/E7: после
 * заморозки добавление сюда поля означало бы ломающее изменение для семи эпиков, а без
 * этих форм не реализуемы ни сценарий S8, ни атака A14, ни ASI09.
 */

/** Канал, которым спросили человека. */
export type ApprovalChannel = 'electron' | 'elicitation';

/**
 * Решение человека. Третьего члена нет намеренно: истечение и отмена выражаются
 * **отсутствием** вердикта, а не значением внутри него.
 */
export type ApprovalDecision = 'approved' | 'denied';

/**
 * Насколько широко действует «да».
 * - `once` — только этот вызов;
 * - `until` — до `expiresAt`;
 * - `recipe_and_args` — для этого рецепта с этим же `argsHash`.
 */
export type ApprovalScope = 'once' | 'until' | 'recipe_and_args';

/**
 * Запись подтверждения в событии аудита.
 *
 * `expiresAt` — **абсолютное** ISO-время, а не относительный TTL: append-only запись
 * читают через месяцы, и «10 минут» в ней уже ничего не означает.
 *
 * `sessionId` дублирует поле события намеренно, чтобы запись вердикта была самодостаточной.
 * Без него подтверждение со скоупом `until` или `recipe_and_args` ключуется только по
 * `(recipeName, argsHash, expiresAt)` и оказывается неявно действительным во всех сессиях —
 * включая ту, которую человеку никогда не показывали. Ключевание — дело E5; E0 обязан
 * сделать сессионную атрибуцию **выразимой**, потому что после заморозки поле не добавить.
 */
export interface ApprovalRecord {
  readonly channel: ApprovalChannel;
  readonly decision: ApprovalDecision;
  readonly scope: ApprovalScope;
  readonly expiresAt: string | null;
  readonly argsHash: string;
  readonly sessionId: string;
}
