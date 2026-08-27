import { join } from 'node:path';
import type { LockFile } from '@mcpproxy/contracts';
import { requestFor, verdictApplicability } from './approve.js';
import type { LockApprovalRequest, LockApprovalVerdict } from './approve.js';
import { confirmTty, parseExpect } from './confirm-tty.js';
import { buildLock, writeLock } from './lock-write.js';
import { renderRequest } from './render-diff.js';
import { startStore } from './store.js';
import type { StartedStore } from './store.js';

/**
 * Команда `mcpproxy lock` — единственный способ появления lock (R15). Ничто не пишет его
 * автоматически, поэтому на репозитории без lock каждый вызов упирается в `denied (absent)`:
 * первый запуск не притворяется одобренным.
 *
 * Когда lock уже есть, та же команда **не** перезаписывает его молча (R15a). Она показывает
 * дифф, требует подтверждения и — вот главное — **перечитывает манифест после ответа
 * человека** и сверяет его с тем, что ему показали. Сравнение снимка, взятого до показа, с
 * самим собой — не проверка, а тавтология: она проходит всегда, в том числе когда файл на
 * диске уже другой. Это и есть окно CVE-2025-54136: человек читает дифф в T₀, атакующий
 * правит манифест в T₁, команда подписывает T₁, не показав его.
 *
 * Беззвучной ветки не осталось ни одной, включая «файла нет» (R15b): удалить lock дешевле,
 * чем испортить, а по модели угроз ADR-0006 репозиторий правит в том числе сама модель.
 * Последовательность «удалить lock → отравить манифест → человек упирается в
 * `denied (absent)` и запускает команду» иначе закрепила бы отравленный манифест, ни разу его
 * не показав.
 */

export type LockCommandOutcome =
  | { readonly kind: 'written' }
  | { readonly kind: 'up-to-date' }
  | { readonly kind: 'refused'; readonly why: 'stale' | 'denied' | 'expect-mismatch' | 'reload-failed' };

export interface LockCommandDeps {
  readonly lockPath: string;
  readonly now: () => string;
  readonly write?: (lockPath: string, lock: LockFile) => Promise<void>;
}

export type Confirm = (request: LockApprovalRequest, rendered: string) => Promise<LockApprovalVerdict>;

export async function runLockCommand(
  store: StartedStore,
  confirm: Confirm,
  expectDigest: string | null,
  deps: LockCommandDeps,
): Promise<LockCommandOutcome> {
  const write = deps.write ?? writeLock;
  const policy = store.current();

  // До всякого показа: вердикт, выданный на манифест X, не может записать манифест Y, и
  // проверить это между процессами способен только дайджест.
  if (expectDigest !== null && expectDigest !== policy.manifest.digest) {
    return { kind: 'refused', why: 'expect-mismatch' };
  }

  const request = requestFor(policy, deps.now());
  if (request === null) return { kind: 'up-to-date' };

  const verdict = await confirm(request, renderRequest(request));

  // Перечитка ПОСЛЕ ответа человека — та самая половина R15a, что закрывает окно подмены.
  // Молча упавшая перечитка была бы fail-open, поэтому её результат разбирается.
  const reloaded = await store.reloadManifest();
  if (reloaded.outcome !== 'reloaded') return { kind: 'refused', why: 'reload-failed' };

  const fresh = store.current();
  const applicability = verdictApplicability(verdict, fresh.manifest);
  if (applicability !== 'applies') return { kind: 'refused', why: applicability };

  await write(deps.lockPath, buildLock(fresh.manifest, verdict.decidedAt));
  return { kind: 'written' };
}

export const MANIFEST_FILE = 'mcpproxy.yaml';
export const LOCK_FILE = 'mcpproxy.lock';

/**
 * Точка входа скрипта запуска. Возвращает код выхода, а не завершает процесс: решать, когда
 * умирать, — дело приложения, а не библиотеки.
 */
export async function mainLockCommand(argv: readonly string[], cwd: string): Promise<number> {
  const manifestPath = join(cwd, MANIFEST_FILE);
  const lockPath = join(cwd, LOCK_FILE);

  const start = await startStore(manifestPath, lockPath);
  if (start.outcome !== 'started') {
    // Сломанный манифест — отказ, а не повод записать lock: реакции на два файла асимметричны
    // намеренно (R3).
    process.stderr.write(`манифест не загружен (${start.outcome}): ${describeStartFailure(start)}\n`);
    return 2;
  }

  const outcome = await runLockCommand(start.store, confirmTty, parseExpect(argv), {
    lockPath,
    now: () => new Date().toISOString(),
  });

  switch (outcome.kind) {
    case 'written':
      process.stdout.write(`${LOCK_FILE} записан.\n`);
      return 0;
    case 'up-to-date':
      process.stdout.write(`${LOCK_FILE} уже совпадает с манифестом.\n`);
      return 0;
    case 'refused':
      process.stderr.write(`${LOCK_FILE} не записан: ${outcome.why}\n`);
      return 1;
  }
}

function describeStartFailure(start: Awaited<ReturnType<typeof startStore>>): string {
  if (start.outcome === 'invalid-manifest') {
    return start.diagnostics.map((one) => `${one.pointer || '(документ)'}: ${one.message}`).join('; ');
  }
  if (start.outcome === 'unreadable-manifest') return `${start.code}: ${start.message}`;
  return '';
}
