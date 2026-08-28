import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ChainedEvent, OtlpSpan } from '@mcpproxy/contracts';
import { toOtlp } from '@mcpproxy/contracts';
import { unchain } from '@mcpproxy/contracts/audit';
import type { LogVerification } from './log.js';
import { AuditLogError, readLog, verifyLog } from './log.js';

/**
 * Экспорт журнала — то, что S9 показывает сразу после бейджа «цепочка верифицирована».
 *
 * **Вердикт едет вместе с файлом (R22).** Экспортированный лог без вердикта требует доверия
 * к тому, кто его экспортировал, — то есть ровно того, чего цепочка и должна была избежать.
 * Получатель при этом не обязан верить и сайдкару: у него есть сам JSONL и публичная формула,
 * так что вердикт он перепроверяет сам. Сайдкар — это заявление экспортёра, а не пломба.
 *
 * **Наружу ничего не уходит (R24).** Функции пишут файлы в указанный каталог; отправку
 * запускает человек. Сетевых зависимостей у модуля нет, и это проверяется по графу в
 * `deps.test.ts`, а не обещанием здесь.
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
  /**
   * Первая неразобранная строка, если она есть.
   *
   * В сайдкаре отдельным полем, а не только внутри `verification`: получателю нужно знать,
   * что за точкой разрыва в файле **лежат ещё байты**, которых нет в `count`. Без этого поля
   * экспорт порченого журнала выглядит как экспорт короткого целого.
   */
  readonly malformedAt: number | null;
  /** Индексы записей, чья версия формы новее известной нам (R20). */
  readonly future: readonly number[];
  /** Индексы записей, чья версия формы старее нашей. */
  readonly legacy: readonly number[];
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
 *
 * **Порядок операций — копия, ПОТОМ чтение копии.** Демон дописывает журнал на каждой стадии
 * каждого вызова, поэтому «прочитать оригинал → скопировать» оставляет окно: `count`, `first`,
 * `last` и, главное, `verification` описывали бы префикс, а рядом лежал бы файл длиннее.
 * Получатель, который по замыслу перепроверяет вердикт сам, получил бы другое число записей —
 * то есть терялось бы ровно то свойство, ради которого сайдкар и существует. Читая КОПИЮ,
 * гонку убираем по построению, без блокировок.
 */
export function exportJsonl(logPath: string, destDir: string, options: ExportOptions = {}): ExportResult {
  // Проверка ДО `mkdirSync`: иначе отсутствующий журнал оставлял бы за собой созданный каталог
  // назначения и падал сырым `ENOENT` из `node:fs`, мимо диагностик модуля.
  if (!existsSync(logPath)) {
    throw new AuditLogError('corrupt', logPath, `журнала ${logPath} не существует: экспортировать нечего`);
  }

  const now = options.now ?? (() => new Date());

  mkdirSync(destDir, { recursive: true, mode: 0o700 });

  const name = basename(logPath);
  const copiedPath = join(destDir, name);
  copyFileSync(logPath, copiedPath);

  // Момент снимка — сразу после копии. Он же делает окно «копия сделана, но ещё не прочитана»
  // НАБЛЮДАЕМЫМ: тест, дописывающий журнал изнутри этих часов, обязан не сдвинуть ни одного
  // поля манифеста, потому что читается копия. Реализация, читающая оригинал, на этом краснеет.
  const verifiedAt = now().toISOString();

  const log = readLog(copiedPath);
  const verification = verifyLog(log);

  const manifest: ExportManifest = {
    manifest: 'mcpproxy.audit.export/1',
    source: name,
    count: log.records.length,
    first: log.records[0]?.chain.self ?? null,
    last: log.records.at(-1)?.chain.self ?? null,
    verifiedAt,
    verification,
    trailingPartial: log.trailingPartial,
    malformedAt: log.malformedAt,
    future: log.future,
    legacy: log.legacy,
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
