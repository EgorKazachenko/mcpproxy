import type { AuditEvent, Stage } from '@mcpproxy/contracts';
import type { StreamOutcome } from './sandbox.js';

/**
 * События стадий E3.
 *
 * Стадий ровно **четыре** — `build_env`, `build_profile`, `spawn`, `violation` — и ни одной
 * больше: `redact` принадлежит E6 по решению D4, `complete` пишет тот, кто закрывает вызов
 * (E4). Событие пишется на **каждой** из них, включая отказ: «отказ без записи в аудит —
 * баг, а не оптимизация» (`07-contracts.md:365`).
 */

/**
 * Подмножество замороженного `AuditEvent`, которое заполняет E3, — именно `Pick`, а не
 * своя форма. Тогда компилятор, а не ревью, держит совпадение: поле, переименованное в
 * контракте, ломает сборку здесь, а `exactOptionalPropertyTypes` исполняет R34 —
 * `{ signal?: string }` не принимает `undefined` как значение, и «отсутствует ключом» с
 * «приехало с null» перестают быть взаимозаменяемы на уровне типов.
 *
 * Остальные поля вписывает E4: у него есть `traceId`, `sessionId` и вердикт, которых E3 не
 * знает и знать не должен.
 */
export type ExecEvent = Pick<AuditEvent, 'stage' | 'durationUs' | 'env' | 'sandbox'>;

/** Стадии E3, перечисленные явно — компилятор проверит, что каждая из них есть в `Stage`. */
export const EXEC_STAGES = ['build_env', 'build_profile', 'spawn', 'violation'] as const satisfies readonly Stage[];

export type ExecStage = (typeof EXEC_STAGES)[number];

export type EventSink = (event: ExecEvent) => void;

/**
 * Монотонная длительность стадии в **микросекундах целым числом** (R35).
 *
 * Разность ISO-меток не годится: она квантована до миллисекунды — то есть до порядка самого
 * измерения — и вдобавок прыгает по NTP. `process.hrtime.bigint()` не делает ни того ни
 * другого.
 */
export function measure<T>(body: () => T): { value: T; durationUs: number } {
  const started = process.hrtime.bigint();
  const value = body();
  const durationUs = Number((process.hrtime.bigint() - started) / 1_000n);
  return { value, durationUs };
}

export async function measureAsync<T>(body: () => Promise<T>): Promise<{ value: T; durationUs: number }> {
  const started = process.hrtime.bigint();
  const value = await body();
  const durationUs = Number((process.hrtime.bigint() - started) / 1_000n);
  return { value, durationUs };
}

/**
 * Схлопывание двух потоков в одну пару события (R20). `AuditEvent.output`
 * (`event.ts:100`) несёт одну пару `{bytes, truncated}`, а потоков два: `bytes` — **сумма**,
 * `truncated` — **дизъюнкция**.
 *
 * Иначе событие сообщало бы про stdout и молчало про stderr — а секрет, вылезший за потолок,
 * с равной вероятностью вылезает во второй поток.
 */
export function collapseOutput(
  stdout: StreamOutcome,
  stderr: StreamOutcome,
): { readonly bytes: number; readonly truncated: boolean } {
  return { bytes: stdout.bytes + stderr.bytes, truncated: stdout.truncated || stderr.truncated };
}

/**
 * Порядок появления полей (R33): поле не приезжает раньше своей стадии.
 *
 * `sandbox.mode` — вынужденное исключение, и оно не наше: в замороженном типе `mode`
 * **обязателен всегда, когда присутствует `sandbox`** (`event.ts:92-93`), поэтому событие с
 * `sandbox.profile` обязано нести и `mode`. Таблица в комментарии `event.ts` относит `mode`
 * к `spawn`, но комментарий проигрывает типу, а режим на `build_profile` уже известен — его
 * выбрал вызывающий (R4).
 */
export const FIELD_FIRST_STAGE: Readonly<Record<'env' | 'profile' | 'violations', ExecStage>> = {
  env: 'build_env',
  profile: 'build_profile',
  violations: 'violation',
};
