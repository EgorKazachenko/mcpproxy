/**
 * Сборка окружения дочернего процесса. Чистая: `base` не мутируется.
 *
 * Мутировать его нельзя не из вкуса — `wrapWithSandboxArgv` возвращает `env`,
 * **тождественно равный** `process.env` (факт Ф7 пробы П1), и запись в него испортила бы
 * окружение самого демона.
 */

/**
 * Минимальный `PATH`. Именованная константа, а не наследование, потому что правило
 * приоритета обязано быть одно на обе ветки (R23): `PATH` из `env.allow` **не**
 * наследуется от демона — константа побеждает всегда.
 *
 * Иначе `env.allow: ["PATH"]` тихо отдавал бы ребёнку путь поиска демона — то есть рецепт,
 * назвавший переменную ради переносимости, получал бы каталоги с чужими бинарями, а рецепт,
 * не назвавший ничего, — нет. Одно и то же имя значило бы разное.
 */
export const MINIMAL_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/**
 * `allow` — имена из `effective.env.allow`; `base` — окружение демона; `injected` —
 * переменные, которые добавляет **режим**.
 *
 * Третий параметр существует потому, что два режима устроены по-разному, и без него
 * фильтр противоречил бы сам себе: в `seatbelt` прокси-переменные вшиты srt в саму строку
 * команды (факт Ф7), значит `injected` пуст; в `none` seatbelt-обёртки нет вовсе, и
 * прокси-переменные вместе с переменными доверия к CA обязан передать режим (D2, R31).
 *
 * `injected` проходит **мимо** `allow` намеренно: это не переменные рецепта, а механика
 * песочницы, и провести их через allowlist значило бы дать манифесту право отключить
 * наблюдение за собственной сетью.
 */
export function buildEnv(
  allow: readonly string[],
  base: NodeJS.ProcessEnv,
  injected: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const name of allow) {
    // `PATH` не наследуется никогда — см. `MINIMAL_PATH`.
    if (name === 'PATH') continue;
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }

  env['PATH'] = MINIMAL_PATH;

  for (const [name, value] of Object.entries(injected)) {
    if (value !== undefined) env[name] = value;
  }

  return env;
}
