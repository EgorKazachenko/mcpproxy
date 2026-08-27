import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ChainedEvent, OtlpSpan } from '@mcpproxy/contracts';
import { toOtlp } from '@mcpproxy/contracts';
import { unchain } from '@mcpproxy/contracts/audit';
import type { LogVerification } from './log.js';
import { readLog, verifyLog } from './log.js';

/**
 * Экспорт журнала — то, что S9 показывает сразу после бейджа «цепочка верифицирована».
 *
 * **Вердикт едет вместе с файлом (R22).** Экспортированный лог без вердикта требует доверия
 * к тому, кто его экспортировал, — то есть ровно того, чего цепочка и должна была избежать.
 * Получатель при этом не обязан верить и сайдкару: у него есть сам JSONL и публичная формула,
 * так что вердикт он перепроверяет сам. Сайдкар — это заявление экспортёра, а не пломба.
 *
 * **Наружу ничего не уходит (R24).** Функции пишут файлы в указанный каталог; отправку
 * запускает человек. Сетевых зависимостей у модуля нет.
 */

export interface ExportManifest {
  /** Версия формы сайдкара. Своя, не контрактная: `AuditEvent` этой формы не описывает. */
  readonly manifest: 'mcpproxy.audit.export/1';
  /** Откуда экспортировано — имя файла, а не полный путь: путь несёт домашний каталог. */
  readonly source: string;
  readonly count: number;
  /** `chain.self` первой и последней записи: два конца цепочки, между ними всё остальное. */
  readonly first: string | null;
  readonly last: string | null;
  readonly verifiedAt: string;
  readonly verification: LogVerification;
  /** Последняя строка была недописана: демон убит на середине. Не подделка (R19). */
  readonly trailingPartial: boolean;
  /** Индексы записей, чья версия формы новее известной нам (R20). */
  readonly future: readonly number[];
}

export interface ExportResult {
  readonly logPath: string;
  readonly manifestPath: string;
  readonly manifest: ExportManifest;
}

export interface ExportOptions {
  /** Часы. Инъекция, а не `new Date()` внутри: иначе `verifiedAt` не проверить тестом. */
  readonly now?: () => Date;
}

/**
 * Кладёт рядом две вещи: побайтовую копию журнала и сайдкар с вердиктом.
 *
 * Копия — именно **копия**, а не пересериализация разобранных записей. Пересериализация
 * прогнала бы каждую запись через `JSON.stringify` этой версии кода, порядок ключей мог бы
 * поехать, а вместе с ним — и дайджесты, которые получатель считает сам. Экспорт обязан
 * отдавать те же байты, на которых цепочка сходилась у нас.
 */
export function exportJsonl(logPath: string, destDir: string, options: ExportOptions = {}): ExportResult {
  const now = options.now ?? (() => new Date());
  const log = readLog(logPath);
  const verification = verifyLog(log);

  mkdirSync(destDir, { recursive: true, mode: 0o700 });

  const name = basename(logPath);
  const copiedPath = join(destDir, name);
  copyFileSync(logPath, copiedPath);

  const manifest: ExportManifest = {
    manifest: 'mcpproxy.audit.export/1',
    source: name,
    count: log.records.length,
    first: log.records[0]?.chain.self ?? null,
    last: log.records.at(-1)?.chain.self ?? null,
    verifiedAt: now().toISOString(),
    verification,
    trailingPartial: log.trailingPartial,
    future: log.future,
  };

  const manifestPath = join(destDir, `${name}.manifest.json`);
  // Права те же, что у журнала: копия несёт ровно те же `argv` и `cwd`, что и оригинал,
  // и делать её читаемой всем при экспорте — вернуть A12 через дверь, которую сами открыли.
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

  return { logPath: copiedPath, manifestPath, manifest };
}

/**
 * Сводка в OTLP (R23).
 *
 * `toOtlp` заморожен в E0 и отдаёт **сводку, а не полную запись**: спан несёт длины
 * (`mcpproxy.redactions.count`), но не сами массивы, и не несёт вовсе `sandbox.profile`,
 * `risk.annotations` и `chain`. Полная запись живёт в JSONL — это ADR-0003, и переносить её
 * в спан значило бы отправить в чужой observability-стек то, ради чего лог держат локально.
 *
 * `chain` снимается через `unchain` контракта, а не спредом: `toOtlp` принимает `AuditEvent`,
 * и подсовывать ему `ChainedEvent` структурно можно, но тогда решение «цепочка в спан не
 * едет» держалось бы на том, что `toOtlp` про неё не знает, — а не на этой строке.
 */
export const exportOtlp = (events: readonly ChainedEvent[]): readonly OtlpSpan[] =>
  events.map((event) => toOtlp(unchain(event)));
