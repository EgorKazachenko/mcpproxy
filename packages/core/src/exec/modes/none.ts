import {
  encodeSandboxedCommand,
  generateProxyEnvVars,
} from '@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js';
import type { SandboxMode } from '@mcpproxy/contracts';
import { srt } from '../srt-manager.js';
import type { ExecRequest, Sandbox } from '../sandbox.js';
import { onceDispose, runInMode } from './seatbelt.js';
import type { ModeBehaviour } from './seatbelt.js';

/**
 * Режим `none` — **наблюдающий baseline**, а не слепой (D2).
 *
 * Прокси тот же, из `srt-manager.ts`, и стор нарушений с семафором общие: положив жизненный
 * цикл в `seatbelt`, мы оставили бы `none` без атрибуции. Seatbelt-обёртки здесь нет вовсе,
 * поэтому переменные, которые в `seatbelt` srt вшивает прямо в строку команды, обязан
 * передать сам режим — и их **две группы**, а не одна.
 */

const MODE: SandboxMode = 'none';

/**
 * Глубокий импорт из `dist/sandbox/sandbox-utils.js`: наружу пакет отдаёт девятнадцать
 * строк деклараций, и `generateProxyEnvVars` среди них нет. Выбор — импорт, а не копия
 * списка: у research-preview с версией в день копия разъезжается молча, а импорт превращает
 * обновление вендора в ошибку типизации. Путь неподдерживаемый, и это записано в границах.
 *
 * Одним вызовом покрываются обе группы (R31):
 * 1. прокси — порт, токен и имя пользователя `srt.<base64(commandId)>`;
 * 2. **доверие к CA** — путь к бандлу, разложенный по переменным трастовых хранилищ.
 *
 * Вторая группа обязательна из-за D12: с включённым `tlsTerminate` и без неё любой HTTPS
 * падает с ошибкой сертификата — то есть baseline ломается как **сетевая ошибка**,
 * неотличимая в таймлайне от «песочница заблокировала». Это худший вид отказа из возможных.
 *
 * Путь трастового бандла, а не голого сертификата CA: почти все переменные из `CA_TRUST_VARS`
 * **заменяют** хранилище инструмента, а не дополняют его, и указав их на один наш CA, мы
 * лишили бы ребёнка возможности проверить хоть один настоящий сертификат.
 */
export function proxyEnvFor(request: ExecRequest): NodeJS.ProcessEnv {
  const vars = generateProxyEnvVars(
    srt.proxyPort(),
    srt.socksPort(),
    srt.caTrustBundlePath(),
    srt.proxyToken(),
    // `skipTmpdir`: файловой политики в этом режиме нет, значит хостовый TMPDIR уже
    // записываем, а `/tmp/claude` может не существовать вовсе.
    true,
    encodeSandboxedCommand(request.commandId),
  );

  return parseEnvPairs(vars);
}

/** `NAME=VALUE` → объект. Делим по ПЕРВОМУ `=`: значение прокси-URL содержит свои. */
export function parseEnvPairs(pairs: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    env[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return env;
}

export function createNoneSandbox(): Sandbox {
  srt.retain();
  const behaviour: ModeBehaviour = {
    mode: MODE,
    injectedEnv: proxyEnvFor,
    /**
     * Пока `none` держит семафор, его allowlist — `*`. Сети остальным это не открывает,
     * потому что потолок семафора равен единице (R21), и именно это делает `evil.io` из S5
     * достижимым в baseline: нарушение пишется с `action: 'allowed'` и реальным числом байт,
     * то есть эксфильтрация **видна**, а не заблокирована.
     */
    networkPolicy: () => ({ allowedDomains: ['*'], deniedDomains: [] }),
    /**
     * Команда идёт как есть: seatbelt-профиля нет вовсе. Если бы `none` начал применять
     * профиль, baseline перестал бы быть baseline — сравнивать «до» и «после» стало бы не с
     * чем, а вся левая половина таблицы S5 держится ровно на этом сравнении.
     */
    toArgv: (request) => Promise.resolve(request.command),
  };

  return {
    mode: MODE,
    run: (request, onViolation, onEvent) => runInMode(behaviour, request, onViolation, onEvent),
    dispose: onceDispose(),
  };
}
