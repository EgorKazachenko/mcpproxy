/**
 * Чистая половина E3 — отдельным входом пакета (`@mcpproxy/core/policy`).
 *
 * Существует потому, что помодульная чистота, которую обещают `netpolicy.ts` и
 * `violation.ts`, **на входе пакета неверна**: корневой вход тянет `createSandbox`, тот —
 * режимы, режимы — `@anthropic-ai/sandbox-runtime`. То есть `import { isWeakened } from
 * '@mcpproxy/core'` ради бейджа в UI (E7) или `classify` ради разбора корпуса (E8) грузил бы
 * вендорский SDK на любой платформе, включая ту, где `assertModeSupported` намеренно
 * отказывает.
 *
 * Форма — та же, что у `packages/contracts` с его `./validate` и `./audit`: граница между
 * «нужен node:crypto» и «не нужен» там держится входами, а не дисциплиной. Здесь граница
 * между «нужен вендор» и «не нужен».
 */

export { buildProfile, policyHash } from './profile.js';
export type { ResolvedSandboxPolicy } from './profile.js';

export { isValidDomainPattern, isWeakened } from './netpolicy.js';

export { classify, parseAndClassify, parseLine, typeForOperation } from './violation.js';
export type { ClassifyPolicy, ParsedLine, RawViolationRecord } from './violation.js';

export { collapseOutput } from './events.js';
export type { ExecEvent, EventSink } from './events.js';

export { ExecError } from './errors.js';
export type { ExecErrorCode, ExecErrorContext } from './errors.js';
