/**
 * Платформенно-независимый вход `@mcpproxy/core/pure`.
 *
 * Существует потому, что корневой баррель стал Node-only: `confirm-tty` тянет
 * `node:readline/promises`, `watch` — `node:fs`, `lock-write` — `node:fs/promises` и
 * `node:crypto`. Ближайшие потребители — E5 (доставка апрува) и E7 (модалка диффа) — нуждаются
 * ровно в `renderRequest`, формах запроса и вердикте, то есть в чистых функциях; импортировав их
 * из корня, они затащили бы `node:readline/promises` в бандл рендерера.
 *
 * Делается **сейчас**, пока у пакета нет ни одного потребителя кода: сегодня это чистое
 * добавление, после первого бандла — ломающая правка. Прецедент в репозитории есть —
 * `@mcpproxy/contracts` держит три входа с разными правами на зависимости, и границу там держит
 * исполняемый тест, а не обещание. Здесь её держит `boundary.test.ts`.
 *
 * Ни один модуль отсюда не импортирует `node:*` — ни прямо, ни транзитивно.
 */
export * from './approve.js';
export * from './diagnostics-log.js';
export * from './event.js';
export * from './render-diff.js';
export * from './shapes.js';

// Формы вердикта — только типами: их ПРОИЗВОДСТВО (`checkLock`) зовёт `verifyLockEntries` и
// потому тянет `node:crypto`, а потребителю на чистой стороне нужна форма, а не производство.
export type { LoadedLock, LoadedManifest, LockDenyCode, LockVerdict } from './lock-check.js';
