import { RECIPE_NAME_PATTERN, RESERVED_RECIPE_NAMES } from '../ipc.js';
import { canonicalizeJcs } from '../jcs.js';
import type { LockEntry, LockFile, NormalizedDefaults, NormalizedRecipe } from '../lock.js';
import { sanitizeDescription } from '../tool.js';
import type { Diagnostic } from '../types.js';

/**
 * Разбор `mcpproxy.lock`.
 *
 * Существует потому, что до него единственной формой, пересекавшей границу процесса без
 * проверки, был именно lock: манифест получил файл схемы, `parseManifest` и диагностики с
 * координатами, а lock — только TS-интерфейс. Потребитель неизбежно написал бы
 * `JSON.parse(text) as LockFile` и подал бы результат прямо в `diffLock`, который
 * разыменовывает `entry.snapshot` и `lock.defaults` на веру: файл прежней формы давал не
 * диагностику и не `absent`, а **необработанное исключение на стадии `lock_check`** — то есть
 * на самом пути принятия решения.
 *
 * Проверка НЕ ограничивается структурой, и это существенно. Единственная бросающая операция
 * внутри `diffLock` — `canonicalizeJcs`, а у неё пять оснований для `TypeError`: нефинитное
 * число, одиночный суррогат, не-plain-объект, значение неcериализуемого типа и вложенность
 * глубже `JCS_MAX_DEPTH`. Ни одно из них не исключается проверкой «поле на месте и это
 * объект»: замер на первой версии этого файла показал четыре крафтовых lock, которые парсер
 * принимал, а `diffLock` ронял. Поэтому обе стороны, которые `diffLock` подаёт в канонизатор
 * — `defaults` и каждый `snapshot.own`, — прогоняются здесь заранее. Ветка `defaults` важнее:
 * `sameDefaults` вызывается на каждом `diffLock` безусловно. Тем же проходом закрывается
 * `verifyLockEntries`: `recipeHash` канонизирует тот же `own`.
 *
 * «Прошло парсер» означает «`diffLock` и `verifyLockEntries` не бросят», а не «поля на месте».
 *
 * Сверка дайджестов — не здесь: она в `verifyLockEntries` из `./audit`, потому что требует
 * `node:crypto`.
 *
 * Отказ здесь читается вызывающим как `absent`, а не как «продолжай»: не разобрали lock —
 * значит одобрения нет, значит рецепт идёт на повторный апрув. Fail-closed.
 */

export type ParseLockResult =
  | { ok: true; lock: LockFile }
  | { ok: false; diagnostics: Diagnostic[] };

/** Форма lock-файла этой ревизии контракта. Разъехалась с `LockFile` — красный тест. */
const LOCK_VERSION = 2;

const HEX64 = /^[0-9a-f]{64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Координат у lock нет: он машинный, его никто не пишет руками. Указатель есть, он и важен. */
const at = (pointer: string, message: string): Diagnostic =>
  // Санитизация по той же причине, что и у диагностик манифеста: `JSON.parse` в V8 эхоит
  // фрагмент разбираемого файла в текст ошибки, а lock — тоже файл с диска.
  ({ pointer, line: 1, column: 1, code: 'lock', message: sanitizeDescription(message).text });

/**
 * Значение переживёт `canonicalizeJcs` — то есть `diffLock` на нём не бросит.
 * Возвращает причину отказа, а не булев: она едет в диагностику.
 */
function canonicalizable(value: unknown): string | null {
  try {
    canonicalizeJcs(value);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function checkEntry(name: string, value: unknown, report: (pointer: string, message: string) => void): void {
  const pointer = `tools.${name}`;
  // Имя записи проверяется той же парой, что и `asRecipeName`: иначе lock несёт имя, которое
  // загрузчик манифеста отвергает, `diffLock` кладёт его в `removed`, и человеку показывают
  // «удалён рецепт `__proto__`», которого никогда не существовало.
  if (!RECIPE_NAME_PATTERN.test(name) || (RESERVED_RECIPE_NAMES as readonly string[]).includes(name)) {
    report(pointer, `не имя рецепта: ${name}`);
  }
  if (!isRecord(value)) {
    report(pointer, 'запись lock обязана быть объектом');
    return;
  }
  if (typeof value.recipeHash !== 'string' || !HEX64.test(value.recipeHash)) {
    report(`${pointer}.recipeHash`, 'recipeHash обязан быть 64 строчными hex без префикса');
  }
  if (typeof value.approvedAt !== 'string') report(`${pointer}.approvedAt`, 'approvedAt обязан быть строкой');
  // Снапшот — то, из чего строится сторона «было». Без него `diffLock` падает, а не диффит.
  if (!isRecord(value.snapshot)) {
    report(`${pointer}.snapshot`, 'снапшот обязателен: без него сторону «было» для диффа строить не из чего');
    return;
  }
  if (!isRecord(value.snapshot.own)) {
    report(`${pointer}.snapshot.own`, 'снапшот обязан нести собственный блок рецепта');
  } else {
    const reason = canonicalizable(value.snapshot.own);
    if (reason !== null) report(`${pointer}.snapshot.own`, `собственный блок не канонизируется: ${reason}`);
  }
  if (!isRecord(value.snapshot.effective)) {
    report(`${pointer}.snapshot.effective`, 'снапшот обязан нести эффективный профиль');
  }
}

export function parseLockFile(text: string): ParseLockResult {
  const diagnostics: Diagnostic[] = [];
  const report = (pointer: string, message: string) => diagnostics.push(at(pointer, message));

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { ok: false, diagnostics: [at('', `lock не разобран как JSON: ${error instanceof Error ? error.message : String(error)}`)] };
  }

  if (!isRecord(data)) return { ok: false, diagnostics: [at('', 'lock обязан быть объектом')] };

  // Версия — первым делом и отдельным сообщением: файл ревизии 1 отличается от мусора, и
  // человек, увидевший диагностику, должен понимать, что у него старый lock, а не сломанный.
  if (data.version !== LOCK_VERSION) {
    report('version', `версия lock ${String(data.version)}, а эта сборка читает ${LOCK_VERSION}`);
  }
  if (typeof data.manifestHash !== 'string' || !HEX64.test(data.manifestHash)) {
    report('manifestHash', 'manifestHash обязан быть 64 строчными hex без префикса');
  }
  if (!isRecord(data.defaults)) {
    report('defaults', 'слот defaults обязателен: из snapshot.effective его не восстановить');
  } else {
    // `sameDefaults` зовётся на КАЖДОМ `diffLock` безусловно, поэтому эта ветка опаснее
    // ветки `own`: там канонизация случается только для имён, присутствующих в манифесте.
    const reason = canonicalizable(data.defaults);
    if (reason !== null) report('defaults', `defaults не канонизируется: ${reason}`);
  }
  if (!isRecord(data.tools)) report('tools', 'tools обязан быть объектом');
  else for (const [name, entry] of Object.entries(data.tools)) checkEntry(name, entry, report);

  if (diagnostics.length > 0) return { ok: false, diagnostics };

  return {
    ok: true,
    lock: {
      version: LOCK_VERSION,
      manifestHash: data.manifestHash as string,
      defaults: data.defaults as NormalizedDefaults,
      tools: data.tools as Record<string, LockEntry & { snapshot: NormalizedRecipe }>,
    },
  };
}
