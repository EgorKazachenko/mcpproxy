import { describe, expect, it } from 'vitest';
import {
  BASE64_ENTROPY_THRESHOLD,
  BASE64_MIN_RUN,
  ENTROPY_RULE_ID,
  findHighEntropyRuns,
  shannonEntropy,
} from './entropy.js';

/** Синтетический токен: форма настоящая, значение выдумано. Энтропия 5.39 — замерена. */
const TOKEN = 'kR7pQz2XvN4mB8sT1wY6uH0jL5gC3fD9eA+oI/xZbn';

/**
 * Строка из РАЗЛИЧНЫХ символов base64-алфавита — максимум энтропии для своей длины.
 * Генерируется, а не набирается литералом: литерал молча отстаёт от константы, когда порог
 * двигают, и граничные тесты начинают проверять не ту длину, что написана в их заголовке.
 */
const distinct = (length: number): string =>
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.slice(0, length);

describe('shannonEntropy', () => {
  it('нулевая на одном повторяющемся символе', () => {
    expect(shannonEntropy('aaaaaaaa')).toBe(0);
  });

  it('единица на двух равновероятных символах', () => {
    expect(shannonEntropy('abab')).toBeCloseTo(1, 10);
  });

  it('двойка на четырёх равновероятных', () => {
    expect(shannonEntropy('abcdabcd')).toBeCloseTo(2, 10);
  });

  it('нулевая на пустой строке, а не NaN', () => {
    // `0 * log2(0)` даёт NaN, и один NaN отравляет сравнение с порогом: `NaN >= 4.5` — false,
    // то есть детектор молча выключается вместо того, чтобы упасть.
    expect(shannonEntropy('')).toBe(0);
  });

  it('считает по символам, а не по кодовым единицам UTF-16', () => {
    // Иначе одна эмодзи выглядит как два разных символа и завышает энтропию.
    expect(shannonEntropy('🔑🔑🔑🔑')).toBe(0);
  });
});

describe('findHighEntropyRuns', () => {
  it('находит base64-токен в строке лога', () => {
    const text = `Bearer ${TOKEN} accepted`;
    const runs = findHighEntropyRuns(text);
    expect(runs).toHaveLength(1);
    expect(text.slice(runs[0]?.start ?? 0, runs[0]?.end ?? 0)).toBe(TOKEN);
  });

  it('R7: не трогает длинный, но низкоэнтропийный идентификатор', () => {
    // Замер: 4.09 при пороге 4.5. Это самый высокий реальный ран, найденный в репозитории.
    expect(findHighEntropyRuns('normalizeManifestForLockEntry')).toEqual([]);
  });

  it('R7: не трогает пути и вывод тестов', () => {
    expect(findHighEntropyRuns('PASS packages/contracts/src/validate/refine.test.ts (34 tests)')).toEqual([]);
    expect(findHighEntropyRuns('node_modules/.cache/vite/deps')).toEqual([]);
  });

  it('R7: git sha не трогается — по замеру порог для hex не существует, и hex-правила тут нет', () => {
    // Ключ Twilio (32 hex, p50 3.62) и git sha (40 hex, p50 3.70) — одно распределение.
    // Детектор, вырезающий sha из вывода `run_tests`, выключат в первый же день.
    expect(findHighEntropyRuns('commit e40b7defb42add5ade60cc85192e63ad42aa7b4a')).toEqual([]);
    expect(findHighEntropyRuns('SK0123456789abcdef0123456789abcdef')).toEqual([]);
  });

  it('минимальная длина рана выведена из порога, а не выбрана руками', () => {
    // Энтропия строки длины n не превышает log2(n). Константа ниже ceil(2^порог) описывала бы
    // границу, которой нет: ран такой длины не прошёл бы порог ни при каком содержимом.
    // Замер: при пороге 4.5 и длине 20 доля пойманных случайных токенов — ровно 0 из 3000.
    expect(BASE64_MIN_RUN).toBe(Math.ceil(2 ** BASE64_ENTROPY_THRESHOLD));
    expect(Math.log2(BASE64_MIN_RUN - 1)).toBeLessThan(BASE64_ENTROPY_THRESHOLD);
    expect(Math.log2(BASE64_MIN_RUN)).toBeGreaterThanOrEqual(BASE64_ENTROPY_THRESHOLD);
  });

  it(`ран короче ${BASE64_MIN_RUN} символов недостижим для порога, а не «редко ловится»`, () => {
    const longest = distinct(BASE64_MIN_RUN - 1);
    // Фикстура не отстала от константы — иначе заголовок утверждает про одну длину, а
    // проверяется другая, и граница перестаёт проверяться молча.
    expect(longest).toHaveLength(BASE64_MIN_RUN - 1);
    // Все символы различны — это максимум энтропии для такой длины. Он всё равно ниже порога.
    expect(new Set(longest).size).toBe(longest.length);
    expect(shannonEntropy(longest)).toBeLessThan(BASE64_ENTROPY_THRESHOLD);
    expect(findHighEntropyRuns(longest)).toEqual([]);
  });

  it(`ран ровно в ${BASE64_MIN_RUN} символов уже проверяется — граница включающая`, () => {
    const exact = distinct(BASE64_MIN_RUN);
    expect(exact).toHaveLength(BASE64_MIN_RUN);
    expect(shannonEntropy(exact)).toBeGreaterThanOrEqual(BASE64_ENTROPY_THRESHOLD);
    expect(findHighEntropyRuns(exact)).toHaveLength(1);
  });

  it('`=` не склеивает имя переменной с токеном в один ран', () => {
    // Иначе плейсхолдер съедает `AWS_SECRET_ACCESS_KEY=` вместе со значением, и читатель
    // лога теряет несекретную половину — ту, по которой он понимает, что вообще случилось.
    const text = `AWS_SECRET_ACCESS_KEY=${TOKEN}`;
    const runs = findHighEntropyRuns(text);
    expect(runs.map((run) => text.slice(run.start, run.end))).toEqual([TOKEN]);
  });

  it('находит несколько токенов и отдаёт их в порядке появления', () => {
    const second = 'Zq4Wm8Kd2Ry6Tn0Bx5Vc9Fj3Hs7Lp1Ga+Ue/OiNvXt';
    const text = `a=${TOKEN} b=${second}`;
    const runs = findHighEntropyRuns(text);
    expect(runs.map((run) => text.slice(run.start, run.end))).toEqual([TOKEN, second]);
  });

  it('раны не пересекаются и не идут вспять — на этом строится замена', () => {
    const text = `x ${TOKEN} y ${TOKEN} z`;
    const runs = findHighEntropyRuns(text);
    // Мощность фиксируется ДО цикла: без неё реализация, вернувшая `[]` или один ран,
    // проходит тест — тело цикла просто не выполняется, и утверждение о порядке вакуумно.
    expect(runs).toHaveLength(2);
    for (let i = 1; i < runs.length; i += 1) {
      expect(runs[i]?.start ?? 0).toBeGreaterThanOrEqual(runs[i - 1]?.end ?? 0);
    }
  });

  it('идентификатор правила — тот, что уедет в Redaction.rule', () => {
    expect(ENTROPY_RULE_ID).toBe('high-entropy-base64');
  });
});
