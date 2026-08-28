/**
 * Коды отказа на границе IPC.
 *
 * Закрытый союз, а не `string`: каждый дискриминатор в контрактах закрыт, и это делает
 * возможным исчерпывающий разбор и тест на опечатку в литерале. Четыре причины отказа
 * отправителю — четыре независимые атаки, и сваливать их в один код значит лишить тест
 * возможности сказать, какая именно проверка сработала.
 */
export type UiErrorCode =
  | 'sender-absent'
  | 'sender-detached'
  | 'sender-subframe'
  | 'sender-origin'
  | 'bad-payload';

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: UiErrorCode; readonly message: string } };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const denied = <T>(code: UiErrorCode, message: string): Result<T> => ({
  ok: false,
  error: { code, message },
});
