// E1 policy · E2 validate · E3 exec · E6 audit. Без импортов Electron — см. ADR-0001.
//
// Публичная поверхность `@mcpproxy/core`. Оснастка тестов (`policy.fixture.ts`,
// `watch.fixture.ts`) и исполняемые проверки границ (`policy/scan.ts`) сюда не входят:
// первое тянуло бы фикстуры в отгружаемый пакет, второе — обход графа в рантайм потребителя.
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
