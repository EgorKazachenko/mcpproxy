import { canonicalizeJcs } from '../jcs.js';
import { sha256Hex } from './chain.js';

/**
 * Третий дайджест границы доверия. Кодировка та же: строчный hex, 64 символа, без префикса.
 *
 *     argsHash = sha256(utf8(canonicalizeJcs({ recipeName, params })))
 *
 * `params` — значения **после** валидации и резолва путей, поэтому `{file: "./logs/a.log"}`
 * и `{file: "/…/logs/a.log"}` — один и тот же вызов. Незаданные необязательные параметры
 * **отсутствуют как ключи**, а не приезжают со значением `undefined`: JCS их различает.
 *
 * `recipeName` входит в дайджест, иначе скоуп `recipe_and_args` переносится между рецептами
 * с совпадающим набором аргументов.
 *
 * В корневом входе живёт только строковое **поле** `argsHash` внутри `ApprovalRecord`:
 * функция требует `node:crypto` и потому лежит здесь.
 */
export const argsHash = (recipeName: string, params: Readonly<Record<string, unknown>>): string =>
  sha256Hex(canonicalizeJcs({ recipeName, params }));
