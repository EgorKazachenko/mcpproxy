import { createHash } from 'node:crypto';
import type { AuditEvent, ChainedEvent } from '../event.js';
import { canonicalizeJcs } from '../jcs.js';

/**
 * Хэш-цепочка аудита.
 *
 * **Формула замораживается явно** — «хэшировать аргумент целиком» её не задаёт:
 *
 *     self = sha256(utf8(canonicalizeJcs({ prev, event })))
 *
 * Ссылка на предыдущую запись входит **внутрь** каноничной формы, поэтому исключать из
 * события ничего не нужно. Без этого возможна реализация `sha256(jcs(event))`, где цепочки
 * нет вовсе, каждая запись самостоятельна, и тезис `docs/02-architecture.md` («изменение
 * любой прошлой записи ломает все последующие») ложен — при этом тест на порчу записи 3
 * всё ещё проходит.
 *
 * **Кодировка дайджеста заморожена и действует для всех трёх формул пакета** (`self`,
 * `argsHash`, `recipeHash`/`manifestHash`): строчный hex, ровно 64 символа, **без префикса
 * `sha256:`**. Префикс, который показывает `docs/07-contracts.md`, — приём отображения.
 * Для цепочки это не косметика: `prev` хэшируется внутри каноничной формы, поэтому
 * `{prev: "sha256:ab…"}` и `{prev: "ab…"}` — разные дайджесты, и два эпика, выбравшие
 * по-разному, дают вечно красный бейдж без единого бага.
 */

export const DIGEST_HEX_LENGTH = 64;

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Аргумент типизирован как «событие, у которого поля `chain` нет». Запрет держит
 * **компилятор**, а не дисциплина: TypeScript структурен, `ChainedEvent` присваивается к
 * `AuditEvent`, и хэширование самоссылочного `chain.self` иначе компилировалось бы молча.
 */
export function chainHash(event: AuditEvent & { chain?: never }, prevHash: string | null): string {
  return sha256Hex(canonicalizeJcs({ prev: prevHash, event }));
}

/** Возвращает **новый** объект без ключа `chain`: `(e) => e` типизировался бы идеально и не удалял бы ничего. */
export function unchain(event: ChainedEvent): AuditEvent {
  const { chain: _chain, ...rest } = event;
  return rest;
}

export type ChainVerification = { ok: true } | { ok: false; brokenAt: number };

/**
 * Проверка цепочки. Возвращает индекс первой разошедшейся записи.
 *
 * Форма возврата — размеченная, как у `ParseManifestResult`: `number | null` сделал бы `0`
 * ложным, то есть подделка **первой** записи прошла бы и через `if (!verify(...))`, и через
 * `if (verify(...))`.
 *
 * **Замораживается предикат, а не только дайджест.** `brokenAt: i` — первый `i`, на котором
 * нарушено любое из двух:
 *
 *     i === 0 ? e.chain.prev === null : e.chain.prev === events[i-1].chain.self
 *     chainHash(unchain(e), e.chain.prev) === e.chain.self
 *
 * Без второй строки возможна реализация «самосогласованности», проверяющая каждую запись в
 * одиночку. Она даёт ноль доказательной силы: формула публична, атакующий правит запись и
 * пересчитывает её `self`, взяв `prev` из неё же.
 *
 * Обрезание **хвоста** лога этим предикатом не ловится — для этого нужен внешний якорь.
 * Это записано в честные границы, а не выдаётся за покрытое.
 */
export function verifyChain(events: readonly ChainedEvent[]): ChainVerification {
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event === undefined) return { ok: false, brokenAt: i };

    const expectedPrev = i === 0 ? null : (events[i - 1]?.chain.self ?? null);
    if (event.chain.prev !== expectedPrev) return { ok: false, brokenAt: i };

    if (chainHash(unchain(event), event.chain.prev) !== event.chain.self) return { ok: false, brokenAt: i };
  }
  return { ok: true };
}
