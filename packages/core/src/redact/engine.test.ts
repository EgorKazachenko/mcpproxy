import { describe, expect, it } from 'vitest';
import { ENTROPY_RULE_ID } from './entropy.js';
import { RuleCompilationError, createRedactor, placeholder } from './engine.js';
import type { SecretRule } from './rules.js';

/** Синтетические значения: форма настоящая, содержимое выдумано. */
const PAT = 'ghp_016ABCdefGHIjklMNOpqrSTUvwxYZ0123456';
const TOKEN = 'kR7pQz2XvN4mB8sT1wY6uH0jL5gC3fD9eA+oI/xZbn';

const rule = (id: string, pattern: string): SecretRule => ({
  id,
  source: 'gitleaks:тест',
  description: 'фикстура',
  pattern,
});

const OUT = { entropy: true } as const;
const IN = { entropy: false } as const;

describe('createRedactor', () => {
  it('R6: несовместимый с RE2 паттерн роняет НАБОР, а не выпадает из него', () => {
    // Правило, тихо выпавшее из набора, — выключенная защита, о которой никто не узнает:
    // тесты на остальные правила остаются зелёными, и вывод в отчёте выглядит чистым.
    expect(() => createRedactor([rule('lookahead', 'foo(?=bar)')])).toThrow(RuleCompilationError);
  });

  it('ошибка компиляции называет виновное правило', () => {
    try {
      createRedactor([rule('ok', 'abc'), rule('lookahead', 'foo(?=bar)')]);
      expect.unreachable('набор с несовместимым правилом обязан бросить');
    } catch (error) {
      expect(error).toBeInstanceOf(RuleCompilationError);
      expect((error as RuleCompilationError).failures.map((one) => one.id)).toEqual(['lookahead']);
    }
  });
});

describe('редакция', () => {
  const redactor = createRedactor();

  it('вырезает секрет и ставит плейсхолдер с именем правила', () => {
    const { text, counts } = redactor.redact(`Authorization: Bearer ${PAT}`, OUT);
    expect(text).toBe(`Authorization: Bearer ${placeholder('github-pat')}`);
    expect(text).not.toContain(PAT);
    expect(counts.get('github-pat')).toBe(1);
  });

  it('R12: плейсхолдер именно [redacted:<id>]', () => {
    expect(placeholder('github-pat')).toBe('[redacted:github-pat]');
  });

  it('считает каждое срабатывание, а не каждое правило', () => {
    const { counts, text } = redactor.redact(`a=${PAT} b=${PAT}`, OUT);
    expect(counts.get('github-pat')).toBe(2);
    expect(text).not.toContain(PAT);
  });

  it('несколько разных правил в одном тексте — по записи на правило', () => {
    const { counts } = redactor.redact(`token=${PAT} key=AKIAIOSFODNN7EXAMPLE`, OUT);
    expect([...counts.entries()].sort()).toEqual([
      ['aws-access-key-id', 1],
      ['github-pat', 1],
    ]);
  });

  it('текст без секретов возвращается неизменным, отчёт пуст', () => {
    const clean = 'PASS src/validate/refine.test.ts (34 tests) 12ms';
    const { text, counts } = redactor.redact(clean, OUT);
    expect(text).toBe(clean);
    expect(counts.size).toBe(0);
  });

  it('переживает многострочный вывод и не съедает переводы строк', () => {
    const { text } = redactor.redact(`line1\ntoken=${PAT}\nline3`, OUT);
    expect(text).toBe(`line1\ntoken=${placeholder('github-pat')}\nline3`);
  });
});

describe('R13: разрешение пересечений', () => {
  it('выигрывает более длинное совпадение', () => {
    const redactor = createRedactor([rule('short', 'abc'), rule('long', 'abcdef')]);
    const { text, counts } = redactor.redact('xx abcdef yy', IN);
    expect(text).toBe(`xx ${placeholder('long')} yy`);
    expect(counts.has('short')).toBe(false);
  });

  it('более длинное выигрывает, даже если начинается ПОЗЖЕ короткого', () => {
    // Именно эта пара отличает жадный по длине отбор от обхода слева направо: обход взял бы
    // `left` на позиции 0 и выкинул `wide`, оставив хвост секрета в тексте.
    //
    // Замена покрывает ОБЪЕДИНЕНИЕ, поэтому уходят и два символа `left`, торчащие левее
    // `wide`: найденный байт не переживает замену, кто бы его ни нашёл. И `left` попадает в
    // отчёт — победитель поглощает его не целиком, значит это вторая находка, а не шум.
    const redactor = createRedactor([rule('left', 'aaaa'), rule('wide', 'aabbbbbbbbbbbb')]);
    const { text, counts } = redactor.redact('aaaabbbbbbbbbbbb', IN);
    expect(text).toBe(placeholder('wide'));
    expect([...counts.entries()].sort()).toEqual([['left', 1], ['wide', 1]]);
  });

  it('M1: кусок отвергнутого кандидата, торчащий за победителя, НЕ остаётся в тексте', () => {
    // Регрессия на находку ревью, воспроизведённую запуском. Прежняя реализация выбрасывала
    // пересёкшегося кандидата ЦЕЛИКОМ: JWT длиннее и побеждал, высокоэнтропийный блоб рядом
    // отбрасывался, и 42 символа секрета уезжали вызывающему — без следа в отчёте.
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g';
    const blob = 'kR7pQz2XvN4mB8sT1wY6uH0jL5gC3fD9eA0oI1xZbn';
    const { text, counts } = createRedactor().redact(blob + jwt, OUT);

    expect(text).not.toContain(blob.slice(0, 20));
    expect(text).not.toContain('eyJhbGci');
    // Оба детектора сработали, и оба обязаны быть в отчёте: блоб торчит за границы JWT.
    expect(counts.get(ENTROPY_RULE_ID)).toBe(1);
    expect(counts.get('jwt')).toBe(1);
  });

  it('поглощённое совпадение в отчёт не идёт — иначе один секрет считается дважды', () => {
    // `ghp_…` — и известный формат, и высокоэнтропийный ран НА ТОМ ЖЕ диапазоне. Два имени
    // на один диапазон заставляют оператора гадать, два там секрета или один.
    const { counts } = createRedactor().redact(`token=${PAT}`, OUT);
    expect([...counts.keys()]).toEqual(['github-pat']);
  });

  it('при равной длине выигрывает правило, идущее в наборе раньше', () => {
    const first = createRedactor([rule('alpha', 'abcd'), rule('beta', 'abcd')]);
    expect(first.redact('..abcd..', IN).text).toBe(`..${placeholder('alpha')}..`);

    const swapped = createRedactor([rule('beta', 'abcd'), rule('alpha', 'abcd')]);
    expect(swapped.redact('..abcd..', IN).text).toBe(`..${placeholder('beta')}..`);
  });

  it('непересекающиеся совпадения не мешают друг другу', () => {
    const redactor = createRedactor([rule('a', 'xxx'), rule('b', 'yyy')]);
    const { text } = redactor.redact('1 xxx 2 yyy 3', IN);
    expect(text).toBe(`1 ${placeholder('a')} 2 ${placeholder('b')} 3`);
  });

  it('паттерн, совпадающий с пустотой, не зацикливает движок', () => {
    // `x*` совпадает с пустой строкой на каждой позиции и не двигает lastIndex сам.
    const redactor = createRedactor([rule('empty', 'x*')]);
    const { text } = redactor.redact('abc', IN);
    expect(text).toBe('abc');
  });

  it('повторный скан того же текста даёт тот же результат', () => {
    // `lastIndex` у скомпилированного RE2 — состояние экземпляра, а экземпляр переиспользуется
    // между вызовами. Цикл всегда доходит до `null`, а `exec` при `null` обнуляет `lastIndex`
    // сам, — но утверждение об идемпотентности обязано стоять здесь, а не в комментарии:
    // первый же досрочный выход из цикла оставил бы состояние посередине текста.
    const redactor = createRedactor();
    const line = `token=${PAT}`;
    expect(redactor.redact(line, OUT).text).toBe(redactor.redact(line, OUT).text);
    expect(redactor.scan(line, OUT)).toEqual(redactor.scan(line, OUT));
  });
});

describe('энтропия внутри движка', () => {
  const redactor = createRedactor();

  it('ловит длинный токен без формы, когда включена', () => {
    const { text, counts } = redactor.redact(`session=${TOKEN}`, OUT);
    expect(text).toBe(`session=${placeholder(ENTROPY_RULE_ID)}`);
    expect(counts.get(ENTROPY_RULE_ID)).toBe(1);
  });

  it('R7: выключенная энтропия не трогает тот же токен', () => {
    const { text, counts } = redactor.redact(`session=${TOKEN}`, IN);
    expect(text).toBe(`session=${TOKEN}`);
    expect(counts.size).toBe(0);
  });

  it('R7: выключенная энтропия НЕ выключает именованные правила', () => {
    const { counts } = redactor.redact(`token=${PAT}`, IN);
    expect(counts.get('github-pat')).toBe(1);
  });

  it('именованное правило выигрывает у энтропии на одном и том же совпадении', () => {
    // `ghp_` + 36 символов — и высокоэнтропийный ран, и известный формат. В отчёте обязан
    // стоять `github-pat`: он говорит владельцу, какой именно ключ отзывать, а
    // `high-entropy-base64` не говорит ничего.
    const { counts } = redactor.redact(`token=${PAT}`, OUT);
    expect(counts.has(ENTROPY_RULE_ID)).toBe(false);
    expect(counts.get('github-pat')).toBe(1);
  });
});
