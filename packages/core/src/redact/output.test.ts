import { describe, expect, it } from 'vitest';
import { createRedactor, placeholder } from './engine.js';
import { redactInbound, redactOutput } from './output.js';

const redactor = createRedactor();

/** Синтетический токен формы GitHub PAT. 40 символов. */
const PAT = 'ghp_016ABCdefGHIjklMNOpqrSTUvwxYZ0123456';
/** Начало секрета — то, что не имеет права уцелеть ни при какой обрезке. */
const PAT_HEAD = PAT.slice(0, 12);
const TOKEN = 'kR7pQz2XvN4mB8sT1wY6uH0jL5gC3fD9eA+oI/xZbn';

const NO_LIMIT = { maxBytes: null, redact: true } as const;
const empty = { stdout: '', stderr: '' } as const;

describe('redactOutput', () => {
  it('вырезает секрет из обоих потоков и атрибутирует поток', () => {
    const result = redactOutput(redactor, { stdout: `out ${PAT}`, stderr: `err ${PAT}` }, NO_LIMIT);

    expect(result.stdout).toBe(`out ${placeholder('github-pat')}`);
    expect(result.stderr).toBe(`err ${placeholder('github-pat')}`);
    expect(result.redactions).toEqual([
      { rule: 'github-pat', count: 1, stream: 'stdout' },
      { rule: 'github-pat', count: 1, stream: 'stderr' },
    ]);
  });

  it('R10: секрет, попадающий на границу maxBytes, вырезан ЦЕЛИКОМ', () => {
    // Реализация «сначала обрезали, потом отредактировали» оставляет здесь `ghp_016ABC`:
    // хвост секрета уехал вместе с обрезкой, голова уже не совпадает ни с одним паттерном
    // и приезжает в модель. Это единственный тест, который отличает два порядка.
    const stdout = `${'x'.repeat(40)}${PAT}`;
    const result = redactOutput(redactor, { stdout, stderr: '' }, { maxBytes: 50, redact: true });

    expect(result.stdout).not.toContain(PAT_HEAD);
    expect(result.stdout).not.toContain('ghp_');
    expect(result.output.truncated).toBe(true);
  });

  it('R10: секрет за потолком тоже вырезан, а не просто отрезан', () => {
    // Вариант, где обрезка удалила бы секрет целиком: без редакции он всё равно не уехал бы
    // в модель, но `redactions` осталось бы пустым — то есть журнал не показал бы, что
    // процесс печатал ключ. Отчёт обязан быть о том, ЧТО ПРОИЗОШЛО, а не о том, что доехало.
    const stdout = `${'x'.repeat(200)}${PAT}`;
    const result = redactOutput(redactor, { stdout, stderr: '' }, { maxBytes: 50, redact: true });

    expect(result.redactions).toEqual([{ rule: 'github-pat', count: 1, stream: 'stdout' }]);
  });

  it('R11: bytes — байты того, что реально отдано, после редакции и обрезки', () => {
    const result = redactOutput(redactor, { stdout: 'abcdefghij', stderr: 'xyz' }, NO_LIMIT);
    expect(result.output.bytes).toBe(13);
    expect(result.output.truncated).toBe(false);
  });

  it('R11: bytes считает БАЙТЫ, а не символы', () => {
    // Кириллица в UTF-8 — два байта на символ. Потолок задан в байтах, и счётчик обязан
    // мерить в них же, иначе `maxBytes: 65536` пропускает 128 КиБ кириллического лога.
    const result = redactOutput(redactor, { stdout: 'привет', stderr: '' }, NO_LIMIT);
    expect(result.output.bytes).toBe(12);
  });

  it('обрезка не разрезает многобайтовый символ пополам', () => {
    // Наивный `subarray(0, maxBytes).toString()` даёт U+FFFD на месте разреза: потолок в
    // байтах ПОРТИЛ бы последний символ вместо того, чтобы его выбросить.
    const result = redactOutput(redactor, { stdout: 'привет', stderr: '' }, { maxBytes: 5, redact: true });
    expect(result.stdout).toBe('пр');
    expect(result.stdout).not.toContain('�');
    expect(result.output.truncated).toBe(true);
  });

  it('под потолком ничего не режется', () => {
    const result = redactOutput(redactor, { stdout: 'short', stderr: '' }, { maxBytes: 1000, redact: true });
    expect(result.stdout).toBe('short');
    expect(result.output.truncated).toBe(false);
  });

  it('maxBytes: null — потолка нет', () => {
    const long = 'y'.repeat(100_000);
    const result = redactOutput(redactor, { stdout: long, stderr: '' }, NO_LIMIT);
    expect(result.stdout).toHaveLength(100_000);
    expect(result.output.truncated).toBe(false);
  });

  it('потолок применяется к каждому потоку отдельно, а не к их сумме', () => {
    // Общий бюджет означал бы, что длинный stdout съедает stderr целиком — и при упавшей
    // сборке в модель уезжает гора логов без единой строки ошибки.
    const result = redactOutput(
      redactor,
      { stdout: 'a'.repeat(100), stderr: 'ОШИБКА' },
      { maxBytes: 50, redact: true },
    );
    expect(result.stdout).toHaveLength(50);
    expect(result.stderr).toBe('ОШИБКА');
  });

  it('truncated поднимается, если обрезан ЛЮБОЙ из потоков', () => {
    const result = redactOutput(
      redactor,
      { stdout: 'ok', stderr: 'z'.repeat(100) },
      { maxBytes: 50, redact: true },
    );
    expect(result.output.truncated).toBe(true);
  });

  it('R14: redact: false пропускает вывод как есть', () => {
    const result = redactOutput(redactor, { stdout: `out ${PAT}`, stderr: '' }, { maxBytes: null, redact: false });
    expect(result.stdout).toBe(`out ${PAT}`);
  });

  it('R14: но отчёт пишется даже при redact: false — журнал обязан знать, что ключ печатали', () => {
    // Раньше ветка `if (limits.redact)` выключала и замену, и ПОДСЧЁТ: запись аудита не
    // содержала следа того, что процесс напечатал ключ. R14 требует выключить редакцию и про
    // отчёт не высказывается, а принцип записан этажом выше: отчёт — о том, ЧТО ПРОИЗОШЛО.
    // E0 держит пол, поэтому `redact: false` — явное решение владельца манифеста, и именно
    // тогда сигнал в журнале нужнее всего.
    const result = redactOutput(redactor, { stdout: `out ${PAT}`, stderr: '' }, { maxBytes: null, redact: false });
    expect(result.redactions).toEqual([{ rule: 'github-pat', count: 1, stream: 'stdout' }]);
  });

  it('R14: redact: false НЕ отменяет обрезку — это разные ограничения', () => {
    const result = redactOutput(redactor, { stdout: 'q'.repeat(100), stderr: '' }, { maxBytes: 10, redact: false });
    expect(result.stdout).toHaveLength(10);
    expect(result.output.truncated).toBe(true);
  });

  it('пустой вывод: ноль байт, ничего не обрезано, отчёт пуст', () => {
    const result = redactOutput(redactor, empty, NO_LIMIT);
    expect(result.output).toEqual({ bytes: 0, truncated: false });
    expect(result.redactions).toEqual([]);
  });

  it('отчёт детерминирован: поток по порядку юниона, внутри — правило по имени', () => {
    const result = redactOutput(
      redactor,
      { stdout: `${TOKEN} AKIAIOSFODNN7EXAMPLE`, stderr: PAT },
      NO_LIMIT,
    );
    expect(result.redactions.map((one) => `${one.stream}:${one.rule}`)).toEqual([
      'stdout:aws-access-key-id',
      'stdout:high-entropy-base64',
      'stderr:github-pat',
    ]);
  });
});

describe('redactInbound', () => {
  it('R9: argv для журнала несёт плейсхолдер, а не значение', () => {
    const { argv, redactions } = redactInbound(redactor, {
      argv: ['./scripts/publish.sh', `--token=${PAT}`],
      env: {},
    });

    expect(argv).toEqual(['./scripts/publish.sh', `--token=${placeholder('github-pat')}`]);
    expect(argv.join(' ')).not.toContain('ghp_');
    expect(redactions).toEqual([{ rule: 'github-pat', count: 1, stream: 'argv' }]);
  });

  it('D4: настоящий argv не трогается — правится только копия для журнала', () => {
    const original = ['./scripts/publish.sh', `--token=${PAT}`];
    const { argv } = redactInbound(redactor, { argv: original, env: {} });

    expect(original[1]).toBe(`--token=${PAT}`);
    expect(argv).not.toBe(original);
  });

  it('R8: значения окружения сканируются, а сами наружу не отдаются', () => {
    const result = redactInbound(redactor, { argv: [], env: { CI: 'true', LEAKED: PAT } });

    expect(result.redactions).toEqual([{ rule: 'github-pat', count: 1, stream: 'env' }]);
    expect(JSON.stringify(result)).not.toContain('ghp_');
    // Ни имени переменной, ни значения: в событие уезжает `env.allowed` из buildEnv, и
    // дублировать его здесь значило бы завести вторую копию, расходящуюся с первой.
    expect(JSON.stringify(result)).not.toContain('LEAKED');
  });

  it('R7: энтропия на входящем направлении выключена', () => {
    // В argv лежат пути и значения параметров. Детектор длинных base64-ранов дал бы там
    // ложняки на путях и не добавил бы находок — блобов в argv не бывает.
    const { argv, redactions } = redactInbound(redactor, { argv: [`--session=${TOKEN}`], env: {} });
    expect(argv).toEqual([`--session=${TOKEN}`]);
    expect(redactions).toEqual([]);
  });

  it('R7: выключенная энтропия НЕ отменяет именованные правила на входе', () => {
    const { redactions } = redactInbound(redactor, { argv: [`--k=AKIAIOSFODNN7EXAMPLE`], env: {} });
    expect(redactions).toEqual([{ rule: 'aws-access-key-id', count: 1, stream: 'argv' }]);
  });

  it('счётчик суммируется по всем элементам argv, а не по последнему', () => {
    const { redactions } = redactInbound(redactor, { argv: [`a=${PAT}`, `b=${PAT}`], env: {} });
    expect(redactions).toEqual([{ rule: 'github-pat', count: 2, stream: 'argv' }]);
  });

  it('чистый вход даёт пустой отчёт и argv без изменений', () => {
    const argv = ['pnpm', 'test', '--testPathPattern', 'auth'];
    const result = redactInbound(redactor, { argv, env: { PATH: '/usr/bin', CI: 'true' } });
    expect(result.argv).toEqual(argv);
    expect(result.redactions).toEqual([]);
  });
});
