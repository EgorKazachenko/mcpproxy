import type { ToolAnnotations } from './annotations.js';
import type { RecipeName } from './ipc.js';
import type { Param, Recipe } from './manifest.generated.js';

/**
 * Проекция рецепта в `Tool` ревизии MCP `2025-11-25` (решение D1).
 *
 * `Tool` объявлен **локально**, а не импортирован из `@modelcontextprotocol/sdk`: пакет с
 * замороженным контрактом не может делать мажорный бамп чужой библиотеки ломающим
 * изменением для семи эпиков, и SDK не должен протекать в `.d.ts` потребителя (Ф6).
 * Запрет исполняемый — `deps.test.ts` держит SDK в списке недопустимых специфаеров.
 *
 * `resultType`, `ttlMs` и `cacheScope` — из следующей ревизии и объявлены **опциональными**:
 * переход на `2026-07-28` не потребует менять замороженный контракт (R18).
 */
export interface Tool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: JsonSchemaObject;
  readonly outputSchema?: JsonSchemaObject;
  readonly annotations?: ToolAnnotations;
  readonly resultType?: string;
  readonly ttlMs?: number;
  readonly cacheScope?: string;
}

export interface JsonSchemaObject {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, JsonSchemaValue>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

export interface JsonSchemaValue {
  readonly type: 'string' | 'number' | 'integer' | 'boolean';
  readonly description?: string;
  readonly pattern?: string;
  readonly maxLength?: number;
  readonly enum?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
}

/** Потолок длины описания. Уменьшение, а не гарантия безопасности. */
export const DESCRIPTION_MAX_LENGTH = 1024;

// ESC собирается через `new RegExp`, чтобы в исходнике не лежал сырой управляющий символ.
const ANSI_CSI = new RegExp('\\u001b\\[[0-9;?]*[ -/]*[@-~]', 'g');
const ANSI_OTHER = new RegExp('\\u001b[@-Z\\\\-_]', 'g');
/** C0/C1 (`Cc`) и форматирующие — zero-width, bidi-переопределения, BOM (`Cf`). */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

/**
 * Санитизация **свободного текста**, который эмитит `toTool`: описания рецепта и параметров.
 * И только их.
 *
 * Задаётся **структурно, а не блоклистом**: лимит длины, вырезание ANSI-escape, C0/C1,
 * zero-width и bidi-переопределений, схлопывание переводов строки. В контракте записано,
 * что результат *уменьшен*, а не *безопасен*: манифест недоверенный, а описания идут прямо
 * в контекст модели, и от инъекции обычным текстом это не спасает.
 *
 * **Имена рецептов и параметров через неё не проходят.** Их безопасность обеспечивает
 * `propertyNames` схемы: имя, прошедшее загрузку, уже соответствует
 * `^[a-z][a-z0-9_]{0,63}$`, санитизировать в нём нечего. Хуже того, лимит длины отдал бы
 * модели имя, которое `IpcRequest.recipeName` затем не разрешит в рецепт.
 *
 * **Значения `enum` — тот же случай.** Это не свободный текст, а ровно те строки, которые
 * модель обязана прислать обратно. Вырезав из объявленного значения bidi-override, мы
 * сделали бы инструмент невызываемым: модель не смогла бы прислать ничего, что пройдёт
 * валидацию. Поэтому `values` ограничены структурно, в схеме, — отравленное значение
 * становится ошибкой загрузки, а не тихо переписанным.
 */
export function sanitizeDescription(text: string): { text: string; removedRuns: number } {
  let removedRuns = 0;
  const count = (_match: string): string => {
    removedRuns += 1;
    return '';
  };

  const withoutAnsi = text.replace(ANSI_CSI, count).replace(ANSI_OTHER, count);
  // Переводы строки схлопываются ДО вырезания невидимых: иначе `a\nb` склеилось бы в `ab`.
  const flattened = withoutAnsi.replace(/[\r\n]+/g, ' ');
  const visible = flattened.replace(INVISIBLE, count);
  const collapsed = visible.replace(/ {2,}/g, ' ').trim();

  return { text: collapsed.slice(0, DESCRIPTION_MAX_LENGTH), removedRuns };
}

function jsonSchemaOf(param: Param): JsonSchemaValue {
  const described = param.description === undefined ? {} : { description: sanitizeDescription(param.description).text };

  switch (param.type) {
    case 'string':
      return {
        type: 'string',
        ...described,
        pattern: param.pattern,
        ...(param.maxLength === undefined ? {} : { maxLength: param.maxLength }),
      };
    case 'enum':
      // Значения едут байт в байт — см. комментарий к sanitizeDescription.
      return { type: 'string', ...described, enum: [...param.values] };
    case 'number':
      return {
        type: param.integer === true ? 'integer' : 'number',
        ...described,
        ...(param.min === undefined ? {} : { minimum: param.min }),
        ...(param.max === undefined ? {} : { maximum: param.max }),
      };
    case 'boolean':
      return { type: 'boolean', ...described };
    case 'path':
      // Confinement под `root` — дело демона: модели незачем знать корень.
      return { type: 'string', ...described };
  }
}

/**
 * Имя приходит отдельным аргументом, потому что в манифесте имена рецептов — **ключи
 * карты**, и в сгенерированном `Recipe` поля `name` нет.
 */
export function toTool(name: RecipeName, recipe: Recipe): Tool {
  const entries = Object.entries(recipe.params ?? {});
  const properties = Object.fromEntries(entries.map(([paramName, param]) => [paramName, jsonSchemaOf(param)]));
  const required = entries.filter(([, param]) => param.required === true).map(([paramName]) => paramName);

  return {
    name,
    description: sanitizeDescription(recipe.description).text,
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length === 0 ? {} : { required }),
      additionalProperties: false,
    },
    ...(recipe.annotations === undefined ? {} : { annotations: recipe.annotations }),
  };
}
