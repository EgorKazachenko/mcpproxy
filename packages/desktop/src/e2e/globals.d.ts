/**
 * Что видит страница.
 *
 * Формы описаны здесь минимально, а не импортом из общего слоя: `rootDir` этого проекта —
 * `src/e2e`, и импорт наружу вывел бы файл за его границы. Смоук проверяет наблюдаемое
 * поведение, и подробные типы ему не нужны.
 */
interface Window {
  readonly mcpproxy: {
    readonly send: (request: unknown) => Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string } }>;
    readonly onEvent: (listener: (event: unknown) => void) => () => void;
  };
  readonly __mcpproxyObserve?: { readonly sandboxed: boolean; readonly contextIsolated: boolean };
}
