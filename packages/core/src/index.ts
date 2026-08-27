/**
 * `@mcpproxy/core` — ядро демона. Без импортов Electron (ADR-0001).
 *
 * E1 policy · E2 validate · E3 exec · **E6 audit** — реализовано в этом эпике.
 *
 * **Поверхность узкая намеренно.** Наружу выходит то, что зовут E3, E4 и E7; примитивы
 * детектора (`shannonEntropy`, `findHighEntropyRuns`, пороги) остаются внутри. Добавить
 * экспорт потом дёшево — снять его из замороженной поверхности дорого, а `api-surface.test.ts`
 * краснеет на каждом новом.
 *
 * **Чего здесь нет и не будет:** `@mcpproxy/contracts/validate`. E6 принимает уже
 * нормализованный `effective`-профиль, а не загружает манифест; границу держит
 * `deps.test.ts`, а не это предложение.
 */

// Стадия `build_env` — И4, первая линия обороны против A12.
export { MINIMAL_PATH, buildEnv } from './env/build.js';
export type { BuiltEnv } from './env/build.js';

// Стадия `redact` — вторая линия. Двусторонняя: исходящее заменяется, входящее считается.
export { ENTROPY_RULE_ID } from './redact/entropy.js';
export { RuleCompilationError, createRedactor, placeholder } from './redact/engine.js';
export type { RedactedText, Redactor, ScanOptions, SecretMatch } from './redact/engine.js';
export { SECRET_RULES } from './redact/rules.js';
export type { SecretRule } from './redact/rules.js';
export { redactInbound, redactOutput } from './redact/output.js';
export type {
  InboundInput,
  OutputLimits,
  ProcessOutput,
  RedactedInbound,
  RedactedOutput,
} from './redact/output.js';

// Журнал: append-only JSONL с хэш-цепочкой. Формула — из `@mcpproxy/contracts/audit`.
export { defaultAuditLogPath, openAuditLog, readLog, verifyLog } from './audit/log.js';
export type { AuditLog, LogVerification, OpenAuditLogOptions, ReadLogResult } from './audit/log.js';
export { exportJsonl, exportOtlp } from './audit/export.js';
export type { ExportManifest, ExportOptions, ExportResult } from './audit/export.js';
