/**
 * Публичная поверхность E3.
 *
 * Реэкспортируется **поимённо**, а не `export *` по всем модулям: `srt-manager.ts` и
 * `modes/` держат вендорские типы в своих сигнатурах, и звёздочка утащила бы их в граф
 * деклараций пакета — то есть ADR-0002 («изолируем за своим интерфейсом `Sandbox`») перестал
 * бы выполняться молча. Проверяет это обход графа `.d.ts` в `events.test.ts` (R1), но список
 * ниже — первая линия.
 *
 * **Каждый символ здесь назван вместе со своим потребителем.** Публичная поверхность, за
 * которой никто не стоит, поддерживается вечно и бесплатно не бывает; то, что нужно только
 * тестам, остаётся экспортом своего модуля и сюда не поднимается. Состав закреплён
 * снапшотом в `surface.test.ts` — новый экспорт краснеет, как в `packages/contracts`.
 */

/** E4 — единственный вход в исполнение; `newCommandId` он же зовёт на каждый вызов. */
export { asCommandId, createSandbox, newCommandId } from './sandbox.js';
export type {
  CommandId,
  ExecOutcome,
  ExecRequest,
  Sandbox,
  StreamOutcome,
  Termination,
} from './sandbox.js';

/** E4 — принимает события стадий; E6 — схлопывает два потока в пару `output` события (R20). */
export { collapseOutput } from './events.js';
export type { EventSink, ExecEvent } from './events.js';

/** E5 — модалка согласия: показывает профиль и сверяет хэш применённой политики (D10, R47). */
export { buildProfile, policyHash } from './profile.js';
export type { ResolvedSandboxPolicy } from './profile.js';

/** E7 — бейдж «ослабленный режим» на рецепте (R14). */
export { isWeakened } from './netpolicy.js';

/** E8 — разбор корпуса атак: отличить «команду резали» от «команда отработала» (R41). */
export { classify, parseAndClassify, parseLine } from './violation.js';
export type { ClassifyPolicy, ParsedLine, RawViolationRecord } from './violation.js';
