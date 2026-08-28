import type { Tool } from '@mcpproxy/contracts';
import type { CallDenied, CallOk } from '@mcpproxy/mcp-server';

/**
 * E8 — типы корпуса и результатов прогона. См. `docs/09-metrics-and-eval.md`.
 *
 * **Кейс сам объявляет свой оракул.** «Заблокировано» и «атака достигла цели» — разные
 * утверждения, и подменять второе первым нельзя: отказ конвейера считается блоком только
 * тогда, когда цель атаки без этого отказа была бы достигнута. Поэтому у каждого кейса есть
 * `run`, который возвращает `achieved`, а не булево «прошло/не прошло»: иначе корпус мерил
 * бы срабатывание защиты, а не её результат, и ASR перестал бы значить то, что написано в
 * доке.
 */
export type BenchMode = 'none' | 'seatbelt';

export const ATTACK_CLASSES = [
  'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8',
  'A9', 'A10', 'A11', 'A12', 'A13', 'A14', 'A15',
] as const;

export type AttackClass = (typeof ATTACK_CLASSES)[number];

export const UTILITY_CLASSES = ['tests', 'build', 'analysis', 'format'] as const;

export type UtilityClass = (typeof UTILITY_CLASSES)[number];

/** Исход одного вызова рецепта — типизированный, а не разобранный из текста MCP-ответа. */
export type CallOutcome = CallOk | CallDenied;

export interface RunCtx {
  readonly mode: BenchMode;
  /** Каталог демо-репозитория: манифест, скрипты, `logs/`. */
  readonly dir: string;
  /** Подставной `$HOME`: там лежат канарейки `~/.aws`, `~/.ssh`, `~/.zshrc`. */
  readonly home: string;
  readonly socketPath: string;
  readonly token: string;
  readonly auditPath: string;
  call(recipe: string, params?: Readonly<Record<string, unknown>>): Promise<CallOutcome>;
  /** Тот же вызов, но через шим: нужен там, где защита — обёртка `<untrusted-output>`. */
  callWrapped(recipe: string, params?: Readonly<Record<string, unknown>>): Promise<WrappedCall>;
  list(): Promise<readonly Tool[]>;
  /** `host:port` локального слушателя для A9 либо `null`, если слушатель не поднят. */
  readonly listener: string | null;
}

export interface WrappedCall {
  readonly text: string;
  readonly isError: boolean;
}

/** Результат оракула атаки. `achieved` — атака достигла цели, то есть попала в ASR. */
export interface AttackProbe {
  readonly achieved: boolean;
  readonly detail: string;
  readonly denyCode?: string | null;
  readonly note?: string;
  /** Кейс не исполнялся: недоступная зависимость, оффлайн. Правило 2 — молча не усекаем. */
  readonly skipped?: string;
}

export interface AttackCase {
  readonly id: string;
  readonly klass: AttackClass;
  readonly title: string;
  /** Откуда взят класс: CVE, раздел спеки, «baseline». Для слайда «корпус не выдуман». */
  readonly source: string;
  /**
   * Кейс требует собственного демона: он правит манифест или lock, и делать это в общем
   * риге значило бы менять условия у соседей по корпусу.
   */
  readonly fresh?: FreshSpec;
  /** Класс не исполним из bench-процесса. Причина едет в отчёт, а не в тишину. */
  readonly skip?: string;
  run(ctx: RunCtx): Promise<AttackProbe>;
}

export interface FreshSpec {
  /** Правка манифеста ДО первой загрузки: A7 (отравленное `description`). */
  readonly manifest?: (base: string) => string;
  /** Правка на диске ПОСЛЕ старта демона: A6 (rug pull между вызовами). */
  readonly after?: (ctx: RunCtx) => Promise<void> | void;
}

export interface UtilityProbe {
  readonly ok: boolean;
  readonly detail: string;
  readonly denyCode?: string | null;
  readonly skipped?: string;
}

export interface UtilityCase {
  readonly id: string;
  readonly klass: UtilityClass;
  readonly title: string;
  /** Рецепт и параметры прямого вызова — нужны для замера оверхеда «относительно прямого». */
  readonly direct?: { readonly argv: readonly string[] };
  run(ctx: RunCtx): Promise<UtilityProbe>;
}

export type CaseStatus =
  | 'blocked'
  | 'achieved'
  | 'completed'
  | 'false-block'
  | 'skipped'
  | 'error';

export interface CaseResult {
  readonly id: string;
  readonly kind: 'attack' | 'utility';
  readonly klass: string;
  readonly title: string;
  readonly mode: BenchMode;
  readonly status: CaseStatus;
  readonly denyCode: string | null;
  readonly detail: string;
  readonly durationMs: number;
  readonly note?: string;
}
