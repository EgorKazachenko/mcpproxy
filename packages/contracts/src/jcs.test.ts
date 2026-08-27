import { describe, expect, it } from 'vitest';
import { canonicalizeJcs, JCS_MAX_DEPTH } from './jcs.js';

/** Символ по коду. Так входные данные тестов не зависят от экранирования в исходнике. */
const ch = (code: number): string => String.fromCharCode(code);

describe('canonicalizeJcs — порядок ключей', () => {
  it('сортирует по кодовым единицам UTF-16, а не по алфавиту локали', () => {
    expect(canonicalizeJcs({ b: 1, a: 2, ä: 3, A: 4 })).toBe('{"A":4,"a":2,"b":1,"ä":3}');
  });

  it('сортирует вложенные объекты тоже', () => {
    expect(canonicalizeJcs({ z: { y: 1, x: 2 }, a: [3, { c: 4, b: 5 }] })).toBe(
      '{"a":[3,{"b":5,"c":4}],"z":{"x":2,"y":1}}',
    );
  });

  it('порядок элементов массива сохраняет — он значим', () => {
    expect(canonicalizeJcs([3, 1, 2])).toBe('[3,1,2]');
  });

  it('пример из RFC 8785 §3.2.3 — порядок ключей', () => {
    // Ключи, на которых «сортировка по алфавиту» и «сортировка по кодовым единицам»
    // расходятся: перевод строки, возврат каретки, цифра, C1-управляющий, ö и знак евро.
    const input: Record<string, string> = {
      '€': 'Euro Sign',
      '\r': 'Carriage Return',
      '\n': 'Newline',
      '1': 'One',
      [ch(0x80)]: `Control${ch(0x7f)}?`,
      ö: 'Latin Small Letter O With Diaeresis',
    };

    const canonical = canonicalizeJcs(input);
    const keysInOrder = ['\n', '\r', '1', ch(0x80), 'ö', '€'];
    expect(canonical).toBe(
      `{${keysInOrder.map((key) => `${JSON.stringify(key)}:${JSON.stringify(input[key])}`).join(',')}}`,
    );
    // И отдельно — что порядок именно такой, а не «какой получился».
    expect([...canonical.matchAll(/"((?:[^"\\]|\\.)*)":/g)].map((m) => JSON.parse(`"${m[1]}"`))).toEqual(keysInOrder);
  });
});

describe('canonicalizeJcs — числа', () => {
  // Значения из RFC 8785 §3.2.2.3 и его таблицы граничных случаев. Полный
  // es6testfile100m.txt (≈3.8 ГБ) не вендорится — это записано в честные границы.
  const CASES: ReadonlyArray<readonly [number, string]> = [
    [0, '0'],
    [-0, '0'],
    [1, '1'],
    [-1, '-1'],
    [0.1, '0.1'],
    [1e30, '1e+30'],
    [1e21, '1e+21'],
    [1e-7, '1e-7'],
    [9007199254740992, '9007199254740992'],
    [1.7976931348623157e308, '1.7976931348623157e+308'],
    [5e-324, '5e-324'],
    [333333333.33333329, '333333333.3333333'],
  ];

  for (const [value, expected] of CASES) {
    it(`${expected} — кратчайшее round-trip представление`, () => {
      expect(canonicalizeJcs(value)).toBe(expected);
    });
  }

  it('минус ноль неотличим от нуля, как требует RFC', () => {
    expect(canonicalizeJcs(-0)).toBe(canonicalizeJcs(0));
  });

  it('отвергает нефинитные числа вместо тихого null', () => {
    expect(() => canonicalizeJcs(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalizeJcs(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});

describe('canonicalizeJcs — строки', () => {
  it('короткие формы для табуляции и перевода строки', () => {
    expect(canonicalizeJcs(ch(9))).toBe('"\\t"');
    expect(canonicalizeJcs(ch(10))).toBe('"\\n"');
  });

  it('прочие C0-управляющие — четырёхзначным \\uXXXX', () => {
    expect(canonicalizeJcs(ch(0x1f))).toBe('"\\u001f"');
  });

  it('DEL и C1 остаются литеральными — RFC делегирует экранирование ECMAScript', () => {
    // Ловушка: текст RFC 8785 рисует их как  для читаемости, но §3.2.2.2 требует
    // ровно поведения JSON.stringify, а оно экранирует только < 0x20, кавычку и слэш.
    // Реализация, «доэкранировавшая» DEL ради похожести на текст RFC, разошлась бы
    // с каждым другим совместимым канонизатором — и молча, потому что оба JSON валидны.
    expect(canonicalizeJcs(ch(0x7f))).toBe(`"${ch(0x7f)}"`);
    expect(canonicalizeJcs(ch(0x80))).toBe(`"${ch(0x80)}"`);
  });

  it('не-ASCII остаётся литеральным', () => {
    expect(canonicalizeJcs('€ö')).toBe('"€ö"');
  });

  it('сохраняет корректную суррогатную пару', () => {
    const emoji = String.fromCodePoint(0x1f600);
    expect(canonicalizeJcs(emoji)).toBe(`"${emoji}"`);
  });

  it('отвергает одиночный суррогат', () => {
    // JSON.stringify экранировал бы его в \udXXX и посчитал бы дайджест от мусора молча.
    expect(() => canonicalizeJcs(`a${ch(0xd800)}b`)).toThrow(TypeError);
    expect(() => canonicalizeJcs({ [ch(0xdc00)]: 1 })).toThrow(TypeError);
  });
});

describe('canonicalizeJcs — глубина', () => {
  const nest = (depth: number): unknown => {
    let value: unknown = 1;
    for (let i = 0; i < depth; i += 1) value = { a: value };
    return value;
  };

  it('ровно на потолке ещё канонизирует, на потолке+1 — уже нет', () => {
    // Два СОСЕДНИХ входа, а не два далёких: с `nest(JCS_MAX_DEPTH - 1)` снизу и `+5` сверху
    // сдвиг границы на единицу (`>` → `>=`) оставлял оба кейса зелёными, то есть пара,
    // поставленная ради границы, границу не пиннила.
    expect(() => canonicalizeJcs(nest(JCS_MAX_DEPTH))).not.toThrow();
    expect(() => canonicalizeJcs(nest(JCS_MAX_DEPTH + 1))).toThrow(TypeError);
  });

  it('за потолком бросает TypeError, а не движковый RangeError', () => {
    // Замер до правки: `argsHash` переживал глубину 1961 и падал на 1962 — то есть 3 930
    // байт в `IpcRequest.params` (произвольный JSON из сокета) роняли вызов на пути
    // подтверждения, причём `JSON.parse` пропускает вход в 25 раз глубже. Отказ обязан быть
    // тем же `TypeError`, что и остальные в этом файле, иначе вызывающий его не поймает.
    let thrown: unknown;
    try {
      canonicalizeJcs(nest(JCS_MAX_DEPTH + 5));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).not.toBeInstanceOf(RangeError);
  });

  it('массивы считаются той же глубиной, что и объекты', () => {
    const deep: unknown = JSON.parse('['.repeat(JCS_MAX_DEPTH + 5) + '1' + ']'.repeat(JCS_MAX_DEPTH + 5));
    expect(() => canonicalizeJcs(deep)).toThrow(TypeError);
  });
});

describe('canonicalizeJcs — что не является JSON', () => {
  class Recipe {
    constructor(readonly name: string) {}
  }

  it('отвергает экземпляр класса, а не сериализует его в {}', () => {
    expect(() => canonicalizeJcs(new Recipe('run_tests'))).toThrow(TypeError);
    expect(() => canonicalizeJcs({ recipe: new Recipe('run_tests') })).toThrow(TypeError);
  });

  it('отвергает Date, Map и RegExp', () => {
    expect(() => canonicalizeJcs(new Date(0))).toThrow(TypeError);
    expect(() => canonicalizeJcs(new Map())).toThrow(TypeError);
    expect(() => canonicalizeJcs(/x/)).toThrow(TypeError);
  });

  it('отвергает undefined, bigint и функцию', () => {
    expect(() => canonicalizeJcs(undefined)).toThrow(TypeError);
    expect(() => canonicalizeJcs(1n)).toThrow(TypeError);
    expect(() => canonicalizeJcs(() => 1)).toThrow(TypeError);
  });

  it('различает отсутствующий ключ и null побайтово', () => {
    // Именно поэтому необязательное поле события отсутствует как ключ, а не приезжает
    // со значением null: оба варианта попадают внутрь chain.self и дают разные дайджесты.
    expect(canonicalizeJcs({ a: 1 })).not.toBe(canonicalizeJcs({ a: 1, b: null }));
  });
});
