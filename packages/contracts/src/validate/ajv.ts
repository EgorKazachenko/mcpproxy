import { readFileSync } from 'node:fs';
import type { Options, ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { RE2_ENGINE } from './regex.js';

// Схема читается из публикуемого файла, а не вшивается сборкой: потребитель, редактор и
// демон обязаны видеть один и тот же артефакт. Путь одинаково резолвится и из `dist/validate`,
// и из `src/validate` — в обоих случаях это `<пакет>/schema`.
const SCHEMA_URL = new URL('../../schema/mcpproxy.schema.json', import.meta.url);

/**
 * Опции вынесены в константу, чтобы у проводки RE2 была исполняемая проверка: тест собирает
 * `new Ajv2020(AJV_OPTIONS)` на схеме с lookahead и требует отказа. Со встроенным движком
 * такая схема компилируется молча, и удаление `code.regExp` иначе не краснело бы ничем —
 * паритет движков (Ф10) на нашей собственной схеме наблюдаемой разницы не даёт.
 *
 * Модуль внутренний: `./validate` экспортирует только `parseManifest`, поэтому публичная
 * поверхность от этой константы не растёт.
 */
export const AJV_OPTIONS: Options = {
  // `discriminator` сводит союз из пяти веток к одной диагностике вместо восьми (Ф5).
  allErrors: true,
  discriminator: true,
  // `strictRequired: false` обязателен рядом с ним: иначе strict-режим отказывается
  // компилировать схему, в которой тег объявлен через `const`.
  strict: true,
  strictRequired: false,
  code: { regExp: RE2_ENGINE },
};

let compiled: ValidateFunction | null = null;

/** Импорт `Ajv2020` — именованный: дефолтный не конструируется под NodeNext (Ф4). */
export function manifestValidator(): ValidateFunction {
  if (compiled === null) {
    const schema: unknown = JSON.parse(readFileSync(SCHEMA_URL, 'utf8'));
    compiled = new Ajv2020(AJV_OPTIONS).compile(schema as object);
  }
  return compiled;
}
