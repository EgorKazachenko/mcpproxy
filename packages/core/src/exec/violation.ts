import type { SandboxViolation, ViolationType } from '@mcpproxy/contracts';

/**
 * Грамматика строки нарушения — отдельно от политики классификации.
 *
 * Две функции, а не одна: у прежней единой было четыре причины меняться — грамматика лога,
 * список шума, семантика путей и бейдж S6, — и тест любой из них строил бы вход,
 * удовлетворяющий всем четырём сразу.
 *
 * Модуль чистый: `resolvePath` **инжектируется** (R40), потому что `realpathSync.native` —
 * синхронный сисколл, и модуль, зовущий его сам, не чист, а его тест требовал бы настоящих
 * путей на диске вместо стаба. Он же оказался бы на горячем пути каждой строки лога живого
 * процесса.
 */

export interface RawViolationRecord {
  readonly source: 'kernel' | 'proxy';
  readonly operation: string;
  readonly target: string;
  /**
   * Исходная строка целиком. Поле есть, чтобы «неразобрано» докладывалось честно: без него
   * `classify` реконструировал бы строку из разобранных частей и терял ровно то, из-за чего
   * она и не разобралась.
   */
  readonly line: string;
}

/**
 * Размеченное объединение, потому что `SandboxViolation` заморожен на четырёх полях
 * (`packages/contracts/src/event.ts:116`) и слота под «неразобрано» не имеет.
 *
 * Складывать неузнанные строки в `type: 'process'` нельзя: это **настоящий** член
 * `ViolationType`, означающий нарушение процесса, и, разделив с ним тег, ни то ни другое
 * больше не посчитать и не отфильтровать — то есть требование «явный неразобрано, а не
 * молча роняет» было бы побеждено классификацией.
 *
 * `null` при этом перестаёт значить две разные вещи разом: «шум, отброшен намеренно» —
 * это `kind: 'suppressed'`, а не отсутствие результата.
 */
export type ParsedLine =
  | { readonly kind: 'violation'; readonly violation: SandboxViolation }
  | { readonly kind: 'suppressed'; readonly operation: string }
  | { readonly kind: 'unrecognized'; readonly line: string };

/**
 * Операции, не отображаемые ни в один член `ViolationType` (R39).
 *
 * Список не выдуман: это ровно те операции, которые вендорский профиль разрешает адресно
 * (`macos-sandbox-utils.js:450-640`), то есть которые `(deny default)` логирует всякий раз,
 * когда узкий `allow` не совпал. Проба П1 поймала два `sysctl-read kern.iossupportversion`
 * на тривиальный `cat` и `mach-lookup com.apple.SystemConfiguration.configd` на каждый
 * `curl`; сырой проброс залил бы таймлайн мусором на каждом вызове и утопил бы в нём
 * настоящее нарушение.
 *
 * Список — **явная константа**, а не префиксная регулярка: операция, которой здесь нет,
 * приходит как «неразобрано» и потому громко видна. Это дороже, чем тихо подавить, и
 * дешевле, чем тихо потерять.
 */
export const SUPPRESSED_OPERATIONS: readonly string[] = [
  'appleevent-send',
  'distributed-notification-post',
  'file-ioctl',
  'iokit-get-properties',
  'iokit-open',
  'ipc-posix-sem',
  'ipc-posix-shm',
  'lsopen',
  'mach-lookup',
  'mach-priv-task-port',
  'process-info',
  'signal',
  'sysctl-read',
  'sysctl-write',
  'system-socket',
  'user-preference-read',
] as const;

const SUPPRESSED = new Set(SUPPRESSED_OPERATIONS);

/**
 * Отображение операции ядра в член `ViolationType`. Правило префиксное и оттого короткое,
 * но перечислено явно: seatbelt именует одну и ту же семью десятком имён
 * (`file-write-data`, `file-write-create`, `file-write-unlink`, …), и перечислить их все
 * значит однажды не перечислить одно и молча выронить нарушение записи.
 */
const TYPE_BY_PREFIX: ReadonlyArray<readonly [string, ViolationType]> = [
  ['file-read', 'file-read'],
  ['file-write', 'file-write'],
  ['network', 'network'],
  ['process-exec', 'process'],
  ['process-fork', 'process'],
  // Отказ прокси на уровне запроса — тоже сетевое нарушение: это отказ соединению, просто
  // принятый на уровень выше транспорта. Отдельного члена `ViolationType` под него нет и
  // заводить его нельзя — юнион заморожен.
  ['http-request', 'network'],
];

/** Ядро: `<proc>(<pid>) deny(<n>) <operation> [<target>]` (факт Ф1). */
const KERNEL = /^(?<proc>.+?)\((?<pid>\d+)\) deny\((?<count>\d+)\) (?<operation>[a-z0-9*-]+)(?: (?<target>.*))?$/;

/** Прокси, транспортный отказ: `deny network-outbound <host>:<port> (<reason>)` (факт Ф3). */
const PROXY_TRANSPORT = /^deny network-outbound (?<target>.+?) \((?<reason>.*)\)$/;

/**
 * Прокси, отказ на уровне запроса: `deny http-request <method> <url> (<reason>)`
 * (`sandbox-manager.js:374`).
 *
 * При нашем дизайне возникает **только** на некорректном URL: строку пишет
 * `onFilterRequestDenied`, срабатывающий когда колбэк отказал или бросил, а наш колбэк
 * всегда разрешает (R26). Разбирается всё равно: грамматика, которую парсер не знает,
 * уезжает в «неразобрано» и выглядит как дефект нашего кода.
 */
const PROXY_REQUEST = /^deny http-request (?<method>\S+) (?<url>\S+) \((?<reason>.*)\)$/;

/**
 * Строка → запись. `null` — строка ни одной из трёх грамматик не соответствует; решение,
 * что с этим делать, принимает вызывающий (`parseAndClassify` даёт `unrecognized`).
 *
 * **Дедупликации нет и быть не должно.** Дедуплицировать нечего, а правило «commandId плюс
 * хост плюс близость по времени» было бы вредным: под семафором `commandId` постоянен на
 * весь вызов, и цикл, стучащийся на один хост пятьдесят раз, схлопнулся бы в одно событие,
 * занизив ровно ту цифру, которую показывает S5.
 */
export function parseLine(line: string): RawViolationRecord | null {
  const text = line.trim();

  const transport = PROXY_TRANSPORT.exec(text);
  if (transport?.groups !== undefined) {
    return { source: 'proxy', operation: 'network-outbound', target: transport.groups['target'] ?? '', line: text };
  }

  const request = PROXY_REQUEST.exec(text);
  if (request?.groups !== undefined) {
    const method = request.groups['method'] ?? '';
    const url = request.groups['url'] ?? '';
    return { source: 'proxy', operation: 'http-request', target: `${method} ${url}`, line: text };
  }

  const kernel = KERNEL.exec(text);
  if (kernel?.groups !== undefined) {
    return {
      source: 'kernel',
      operation: kernel.groups['operation'] ?? '',
      target: kernel.groups['target'] ?? '',
      line: text,
    };
  }

  return null;
}

/**
 * Зеркало вендорского `globToRegex` (`sandbox-utils.js:743`) с расширением
 * `denyGlobRegex` (`macos-sandbox-utils.js:63`): запрет по глобу покрывает всё, что лежит
 * под совпадением, ровно как `subpath` покрывает поддерево для литерала.
 *
 * Копия, а не импорт: модуль обязан оставаться свободным от вендора в рантайме. Согласие
 * копии с оригиналом проверяет `violation.test.ts`, гоняя настоящую вендорскую функцию.
 */
function denyGlobToRegex(glob: string): RegExp {
  const body = glob
    .replace(/[.^$+{}()|\\]/g, '\\$&')
    .replace(/\[([^\]]*?)$/g, '\\[$1')
    .replace(/\*\*\//g, ' GLOBSTAR_SLASH ')
    .replace(/\*\*/g, ' GLOBSTAR ')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/ GLOBSTAR_SLASH /g, '(.*/)?')
    .replace(/ GLOBSTAR /g, '.*');
  return new RegExp(`^${body}(/.*)?$`);
}

const GLOB_CHARS = /[*?[\]]/;

/**
 * Статический префикс шаблона до первого глоб-символа. srt резолвит символьные ссылки
 * именно на нём (`sandbox-utils.js:317-336`), поэтому и нам сравнивать надо после того же
 * резолва: в конфиг кладётся `/tmp/x`, а в строке лога приезжает `/private/tmp/x`.
 */
function resolveGlobPrefix(pattern: string, resolvePath: (path: string) => string): string {
  const match = GLOB_CHARS.exec(pattern);
  if (match === null) return safeResolve(pattern, resolvePath);

  const staticPrefix = pattern.slice(0, match.index);
  const cut = staticPrefix.lastIndexOf('/');
  if (cut <= 0) return pattern;

  const baseDir = staticPrefix.slice(0, cut);
  return safeResolve(baseDir, resolvePath) + pattern.slice(cut);
}

/**
 * Резолв, который не роняет классификацию. `realpathSync` бросает на несуществующем пути —
 * а несуществующий путь тут норма: запись отказана как раз потому, что файла нет и не
 * будет. Ветка проверяется явно, с непустым `mandatoryPaths`: с пустым списком любая
 * реализация закоротила бы до вызова резолвера, и падение резолвера не исполнилось бы.
 */
function safeResolve(path: string, resolvePath: (path: string) => string): string {
  try {
    return resolvePath(path);
  } catch {
    return path;
  }
}

export interface ClassifyPolicy {
  /** Глобы обязательных запретов, как их отдал `mandatoryDenyGlobs` (R9). */
  readonly mandatoryPaths: readonly string[];
  readonly resolvePath: (path: string) => string;
}

/**
 * Запись → классифицированная строка.
 *
 * Сопоставление идёт **глоба с реальным путём**, а не строки со строкой (R28): наши
 * `mandatoryPaths` после R9 — глобы, цель из лога ядра приходит реальным путём (проба П1),
 * и статический префикс шаблона srt резолвит тоже. Реализация через `includes(target)`
 * зеленеет на литеральной фикстуре и вырождается в `file-write` в продакшене — то есть
 * бейдж S6 умирает молча.
 */
export function classify(record: RawViolationRecord, policy: ClassifyPolicy): ParsedLine {
  if (SUPPRESSED.has(record.operation)) return { kind: 'suppressed', operation: record.operation };

  const type = typeForOperation(record.operation);
  if (type === null) return { kind: 'unrecognized', line: record.line };

  const finalType = type === 'file-write' && isMandatory(record.target, policy) ? 'mandatory-deny' : type;

  return {
    kind: 'violation',
    violation: {
      type: finalType,
      target: record.target,
      action: 'denied',
      // Байт у отказа нет и быть не может: соединение не состоялось, запись не произошла.
      // Число тела даёт только `filterRequest` для разрешённого трафика (R15, R26).
      bytes: 0,
    },
  };
}

/**
 * Операция → член `ViolationType`, или `null`, если такого члена нет.
 *
 * Экспортируется ради теста, и это не удобство: список подавления обязан не пересекаться с
 * отображением, иначе одна строка в константе выключает бейдж S6 целиком. Утверждать это
 * свойство перечислением двух имён — значит проверять два имени; утверждать его через эту
 * функцию — значит проверять весь список, включая имена, которых там ещё нет.
 */
export function typeForOperation(operation: string): ViolationType | null {
  for (const [prefix, type] of TYPE_BY_PREFIX) {
    if (operation.startsWith(prefix)) return type;
  }
  return null;
}

/**
 * Классификация в `mandatory-deny` отделена от `file-write` — S6 требует отдельного бейджа
 * (R28), потому что «команда попыталась переписать git-хук» и «команда попыталась записать
 * файл вне разрешённой зоны» — разные новости для человека.
 */
function isMandatory(target: string, policy: ClassifyPolicy): boolean {
  if (policy.mandatoryPaths.length === 0) return false;
  const resolvedTarget = safeResolve(target, policy.resolvePath);

  return policy.mandatoryPaths.some((pattern) => {
    const resolved = resolveGlobPrefix(pattern, policy.resolvePath);
    return denyGlobToRegex(resolved).test(resolvedTarget) || denyGlobToRegex(pattern).test(target);
  });
}

/** Шов для вызывающего: неразобранная строка получает свой тег, а не молча исчезает (R27). */
export function parseAndClassify(line: string, policy: ClassifyPolicy): ParsedLine {
  const record = parseLine(line);
  if (record === null) return { kind: 'unrecognized', line: line.trim() };
  return classify(record, policy);
}
