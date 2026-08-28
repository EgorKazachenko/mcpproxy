export type CspMode = 'development' | 'production';

/**
 * Режим политики по окружению, **с падением в строгую при отсутствующем значении**.
 *
 * Не по `app.isPackaged`: собранное приложение под смоуком идёт с `isPackaged === false` и
 * получило бы мягкую политику в единственной автоматической проверке, которая вообще
 * поднимает настоящий рендерер.
 */
export function cspModeFrom(nodeEnv: string | undefined): CspMode {
  return nodeEnv === 'development' ? 'development' : 'production';
}

/**
 * Политика для схемы приложения.
 *
 * `script-src 'self'` без nonce: на схеме `app://` инлайновых скриптов нет, и вся возня с
 * одноразовыми токенами не нужна — а `'unsafe-inline'` не появляется ни в одном режиме.
 *
 * `base-uri`, `form-action` и `frame-ancestors` заданы явно, потому что от `default-src` они
 * **не наследуются**: политика с `default-src 'none'` всё ещё позволяет встроить страницу
 * кому угодно.
 *
 * `'unsafe-eval'` не появляется нигде: React с Vite в нём не нуждается, а предупреждение
 * Electron про небезопасную политику завязано ровно на разрешение eval.
 */
export function cspFor(mode: CspMode): string {
  const connect = mode === 'development' ? "connect-src 'self' ws://localhost:*" : "connect-src 'self'";
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    connect,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
