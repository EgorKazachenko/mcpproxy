// E0 — заморозить до старта волны 1. См. docs/07-contracts.md
export const CONTRACTS_VERSION = 1 as const;

export * from './domain.js';
export * from './annotations.js';
export * from './manifest.generated.js';
export * from './types.js';

// TODO(E0): схема события (OTel GenAI), lock, IPC, четыре рецепта-заглушки.
