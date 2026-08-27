#!/usr/bin/env node
/**
 * Генерация TS-типов из JSON Schema манифеста.
 *
 * Результат **коммитится** в `src/manifest.generated.ts`: корневой вход обязан собираться
 * `tsc -b` без запуска этого скрипта, а `.d.ts` пакета — не ссылаться ни на одну внешнюю
 * библиотеку (R3, Ф6). Совпадение закоммиченной копии с текущим выводом проверяет
 * `src/schema.test.ts` — иначе схема и типы разъезжаются молча.
 *
 * `--stdout` печатает результат вместо записи; этим пользуется тест.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileFromFile } from 'json-schema-to-typescript';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const schemaPath = `${packageRoot}schema/mcpproxy.schema.json`;
const outPath = `${packageRoot}src/manifest.generated.ts`;

export const BANNER = `/* eslint-disable */
/**
 * СГЕНЕРИРОВАННЫЙ ФАЙЛ — не править руками.
 * Источник: schema/mcpproxy.schema.json. Перегенерация: yarn workspace @mcpproxy/contracts gen:types
 */`;

export async function generate() {
  return compileFromFile(schemaPath, {
    bannerComment: BANNER,
    additionalProperties: false,
    declareExternallyReferenced: true,
    enableConstEnums: false,
    unreachableDefinitions: false,
    style: { singleQuote: true, printWidth: 100 },
  });
}

const text = await generate();
if (process.argv.includes('--stdout')) process.stdout.write(text);
else writeFileSync(outPath, text);
