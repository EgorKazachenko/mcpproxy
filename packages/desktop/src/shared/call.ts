import { stageOrder, type ChainedEvent, type Stage, type Verdict } from '@mcpproxy/contracts';

/**
 * Вызов, свёрнутый из событий.
 *
 * `AuditEvent` описывает **одну стадию**: он несёт один `stage`, одну длительность стадии и
 * собирается в вызов только по `traceId`. Пока такой свёртки нет, ни «худший исход в группе»,
 * ни «каких стадий не было», ни «команда не собиралась» вычислить не из чего — все три
 * свойства вызова, а не события.
 */
export interface Call {
  readonly traceId: string;
  readonly toolName: string;
  readonly startedAt: string;
  readonly verdict: Verdict;
  readonly stages: readonly ChainedEvent[];
  readonly reached: ReadonlySet<Stage>;
  readonly open: boolean;
}

const POSITION = new Map<Stage, number>(stageOrder.map((stage, index) => [stage, index]));

/** Позиция стадии в замороженном порядке; неизвестная уезжает в конец, а не роняет свёртку. */
const positionOf = (event: ChainedEvent): number => POSITION.get(event.stage) ?? stageOrder.length;

/** Вердикты, после которых вызов уже никуда не идёт. */
const TERMINAL: ReadonlySet<Verdict> = new Set<Verdict>(['denied', 'error']);

/**
 * Свёртка событий в вызовы по `traceId`.
 *
 * Правила заданы явно, иначе четыре поля из семи остались бы на усмотрение реализующего:
 *
 * - `stages` **сортируются** по позиции в `stageOrder`, при равенстве — по времени начала.
 *   Хранить «как пришло» нельзя: проигрыватель отдаёт события по одному, порядок прихода не
 *   гарантирован, а панель деталей требует стадии по порядку. Повторы `violation`
 *   сохраняются — схлопывание потеряло бы контраст сценария S5.
 * - `verdict` берётся из **последнего** события по тому же порядку: вердикт вызова это его
 *   исход, а не вердикт промежуточной стадии.
 * - `open` истинно, пока вызов не завершён **и** не отказан. Вызов, остановленный на
 *   `validate`, до `complete` не доходит никогда, и правило «нет `complete` — значит открыт»
 *   держало бы его в списке ждущих вечно. Ожидание подтверждения остаётся открытым: оно
 *   действительно ждёт.
 * - Вызовы сортируются по времени начала убыванием — свежие сверху.
 */
export function foldCalls(events: readonly ChainedEvent[]): readonly Call[] {
  const byTrace = new Map<string, ChainedEvent[]>();
  for (const event of events) {
    const bucket = byTrace.get(event.traceId);
    if (bucket === undefined) byTrace.set(event.traceId, [event]);
    else bucket.push(event);
  }

  const calls: Call[] = [];
  for (const [traceId, bucket] of byTrace) {
    const stages = [...bucket].sort(
      (a, b) => positionOf(a) - positionOf(b) || a.startTime.localeCompare(b.startTime),
    );
    const reached = new Set<Stage>(stages.map((event) => event.stage));
    const last = stages[stages.length - 1];
    const first = stages.find((event) => event.stage === 'received') ?? stages[0];
    if (last === undefined || first === undefined) continue;

    calls.push({
      traceId,
      toolName: last.toolName,
      startedAt: first.startTime,
      verdict: last.verdict,
      stages,
      reached,
      open: !reached.has('complete') && !TERMINAL.has(last.verdict),
    });
  }

  return calls.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
