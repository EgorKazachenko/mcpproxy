/* eslint-disable */
/**
 * СГЕНЕРИРОВАННЫЙ ФАЙЛ — не править руками.
 * Источник: schema/mcpproxy.schema.json. Перегенерация: yarn workspace @mcpproxy/contracts gen:types
 */

/**
 * Целое число с единицей. Нормализуется в миллисекунды до хэширования, иначе 120s и 2m дают разные дайджесты при одном таймауте.
 */
export type Duration = string;
/**
 * Союз самодостаточных веток с const-дискриминатором type. Соседних properties рядом с oneOf нет намеренно; type здесь обязателен — без него ajv в strict-режиме отказывается компилировать discriminator.
 */
export type Param = StringParam | EnumParam | NumberParam | BooleanParam | PathParam;
/**
 * Массив литералов. Слот {} допустим не более одного раза на элемент — проверяется на загрузке.
 */
export type ArgvTemplate = string[];
/**
 * Строка без управляющих и форматирующих символов: \p{Cc} закрывает C0/C1, \p{Cf} — zero-width, bidi-переопределения и BOM. Категории вместо перечисления диапазонов: читаемо, ASCII-only в файле схемы и принимается обоими движками.
 */
export type SafeText = string;

/**
 * Манифест рецептов mcpproxy. Содержимое НЕДОВЕРЕННОЕ: инварианты кодируются структурно, а не комментарием.
 */
export interface Manifest {
  /**
   * Версия формата. Двигается только вместе с CONTRACTS_VERSION и явным решением владельца.
   */
  version: 1;
  defaults: Defaults;
  /**
   * Рецепты, ключованные именем. Имя ограничено propertyNames, поэтому __proto__ и constructor — ошибка загрузки, а не имя рецепта.
   */
  tools: {
    [k: string]: Recipe;
  };
}
/**
 * Общая база. Блок обязателен: без него манифест терял бы весь список запретов на учётные данные одной строкой.
 */
export interface Defaults {
  timeout: Duration;
  output: OutputPolicy;
  env: EnvPolicy;
  sandbox: SandboxProfile;
}
export interface OutputPolicy {
  maxBytes?: number;
  redact?: boolean;
}
export interface EnvPolicy {
  allow: string[];
}
export interface SandboxProfile {
  read?: AccessRule;
  write?: AccessRule;
  network?: AccessRule;
}
export interface AccessRule {
  allow?: string[];
  deny?: string[];
}
export interface Recipe {
  /**
   * Свободный текст, попадающий прямо в контекст модели. Санитизируется в toTool, а не здесь.
   */
  description: string;
  /**
   * exec[0] резолвится в абсолютный путь и проверяется по binary allowlist демона. Ни один параметр в него не подставляется.
   *
   * @minItems 1
   */
  exec: [string, ...string[]];
  cwd?: string;
  params?: {
    [k: string]: Param;
  };
  annotations?: Annotations;
  sandbox?: SandboxProfile;
  timeout?: Duration;
  env?: EnvPolicy;
  output?: OutputPolicy;
}
export interface StringParam {
  type: 'string';
  description?: string;
  required?: boolean;
  argv?: ArgvTemplate;
  /**
   * Синтаксис RE2, компилируется на загрузке. Отсутствие — ошибка загрузки, а не warning.
   */
  pattern: string;
  maxLength?: number;
}
export interface EnumParam {
  type: 'enum';
  description?: string;
  required?: boolean;
  argv?: ArgvTemplate;
  /**
   * Значения едут в контекст модели и обязаны вернуться байт в байт, поэтому ограничиваются здесь структурно, а не переписываются санитайзером.
   *
   * @minItems 1
   */
  values: [SafeText, ...SafeText[]];
}
export interface NumberParam {
  type: 'number';
  description?: string;
  required?: boolean;
  argv?: ArgvTemplate;
  min?: number;
  max?: number;
  integer?: boolean;
}
/**
 * Флаг присутствует или отсутствует; подстановки в argv нет.
 */
export interface BooleanParam {
  type: 'boolean';
  description?: string;
  required?: boolean;
  argv?: ArgvTemplate;
}
export interface PathParam {
  type: 'path';
  description?: string;
  required?: boolean;
  argv?: ArgvTemplate;
  /**
   * realpath, затем confinement под root. Обязателен: без него path — обычная строка с обходом каталогов.
   */
  root: string;
}
export interface Annotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}
