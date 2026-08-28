import { normalizeRecipe } from '@mcpproxy/contracts';
import type { ApprovalDecision, Diagnostic, LockDiff, NormalizedRecipe } from '@mcpproxy/contracts';
import type { LoadedManifest } from './lock-check.js';
import type { LoadedPolicy } from './store.js';

/**
 * Формы апрува дрифта. Объявлены **здесь**, а не в `@mcpproxy/contracts`: контракт заморожен,
 * и E1 его не трогает (R16, решение владельца D2).
 *
 * E1 объявляет форму запроса и производит решение — доставку решения человеку через два
 * канала строит E5. Канала апрува здесь нет как класса, и это структурная половина R17:
 * `checkLock` отказывает на `drifted` и `absent` безусловно, а единственный выход — явная
 * команда, запущенная человеком в терминале. Отдельной проверки «мы в headless?» нет: она
 * была бы поверхностью без потребителя.
 */

/**
 * Что показывают человеку. Размеченное объединение из трёх ветвей, а не тотальная форма с
 * обязательным `diff`: у `unreadable` и `unparsed` `LockFile` нет вовсе, диффа взять негде, а
 * подстановка пустого диффа столкнулась бы с веткой «дрифт есть, показать нечего» — и человек
 * получил бы текст про подделку на ошибке доступа.
 */
/**
 * Рецепт, который команда собирается закрепить, — **вместе с содержимым**.
 *
 * Одного имени мало, и это не стилистика. R15b заведён против последовательности «удалить lock →
 * отравить манифест → человек упирается в `denied (absent)` и запускает команду». Показав ему
 * `- run_tests` — имя, которое стояло там и до атаки, — команда закрепляет отравленные `exec` и
 * `description`, **ни разу их не показав**: ровно тот исход, который требование объявляет
 * предотвращённым. Спека говорит «список рецептов», но предыдущим же предложением требует
 * «показывает **то, что собирается закрепить**», и выиграть обязано второе.
 */
export interface PinnedRecipe {
  readonly name: string;
  readonly snapshot: NormalizedRecipe;
}

export type LockApprovalRequest =
  | {
      readonly kind: 'first';
      /** Рецепты, которые впервые получают одобрение, с содержимым. */
      readonly recipes: readonly PinnedRecipe[];
      readonly manifestHash: string;
      readonly requestedAt: string;
    }
  | {
      readonly kind: 'drift';
      readonly diff: LockDiff;
      readonly mismatched: readonly string[];
      readonly digest: { readonly was: string; readonly is: string } | null;
      readonly manifestHash: string;
      readonly requestedAt: string;
    }
  | {
      readonly kind: 'unusable';
      readonly reason: 'unreadable' | 'unparsed';
      readonly diagnostics: readonly Diagnostic[];
      /** То же и по той же причине: испорченный lock закрепляется так же вслепую, как удалённый. */
      readonly recipes: readonly PinnedRecipe[];
      readonly manifestHash: string;
      readonly requestedAt: string;
    };

/**
 * Ответ человека. Поле названо `manifestHash` так же, как в запросе и в `LockFile`: прецедент
 * — `packages/contracts/src/lock.ts:113`, где замороженная формула носит имя своего поля.
 */
export interface LockApprovalVerdict {
  readonly manifestHash: string;
  readonly decision: ApprovalDecision;
  readonly decidedAt: string;
}

export type VerdictApplicability = 'applies' | 'stale' | 'denied';

/**
 * Запрос на подтверждение, или `null` — если спрашивать не о чем.
 *
 * `null` возвращается **только** для `verified`. Ветвь `'first'` существует потому, что
 * «файла нет» перестало быть беззвучной записью (R15b): удалить lock дешевле, чем испортить,
 * а по модели угроз ADR-0006 репозиторий правит в том числе сама модель. Последовательность
 * «удалить lock → отравить манифест → человек упирается в `denied (absent)` и запускает
 * команду» закрепила бы отравленный манифест, ни разу его не показав.
 */
export function requestFor(policy: LoadedPolicy, requestedAt: string): LockApprovalRequest | null {
  const { check, mismatched, digest, diagnostics } = policy.verdict;
  const manifestHash = policy.manifest.digest;

  if (check.status === 'verified') return null;

  if (check.status === 'drifted') {
    return { kind: 'drift', diff: check.diff, mismatched, digest, manifestHash, requestedAt };
  }

  const { manifest } = policy.manifest;
  const recipes: PinnedRecipe[] = Object.entries(manifest.tools)
    .map(([name, recipe]) => ({ name, snapshot: normalizeRecipe(recipe, manifest.defaults) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const first: LockApprovalRequest = { kind: 'first', recipes, manifestHash, requestedAt };

  // `absent` при разобранном lock невозможно: `checkLock` производит его только из
  // отсутствующего, нечитаемого или неразобранного файла. Ветка существует ради тотальности
  // и ведёт себя как «файла нет» — то есть спрашивает, а не пишет молча.
  if (policy.lock.present || policy.lock.reason === 'missing') return first;

  return { kind: 'unusable', reason: policy.lock.reason, diagnostics, recipes, manifestHash, requestedAt };
}

/**
 * Действует ли вердикт на **этот** манифест.
 *
 * Сверка идёт по дайджесту, и только по нему. Счётчик перезагрузок для этого не годится
 * дважды: он растёт при каждой успешной загрузке, поэтому перечитка после ответа человека
 * всегда меняла бы его и всякий законный апрув отвергался бы как устаревший; и он локален для
 * процесса, тогда как команда `mcpproxy lock` — отдельный процесс от демона. Дайджест
 * переживает границу процесса, счётчик — нет, и дайджест же есть то, что человек одобрял.
 *
 * `'denied'` проверяется раньше `'stale'`: отказ человека — сам по себе исход, и подменять его
 * рассказом про устаревание значило бы прятать решение, которое он принял.
 */
export function verdictApplicability(verdict: LockApprovalVerdict, manifest: LoadedManifest): VerdictApplicability {
  if (verdict.decision === 'denied') return 'denied';
  return verdict.manifestHash === manifest.digest ? 'applies' : 'stale';
}
