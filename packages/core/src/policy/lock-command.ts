import { join } from 'node:path';
import type { Diagnostic, LockFile } from '@mcpproxy/contracts';
import { requestFor, verdictApplicability } from './approve.js';
import type { LockApprovalRequest, LockApprovalVerdict } from './approve.js';
import { confirmTty, parseExpect } from './confirm-tty.js';
import { LockWriteError, buildLock, writeLock } from './lock-write.js';
import type { WriteResult } from './lock-write.js';
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

/**
 * Исход команды.
 *
 * Отказы несут **улику, а не тег**. `stale` — это подпись CVE-2025-54136: манифест изменился
 * между показом диффа и ответом человека, то есть самое высокосигнальное событие, ради которого
 * этот модуль существует. Прежняя редакция сообщала его оператору одним словом и не сохраняла
 * нигде; теперь он видит, какой дайджест одобрил и какой лежит на диске. `reload-failed`
 * по той же причине несёт диагностики: «манифест стал неразбираем, пока вы читали дифф» и
 * «манифест удалён» — разные истории.
 *
 * `write-failed` — отдельный член, а не `refused`: отказ записи не есть отказ человека, и до
 * этой правки он вообще не был выразим — исключение уходило в необработанное отклонение
 * `bin/mcpproxy-lock.mjs` и давало код 1, тот же, что и «человек сказал нет».
 */
export type LockCommandOutcome =
  | { readonly kind: 'written'; readonly durable: boolean; readonly reason?: string }
  | { readonly kind: 'up-to-date' }
  | { readonly kind: 'refused'; readonly why: 'denied' }
  | { readonly kind: 'refused'; readonly why: 'stale'; readonly approved: string; readonly onDisk: string }
  | {
      readonly kind: 'refused';
      readonly why: 'expect-mismatch';
      readonly expected: string;
      readonly onDisk: string;
    }
  | {
      readonly kind: 'refused';
      readonly why: 'reload-failed';
      readonly detail: string;
      readonly diagnostics: readonly Diagnostic[];
    }
  | { readonly kind: 'write-failed'; readonly code: string; readonly message: string };

export interface LockCommandDeps {
  readonly lockPath: string;
  readonly now: () => string;
  readonly write?: (lockPath: string, lock: LockFile) => Promise<WriteResult>;
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
    return { kind: 'refused', why: 'expect-mismatch', expected: expectDigest, onDisk: policy.manifest.digest };
  }

  const request = requestFor(policy, deps.now());
  if (request === null) return { kind: 'up-to-date' };

  const verdict = await confirm(request, renderRequest(request));

  // Перечитка ПОСЛЕ ответа человека — та самая половина R15a, что закрывает окно подмены.
  // Молча упавшая перечитка была бы fail-open, поэтому её результат разбирается.
  const reloaded = await store.reloadManifest();
  if (reloaded.outcome !== 'reloaded') {
    return {
      kind: 'refused',
      why: 'reload-failed',
      detail:
        reloaded.outcome === 'unreadable'
          ? `манифест не читается (${reloaded.code}): ${reloaded.message}`
          : 'манифест перестал соответствовать схеме, пока показывался дифф',
      diagnostics: reloaded.outcome === 'invalid' ? reloaded.diagnostics : [],
    };
  }

  // Снимок берётся из результата перезагрузки, а не повторным `current()`: между двумя
  // обращениями вотчер может подвинуть стор, и на самом охраняемом пути лишний источник
  // расхождения не нужен.
  const fresh = reloaded.policy;
  const applicability = verdictApplicability(verdict, fresh.manifest);
  if (applicability === 'denied') return { kind: 'refused', why: 'denied' };
  if (applicability === 'stale') {
    return { kind: 'refused', why: 'stale', approved: verdict.manifestHash, onDisk: fresh.manifest.digest };
  }

  try {
    const result = await write(deps.lockPath, buildLock(fresh.manifest, verdict.decidedAt));
    return result.durable ? { kind: 'written', durable: true } : { kind: 'written', durable: false, ...(result.reason === undefined ? {} : { reason: result.reason }) };
  } catch (error) {
    const code = error instanceof LockWriteError ? error.code : 'UNKNOWN';
    return { kind: 'write-failed', code, message: error instanceof Error ? error.message : String(error) };
  }
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

  // Разбор аргументов — ДО загрузки: аргумент, заданный неверно, не должен приводить к показу
  // диффа, ответ на который всё равно будет отвергнут.
  const expect = parseExpect(argv);
  if (expect.kind === 'invalid') {
    process.stderr.write(`${expect.reason}\n`);
    return 2;
  }

  const start = await startStore(manifestPath, lockPath);
  if (start.outcome !== 'started') {
    // Сломанный манифест — отказ, а не повод записать lock: реакции на два файла асимметричны
    // намеренно (R3).
    process.stderr.write(`манифест не загружен (${start.outcome}): ${describeStartFailure(start)}\n`);
    return 2;
  }

  const outcome = await runLockCommand(start.store, confirmTty, expect.kind === 'digest' ? expect.digest : null, {
    lockPath,
    now: () => new Date().toISOString(),
  });

  return report(outcome);
}

/** Печать исхода и код выхода. Каждый отказ печатает свою улику, а не свой тег. */
function report(outcome: LockCommandOutcome): number {
  switch (outcome.kind) {
    case 'written':
      process.stdout.write(`${LOCK_FILE} записан.\n`);
      if (!outcome.durable) {
        // Файл на месте и корректен: это предупреждение о долговечности, а не отказ, и код
        // выхода остаётся нулевым — иначе человек одобрял бы заново уже записанный lock.
        process.stderr.write(`предупреждение: каталог не синхронизирован (${outcome.reason ?? 'причина не указана'}).\n`);
      }
      return 0;
    case 'up-to-date':
      process.stdout.write(`${LOCK_FILE} уже совпадает с манифестом.\n`);
      return 0;
    case 'write-failed':
      process.stderr.write(`${LOCK_FILE} не записан, ошибка записи (${outcome.code}): ${outcome.message}\n`);
      return 3;
    case 'refused':
      process.stderr.write(`${LOCK_FILE} не записан: ${refusalText(outcome)}\n`);
      return 1;
  }
}

function refusalText(outcome: Extract<LockCommandOutcome, { kind: 'refused' }>): string {
  switch (outcome.why) {
    case 'denied':
      return 'вы отказались.';
    case 'stale':
      return [
        'манифест изменился между показом диффа и вашим ответом — вердикт не действует.',
        `  одобрен дайджест: ${outcome.approved}`,
        `  на диске сейчас:  ${outcome.onDisk}`,
        '  запустите команду снова и прочитайте дифф заново.',
      ].join('\n');
    case 'expect-mismatch':
      return [
        'манифест на диске не тот, ради которого команда была запущена.',
        `  ожидался дайджест: ${outcome.expected}`,
        `  на диске сейчас:   ${outcome.onDisk}`,
      ].join('\n');
    case 'reload-failed':
      return [
        `перечитка манифеста после ответа не удалась: ${outcome.detail}`,
        ...outcome.diagnostics.map((one) => `  ${one.pointer || '(документ)'}: ${one.message}`),
      ].join('\n');
  }
}

/**
 * Тип сужен до отказов: с полным `StartResult` компилятор не мог доказать тотальность, и
 * появлялась недостижимая ветка, молча вернувшая бы пустую причину, если бы исполнилась.
 */
function describeStartFailure(start: Exclude<Awaited<ReturnType<typeof startStore>>, { outcome: 'started' }>): string {
  return start.outcome === 'invalid-manifest'
    ? start.diagnostics.map((one) => `${one.pointer || '(документ)'}: ${one.message}`).join('; ')
    : `${start.code}: ${start.message}`;
}
