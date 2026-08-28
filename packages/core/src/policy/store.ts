import { open as fsOpen, stat as fsStat } from 'node:fs/promises';
import { MANIFEST_MAX_BYTES, normalizeRecipe, sanitizeDescription } from '@mcpproxy/contracts';
import type { Diagnostic, Manifest } from '@mcpproxy/contracts';
import { manifestHash, recipeHash } from '@mcpproxy/contracts/audit';
import { parseLockFile, parseManifest } from '@mcpproxy/contracts/validate';
import { checkLock } from './lock-check.js';
import { SIZE_LIMIT_CODE } from './shapes.js';
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
 * Значение — **бюджет памяти, а не гарантия вместимости**, и это различие существенно.
 *
 * Отношение «манифест → lock» не ограничено сверху ничем. `snapshot.effective` копирует весь
 * нормализованный блок `defaults` в **каждую** запись, поэтому манифест из множества крошечных
 * рецептов при богатых `defaults` раздувает lock произвольно. Измерено на законных манифестах у
 * самого потолка `MANIFEST_MAX_BYTES`:
 *
 * | форма | рецептов | манифест | lock | отношение |
 * |---|---:|---:|---:|---:|
 * | обычные рецепты, 12 `deny` | 1 700 | 260 777 B | 4 030 340 B | 15.5x |
 * | минимальные рецепты, 12 `deny` | 5 500 | 259 712 B | 15 858 439 B | 61x |
 * | минимальные рецепты, 60 `deny` | 5 400 | 258 276 B | 41 494 363 B | 161x |
 *
 * Значит **никакая константа не делает «законный манифест ⇒ lock влезает» истинным**, и искать
 * её бессмысленно. Прежнее `4 *` было хуже вдвойне: оно лежало ниже даже типичного отношения,
 * и — главное — писатель о нём не знал. Манифест в 152 КБ давал честный lock в 1.05 МБ, команда
 * писала его, печатала «записан» и выходила с нулём, а читатель той же сборки объявлял файл
 * непригодным и отказывал каждому вызову; повторный запуск команды писал те же байты. Выхода из
 * цикла не было.
 *
 * Дыру закрывает не константа, а инвариант **«потолок писателя ≡ потолок читателя»**: `writeLock`
 * меряет сериализованный lock тем же пределом и отказывается его писать, поэтому превышение —
 * диагностируемый отказ с ненулевым кодом выхода, а не молчаливый клин. Держит инвариант тест, а
 * не симметрия констант.
 *
 * Сама же величина отвечает только за то, ради чего предел и заведён, — «не дать вотчеру
 * прочитать в память произвольный файл». 4 МиБ покрывают порядка полутора тысяч рецептов при
 * реалистичных `defaults`, то есть любой манифест, написанный человеком.
 */
export const LOCK_MAX_BYTES = 16 * MANIFEST_MAX_BYTES;

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
  /** Обязана читать не больше `limit + 1` байт и отказывать на превышении — см. `nodeReadFile`. */
  readonly readFile: (path: string, limit: number) => Promise<string>;
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
  /**
   * Число успешных перезагрузок. Наблюдаемое, **не участвующее в решении**: одобрение связывает
   * дайджест манифеста, а не этот счётчик — почему именно, развёрнуто в `approve.ts`.
   */
  reloadCount(): number;
}

/**
 * Конструктор диагностики санитизирует текст, как того требует контракт от **всех**
 * производителей: `Diagnostic.message` объявлен «безопасным для отрисовки», и держится это
 * обещание тем, что санитизация стоит в конструкторе, а не у пяти вызывающих. Сюда приезжает
 * сообщение ошибки ФС, то есть чужой текст с путём внутри.
 */
const diagnostic = (code: Diagnostic['code'], message: string): Diagnostic => ({
  pointer: '',
  line: 1,
  column: 1,
  code,
  message: sanitizeDescription(message).text,
});

/**
 * `error` проверяется на объект ДО разыменования: `null` в качестве причины отклонения — это
 * `TypeError` изнутри собственного `catch`, то есть модуль, объявивший «никогда не бросает»,
 * бросил бы. Отклониться не-объектом может внедрённая реализация `StoreDeps`, а она публична.
 */
const errnoOf = (error: unknown): { code: string; message: string } => {
  const record = typeof error === 'object' && error !== null ? (error as { code?: unknown }) : {};
  return {
    code: typeof record.code === 'string' ? record.code : 'UNKNOWN',
    message: error instanceof Error ? error.message : String(error),
  };
};

const sizeLimit = (path: string, limit: number): Error =>
  Object.assign(new Error(`${path}: файл больше предела ${limit} байт`), { code: SIZE_LIMIT_CODE });

/**
 * Чтение, **ограниченное сверху на самом дескрипторе**.
 *
 * `statSize` → `readFile` — две независимые операции по пути, который по модели угроз правит в
 * том числе атакующий: между ними файл можно подменить на сколь угодно больший, и обычный
 * `readFile` втянул бы его в память целиком. Проверка порядка вызовов (R1a) от этого не
 * защищает — она утверждает очерёдность, а не эффект. Здесь читается не больше `limit + 1`
 * байт, поэтому окно между проверкой и чтением перестаёт что-либо давать: превышение
 * обнаруживается по факту чтения, а память ограничена в любом случае.
 *
 * Усечённая строка наружу не отдаётся: `limit + 1` прочитанных байт — это отказ, а не значение,
 * поэтому разрезанная пополам кодовая точка никогда не доезжает до разбора.
 */
export const readBounded = async (path: string, limit: number): Promise<string> => {
  const handle = await fsOpen(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, limit + 1, 0);
    if (bytesRead > limit) throw sizeLimit(path, limit);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
};

const defaultDeps: StoreDeps = {
  statSize: async (path) => (await fsStat(path)).size,
  readFile: readBounded,
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
  // Пер-рецептные дайджесты считаются ЛЕНИВО. Каждый из них нормализует свой рецепт, и ровно ту
  // же работу через мгновение делает `diffLock` внутри `checkLock`; цену прохода называет
  // доккомментарий `lock-check.ts` — 2.2 с CPU на манифесте у потолка. Платить её дважды на
  // каждой перезагрузке, которую инициирует вотчер, незачем: до E4 у карты нет ни одного
  // потребителя, а `checkLock` её не читает.
  let digests: ReadonlyMap<string, string> | null = null;

  return {
    manifest: deepFreeze(manifest),
    matchers,
    digest: manifestHash(manifest),
    get recipeDigests(): ReadonlyMap<string, string> {
      if (digests === null) {
        digests = new Map(
          Object.entries(manifest.tools).map(([name, recipe]) => [
            name,
            recipeHash(normalizeRecipe(recipe, manifest.defaults)),
          ]),
        );
      }
      return digests;
    },
  };
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
    text = await deps.readFile(path, MANIFEST_MAX_BYTES);
  } catch (error) {
    const { code, message } = errnoOf(error);
    // Превышение предела — это диагностика загрузки, а не ошибка ввода-вывода: причина у них
    // разная, и оператор обязан их различать.
    return code === SIZE_LIMIT_CODE
      ? { ok: false, diagnostics: [diagnostic('size-limit', message)] }
      : { ok: false, code, message };
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
      code: SIZE_LIMIT_CODE,
      message: `lock больше ${LOCK_MAX_BYTES} байт: ${size}`,
    };
  }

  let text: string;
  try {
    text = await deps.readFile(path, LOCK_MAX_BYTES);
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
  // Две перезагрузки идут параллельно штатно: вотчер и `mcpproxy lock` зовут `reloadManifest` на
  // одном сторе. Без поколения побеждала бы та, что завершилась позже, а не та, что читала
  // позже, — и `current()` мог бы остаться СТАРЕЕ диска, ничем этого не показав.
  let generation = 0;
  const claim = (): (() => boolean) => {
    const mine = (generation += 1);
    return () => mine === generation;
  };

  /**
   * Перечитки исполняются ПО ОДНОЙ. Без этого номер поколения не выражает того, ради чего
   * заведён: он берётся до чтения, а порядок завершения чтений ему не подчинён. Две
   * параллельные перечитки могут прочитать файл в порядке, обратном порядку захвата номера, —
   * и тогда побеждает та, что прочитала СТАРОЕ содержимое, а `current()` остаётся старее
   * диска навсегда, ничем этого не показав. Именно этот исход запрещает комментарий выше.
   *
   * Воспроизведено детерминированно: `probes/p12-reload-race.mjs`. Найдено в E4 при
   * подключении вотчера к демону — в фикстуре запись файла токена будила перечитку
   * одновременно с правкой манифеста, и правка терялась.
   *
   * Очередь, а не отмена: обе перечитки обязаны вернуть вызывающему результат — `mcpproxy
   * lock` ветвится по нему, а вотчер по нему же пишет диагностику.
   */
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const store: StartedStore = {
    current: () => policy,
    reloadCount: () => reloads,

    // Правка с опечаткой не обезоруживает прокси: пока новая загрузка не завершилась успехом,
    // действует прежний манифест (R4). Диагностики при этом отдаются вызывающему, а не тонут.
    reloadManifest: async () =>
      serialize(async () => {
        const newest = claim();
        const next = await loadManifest(manifestPath, resolved);
        if (!next.ok) {
          return 'diagnostics' in next
            ? { outcome: 'invalid', diagnostics: next.diagnostics }
            : { outcome: 'unreadable', code: next.code, message: next.message };
        }
        const loaded = withLock(next.loaded, policy.lock);
        if (newest()) policy = loaded;
        reloads += 1;
        return { outcome: 'reloaded', policy: loaded };
      }),

    // Обновление lock **не** влечёт перечитку и перехэширование манифеста (R5b): это разные
    // файлы с разным временем жизни.
    reloadLock: async () =>
      serialize(async () => {
        const newest = claim();
        const lock = await loadLock(lockPath, resolved);
        const loaded = withLock(policy.manifest, lock);
        if (newest()) policy = loaded;
        reloads += 1;
        return { outcome: 'reloaded', policy: loaded };
      }),
  };

  return { outcome: 'started', store };
}

const withLock = (manifest: LoadedManifest, lock: LoadedLock): LoadedPolicy => ({
  manifest,
  lock,
  verdict: checkLock(manifest, lock),
});
