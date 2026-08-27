import { diffLock } from '@mcpproxy/contracts';
import type { Diagnostic, LockCheck, LockDiff, LockFile, Manifest, PatternMatcher } from '@mcpproxy/contracts';
import { verifyLockEntries } from '@mcpproxy/contracts/audit';

/**
 * Сверка манифеста с `mcpproxy.lock` — единственная точка, производящая `LockCheck`.
 *
 * `LockCheck` и `LockStatus` объявлены в контракте и до E1 не производились ничем: это долг,
 * оставленный E0 явно (R7). Три шага замороженных функций — `parseLockFile` → `verifyLockEntries`
 * → `diffLock` — распределены между двумя местами. Разбор файла принадлежит загрузке (`store.ts`):
 * он делается при изменении файла, а не при вызове. Здесь — сверка.
 *
 * **На пути вызова эта функция не зовётся.** `lock_check` — стадия каждого вызова и она не
 * входит в `OVERHEAD_EXCLUDED_STAGES`, то есть попадает в бюджет ≤ 50 мс p95, тогда как
 * `diffLock` нормализует каждый рецепт: замер сопоставимой работы — 2.2 с CPU на манифесте в
 * 258 КБ. Вердикт производится на изменении файлов и читается полем.
 *
 * `deriveRiskTier` здесь не импортируется и не может появиться: там `high` означает out-of-band
 * апрув обычного вызова, а расхождение с lock требует жёсткого стопа (R13). Запрет исполняемый —
 * скан `policy/**` в `scan.ts`.
 */

export interface LoadedManifest {
  readonly manifest: Manifest;
  /**
   * Матчеры едут **вместе** с манифестом, одним значением (R5a): потребитель, взявший матчеры
   * от одной загрузки, а манифест от следующей, проверял бы новые `pattern` старыми объектами
   * RE2 — молчаливое расхождение на пути валидации.
   */
  readonly matchers: ReadonlyMap<string, PatternMatcher>;
  /** `manifestHash` — то, чем связывается одобрение, и то, что переживает границу процесса. */
  readonly digest: string;
  readonly recipeDigests: ReadonlyMap<string, string>;
}

/**
 * Причина отсутствия одобрения не схлопывается в один `null` (R6a). Три формы отказа —
 * файла нет; файл есть, но не читается; файл есть и читается, но не разбирается — fail-closed
 * все три, но для оператора это разные истории, а для команды записи — разные тексты.
 */
export type LoadedLock =
  | { readonly present: true; readonly lock: LockFile }
  | { readonly present: false; readonly reason: 'missing' }
  | { readonly present: false; readonly reason: 'unreadable'; readonly code: string; readonly message: string }
  | { readonly present: false; readonly reason: 'unparsed'; readonly diagnostics: readonly Diagnostic[] };

export interface LockVerdict {
  readonly check: LockCheck;
  /**
   * Диагностики `parseLockFile` не выбрасываются (R17a): у `LockCheck` слота под них нет, а
   * «lock старой версии», «lock испорчен» и «lock отсутствует» обязаны различаться в логе
   * оператора — ради этого различия в `DiagnosticCode` и существует член `lock`.
   */
  readonly diagnostics: readonly Diagnostic[];
  /** Записи, чей `recipeHash` противоречит собственному снапшоту. Пусто, если таких нет. */
  readonly mismatched: readonly string[];
  /**
   * Обе стороны дайджеста, когда разошёлся именно он.
   *
   * Поле, а не локальная переменная, потому что путей «дрифт есть, а дифф пуст» **два**, и
   * улики у них разные. Первый — подделанный `snapshot`: записи называет `mismatched`. Второй —
   * lock, пересчитанный целиком под изменённый манифест с оставленным прежним `manifestHash`:
   * тогда `verifyLockEntries` доволен, `diffLock` чист, `mismatched` пуст, и расходится только
   * дайджест. Не неси вердикт обе его стороны — и на этом пути рендеру нечего сказать вообще
   * (R19a), а это ровно тот путь, ради которого существует сверка дайджеста (R11).
   */
  readonly digest: { readonly was: string; readonly is: string } | null;
  /**
   * Причина отказа. Уезжает в OTLP как `mcpproxy.deny_reason` и как сообщение статуса спана
   * (R12a), поэтому без неё самый важный отказ продукта приезжает оператору без причины.
   * `null` — только на `verified`.
   */
  readonly denyReason: string | null;
}

/** Координат у синтезированной диагностики нет: она не указывает внутрь файла. */
const lockDiagnostic = (pointer: string, message: string): Diagnostic => ({
  pointer,
  line: 1,
  column: 1,
  code: 'lock',
  message,
});

const isEmptyDiff = (diff: LockDiff): boolean =>
  diff.defaults === null && diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;

function absent(lock: Extract<LoadedLock, { present: false }>): LockVerdict {
  const base = { check: { status: 'absent' } as const, mismatched: [], digest: null };
  switch (lock.reason) {
    case 'missing':
      return { ...base, diagnostics: [], denyReason: 'lock-absent: mcpproxy.lock отсутствует, одобрения нет' };
    case 'unreadable':
      return {
        ...base,
        diagnostics: [lockDiagnostic('', `lock не читается (${lock.code}): ${lock.message}`)],
        denyReason: `lock-unreadable: mcpproxy.lock не читается (${lock.code}), одобрения нет`,
      };
    case 'unparsed':
      return {
        ...base,
        diagnostics: lock.diagnostics,
        denyReason: 'lock-unparsed: mcpproxy.lock не разобран, одобрения нет',
      };
  }
}

/**
 * Производит вердикт. `diffLock` считается **всегда**, до всякого ветвления: иначе ветка
 * «разошёлся дайджест» отдала бы `drifted` с пустым диффом даже там, где рецепт изменён, и
 * рендеру нечего было бы показать человеку.
 */
export function checkLock(manifest: LoadedManifest, lock: LoadedLock): LockVerdict {
  if (!lock.present) return absent(lock);

  const diff = diffLock(lock.lock, manifest.manifest);
  const drifted: LockCheck = { status: 'drifted', diff };

  // Обязателен: без него lock с подменённым `snapshot` и оставленным прежним `recipeHash` даёт
  // чистый дифф во всех четырёх слотах — `diffLock` сравнивает `snapshot.own` с текущим
  // рецептом и на `recipeHash` не смотрит вовсе (R10, измерено P1d/P1e).
  const entries = verifyLockEntries(lock.lock);
  if (!entries.ok) {
    return {
      check: drifted,
      diagnostics: [
        lockDiagnostic(
          '',
          `записи lock противоречат собственным дайджестам: ${entries.mismatched.join(', ')}`,
        ),
      ],
      mismatched: entries.mismatched,
      digest: null,
      denyReason: `lock-tampered: записи lock противоречат собственным дайджестам (${entries.mismatched.join(', ')})`,
    };
  }

  // Сверка дайджеста не избыточна ровно на одном сценарии (R11): lock, у которого `defaults`,
  // все `snapshot` и все `recipeHash` пересчитаны под изменённый манифест, а `manifestHash`
  // оставлен прежним. Тогда обе проверки выше довольны, и расходится только он.
  if (lock.lock.manifestHash !== manifest.digest) {
    return {
      check: drifted,
      diagnostics: [],
      mismatched: [],
      digest: { was: lock.lock.manifestHash, is: manifest.digest },
      denyReason: 'lock-drifted: дайджест манифеста не совпадает с записанным в lock',
    };
  }

  if (!isEmptyDiff(diff)) {
    return {
      check: drifted,
      diagnostics: [],
      mismatched: [],
      digest: null,
      denyReason: 'lock-drifted: манифест разошёлся с одобренным lock',
    };
  }

  return { check: { status: 'verified' }, diagnostics: [], mismatched: [], digest: null, denyReason: null };
}
