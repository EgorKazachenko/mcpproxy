/**
 * Контракт IPC между шимом и демоном.
 *
 * Форма запроса делает **невыразимыми** argv, путь к бинарю, `cwd` и профиль песочницы.
 * Это структурная защита от «stdio Transport Security in Proxy Scenarios» из спеки MCP:
 * даже полный контроль над сокетом не даёт произвольного исполнения (И5).
 */

/**
 * Брендированные идентификаторы: перестановка аргументов на границе доверия — ошибка
 * компиляции, а не тихо принятый запрос от чужой сессии.
 */
export type RecipeName = string & { readonly __brand: 'RecipeName' };
export type SessionId = string & { readonly __brand: 'SessionId' };
export type RequestId = string & { readonly __brand: 'RequestId' };

/**
 * Та же форма, что у `propertyNames` схемы манифеста. Копия здесь намеренная: корневой
 * вход не читает файл схемы. Совпадение двух копий проверяет тест — иначе они разъедутся.
 *
 * `propertyNames` состоит из **двух** частей, и обе обязаны быть здесь. Одного паттерна
 * мало: `constructor` и `prototype` целиком из строчных букв, то есть ему соответствуют.
 * Пропустив их, `asRecipeName` вернул бы брендированный `RecipeName` для имени, которое
 * загрузчик манифеста отвергает, а `manifest.tools` — обычный объект из `doc.toJS()`, так
 * что `tools['constructor']` у потребителя резолвится по цепочке прототипов в истинное
 * значение, и проверка вида `if (!recipe) reject` его не ловит.
 */
export const RECIPE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Вторая половина `propertyNames`. Значение заморожено вместе с паттерном.
 *
 * Тип — `readonly string[]`, а не кортеж литералов: кортеж заставлял бы каждого потребителя
 * писать `(RESERVED_RECIPE_NAMES as readonly string[]).includes(name)`, и в этом дереве такой
 * каст появился дважды прежде, чем список успел замёрзнуть. Значение при этом остаётся в
 * снапшоте поверхности, потому что объявлено `as const` до расширения типа.
 */
export const RESERVED_RECIPE_NAMES: readonly string[] = ['constructor', 'prototype', '__proto__'] as const;

/** Единственная форма проверки имени. Обе половины `propertyNames`, и звать её проще, чем повторять. */
export function isRecipeName(value: string): boolean {
  return RECIPE_NAME_PATTERN.test(value) && !RESERVED_RECIPE_NAMES.includes(value);
}

export function asRecipeName(value: string): RecipeName {
  if (!RECIPE_NAME_PATTERN.test(value)) throw new TypeError(`не имя рецепта: ${value}`);
  if (RESERVED_RECIPE_NAMES.includes(value)) {
    throw new TypeError(`зарезервированное имя, не имя рецепта: ${value}`);
  }
  return value as RecipeName;
}

export function asSessionId(value: string): SessionId {
  if (value.length === 0) throw new TypeError('пустой sessionId');
  return value as SessionId;
}

export function asRequestId(value: string): RequestId {
  if (value.length === 0) throw new TypeError('пустой requestId');
  return value as RequestId;
}

/**
 * Единственная форма запроса от шима к демону.
 *
 * Поле называется `recipeName`, а не `recipe`: в `normalizeRecipe` и `toTool` слово
 * `recipe` означает объект, и одно слово на два смысла в замороженном контракте — ровно
 * то, что потом читается неверно.
 */
export interface IpcRequest {
  readonly recipeName: RecipeName;
  readonly params: Readonly<Record<string, unknown>>;
  readonly sessionId: SessionId;
}
