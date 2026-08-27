// E0 — заморозить до старта волны 1. См. docs/07-contracts.md
export const CONTRACTS_VERSION = 1 as const;

export * from './domain.js';
export * from './annotations.js';
export * from './manifest.generated.js';
export * from './types.js';
export * from './mcp.js';
export * from './approval.js';
export * from './event.js';
export * from './otlp.js';

// TODO(E0): lock, IPC, четыре рецепта-заглушки.
