/**
 * Стадия `approval` — E5. Двухканальные подтверждения: elicitation как мягкий путь и
 * Electron как единственный authoritative-канал для `high` (ADR-0005).
 *
 * Модуль **чистый**: ни Electron, ни MCP-транспорта, ни сокета. Канал приезжает портом
 * (`ApprovalPort`), потому что и окно, и elicitation живут в других процессах, а решение
 * о том, кого спрашивать и что считать разрешением, обязано быть проверяемым в тесте.
 */
export { createBroker, APPROVAL_DENY_CODES } from './broker.js';
export type { ApprovalDenyCode, ApprovalOutcome, ApprovalPort, Broker, BrokerDeps } from './broker.js';
export { createGrantStore, isLive, parseExpiresAt } from './grants.js';
export type { Grant, GrantKey, GrantScope, GrantStore } from './grants.js';
export { dangerousToken } from './token.js';
export type { DangerousToken } from './token.js';
