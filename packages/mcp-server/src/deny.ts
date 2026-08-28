import { DENIAL_CODES, type DenialCode } from '@mcpproxy/core';
import type { AuditLogErrorCode } from '@mcpproxy/core/audit';
import type { ExecErrorCode, LockDenyCode } from '@mcpproxy/core';
import type { Verdict } from '@mcpproxy/contracts';

/**
 * Единственный носитель машиночитаемого кода отказа — `AuditEvent.denyReason`.
 *
 * Замороженное событие не имеет типизированного поля под код: есть только
 * `denyReason?: string | null`. При этом до E4 доехали ЧЕТЫРЕ непересекающихся словаря —
 * шесть кодов lock из E1, шестнадцать отказов валидации из E2, девять кодов `ExecError` из
 * E3 и пять кодов журнала из E6, — плюс собственный словарь E4. Если E4 отрендерит одну
 * человеческую прозу, машиночитаемость отказа кончится на границе лога: журнал append-only,
 * и разобрать запись обратно будет нечем.
 *
 * Поэтому формат фиксируется здесь: `<code>: <текст>`. Код — первый токен до двоеточия,
 * дословно из своего словаря; текст — то, что читает человек. Обратный разбор проверяется
 * тестом, а непересечение словарей — исчерпывающими `Record`-ами ниже, которые краснеют,
 * если сосед добавит себе код.
 */
export const E4_DENY_CODES = [
  'unknown-recipe',
  'recipe-unprepared',
  'binary-unresolved',
  'binary-not-allowed',
  'approval-unavailable',
  'audit-unavailable',
  'bad-request',
] as const;

export type E4DenyCode = (typeof E4_DENY_CODES)[number];

export type DenyCode = LockDenyCode | DenialCode | ExecErrorCode | AuditLogErrorCode | E4DenyCode;

/**
 * Исчерпывающие свидетели словарей соседей. Смысл именно в типе `Record<Union, true>`: он
 * не «список, который надо не забыть дополнить», а утверждение, проверяемое компилятором.
 * Сосед, добавивший себе код, красит эти литералы, а не молча проносит код мимо разбора.
 */
const LOCK_DENY_CODES: Record<LockDenyCode, true> = {
  'lock-absent': true,
  'lock-unreadable': true,
  'lock-too-large': true,
  'lock-unparsed': true,
  'lock-tampered': true,
  'lock-drifted': true,
};

const EXEC_ERROR_CODES: Record<ExecErrorCode, true> = {
  'mode-unsupported': true,
  'invalid-domain': true,
  disposed: true,
  poisoned: true,
  'group-not-drained': true,
  'proxy-down': true,
  'wildcard-dropped': true,
  'spawn-failed': true,
  'srt-uninitialized': true,
};

const AUDIT_LOG_ERROR_CODES: Record<AuditLogErrorCode, true> = {
  corrupt: true,
  closed: true,
  'already-open': true,
  'short-write': true,
  'insecure-directory': true,
};

export const ALL_DENY_CODES: readonly DenyCode[] = [
  ...Object.keys(LOCK_DENY_CODES),
  ...DENIAL_CODES,
  ...Object.keys(EXEC_ERROR_CODES),
  ...Object.keys(AUDIT_LOG_ERROR_CODES),
  ...E4_DENY_CODES,
] as readonly DenyCode[];

const SEPARATOR = ': ';

/** Текст переносится как есть: он уже санитизирован своим эпиком и значения не содержит (R25 E2). */
export function denyReason(code: DenyCode, text: string): string {
  return `${code}${SEPARATOR}${text}`;
}

export interface ParsedDenyReason {
  readonly code: DenyCode;
  readonly text: string;
}

/**
 * Разбор обратно. `null` — не «пустой отказ», а «строка не в формате»: читатель лога обязан
 * различать запись, сделанную до фиксации формата, и запись с неизвестным кодом.
 */
export function parseDenyReason(reason: string): ParsedDenyReason | null {
  const at = reason.indexOf(SEPARATOR);
  if (at <= 0) return null;
  const code = reason.slice(0, at);
  if (!(ALL_DENY_CODES as readonly string[]).includes(code)) return null;
  return { code: code as DenyCode, text: reason.slice(at + SEPARATOR.length) };
}

/**
 * `ExecError.code` → `Verdict`. Развилка нужна ровно потому, что E3 бросает, а `Verdict` —
 * юнион из четырёх значений: без явного отображения безопасным дефолтом стал бы `error`, и
 * вызов, **заблокированный политикой**, лёг бы в лог как сбой прокси. Это прямо запрещено
 * решением D6 эпика E3: «отказ политики — штатный исход решения, а не сбой».
 *
 * `invalid-domain` — единственный код политики: домен, который не принимает валидатор, есть
 * решение о рецепте. Остальные восемь описывают состояние прокси и демона, а не рецепта.
 */
export function verdictOfExecError(code: ExecErrorCode): Extract<Verdict, 'denied' | 'error'> {
  return code === 'invalid-domain' ? 'denied' : 'error';
}

/**
 * Коды, после которых демон больше не выдаёт вызовов. Отравленный синглтон терминален: у
 * группы процессов не подтверждён слив, и следующий вызов получил бы чужие нарушения в
 * атрибуцию. Различается по коду, а не по тексту сообщения.
 */
export function isExecCode(code: DenyCode): code is ExecErrorCode {
  return Object.hasOwn(EXEC_ERROR_CODES, code);
}

export function isTerminal(code: ExecErrorCode): boolean {
  return code === 'poisoned' || code === 'group-not-drained';
}
