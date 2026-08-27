import type { AnnotationKey, RiskTier } from './domain.js';

/**
 * Аннотации так, **как их задал манифест**: любое поле может отсутствовать.
 * Дефолты подставляет `deriveRiskTier`, а не вызывающий, — иначе «молчание манифеста»
 * означало бы разное в каждом эпике.
 */
export type ToolAnnotations = Partial<Record<AnnotationKey, boolean>>;

/**
 * Дефолты спецификации MCP, дословно по `schema/2026-07-28/schema.ts`; идентичны
 * начиная с ревизии `2025-03-26`. Пессимистичные: молчащий манифест — опасный манифест.
 */
export const ANNOTATION_DEFAULTS: Readonly<Record<AnnotationKey, boolean>> = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/**
 * Тир риска по аннотациям. Чистая функция: ни ввода-вывода, ни обращения к манифесту.
 *
 * Граница гарантии (R11), и она уже, чем «fail-safe by construction»: молчание манифеста
 * может сделать рецепт только **опаснее** — незаданные поля берут пессимистичные дефолты.
 * Но явный `readOnlyHint: true` тир **понижает**, а спека требует считать аннотации
 * недоверенными. Значит вторая линия обороны — песочница и lock, а не эта функция.
 *
 * Расхождение с lock-файлом сюда **не отображается** намеренно: `high` здесь означает
 * out-of-band апрув в Electron, а дрейф lock — жёсткий стоп на стадии `lock_check` с
 * диффом «было/стало» (ADR-0006, сценарий S7). Это разные поведения; для дрейфа
 * существует `LockStatus`.
 */
export function deriveRiskTier(annotations: ToolAnnotations): RiskTier {
  const readOnly = annotations.readOnlyHint ?? ANNOTATION_DEFAULTS.readOnlyHint;

  // Оговорка спеки: `destructiveHint` и `idempotentHint` значимы только при
  // `readOnlyHint == false`. Прочитать их раньше этой проверки — вернуть `high`
  // на честном read-only рецепте, который вдобавок объявил `destructiveHint: true`.
  if (readOnly) return 'low';

  const destructive = annotations.destructiveHint ?? ANNOTATION_DEFAULTS.destructiveHint;
  const openWorld = annotations.openWorldHint ?? ANNOTATION_DEFAULTS.openWorldHint;

  return destructive || openWorld ? 'high' : 'medium';
}
