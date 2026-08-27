import { ANNOTATION_DEFAULTS } from './annotations.js';
import type { ToolAnnotations } from './annotations.js';
import { canonicalizeJcs } from './jcs.js';
import type { AccessRule, Defaults, Manifest, Param, Recipe } from './manifest.generated.js';

/**
 * Нормализованное представление рецепта и манифеста — основание всех трёх хэшей lock.
 *
 * Живёт в **корневом** входе: `diffLock` обязан быть доступен рендереру, а `node:crypto`
 * ему не нужен. Сами хэш-функции — в `./audit`.
 */

const UNIT_MS: Readonly<Record<string, number>> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

/**
 * `"120s"` → `120000`. Длительности нормализуются в целые миллисекунды, иначе `"120s"` и
 * `"2m"` — один и тот же таймаут и разные дайджесты, то есть косметическая правка даёт
 * жёсткий стоп на `lock_check` с диффом, в котором ничего не изменилось.
 */
export function durationToMs(duration: string): number {
  const match = /^([0-9]+)(ms|s|m|h)$/.exec(duration);
  if (match === null) throw new TypeError(`не длительность: ${duration}`);
  return Number(match[1]) * (UNIT_MS[match[2] as string] ?? 1);
}

export interface NormalizedAccess {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

export interface NormalizedSandbox {
  readonly read: NormalizedAccess;
  readonly write: NormalizedAccess;
  readonly network: NormalizedAccess;
}

export interface NormalizedDefaults {
  readonly timeoutMs: number;
  readonly output: { readonly maxBytes: number | null; readonly redact: boolean };
  readonly env: { readonly allow: readonly string[] };
  readonly sandbox: NormalizedSandbox;
}

/**
 * Параметры — **упорядоченный массив**, а не объект.
 *
 * JCS сортирует члены объекта, поэтому `params`, ключованные именем, теряли бы порядок ещё
 * до хэширования — и утверждение «сортировка изменила бы команду, не изменив хэш» оказалось
 * бы ровно наоборот. Из порядка собирается argv, значит он входит в форму.
 */
export interface NormalizedParam {
  readonly name: string;
  readonly schema: Param;
}

/** Собственный блок рецепта. Именно он — основание `recipeHash`. */
export interface NormalizedOwn {
  readonly description: string;
  readonly exec: readonly string[];
  readonly cwd: string | null;
  readonly params: readonly NormalizedParam[];
  /** С применёнными дефолтами спеки: молчание и явное повторение дефолта — один и тот же рецепт. */
  readonly annotations: Readonly<Record<keyof ToolAnnotations, boolean>>;
  readonly sandbox: { readonly read: AccessRule | null; readonly write: AccessRule | null; readonly network: AccessRule | null } | null;
  readonly timeoutMs: number | null;
  readonly env: { readonly allow: readonly string[] } | null;
  readonly output: { readonly maxBytes: number | null; readonly redact: boolean | null } | null;
}

export interface NormalizedRecipe {
  readonly own: NormalizedOwn;
  /**
   * Эффективный профиль — `defaults`, слитый с блоком рецепта.
   *
   * **Не хэшируется пер-рецепт.** Он лежит в снапшоте ради диффа S7, и только: иначе
   * расширение `defaults.env.allow` меняло бы эффективный профиль всех рецептов, все
   * `recipeHash` разъезжались бы, и `lock_check` докладывал бы `drifted` на каждом. Дрейф
   * `defaults` ловится `manifestHash` и атрибутируется в слот `defaults` ровно один раз.
   */
  readonly effective: NormalizedDefaults;
}

export interface LockEntry {
  /** Поле называется `recipeHash`, а не `hash`: замороженная формула носит это имя. */
  readonly recipeHash: string;
  readonly approvedAt: string;
  /**
   * Снапшот обязателен: SHA-256 необратим, и без него сторону «было» для диффа S7 построить
   * не из чего, а ADR-0006 требует показать дифф целиком и без усечения.
   */
  readonly snapshot: NormalizedRecipe;
}

export interface LockFile {
  readonly version: 1;
  readonly manifestHash: string;
  /**
   * Слот обязателен по тому же доводу, что и снапшот: `manifestHash` необратим, а
   * `snapshot.effective` восстановить `defaults` не даёт — каждый лист, переопределённый
   * рецептом, в эффективном профиле уже не виден.
   */
  readonly defaults: NormalizedDefaults;
  readonly tools: Record<string, LockEntry>;
}

export interface LockDiff {
  readonly defaults: { readonly was: NormalizedDefaults; readonly is: NormalizedDefaults } | null;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: ReadonlyArray<{ readonly name: string; readonly was: NormalizedRecipe; readonly is: NormalizedRecipe }>;
}

export type LockStatus = 'verified' | 'drifted' | 'absent';

/**
 * `drifted` и `absent` дают `verdict: 'denied'` на стадии `lock_check`. Это **не** риск-тир:
 * в `deriveRiskTier` расхождение с lock не отображается — там `high` означает out-of-band
 * апрув, а здесь нужен жёсткий стоп с модалкой «было/стало» (ADR-0006, S7).
 */
export type LockCheck =
  | { status: 'verified' }
  | { status: 'drifted'; diff: LockDiff }
  | { status: 'absent' };

const EMPTY_ACCESS: NormalizedAccess = { allow: [], deny: [] };

const dedupe = (values: readonly string[]): string[] => [...new Set(values)];

/**
 * Слияние одного узла профиля.
 *
 * `allow` — замена по листу: рецепт осознанно сужает или расширяет свой blast radius, и
 * пустой массив означает «обнулить», а не «наследовать». `deny` — **объединение**: запрет
 * из `defaults` неснимаем, потому что там лежат `~/.ssh`, `~/.aws` и `~/.config/gh`
 * (атака A10). Пустой рецептный `deny` — ошибка загрузки, а не тихий no-op; её ловит
 * `refine`, и правило страхует от реализации слияния через замену.
 */
function mergeAccess(base: NormalizedAccess, own: AccessRule | null): NormalizedAccess {
  return {
    allow: own?.allow !== undefined ? [...own.allow] : base.allow,
    deny: dedupe([...base.deny, ...(own?.deny ?? [])]),
  };
}

const accessOf = (rule: AccessRule | undefined): NormalizedAccess =>
  rule === undefined ? EMPTY_ACCESS : { allow: [...(rule.allow ?? [])], deny: [...(rule.deny ?? [])] };

export function normalizeDefaults(defaults: Defaults): NormalizedDefaults {
  return {
    timeoutMs: durationToMs(defaults.timeout),
    output: { maxBytes: defaults.output.maxBytes ?? null, redact: defaults.output.redact ?? false },
    env: { allow: [...defaults.env.allow] },
    sandbox: {
      read: accessOf(defaults.sandbox.read),
      write: accessOf(defaults.sandbox.write),
      network: accessOf(defaults.sandbox.network),
    },
  };
}

export function normalizeRecipe(recipe: Recipe, defaults: Defaults): NormalizedRecipe {
  const base = normalizeDefaults(defaults);

  const own: NormalizedOwn = {
    description: recipe.description,
    exec: [...recipe.exec],
    cwd: recipe.cwd ?? null,
    // Порядок ключей `recipe.params` совпадает с порядком в YAML и движком не переставляется:
    // `propertyNames` запрещает имена, похожие на целые числа.
    params: Object.entries(recipe.params ?? {}).map(([name, schema]) => ({ name, schema })),
    annotations: {
      readOnlyHint: recipe.annotations?.readOnlyHint ?? ANNOTATION_DEFAULTS.readOnlyHint,
      destructiveHint: recipe.annotations?.destructiveHint ?? ANNOTATION_DEFAULTS.destructiveHint,
      idempotentHint: recipe.annotations?.idempotentHint ?? ANNOTATION_DEFAULTS.idempotentHint,
      openWorldHint: recipe.annotations?.openWorldHint ?? ANNOTATION_DEFAULTS.openWorldHint,
    },
    sandbox:
      recipe.sandbox === undefined
        ? null
        : {
            read: recipe.sandbox.read ?? null,
            write: recipe.sandbox.write ?? null,
            network: recipe.sandbox.network ?? null,
          },
    timeoutMs: recipe.timeout === undefined ? null : durationToMs(recipe.timeout),
    env: recipe.env === undefined ? null : { allow: [...recipe.env.allow] },
    output:
      recipe.output === undefined
        ? null
        : { maxBytes: recipe.output.maxBytes ?? null, redact: recipe.output.redact ?? null },
  };

  const effective: NormalizedDefaults = {
    timeoutMs: own.timeoutMs ?? base.timeoutMs,
    output: {
      maxBytes: own.output?.maxBytes ?? base.output.maxBytes,
      redact: own.output?.redact ?? base.output.redact,
    },
    env: { allow: own.env?.allow ?? base.env.allow },
    sandbox: {
      read: mergeAccess(base.sandbox.read, own.sandbox?.read ?? null),
      write: mergeAccess(base.sandbox.write, own.sandbox?.write ?? null),
      network: mergeAccess(base.sandbox.network, own.sandbox?.network ?? null),
    },
  };

  return { own, effective };
}

export interface NormalizedManifest {
  readonly version: 1;
  readonly defaults: NormalizedDefaults;
  /**
   * Рецепты сортируются по имени, и асимметрия с порядком параметров намеренная: из
   * порядка параметров собирается argv, а рецепты везде адресуются по имени. Заморозив
   * порядок рецептов, мы получили бы `drifted` на перестановке двух ключей `tools:` —
   * при `diffLock`, возвращающем пустой дифф во всех четырёх слотах.
   */
  readonly tools: ReadonlyArray<{ readonly name: string; readonly own: NormalizedOwn }>;
}

export function normalizeManifest(manifest: Manifest): NormalizedManifest {
  return {
    version: manifest.version,
    defaults: normalizeDefaults(manifest.defaults),
    tools: Object.entries(manifest.tools)
      .map(([name, recipe]) => ({ name, own: normalizeRecipe(recipe, manifest.defaults).own }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
}

const sameOwn = (a: NormalizedRecipe, b: NormalizedRecipe): boolean =>
  canonicalizeJcs(a.own) === canonicalizeJcs(b.own);

const sameDefaults = (a: NormalizedDefaults, b: NormalizedDefaults): boolean =>
  canonicalizeJcs(a) === canonicalizeJcs(b);

/**
 * Дифф «было / стало» между lock-файлом и манифестом.
 *
 * Добавление и удаление рецепта — обязательство **формы возврата**, а не дисциплины
 * реализации: обход записей lock со сверкой хэшей добавленный рецепт просто не заметил бы.
 *
 * Слот `defaults` отдельный, иначе правка одной строки в `defaults.env.allow` меняет
 * эффективный профиль каждого рецепта, `changed` содержит их все, и модалка S7 показывает
 * одно изменение, размноженное N раз. В `changed` попадают только рецепты с изменением
 * **собственного** блока.
 */
export function diffLock(lock: LockFile, manifest: Manifest): LockDiff {
  const current = new Map(
    Object.entries(manifest.tools).map(([name, recipe]) => [name, normalizeRecipe(recipe, manifest.defaults)]),
  );
  const locked = new Set(Object.keys(lock.tools));

  const added = [...current.keys()].filter((name) => !locked.has(name)).sort();
  const removed = [...locked].filter((name) => !current.has(name)).sort();

  const changed: Array<{ name: string; was: NormalizedRecipe; is: NormalizedRecipe }> = [];
  for (const [name, entry] of Object.entries(lock.tools)) {
    const is = current.get(name);
    if (is === undefined) continue;
    if (!sameOwn(entry.snapshot, is)) changed.push({ name, was: entry.snapshot, is });
  }
  changed.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const is = normalizeDefaults(manifest.defaults);
  const defaults = sameDefaults(lock.defaults, is) ? null : { was: lock.defaults, is };

  return { defaults, added, removed, changed };
}
