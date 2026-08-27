/**
 * Каноничная сериализация JSON по RFC 8785 (JCS).
 *
 * Живёт в **корневом** входе: зависимостей у неё нет вообще, включая `node:crypto`.
 * Хэши, которым `node:crypto` нужен, живут в `./audit`.
 *
 * Скаляры делегируются `JSON.stringify` — он уже даёт и кратчайшее round-trip
 * представление чисел (тот самый алгоритм ECMAScript, на который ссылается RFC), и
 * well-formed экранирование строк. Руками пишутся только порядок ключей и структура.
 */

const isPlainObject = (value: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** Одиночный суррогат — не текст. `JSON.stringify` его экранирует, то есть дефект был бы тихим. */
function assertWellFormed(text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0xd800 || code > 0xdfff) continue;
    const high = code <= 0xdbff;
    const next = high ? text.charCodeAt(i + 1) : Number.NaN;
    if (high && next >= 0xdc00 && next <= 0xdfff) {
      i += 1;
      continue;
    }
    throw new TypeError(`строка содержит одиночный суррогат в позиции ${i}`);
  }
}

export function canonicalizeJcs(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';

    case 'number':
      // Нефинитные числа — явный отказ, а не тихий `null`, в который их превращает
      // `JSON.stringify`: дайджест от `null` неотличим от дайджеста осмысленных данных.
      if (!Number.isFinite(value)) throw new TypeError(`нефинитное число: ${String(value)}`);
      return JSON.stringify(value);

    case 'string':
      assertWellFormed(value);
      return JSON.stringify(value);

    case 'object':
      break;

    default:
      // undefined, function, symbol, bigint
      throw new TypeError(`значение типа ${typeof value} не сериализуется в JSON`);
  }

  const object = value as object;

  if (Array.isArray(object)) {
    return `[${object.map((item) => canonicalizeJcs(item)).join(',')}]`;
  }

  // Экземпляр класса, Date, Map, Set — отказ. `JSON.stringify` превратил бы их в `{}`
  // или в строку, то есть два разных значения дали бы один дайджест.
  if (!isPlainObject(object)) {
    throw new TypeError(`не plain-объект: ${object.constructor?.name ?? 'без прототипа'}`);
  }

  // RFC 8785 сортирует ключи по последовательности кодовых ЕДИНИЦ UTF-16 — ровно то,
  // что делает `Array.prototype.sort` над строками по умолчанию.
  const keys = Object.keys(object).sort();
  const members = keys.map((key) => {
    assertWellFormed(key);
    return `${JSON.stringify(key)}:${canonicalizeJcs((object as Record<string, unknown>)[key])}`;
  });
  return `{${members.join(',')}}`;
}
