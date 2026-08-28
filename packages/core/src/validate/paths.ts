import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  denial,
  isCanonicalizable,
  type Denial,
  type ParamValue,
  type ResolvedValues,
  type ValidatedValues,
} from './denial.js';
import type { PreparedRecipe } from './prepare.js';

/**
 * Стадия `resolve_paths`. Единственная стадия E2, которая трогает файловую систему.
 *
 * Порядок шагов несущий и замерен: `realpath` корня → советующая лексическая предпроверка →
 * `realpath` кандидата → confinement по результату. Проверка «строка не содержит `..`»
 * защитой не является и как таковая не применяется (R13, И3).
 */

export type ResolvePathsResult =
  | { ok: true; values: ResolvedValues }
  | { ok: false; denials: readonly [Denial, ...Denial[]] };

/**
 * Три исхода, а не два. `root-itself` отделён от `outside` потому, что отказ обязан объяснять
 * себя: при `rel === ''` общая формулировка давала текст «резолвнутый путь X лежит вне
 * root: X» — один и тот же путь по обе стороны от «лежит вне», что читается как дефект
 * проверки, а не как «вы передали каталог вместо файла». Замерено на `file: '.'`.
 */
type Confinement = 'inside' | 'root-itself' | 'outside';

/**
 * Предикат confinement (R15). Строится на `path.relative`, а не на `startsWith`: голый
 * `startsWith` считает `/logs-evil/a` лежащим внутри `/logs` (Ф3).
 *
 * `rel === '..'` проверяется отдельно от `startsWith('..' + sep)` по той же причине, по
 * которой она стоит в `checkRootConfinement` (`packages/contracts/src/validate/refine.ts:223`):
 * каталог `..cache` даёт `relative` = `..cache`, и голый `startsWith('..')` объявил бы законный
 * подкаталог выходом за пределы. Обратная сторона той же клаузы — значение ровно `..`, то есть
 * родительский каталог корня без хвоста: без неё он проходит границу целиком.
 */
function confinementOf(root: string, candidate: string): Confinement {
  const rel = relative(root, candidate);
  if (rel === '') return 'root-itself';
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return 'outside';
  return 'inside';
}

/** Ловится `error.code`, а не текст сообщения: текст не заморожен и локализуется. */
function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code: unknown = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export function resolvePaths(prepared: PreparedRecipe, values: ValidatedValues): ResolvePathsResult {
  const denials: Denial[] = [];
  const out = new Map<string, ParamValue>(values);

  for (const param of prepared.params) {
    if (param.kind !== 'path') continue;

    const value = values.get(param.name);
    // Необязательный и не переданный: без этой ветки `path.resolve(root, undefined)` бросает.
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      // Ветка недостижима после стадии `validate`, но названа, иначе была бы закрыта через
      // `as string`. Замерено: `path.resolve(root, 42)` бросает `ERR_INVALID_ARG_TYPE` (Ф13).
      denials.push(
        denial({ stage: 'resolve_paths', code: 'path-unusable', paramName: param.name, reason: 'значение параметра не строка' }),
      );
      continue;
    }

    // Шаг 2. `realpath` корня — ПЕРВЫМ (R14, Ф4). Обе последующие проверки сравнивают с
    // корнем, а сравнивать с нерезолвнутым нельзя: на macOS `/var` — симлинк на `/private/var`,
    // и нерезолвнутый `root` не совпадает с резолвнутым путём ни для одного файла.
    //
    // Делается на каждый вызов, а не кэшируется в подготовке, и это сознательно: корень мог
    // быть подменён на симлинк после загрузки манифеста, а кэш сделал бы подмену невидимой.
    let realRoot: string;
    try {
      realRoot = realpathSync(param.root);
    } catch (error) {
      // Ошибка СВЯЗЫВАЕТСЯ, а её код доезжает до причины. Голый `catch {}` здесь стирал
      // различие между четырьмя разными авариями — `ENOENT` (корня нет), `ELOOP` (корень
      // подменён на петлю симлинков), `EACCES` (потерян доступ) и `ENOTDIR` (на месте
      // каталога оказался файл), — и это била ровно по тому, ради чего `realpath` корня
      // делается на каждый вызов: подмена корня обнаруживалась и становилась в следе
      // неотличима от опечатки в конфиге. `param.root` — данные манифеста, а не значение
      // параметра, и R25 разрешает его называть.
      const code = errorCode(error);
      denials.push(
        denial({
          stage: 'resolve_paths',
          code: 'path-unusable',
          paramName: param.name,
          reason: `корень параметра не резолвится (${code ?? 'без кода'}): ${param.root}`,
        }),
      );
      continue;
    }

    // Шаг 3. Лексическая предпроверка — СОВЕТУЮЩАЯ (R15а). Результат запоминается, и на этом
    // всё: вызов здесь не отвергается ни при каком исходе. Запрещающей она быть не может, и
    // это замерено в обе стороны (Ф14, Ф16): лексический предикат симлинков не видит, поэтому
    // ЛЮБОЙ законный файл внутри `root`, достигнутый через симлинк, был бы им отвергнут.
    //
    // Влияет ровно на одно: если она не прошла, любой последующий провал называется
    // `path-escapes-root`, а не `path-not-found`, — и оракул существования схлопывается там,
    // где его дешевле всего убрать.
    const candidate = resolve(realRoot, value);
    const preOk = confinementOf(realRoot, candidate) === 'inside';

    // Шаг 4. `realpath` кандидата — НЕЗАВИСИМО от `preOk`.
    let resolved: string;
    try {
      resolved = realpathSync(candidate);
    } catch (error) {
      const code = errorCode(error);
      const [denialCode, reason] =
        !preOk
          ? (['path-escapes-root', `значение выходит за границу root: ${realRoot}`] as const)
          : code === 'ENOENT'
            ? (['path-not-found', `файла нет внутри root: ${realRoot}`] as const)
            : (['path-unusable', `путь непригоден (${code ?? 'без кода'}) внутри root: ${realRoot}`] as const);

      denials.push(denial({ stage: 'resolve_paths', code: denialCode, paramName: param.name, reason }));
      continue;
    }

    // Шаг 5. Предикат над результатом `realpath` (R13). ЕДИНСТВЕННОЕ место, где вызов
    // отвергается по границе, и единственное, которое ловит симлинк.
    const verdict = confinementOf(realRoot, resolved);
    if (verdict !== 'inside') {
      // Резолвнутый путь показывается — этого требует сценарий S4, где зал должен увидеть,
      // куда вызов на самом деле указывал (R26). Осознанное исключение из R25; строка
      // санитизируется конструктором `denial`, потому что `realpath` возвращает имя файла
      // дословно, включая bidi-override (Ф13).
      const reason =
        verdict === 'root-itself'
          ? `значение указывает на сам корень, а не на файл под ним: ${realRoot}`
          : `резолвнутый путь ${resolved} лежит вне root: ${realRoot}`;
      denials.push(denial({ stage: 'resolve_paths', code: 'path-escapes-root', paramName: param.name, reason }));
      continue;
    }

    // Шаг 6. Гейт канонизируемости над результатом `realpath` (R28, источник 2). Гейт стадии
    // `validate` сюда не дотягивается: `realpath` ЗАМЕНЯЕТ проверенный вход новой строкой,
    // собранной из имён на диске. То, что на macOS имена — UTF-8, свойство платформы, а не
    // гарантия E2.
    if (!isCanonicalizable(resolved)) {
      denials.push(
        denial({
          stage: 'resolve_paths',
          code: 'not-canonicalizable',
          paramName: param.name,
          reason: 'резолвнутый путь содержит одиночный суррогат и не переживёт запись события',
        }),
      );
      continue;
    }

    // Шаг 7. Одна карта. Путь кладётся ровно в том виде, в каком его вернул `realpath` —
    // нормализации нет нигде (R17). Одна и та же строка уходит и в argv, и в `params`, по
    // которым считается `argsHash`, так что второго источника здесь физически нет.
    out.set(param.name, resolved);
  }

  if (denials.length > 0) return { ok: false, denials: denials as [Denial, ...Denial[]] };

  // Второе и последнее место чеканки бренда; двойной каст по той же причине, что и в
  // `validateParams`. `cwd` здесь не вычисляется — его единственный владелец `prepareRecipe` (R18).
  return { ok: true, values: out as unknown as ResolvedValues };
}
