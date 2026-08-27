/**
 * Семантика домена: как состояния прокси отображаются в цвет.
 *
 * Типы приходят из `@mcpproxy/contracts` — что значит состояние, решает контракт.
 * Здесь только одно: как оно выглядит и как называется по-русски.
 *
 * Это самая важная часть визуального языка. Приложение существует, чтобы
 * человек за долю секунды отличал «защита сработала» от «защита не сработала».
 * Если красить оба исхода одинаково, смысл продукта теряется.
 *
 *   ok      зелёный    прошло штатно
 *   warn    янтарный   ОТБИТО — защита сработала, нормальный рабочий исход
 *   danger  красный    ПЛОХО ПО-НАСТОЯЩЕМУ — защита не сработала или сломана
 *   info    синий      ждём человека
 *   human   фиолетовый решение человека принято и действует
 */

import type {
  AnnotationKey,
  RiskTier,
  SandboxMode,
  Stage,
  Verdict,
  ViolationType,
} from '@mcpproxy/contracts';

export type Role = 'ok' | 'warn' | 'danger' | 'info' | 'human' | 'muted';

/* ── Вердикт вызова ─────────────────────────────────────────────────────── */

export const verdictRole: Readonly<Record<Verdict, Role>> = {
  allowed: 'ok',
  /** Отказ прокси — штатная работа, а не авария. Янтарь, не красный. */
  denied: 'warn',
  pending_approval: 'info',
  error: 'danger',
} as const;

export const verdictLabel: Readonly<Record<Verdict, string>> = {
  allowed: 'разрешено',
  denied: 'отказано',
  pending_approval: 'ждёт апрува',
  error: 'ошибка',
} as const;

/* ── Стадии вызова ──────────────────────────────────────────────────────── */

export const stageLabel: Readonly<Record<Stage, string>> = {
  received: 'принят',
  lock_check: 'сверка lock',
  validate: 'валидация',
  resolve_paths: 'резолв путей',
  build_argv: 'сборка argv',
  classify_risk: 'оценка риска',
  approval: 'подтверждение',
  build_env: 'сборка env',
  build_profile: 'профиль песочницы',
  spawn: 'запуск',
  violation: 'нарушение',
  redact: 'редакция',
  complete: 'завершено',
} as const;

/* ── Тиры риска ─────────────────────────────────────────────────────────── */

export const riskRole: Readonly<Record<RiskTier, Role>> = {
  low: 'ok',
  medium: 'warn',
  high: 'danger',
} as const;

export const riskLabel: Readonly<Record<RiskTier, string>> = {
  low: 'низкий',
  medium: 'средний',
  high: 'высокий',
} as const;

/* ── Режимы песочницы ───────────────────────────────────────────────────── */

/**
 * `none` — красный всегда, включая баннер во всю ширину окна. Baseline-режим
 * не должен ни секунды выглядеть как обычная работа.
 */
export const sandboxRole: Readonly<Record<SandboxMode, Role>> = {
  none: 'danger',
  seatbelt: 'ok',
  container: 'info',
} as const;

export const sandboxLabel: Readonly<Record<SandboxMode, string>> = {
  none: 'без песочницы',
  seatbelt: 'seatbelt',
  container: 'контейнер',
} as const;

/* ── Нарушения песочницы ────────────────────────────────────────────────── */

export const violationRole: Readonly<Record<ViolationType, Role>> = {
  network: 'warn',
  'file-read': 'warn',
  'file-write': 'warn',
  /**
   * Попытка записи в persistence-путь (`.git/hooks`, `.zshrc`) — красный.
   * Отбито успешно, но сам факт попытки означает, что запущенный код
   * пытался закрепиться в системе. Это не рутина.
   */
  'mandatory-deny': 'danger',
  process: 'warn',
} as const;

export const violationLabel: Readonly<Record<ViolationType, string>> = {
  network: 'сеть',
  'file-read': 'чтение',
  'file-write': 'запись',
  'mandatory-deny': 'persistence',
  process: 'процесс',
} as const;

/* ── Аннотации MCP ──────────────────────────────────────────────────────── */

export const annotationLabel: Readonly<Record<AnnotationKey, string>> = {
  readOnlyHint: 'только чтение',
  destructiveHint: 'разрушительный',
  idempotentHint: 'идемпотентный',
  openWorldHint: 'внешний мир',
} as const;

/** Роль бейджа зависит от значения: `destructive: true` тревожен, `false` — нет. */
export function annotationRole(key: AnnotationKey, value: boolean): Role {
  switch (key) {
    case 'readOnlyHint':
    case 'idempotentHint':
      return value ? 'ok' : 'muted';
    case 'destructiveHint':
      return value ? 'danger' : 'muted';
    case 'openWorldHint':
      return value ? 'warn' : 'muted';
  }
}

/* ── CSS-переменные для роли ────────────────────────────────────────────── */

/**
 * Роль → пара CSS-переменных. Компоненты не берут цвет напрямую, а спрашивают
 * роль — тогда смена палитры не требует правок в компонентах.
 */
export function roleVars(role: Role): { fg: string; bg: string } {
  if (role === 'muted') {
    return { fg: 'var(--text-tertiary)', bg: 'var(--bg-hover)' };
  }
  return { fg: `var(--state-${role})`, bg: `var(--state-${role}-subtle)` };
}
