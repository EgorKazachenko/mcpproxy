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
//
// Реэкспорт из барреля `./audit`, а не из модулей напрямую: тот же набор доступен вторым
// входом пакета — `@mcpproxy/core/audit`, — который НЕ тянет нативный `re2`. Потребителю
// журнала (E7, проверка чужого экспорта) хватает его; корневой вход остаётся полным.
export * from './audit/index.js';

// Стадия `lock_check` — E1. Загрузка манифеста и lock, сверка, дифф и запись по команде
// человека. Единственная точка загрузки политики в ядре: прямой вызов `parseManifest` в обход
// `policy/store.ts` запрещён исполняемым сканом (`policy/boundary.test.ts`), а не соглашением.
//
// Вход тянет `@mcpproxy/contracts/validate` — это и есть работа E1, и потому запрет на
// валидатор в `deps.test.ts` сужен: он защищает от ВТОРОЙ точки загрузки, не от этой.
// Кому нужен рендер диффа без платформенных модулей — второй вход, `@mcpproxy/core/pure`.
export * from './policy/approve.js';
export * from './policy/confirm-tty.js';
export * from './policy/diagnostics-log.js';
export * from './policy/event.js';
export * from './policy/lock-check.js';
export * from './policy/lock-command.js';
export * from './policy/lock-write.js';
export * from './policy/render-diff.js';
export * from './policy/shapes.js';
export * from './policy/store.js';
export * from './policy/watch.js';
