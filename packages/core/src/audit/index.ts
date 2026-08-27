/**
 * Вход `./audit` — журнал и его экспорт, **без движка редакции**.
 *
 * Причина отдельного входа измерена, а не предположена: корневой вход тянет `re2` — нативный
 * аддон, собранный под ABI Node (`node-gyp`, prebuild). Потребитель, которому нужны только
 * `readLog` / `verifyLog` / `ChainedEvent` — вкладка аудита и бейдж в E7, или человек,
 * проверяющий вердикт ЧУЖОГО экспортированного лога на своей машине, — не должен ради этого
 * собирать RE2. Electron несёт собственный `process.versions.modules`, поэтому тот же бинарь
 * в нём не загрузится без `electron-rebuild`: ADR-0001 запрещает `core` импортировать Electron,
 * но не мешал `core` навязывать Electron-потребителю нативный ребилд.
 *
 * Добавление чисто аддитивное: `"."` продолжает экспортировать всё, что экспортировал.
 * Границу «здесь нет `re2`» держит `deps.test.ts`, а не это предложение.
 */
export { AuditLogError, defaultAuditLogPath, openAuditLog, readLog, verifyLog } from './log.js';
export type { AuditLog, AuditLogErrorCode, LogVerification, OpenAuditLogOptions, ReadLogResult } from './log.js';
export { exportJsonl, exportOtlp } from './export.js';
export type { ExportManifest, ExportOptions, ExportResult } from './export.js';
