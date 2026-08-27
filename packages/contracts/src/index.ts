/**
 * `@mcpproxy/contracts` — замороженный контракт. От него зависят семь эпиков.
 *
 * **Заморожен** означает: публичная поверхность меняется только явным решением владельца.
 * Механизм — не дисциплина, а тест: `api-surface.test.ts` снимает снапшот с `.d.ts` всех
 * трёх входов и с файла схемы и краснеет на любом новом экспорте.
 *
 * `CONTRACTS_VERSION` двигается **только** при несовместимом изменении публичной
 * поверхности, вместе с обновлением снапшота. Правило записано в `docs/07-contracts.md`.
 *
 * Три входа — у них разные права на зависимости:
 * - `.` — типы и чистые функции, **без зависимостей вообще**;
 * - `./validate` — `parseManifest`; тянет `ajv`, `yaml`, `re2`;
 * - `./audit` — хэши; тянет `node:crypto`.
 *
 * Границу держит `deps.test.ts`, а не обещание в этом комментарии.
 */
export const CONTRACTS_VERSION = 1 as const;

export * from './domain.js';
export * from './annotations.js';
export * from './manifest.generated.js';
export * from './types.js';
export * from './mcp.js';
export * from './approval.js';
export * from './event.js';
export * from './otlp.js';
export * from './jcs.js';
export * from './lock.js';
export * from './ipc.js';
export * from './tool.js';
