import type { ApprovalChannel, ApprovalScope, ApprovalVerdict, RecipeName, SessionId } from '@mcpproxy/contracts';

/**
 * Хранилище выданных разрешений — то, из-за чего человека не спрашивают второй раз.
 *
 * **Ключ — тройка `(sessionId, recipeName, argsHash)`, и все три части обязательны.**
 * ADR-0005 говорит об этом прямо: без `sessionId` подтверждение со скоупом `until` или
 * `recipe_and_args` ключуется только по `(recipeName, argsHash)` и оказывается неявно
 * действительным во всех сессиях — включая ту, которую человеку никогда не показывали.
 * `argsHash` считается по значениям ПОСЛЕ валидации и резолва (`contracts/audit/args.ts`),
 * поэтому `./logs/a.log` и `/abs/logs/a.log` — один вызов, а `rm /tmp` и `rm /` — разные.
 *
 * **Отказы не запоминаются.** Кэш «нет» выглядит симметрично, но им он не является:
 * `ApprovalDecision` не имеет третьего члена именно потому, что отсутствие вердикта — это
 * отсутствие разрешения. Запомненный отказ добавил бы состояние, из которого вызов нельзя
 * переспросить, а переспросить дёшево: модалка и так поднимается.
 */

/** Скоупы, которые вообще переживают вызов. `once` в это множество не входит по определению. */
export type GrantScope = Extract<ApprovalScope, 'until' | 'recipe_and_args'>;

export interface Grant {
  readonly channel: ApprovalChannel;
  readonly scope: GrantScope;
  /** Абсолютное ISO-время, а не TTL (ADR-0005). `null` допустим только у `recipe_and_args`. */
  readonly expiresAt: string | null;
}

export interface GrantKey {
  readonly sessionId: SessionId;
  readonly recipeName: RecipeName;
  readonly argsHash: string;
}

export interface GrantStore {
  /** Действующее разрешение или `null`. Истёкшее — это `null`, а не `Grant` с прошедшим сроком. */
  find(key: GrantKey, now: Date): Grant | null;
  /** `false` — вердикт не создаёт разрешения (`once`, отказ, негодный срок). */
  remember(verdict: ApprovalVerdict, recipeName: RecipeName, argsHash: string, now: Date): boolean;
  /** Только для тестов и диагностики: сколько живых разрешений держится. */
  size(now: Date): number;
}

/**
 * Разделитель — NUL. Он невыразим ни в `RECIPE_NAME_PATTERN`, ни в hex-дайджесте, ни в
 * `sessionId`, который приезжает из сокета внутри JSON-строки. Взяв обычный `:`, я получил бы
 * склейку, в которой `a:b` + `c` и `a` + `b:c` дают один ключ, то есть чужое разрешение.
 */
const keyOf = (key: GrantKey): string => [key.sessionId, key.recipeName, key.argsHash].join('\u0000');

/**
 * Форма `expiresAt` — ISO-8601 с обязательным смещением. Дата без зоны означала бы «в
 * локальной зоне читателя», а append-only запись читают на другой машине.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Разбор `expiresAt`. Возвращает `null` на всём, что не является абсолютным моментом
 * времени.
 *
 * **Разбор строгий по форме, а не «что примет `Date`».** Замерено: `new Date('600')` — не
 * ошибка, а полночь 600 года; `new Date('10')` — 2001-й. То есть относительный TTL, случайно
 * доехавший сюда строкой, разобрался бы в момент времени и — будучи прошедшим — молча
 * обнулил бы подтверждение либо, при другом числе, продлил бы его на века. Ни один из двух
 * исходов не является тем, что выбрал человек.
 */
export function parseExpiresAt(value: string | null): Date | null {
  if (value === null || !ISO_INSTANT.test(value)) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

export function isLive(grant: Grant, now: Date): boolean {
  if (grant.expiresAt === null) return grant.scope === 'recipe_and_args';
  const at = parseExpiresAt(grant.expiresAt);
  return at !== null && at.getTime() > now.getTime();
}

export function createGrantStore(): GrantStore {
  const grants = new Map<string, Grant>();

  return {
    find(key, now) {
      const id = keyOf(key);
      const grant = grants.get(id);
      if (grant === undefined) return null;
      if (!isLive(grant, now)) {
        // Истёкшее удаляется на чтении, а не по таймеру: таймер — это второй источник
        // времени, который может не сработать, а разрешение обязано кончиться само.
        grants.delete(id);
        return null;
      }
      return grant;
    },

    remember(verdict, recipeName, argsHash, now) {
      if (verdict.decision !== 'approved') return false;
      if (verdict.scope === 'once') return false;

      if (verdict.scope === 'until') {
        const at = parseExpiresAt(verdict.expiresAt);
        // «Разрешено до момента, который уже прошёл» не покрывает даже этот вызов. Решение
        // о самом вызове принимает брокер; здесь — только про то, что запоминать нечего.
        if (at === null || at.getTime() <= now.getTime()) return false;
      }

      const grant: Grant = {
        channel: verdict.channel,
        scope: verdict.scope,
        // `recipe_and_args` со сроком остаётся со сроком: человек сузил, и сужение уважается.
        expiresAt: verdict.expiresAt,
      };
      grants.set(keyOf({ sessionId: verdict.sessionId, recipeName, argsHash }), grant);
      return true;
    },

    size(now) {
      let live = 0;
      for (const [id, grant] of grants) {
        if (isLive(grant, now)) live += 1;
        else grants.delete(id);
      }
      return live;
    },
  };
}
