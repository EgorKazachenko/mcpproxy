import { canonicalizeJcs } from '@mcpproxy/contracts';
import { describe, expect, it } from 'vitest';
import {
  codePointLength,
  codePointLengthAtMost,
  DENIAL_CODES,
  DENIAL_STAGES,
  DENIALS_MAX,
  denial,
  E2_STAGES,
  isCanonicalizable,
  VALUE_MAX_CODE_POINTS,
  type DenialCode,
  type DenialStage,
  type E2Stage,
} from './denial.js';

// Полноту списков проверяет компилятор, а не только прогон: член, добавленный в юнион, но не
// внесённый в массив, делает `Missing` непустым и роняет сборку до запуска vitest.
type MissingStage = Exclude<E2Stage, (typeof E2_STAGES)[number]>;
const _everyStageListed: [MissingStage] extends [never] ? true : MissingStage = true;
void _everyStageListed;

type MissingCode = Exclude<DenialCode, (typeof DENIAL_CODES)[number]>;
const _everyCodeListed: [MissingCode] extends [never] ? true : MissingCode = true;
void _everyCodeListed;

const LONE_HIGH = '\uD800';
const LONE_LOW = '\uDC00';
/** bidi-override, категория `Cf`. Записан escape'ом: литерал невидим в диффе и в ревью. */
const RLO = '\u202E';
const ZWSP = '\u200B';

describe('конструктор denial', () => {
  it('строит отказ, который E4 сможет записать: канонизуется ВЕСЬ объект', () => {
    // Утверждается канонизация всего объекта, а не отдельного поля: трейс на одном поле
    // зелен при дефекте в соседнем. Одиночный суррогат стоит в ОБОИХ строковых полях.
    const d = denial({
      stage: 'validate',
      code: 'unknown-param',
      paramName: `evil${LONE_HIGH}`,
      reason: `имя не объявлено${LONE_LOW}`,
    });

    expect(() => canonicalizeJcs({ d })).not.toThrow();
    expect(isCanonicalizable(d.paramName ?? '')).toBe(true);
    expect(isCanonicalizable(d.reason)).toBe(true);
  });

  it('вырезает форматирующие символы: bidi-override из имени файла не доезжает до UI', () => {
    // Вторая мутация R27: убрать `sanitizeDescription`, оставив только зачистку суррогатов, —
    // и это утверждение краснеет, тогда как предыдущее остаётся зелёным.
    const d = denial({
      stage: 'resolve_paths',
      code: 'path-escapes-root',
      paramName: 'file',
      reason: `путь вне root: /tmp/we${RLO}lgnp.txt`,
    });

    expect(/\p{Cf}/u.test(d.reason)).toBe(false);
    expect(/\p{Cc}/u.test(d.reason)).toBe(false);
  });

  it('сохраняет корректную суррогатную пару — зачистка не режет законный текст', () => {
    const d = denial({ stage: 'validate', code: 'wrong-type', paramName: 'p', reason: 'a\u{1F600}b' });
    expect(d.reason).toContain('\u{1F600}');
  });

  it('пропускает `paramName: null` как есть — «известно и пусто»', () => {
    const d = denial({ stage: 'validate', code: 'bad-params-container', paramName: null, reason: 'не объект' });
    expect(d.paramName).toBeNull();
    expect(() => canonicalizeJcs({ d })).not.toThrow();
  });
});

describe('isCanonicalizable', () => {
  it('совпадает с фактическим поведением canonicalizeJcs на всём наборе', () => {
    // Без этой сверки предикат и канонизатор разъезжаются молча, и гейт R28 становится
    // декоративным: он бы разрешал ровно то, на чём запись события бросает.
    const corpus: readonly string[] = [
      '',
      'обычная строка',
      'a.log',
      LONE_HIGH,
      LONE_LOW,
      `a${LONE_HIGH}b`,
      `a${LONE_LOW}b`,
      `${LONE_HIGH}${LONE_HIGH}`,
      `${LONE_LOW}${LONE_HIGH}`,
      '\u{10000}',
      '\u{1F600}',
      `a\u{1F600}b`,
      `\u{1F600}${LONE_HIGH}`,
      '\u0000',
      RLO,
      ZWSP,
      'ёжик',
      '\t\n\\"',
      'a'.repeat(4097),
      `${LONE_HIGH}хвост`,
    ];

    const actual = (value: string): boolean => {
      try {
        canonicalizeJcs(value);
        return true;
      } catch {
        return false;
      }
    };

    const disagreements = corpus
      .map((value, index) => ({ index, predicate: isCanonicalizable(value), actual: actual(value) }))
      .filter((one) => one.predicate !== one.actual);

    expect(disagreements).toEqual([]);
  });
});

describe('константы формы', () => {
  it('стадия отказа — подмножество стадий E2, без build_argv', () => {
    // `buildArgv` тотальна: отказать ей нечем. Утверждение фиксирует это как форму, а не
    // как рассуждение в комментарии.
    expect([...DENIAL_STAGES].every((one) => (E2_STAGES as readonly string[]).includes(one))).toBe(true);
    expect((DENIAL_STAGES as readonly string[]).includes('build_argv')).toBe(false);
  });

  it('потолки ограничивают, а не только называются', () => {
    // Независимая граница, а не пересказ константы: без неё оба потолка поднимаются до
    // величины, при которой они перестают что-либо ограничивать, и сюита остаётся зелёной —
    // проверено мутацией (`DENIALS_MAX = 100000`, `VALUE_MAX_CODE_POINTS = 8000000`).
    // Числа справа взяты из мотивов R30/R30а: список должен читаться человеком в модалке,
    // а значение — не доезжать мегабайтом до realpath, argv, argsHash и записи аудита.
    expect(DENIALS_MAX).toBeLessThanOrEqual(64);
    expect(VALUE_MAX_CODE_POINTS).toBeLessThanOrEqual(1 << 16);
  });

  it('не содержит дублей кодов', () => {
    expect(new Set(DENIAL_CODES).size).toBe(DENIAL_CODES.length);
  });

  it('считает длину по кодовым точкам, а не по единицам UTF-16', () => {
    // Замерено (Ф11): для эмодзи два счётчика расходятся, и потолок, заданный автором
    // манифеста в символах, при подсчёте по `length` оказался бы вдвое строже.
    expect(codePointLength('a\u{1F600}b')).toBe(3);
    expect('a\u{1F600}b'.length).toBe(4);
  });
});

describe('codePointLengthAtMost — ограниченный счётчик', () => {
  it('совпадает с точным счётом на границах', () => {
    const cases: ReadonlyArray<readonly [string, number]> = [
      ['', 4],
      ['abcd', 4],
      ['abcde', 4],
      ['\u{1F600}\u{1F600}\u{1F600}\u{1F600}', 4],
      ['\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}', 4],
      [`${LONE_HIGH}${LONE_HIGH}${LONE_HIGH}${LONE_HIGH}${LONE_HIGH}`, 4],
      ['a\u{1F600}b', 3],
    ];
    for (const [value, max] of cases) {
      expect(codePointLengthAtMost(value, max), JSON.stringify(value)).toBe(codePointLength(value) <= max);
    }
  });

  it('не разворачивает вход — и это утверждается временем, потому что ответ у обеих реализаций один', () => {
    // Единственный трейс в сюите, где предмет — РЕСУРС, а не результат: точный счёт через
    // `[...value]` даёт тот же ответ, поэтому функциональным утверждением дефект неотличим.
    // Замерено на этом дереве (32 млн единиц UTF-16, node 22, macOS arm64):
    // ограниченный счётчик — 0.0006 мс, `[...value].length` — 112 мс и сотни мегабайт кучи;
    // на ста миллионах — фатальный OOM, который `try/catch` не ловит, то есть вызов не
    // получает отказа вовсе. Порог 25 мс лежит вчетверо ниже дефекта и в сорок тысяч раз
    // выше исправной реализации — запас в обе стороны, а не подогнанное число.
    const huge = 'a'.repeat(32_000_000);
    const started = process.hrtime.bigint();
    const verdict = codePointLengthAtMost(huge, VALUE_MAX_CODE_POINTS);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(verdict).toBe(false);
    expect(elapsedMs).toBeLessThan(25);
  });
});

describe('scrub — потеря не бывает молчаливой', () => {
  it('изменённая зачисткой причина помечается', () => {
    // `sanitizeDescription` — санитайзер свободного текста: он схлопывает пробелы и режет по
    // 1024 кодовым точкам. Замерено: `/root/a  b\tc.log` приезжает как `/root/a b c.log` —
    // путь, которого на диске нет. Пометка отличает искажённую строку от факта.
    const distorted = denial({
      stage: 'resolve_paths',
      code: 'path-escapes-root',
      paramName: 'file',
      reason: '/root/a  b\tc.log',
    });
    expect(distorted.reason).toContain('scrubbing changed the text');
    // Пометка приписывается ВНУТРИ потолка: наивное `clean + MARK` снимало гарантию
    // `<= DESCRIPTION_MAX_LENGTH`, и причина из 2000 символов приезжала длиной 1050.
    const overlong = denial({ stage: 'validate', code: 'wrong-type', paramName: 'p', reason: 'я'.repeat(2000) });
    expect(codePointLength(overlong.reason)).toBeLessThanOrEqual(1024);

    const intact = denial({
      stage: 'validate',
      code: 'wrong-type',
      paramName: 'p',
      reason: 'ожидалась строка (type: string)',
    });
    expect(intact.reason).toBe('ожидалась строка (type: string)');
  });

  it('пустой ключ и съеденный зачисткой — разные состояния, а не один плейсхолдер', () => {
    // `{"": 1}` — валидный JSON-объект, достижимый по И6, и зачистка в нём ничего не вырезала.
    // Один текст на два случая дал бы разбирающему запись объяснение, которого не было.
    const empty = denial({ stage: 'validate', code: 'unknown-param', paramName: '', reason: 'ключ не объявлен' });
    const erased = denial({ stage: 'validate', code: 'unknown-param', paramName: ZWSP, reason: 'ключ не объявлен' });
    expect(empty.paramName).not.toBe(erased.paramName);
    expect(empty.paramName).not.toBe('');
  });

  it('усечённое имя помечается так же, как причина', () => {
    // Принцип «потеря не бывает молчаливой» — свойство обоих полей, а не одного: без пометки
    // ключ из 4096 эмодзи и ключ из 32 млн единиц приезжают одинаковыми 1024 точками.
    const long = denial({ stage: 'validate', code: 'unknown-param', paramName: 'k'.repeat(8192), reason: 'ключ не объявлен' });
    expect(long.paramName).toContain('scrubbing changed the text');
    expect(codePointLength(long.paramName ?? '')).toBeLessThanOrEqual(1024);
  });

  it('имя, съеденное зачисткой целиком, не превращается в пустую строку', () => {
    // `''` — третье, неописанное состояние: `null` по контракту значит «претензия к самому
    // запросу», и потребитель, рисующий `paramName ?? 'запрос'`, показал бы пустую метку.
    const erased = denial({ stage: 'validate', code: 'unknown-param', paramName: ZWSP + ZWSP, reason: 'ключ не объявлен' });
    expect(erased.paramName).not.toBe('');
    expect(erased.paramName).not.toBeNull();
    expect(erased.paramName).toContain('erased');
  });
});

// Уровня типа: `DenialStage` не может принять `build_argv`.
type BuildArgvIsNotDenialStage = Extract<DenialStage, 'build_argv'>;
const _buildArgvExcluded: [BuildArgvIsNotDenialStage] extends [never] ? true : never = true;
void _buildArgvExcluded;
