import { readFile as fsReadFile, stat as fsStat } from 'node:fs/promises';
import { MANIFEST_MAX_BYTES, normalizeRecipe } from '@mcpproxy/contracts';
import type { Diagnostic, Manifest } from '@mcpproxy/contracts';
import { manifestHash, recipeHash } from '@mcpproxy/contracts/audit';
import { parseLockFile, parseManifest } from '@mcpproxy/contracts/validate';
import { checkLock } from './lock-check.js';
import type { LoadedLock, LoadedManifest, LockVerdict } from './lock-check.js';

/**
 * Единственная точка загрузки политики в `core` (R1).
 *
 * Она читает оба файла с диска и **никогда не бросает**: и отсутствие файла, и ошибка чтения,
 * и диагностики парсера возвращаются размеченным результатом. Прямой вызов `parseManifest` в
 * обход этого модуля не появляется нигде в `core` — запрет исполняемый, его держит скан
 * `scan.ts`, а не обещание в этом комментарии.
 *
 * Асимметрия реакций намеренная и требуется `docs/07-contracts.md:402` (R3): сломанный манифест
 * — отказ старта; сломанный или устаревший lock — повторный апрув. Поэтому неудача загрузки
 * манифеста имеет **форму** (`StartResult`, `ReloadResult`), по которой демон E4 отказывается
 * стартовать, а неудача загрузки lock — это его значение (`absent`), а не отказ загрузки.
 */

/**
 * Предел размера `mcpproxy.lock` — до чтения в память (R1a).
 *
 * У манифеста предел есть (`MANIFEST_MAX_BYTES`), но срабатывает он уже внутри парсера, то есть
 * после того, как файл целиком прочитан строкой; у lock предела нет вовсе. Оба файла
 * недоверенные по модели угроз, оба лежат на пути решения, и оба перечитываются вотчером при
 * каждой записи в каталоге.
 *
 * Значение кратно манифестному, а не равно ему: lock несёт на каждый рецепт `own` — дословные
 * строки манифеста — **плюс** эффективный профиль, поэтому честный lock законно больше своего
 * манифеста. Задача предела одна: не дать вотчеру прочитать в память произвольный файл.
 */
export const LOCK_MAX_BYTES = 4 * MANIFEST_MAX_BYTES;

export type StartResult =
  | { readonly outcome: 'started'; readonly store: StartedStore }
  | { readonly outcome: 'invalid-manifest'; readonly diagnostics: readonly Diagnostic[] }
  | { readonly outcome: 'unreadable-manifest'; readonly code: string; readonly message: string };

/**
 * Перечитка отдаёт результат, а не `void` (R2a): иначе диагностики некуда деть, и вызывающий не
 * отличает «перечитка не удалась» от «перечитка удалась, ничего не изменилось» — молчаливый
 * fail-open на пути решения.
 */
export type ReloadResult =
  | { readonly outcome: 'reloaded'; readonly policy: LoadedPolicy }
  | { readonly outcome: 'invalid'; readonly diagnostics: readonly Diagnostic[] }
  | { readonly outcome: 'unreadable'; readonly code: string; readonly message: string };

export interface LoadedPolicy {
  readonly manifest: LoadedManifest;
  readonly lock: LoadedLock;
  readonly verdict: LockVerdict;
}

export interface StoreDeps {
  readonly statSize: (path: string) => Promise<number>;
  readonly readFile: (path: string) => Promise<string>;
}

/**
 * Снимок политики выдаётся только отсюда, и объект существует **только** внутри
 * `{outcome:'started'}` (R6b): до первой успешной загрузки политики нет, и вызов в этом
 * состоянии невозможен по построению, а не по проверке. Тип, а не гарантия словом.
 */
export interface StartedStore {
  current(): LoadedPolicy;
  reloadManifest(): Promise<ReloadResult>;
  reloadLock(): Promise<ReloadResult>;
  /** Внутреннее наблюдаемое для тестов. В решении **не участвует** — связывает дайджест. */
  reloadCount(): number;
}

const diagnostic = (code: Diagnostic['code'], message: string): Diagnostic => ({
  pointer: '',
  line: 1,
  column: 1,
  code,
  message,
});

const errnoOf = (error: unknown): { code: string; message: string } => ({
  code: typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'UNKNOWN',
  message: error instanceof Error ? error.message : String(error),
});

const defaultDeps: StoreDeps = {
  statSize: async (path) => (await fsStat(path)).size,
  readFile: async (path) => fsReadFile(path, 'utf8'),
};

/**
 * Заморозка вглубь, и только манифеста (R6).
 *
 * `parseManifest` возвращает изменяемый `Manifest` — простое дерево из `doc.toJS()`, — поэтому
 * присваивание `manifest.tools.run_tests.exec[0] = '/bin/sh'` после успешной валидации обходит
 * все инварианты `refine`. Сузить это в замороженном контракте уже нельзя, значит границу
 * держит `core`.
 *
 * Карту матчеров замораживать незачем: `Object.freeze` на `Map` не влияет ни на `get`, ни на
 * вызов `test`, а сам `PatternMatcher` — объектный литерал, у которого `test` собственное
 * свойство-замыкание (`packages/contracts/src/validate/regex.ts:43`).
 */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

type ManifestLoad =
  | { readonly ok: true; readonly loaded: LoadedManifest }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }
  | { readonly ok: false; readonly code: string; readonly message: string };

function describeManifest(manifest: Manifest, matchers: LoadedManifest['matchers']): LoadedManifest {
  const recipeDigests = new Map<string, string>();
  for (const [name, recipe] of Object.entries(manifest.tools)) {
    recipeDigests.set(name, recipeHash(normalizeRecipe(recipe, manifest.defaults)));
  }
  return { manifest: deepFreeze(manifest), matchers, digest: manifestHash(manifest), recipeDigests };
}

async function loadManifest(path: string, deps: StoreDeps): Promise<ManifestLoad> {
  let size: number;
  try {
    size = await deps.statSize(path);
  } catch (error) {
    return { ok: false, ...errnoOf(error) };
  }
  // Предел — ДО чтения в память, а не внутри парсера на уже прочитанной строке (R1a).
  if (size > MANIFEST_MAX_BYTES) {
    return {
      ok: false,
      diagnostics: [diagnostic('size-limit', `манифест больше ${MANIFEST_MAX_BYTES} байт: ${size}`)],
    };
  }

  let text: string;
  try {
    text = await deps.readFile(path);
  } catch (error) {
    return { ok: false, ...errnoOf(error) };
  }

  const parsed = parseManifest(text, { path });
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
  return { ok: true, loaded: describeManifest(parsed.manifest, parsed.matchers) };
}

/**
 * Загрузка lock. Отказ здесь — это **значение** `absent`, а не отказ загрузки: не разобрали
 * lock — значит одобрения нет — значит рецепт идёт на повторный апрув (R9, fail-closed).
 */
async function loadLock(path: string, deps: StoreDeps): Promise<LoadedLock> {
  let size: number;
  try {
    size = await deps.statSize(path);
  } catch (error) {
    const { code, message } = errnoOf(error);
    return code === 'ENOENT' ? { present: false, reason: 'missing' } : { present: false, reason: 'unreadable', code, message };
  }
  if (size > LOCK_MAX_BYTES) {
    return {
      present: false,
      reason: 'unreadable',
      code: 'ERR_SIZE_LIMIT',
      message: `lock больше ${LOCK_MAX_BYTES} байт: ${size}`,
    };
  }

  let text: string;
  try {
    text = await deps.readFile(path);
  } catch (error) {
    const { code, message } = errnoOf(error);
    return code === 'ENOENT' ? { present: false, reason: 'missing' } : { present: false, reason: 'unreadable', code, message };
  }

  // Только через `parseLockFile` (R8): `JSON.parse(text) as LockFile` дал бы `diffLock` файл
  // старой формы, а тот разыменовывает `entry.snapshot` и `lock.defaults` без проверок —
  // необработанное исключение на самом пути принятия решения.
  const parsed = parseLockFile(text);
  return parsed.ok ? { present: true, lock: parsed.lock } : { present: false, reason: 'unparsed', diagnostics: parsed.diagnostics };
}

export async function startStore(
  manifestPath: string,
  lockPath: string,
  deps: Partial<StoreDeps> = {},
): Promise<StartResult> {
  const resolved: StoreDeps = { ...defaultDeps, ...deps };

  const first = await loadManifest(manifestPath, resolved);
  if (!first.ok) {
    return 'diagnostics' in first
      ? { outcome: 'invalid-manifest', diagnostics: first.diagnostics }
      : { outcome: 'unreadable-manifest', code: first.code, message: first.message };
  }

  let policy: LoadedPolicy = withLock(first.loaded, await loadLock(lockPath, resolved));
  let reloads = 0;

  const store: StartedStore = {
    current: () => policy,
    reloadCount: () => reloads,

    // Правка с опечаткой не обезоруживает прокси: пока новая загрузка не завершилась успехом,
    // действует прежний манифест (R4). Диагностики при этом отдаются вызывающему, а не тонут.
    reloadManifest: async () => {
      const next = await loadManifest(manifestPath, resolved);
      if (!next.ok) {
        return 'diagnostics' in next
          ? { outcome: 'invalid', diagnostics: next.diagnostics }
          : { outcome: 'unreadable', code: next.code, message: next.message };
      }
      policy = withLock(next.loaded, policy.lock);
      reloads += 1;
      return { outcome: 'reloaded', policy };
    },

    // Обновление lock **не** влечёт перечитку и перехэширование манифеста (R5b): это разные
    // файлы с разным временем жизни.
    reloadLock: async () => {
      policy = withLock(policy.manifest, await loadLock(lockPath, resolved));
      reloads += 1;
      return { outcome: 'reloaded', policy };
    },
  };

  return { outcome: 'started', store };
}

const withLock = (manifest: LoadedManifest, lock: LoadedLock): LoadedPolicy => ({
  manifest,
  lock,
  verdict: checkLock(manifest, lock),
});
