import type {
  ApprovalChannel,
  ApprovalRecord,
  ApprovalRequest,
  ApprovalVerdict,
  RiskTier,
} from '@mcpproxy/contracts';
import { createGrantStore, parseExpiresAt, type GrantStore } from './grants.js';

/**
 * Брокер подтверждений — стадия `approval`. Два канала с **разными ролями** (ADR-0005), а не
 * два взаимозаменяемых способа спросить одно и то же.
 *
 * | Тир | Кто спрашивает | Почему |
 * |---|---|---|
 * | `low` | никто | `07-contracts.md`: automatic |
 * | `medium` | `elicitation`, если канал подключён | мягкий путь, идёт через клиента и модель |
 * | `high` | **только** `electron` | канал не проходит через модель — в этом весь механизм |
 *
 * **`elicitation` на `high` не годится, и это не настройка.** Elicitation идёт через клиента,
 * то есть через тот самый канал, который модель угрозы считает скомпрометированным: это OWASP
 * ASI09 в чистом виде. Поэтому подключённый elicitation-канал `high`-вызов не спасает —
 * брокер его для `high` не смотрит, и на это стоит тест.
 *
 * **Headless — отказ, а не ожидание.** Нет подключённого authoritative-канала — вызов
 * отказан кодом `approval-unavailable`. Отсутствующий канал подтверждения есть отсутствующее
 * подтверждение (`R44`, ADR-0005: «Headless mode defaults to deny»).
 */

/**
 * Порт канала. `null` из `ask` — это **отсутствие вердикта**: окно закрыли, не создалось,
 * истёк срок ожидания. Третьего члена в `ApprovalDecision` нет намеренно, и порт не имеет
 * права синтезировать `denied` вместо молчания там, где различие ещё видно.
 */
export interface ApprovalPort {
  readonly channel: ApprovalChannel;
  ask(request: ApprovalRequest): Promise<ApprovalVerdict | null>;
}

export interface BrokerDeps {
  /** Каналы, подключённые этой установкой. Пустой список — headless. */
  readonly ports: readonly ApprovalPort[];
  readonly grants?: GrantStore;
  readonly clock?: () => Date;
}

/** Коды отказа стадии. Расширяют словарь E4 — разбор `denyReason` остаётся машиночитаемым. */
export const APPROVAL_DENY_CODES = [
  'approval-unavailable',
  'approval-denied',
  'approval-no-verdict',
  'approval-mismatched',
  'approval-expired',
] as const;

export type ApprovalDenyCode = (typeof APPROVAL_DENY_CODES)[number];

export type ApprovalOutcome =
  /**
   * Решения не требовалось. Событие стадии пишется всё равно, но **без** `ApprovalRecord`:
   * вызов, где спрашивать было незачем, отличается от вызова, где спросить забыли, ровно
   * отсутствием записи вердикта внутри пройденной стадии.
   */
  | { readonly kind: 'not_required' }
  | { readonly kind: 'granted'; readonly record: ApprovalRecord; readonly reused: boolean }
  | {
      readonly kind: 'refused';
      readonly code: ApprovalDenyCode;
      readonly reason: string;
      /** Присутствует, только если человек ответил: отказ канала — это запись, отказ из-за молчания — нет. */
      readonly record?: ApprovalRecord;
    };

export interface Broker {
  decide(request: ApprovalRequest, tier: RiskTier): Promise<ApprovalOutcome>;
}

const recordOf = (
  request: ApprovalRequest,
  parts: Pick<ApprovalRecord, 'channel' | 'decision' | 'scope' | 'expiresAt'>,
): ApprovalRecord => ({
  ...parts,
  // Обе части ключа дублируются в запись намеренно: append-only строку читают отдельно от
  // события, и без них она не самодостаточна (ADR-0005).
  argsHash: request.argsHash,
  sessionId: request.sessionId,
});

export function createBroker(deps: BrokerDeps): Broker {
  const clock = deps.clock ?? ((): Date => new Date());
  const grants = deps.grants ?? createGrantStore();

  const portFor = (channel: ApprovalChannel): ApprovalPort | undefined =>
    deps.ports.find((port) => port.channel === channel);

  return {
    async decide(request, tier) {
      if (tier === 'low') return { kind: 'not_required' };

      // `medium` — automatic, если мягкого канала нет. Это не послабление: тир `medium`
      // означает «не только чтение, но и не разрушение и не открытый мир», и `07-contracts.md`
      // назначает ему автоматический пропуск с громкой записью в журнал. Подключённый
      // elicitation даёт человеку право остановить и такой вызов, но не обязан существовать.
      const channel: ApprovalChannel = tier === 'high' ? 'electron' : 'elicitation';
      const port = portFor(channel);
      if (port === undefined) {
        if (tier === 'medium') return { kind: 'not_required' };
        return {
          kind: 'refused',
          code: 'approval-unavailable',
          reason: 'high-risk требует out-of-band подтверждения, authoritative-канал не подключён',
        };
      }

      const now = clock();
      const grant = grants.find(
        { sessionId: request.sessionId, recipeName: request.recipeName, argsHash: request.argsHash },
        now,
      );
      if (grant !== null) {
        return {
          kind: 'granted',
          reused: true,
          record: recordOf(request, {
            // Канал берётся из разрешения, а не из текущего маршрута: запись обязана говорить,
            // чем человека спросили НА САМОМ ДЕЛЕ, а спросили его один раз и раньше.
            channel: grant.channel,
            decision: 'approved',
            scope: grant.scope,
            expiresAt: grant.expiresAt,
          }),
        };
      }

      const verdict = await port.ask(request);
      if (verdict === null) {
        return {
          kind: 'refused',
          code: 'approval-no-verdict',
          reason: 'подтверждение не получено: отсутствие вердикта есть отказ',
        };
      }

      // `R43`: сверяются ОБЕ части ключа. Без `requestId` вердикт из рендерера одобрил бы не
      // тот ожидающий вызов, который человеку показали; без `sessionId` — вызов чужой сессии.
      if (verdict.requestId !== request.requestId || verdict.sessionId !== request.sessionId) {
        return {
          kind: 'refused',
          code: 'approval-mismatched',
          reason: 'вердикт не относится к этому запросу подтверждения',
        };
      }

      const decided = clock();
      const record = recordOf(request, {
        channel: verdict.channel,
        decision: verdict.decision,
        scope: verdict.scope,
        expiresAt: verdict.expiresAt,
      });

      if (verdict.decision === 'denied') {
        return { kind: 'refused', code: 'approval-denied', reason: 'человек отказал в подтверждении', record };
      }

      if (verdict.scope === 'until') {
        const at = parseExpiresAt(verdict.expiresAt);
        // «Разрешено до момента, который уже прошёл» не покрывает и текущий вызов: отказ, а
        // не молчаливое сведение к `once`. Переписать выбор человека в более широкий значило
        // бы записать в журнал не то решение, которое он принял.
        if (at === null || at.getTime() <= decided.getTime()) {
          return { kind: 'refused', code: 'approval-expired', reason: 'срок подтверждения истёк или не разобран', record };
        }
      }

      grants.remember(verdict, request.recipeName, request.argsHash, decided);
      return { kind: 'granted', reused: false, record };
    },
  };
}
