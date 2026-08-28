import { describe, expect, it } from 'vitest';
import { globToRegex } from '@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js';
import { SUPPRESSED_OPERATIONS, classify, parseAndClassify, parseLine, typeForOperation } from './violation.js';
import type { ClassifyPolicy, RawViolationRecord } from './violation.js';

/**
 * Три строки из пробы П1 — дословно, а не выдуманные. На тривиальный `cat` прилетают два
 * `sysctl-read` и одно настоящее нарушение чтения; именно это число «выживает одна» и
 * утверждает первый тест.
 */
const P1_LINES = [
  'bash(10515) deny(1) sysctl-read kern.iossupportversion',
  'cat(10515) deny(1) sysctl-read kern.iossupportversion',
  'cat(10515) deny(1) file-read-data /private/var/folders/zz/p1-TGNn5Y/secret.txt',
];

/** Стаб резолвера: моделирует macOS-ную ссылку `/tmp` → `/private/tmp` с обеих сторон. */
const realpathStub = (path: string): string => (path.startsWith('/tmp/') || path === '/tmp' ? `/private${path}` : path);

const EMPTY_POLICY: ClassifyPolicy = { mandatoryPaths: [], resolvePath: realpathStub };

const policyWith = (mandatoryPaths: readonly string[]): ClassifyPolicy => ({
  mandatoryPaths,
  resolvePath: realpathStub,
});

describe('parseLine — три грамматики (R27)', () => {
  it('ядро: <proc>(<pid>) deny(<n>) <operation> <target>', () => {
    expect(parseLine(P1_LINES[2] as string)).toEqual({
      source: 'kernel',
      operation: 'file-read-data',
      target: '/private/var/folders/zz/p1-TGNn5Y/secret.txt',
      line: P1_LINES[2],
    });
  });

  it('прокси, транспортный отказ: другая грамматика, без proc(pid) и без deny(n)', () => {
    expect(parseLine('deny network-outbound evil.invalid:80 (host is not on the allow list)')).toEqual({
      source: 'proxy',
      operation: 'network-outbound',
      target: 'evil.invalid:80',
      line: 'deny network-outbound evil.invalid:80 (host is not on the allow list)',
    });
  });

  it('прокси, отказ на уровне запроса — разбирается, а не уезжает в «неразобрано»', () => {
    const parsed = parseLine('deny http-request GET https://h/p (bad url)');
    expect(parsed).toMatchObject({ source: 'proxy', operation: 'http-request', target: 'GET https://h/p' });
    // И классифицируется как сетевое: отказ соединению, принятый уровнем выше транспорта.
    expect(classify(parsed as RawViolationRecord, EMPTY_POLICY)).toMatchObject({
      kind: 'violation',
      violation: { type: 'network' },
    });
  });

  it('строка неизвестной формы даёт явный «неразобрано», а не член ViolationType', () => {
    const parsed = parseAndClassify('какой-то мусор из лога', EMPTY_POLICY);
    expect(parsed).toEqual({ kind: 'unrecognized', line: 'какой-то мусор из лога' });
    // Именно НЕ 'process': это настоящий член юниона, и, разделив с ним тег, ни то ни
    // другое больше не посчитать и не отфильтровать.
    expect(parsed.kind).not.toBe('violation');
  });

  /**
   * Разобранная строка с операцией, которой нет ни в отображении, ни в списке шума — это
   * НЕ то же самое, что неразобранная строка: грамматика узнана, семантика нет. Ветка
   * своя, и без этого утверждения она проверяется только через `parseLine`-null, то есть
   * не проверяется вовсе — реализация, кладущая такую операцию в `type: 'process'`,
   * оставалась бы зелёной.
   */
  it('узнанная грамматика с неизвестной операцией даёт «неразобрано», а не process', () => {
    const parsed = parseAndClassify('nvram(999) deny(1) nvram-get boot-args', EMPTY_POLICY);
    expect(parsed).toEqual({ kind: 'unrecognized', line: 'nvram(999) deny(1) nvram-get boot-args' });
  });

  it('не дедуплицирует: пятьдесят отказов к одному хосту остаются пятьюдесятью', () => {
    // Схлопывание занизило бы ровно ту цифру, которую показывает S5: под семафором
    // `commandId` постоянен на весь вызов, и цикл на один хост стал бы одним событием.
    const fifty = Array.from({ length: 50 }, () => 'deny network-outbound evil.invalid:80 (host is not on the allow list)');
    expect(fifty.map((line) => parseLine(line)).filter((one) => one !== null)).toHaveLength(50);
  });
});

describe('classify — шум и счёт выживших (R39)', () => {
  it('на трёх строках вывода `cat` из П1 выживает ровно одна', () => {
    const survivors = P1_LINES.map((line) => parseAndClassify(line, EMPTY_POLICY)).filter(
      (one) => one.kind === 'violation',
    );
    expect(survivors).toHaveLength(1);
    expect(survivors[0]).toMatchObject({ violation: { type: 'file-read', action: 'denied', bytes: 0 } });
  });

  it('подавляет именно шум, и «подавлено» отличимо от «не разобрано»', () => {
    expect(parseAndClassify(P1_LINES[0] as string, EMPTY_POLICY)).toEqual({
      kind: 'suppressed',
      operation: 'sysctl-read',
    });
    expect(parseAndClassify('curl(11052) deny(1) mach-lookup com.apple.SystemConfiguration.configd', EMPTY_POLICY)).toEqual({
      kind: 'suppressed',
      operation: 'mach-lookup',
    });
  });

  /**
   * Свойство **универсальное**, а не два имени: список подавления обязан не пересекаться с
   * отображением в `ViolationType` целиком. Перечисление `file-write-data` и
   * `network-outbound` проверяло ровно эти две строки — замер: добавление
   * `file-write-create` (настоящее имя из семьи записи, которую `TYPE_BY_PREFIX`
   * перечисляет явно) оставляло весь файл зелёным, а краснел только интеграционный тест
   * бейджа S6, то есть **невидимо на Linux-раннере**. Одна строка в константе выключала бы
   * бейдж молча.
   */
  it('ни одна подавляемая операция не отображается в член ViolationType', () => {
    const overlapping = SUPPRESSED_OPERATIONS.filter((operation) => typeForOperation(operation) !== null);
    expect(overlapping).toEqual([]);
  });

  it('и каждая из них действительно подавляется', () => {
    for (const operation of SUPPRESSED_OPERATIONS) {
      expect(classify({ source: 'kernel', operation, target: '/x', line: 'x' }, EMPTY_POLICY)).toEqual({
        kind: 'suppressed',
        operation,
      });
    }
  });

  it('а операции с типом — наоборот, доезжают нарушениями', () => {
    // Положительный контроль к отрицанию выше: без него «пересечения нет» было бы зелено и
    // на пустом отображении.
    for (const operation of ['file-write-data', 'file-read-data', 'network-outbound', 'process-exec']) {
      expect(typeForOperation(operation)).not.toBeNull();
    }
  });
});

describe('classify — бейдж mandatory-deny (R28)', () => {
  it('цель в списке обязательных запретов даёт mandatory-deny, а не file-write', () => {
    const record: RawViolationRecord = {
      source: 'kernel',
      operation: 'file-write-data',
      target: '/private/tmp/x/.git/hooks/pre-commit',
      line: 'bash(12042) deny(1) file-write-data /private/tmp/x/.git/hooks/pre-commit',
    };
    expect(classify(record, policyWith(['/tmp/x/**/.git/hooks']))).toMatchObject({
      kind: 'violation',
      violation: { type: 'mandatory-deny' },
    });
  });

  /**
   * Фикстура несёт **глоб и вложенную цель**, а не литерал: реализация через
   * `mandatoryPaths.includes(target)` зеленеет на литеральной фикстуре и вырождается в
   * `file-write` в продакшене — бейдж S6 умирает молча. Плюс `/tmp` → `/private/tmp` с
   * обеих сторон: без резолва статического префикса шаблона сравнение не сойдётся никогда.
   */
  it('матчит глоб с реальным путём на глубине, а не строку со строкой', () => {
    const record: RawViolationRecord = {
      source: 'kernel',
      operation: 'file-write-data',
      target: '/private/tmp/x/sub/.git/hooks/pre-commit',
      line: 'bash(1) deny(1) file-write-data /private/tmp/x/sub/.git/hooks/pre-commit',
    };
    expect(classify(record, policyWith(['/tmp/x/**/.git/hooks']))).toMatchObject({
      kind: 'violation',
      violation: { type: 'mandatory-deny' },
    });
  });

  it('обычная запись вне списка остаётся file-write', () => {
    const record: RawViolationRecord = {
      source: 'kernel',
      operation: 'file-write-data',
      target: '/private/tmp/x/ordinary.txt',
      line: 'bash(11433) deny(1) file-write-data /private/tmp/x/ordinary.txt',
    };
    expect(classify(record, policyWith(['/tmp/x/**/.git/hooks']))).toMatchObject({
      kind: 'violation',
      violation: { type: 'file-write' },
    });
  });

  it('падение резолвера не роняет классификацию', () => {
    // `mandatoryPaths` непустой намеренно: с пустым списком любая реализация закоротит до
    // вызова резолвера, и ветка его падения не исполнится вовсе.
    const throwing: ClassifyPolicy = {
      mandatoryPaths: ['/private/tmp/x/**/.git/hooks'],
      resolvePath: () => {
        throw new Error('нет пути');
      },
    };
    const record: RawViolationRecord = {
      source: 'kernel',
      operation: 'file-write-data',
      target: '/private/tmp/x/.git/hooks/pre-commit',
      line: 'bash(1) deny(1) file-write-data /private/tmp/x/.git/hooks/pre-commit',
    };
    const parsed = classify(record, throwing);
    expect(parsed.kind).toBe('violation');
    // Резолвер упал, но шаблон и цель уже в одном пространстве имён — бейдж сохраняется.
    expect(parsed).toMatchObject({ violation: { type: 'mandatory-deny' } });
  });

  it('чтение в mandatory-deny не переклассифицируется — бейдж про запись', () => {
    const record: RawViolationRecord = {
      source: 'kernel',
      operation: 'file-read-data',
      target: '/private/tmp/x/.git/hooks/pre-commit',
      line: 'cat(1) deny(1) file-read-data /private/tmp/x/.git/hooks/pre-commit',
    };
    expect(classify(record, policyWith(['/tmp/x/**/.git/hooks']))).toMatchObject({
      violation: { type: 'file-read' },
    });
  });
});

/**
 * Наш глоб-в-регулярку — копия вендорского `globToRegex` (`sandbox-utils.js:743`), потому
 * что модуль обязан оставаться свободным от вендора в рантайме. Копия без сверки устаревает
 * молча; вот сверка, и она гоняет настоящую вендорскую функцию.
 */
describe('конформанс глоб-матчинга с вендором', () => {
  it('на каждом шаблоне наш матчер совпадает с вендорским по включению пути', () => {
    const CASES: ReadonlyArray<readonly [string, string]> = [
      ['/tmp/x/**/.git/hooks', '/tmp/x/.git/hooks'],
      ['/tmp/x/**/.git/hooks', '/tmp/x/sub/.git/hooks'],
      ['/tmp/x/**/.git/hooks', '/tmp/x/other/file'],
      ['/tmp/x/**/.zshrc', '/tmp/x/.zshrc'],
      ['/tmp/x/**/.zshrc', '/tmp/y/.zshrc'],
      ['/tmp/x/*.env', '/tmp/x/prod.env'],
      ['/tmp/x/*.env', '/tmp/x/sub/prod.env'],
    ];

    for (const [pattern, path] of CASES) {
      // Вендорская форма без расширения на поддерево: сравниваем точное совпадение.
      const vendor = new RegExp(globToRegex(pattern)).test(path);
      const ours = classify(
        { source: 'kernel', operation: 'file-write-data', target: path, line: 'x' },
        { mandatoryPaths: [pattern], resolvePath: (one) => one },
      );
      const oursMatched = ours.kind === 'violation' && ours.violation.type === 'mandatory-deny';
      expect({ pattern, path, matched: oursMatched }).toEqual({ pattern, path, matched: vendor });
    }
  });

  it('и расширяет запрет на поддерево совпадения, как denyGlobRegex у вендора', () => {
    // Вендор режет `$` и доклеивает необязательный хвост: запрет по глобу покрывает всё,
    // что лежит под совпадением. Без этого `<корень>/.git/hooks/pre-commit` не совпал бы
    // с `<корень>/**/.git/hooks`, и бейдж S6 не появился бы ни разу.
    const ours = classify(
      {
        source: 'kernel',
        operation: 'file-write-data',
        target: '/tmp/x/.git/hooks/pre-commit',
        line: 'x',
      },
      { mandatoryPaths: ['/tmp/x/**/.git/hooks'], resolvePath: (one) => one },
    );
    expect(ours).toMatchObject({ violation: { type: 'mandatory-deny' } });
    expect(new RegExp(globToRegex('/tmp/x/**/.git/hooks')).test('/tmp/x/.git/hooks/pre-commit')).toBe(false);
  });
});
