import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const schemaPath = `${packageRoot}schema/mcpproxy.schema.json`;

// Схема читается как файл, а не через resolveJsonModule: публикуемый артефакт — именно файл,
// и тест обязан проверять то, что уедет потребителю, а не копию, вшитую сборкой.
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;

const ajv = () => new Ajv2020({ allErrors: true, discriminator: true, strict: true, strictRequired: false });

const VALID_MANIFEST = `{
  "version": 1,
  "defaults": {
    "timeout": "120s",
    "output": { "maxBytes": 65536, "redact": true },
    "env": { "allow": ["PATH", "HOME"] },
    "sandbox": { "read": { "deny": ["~/.ssh"], "allow": ["."] }, "write": { "allow": [] }, "network": { "allow": [] } }
  },
  "tools": {
    "run_tests": {
      "description": "Прогнать тесты",
      "exec": ["pnpm", "test"],
      "params": { "pattern": { "type": "string", "pattern": "^[\\\\w./-]{0,64}$", "argv": ["--testPathPattern", "{}"] } }
    }
  }
}`;

/** Подменяет один узел в валидном манифесте, не переписывая его целиком. */
function withTools(toolsJson: string): unknown {
  return JSON.parse(VALID_MANIFEST.replace(/"tools": \{[\s\S]*\}\n\}$/, `"tools": ${toolsJson}\n}`));
}

describe('схема манифеста', () => {
  it('валидна по мета-схеме 2020-12', () => {
    // compile прогоняет схему через мета-схему; невалидная схема здесь бросает.
    expect(() => ajv().compile(schema)).not.toThrow();
  });

  it('замораживает версию формата', () => {
    expect(schema).toMatchObject({ properties: { version: { const: 1 } } });
  });

  it('делает pattern обязательным для string, а root — для path', () => {
    expect(schema).toMatchObject({
      $defs: {
        StringParam: { required: ['type', 'pattern'] },
        PathParam: { required: ['type', 'root'] },
        EnumParam: { required: ['type', 'values'] },
      },
    });
  });

  it('требует непустой values у enum', () => {
    expect(schema).toMatchObject({ $defs: { EnumParam: { properties: { values: { minItems: 1 } } } } });
  });

  it('запрещает additionalProperties на каждой ветке союза', () => {
    const defs = (schema as { $defs: Record<string, { additionalProperties?: unknown }> }).$defs;
    const branches = ['StringParam', 'EnumParam', 'NumberParam', 'BooleanParam', 'PathParam'];
    for (const branch of branches) expect(defs[branch]?.additionalProperties).toBe(false);
  });

  it('союз параметров — oneOf из $ref без соседних properties', () => {
    const param = (schema as { $defs: Record<string, Record<string, unknown>> }).$defs.Param ?? {};
    expect(Object.keys(param).sort()).toEqual(['description', 'discriminator', 'oneOf', 'type']);
    expect(param.oneOf).toEqual([
      { $ref: '#/$defs/StringParam' },
      { $ref: '#/$defs/EnumParam' },
      { $ref: '#/$defs/NumberParam' },
      { $ref: '#/$defs/BooleanParam' },
      { $ref: '#/$defs/PathParam' },
    ]);
  });
});

describe('валидация манифеста по схеме', () => {
  it('пропускает валидный манифест', () => {
    const validate = ajv().compile(schema);
    expect(validate(JSON.parse(VALID_MANIFEST))).toBe(true);
  });

  it('скелет подстановки сам по себе валиден — контроль к отказам ниже', () => {
    // Пять кейсов ниже утверждают только `validate(...) === false` и ходят через `withTools`,
    // а единственный положительный кейс выше эту подстановку обходит. Без этой строки
    // ужесточение схемы, сделавшее невалидным сам скелет, превратило бы все пять в
    // ложно-зелёные — проходящие по неправильной причине.
    const manifest = withTools('{"ok": {"description": "x", "exec": ["true"], "params": {"p": {"type": "boolean"}}}}');
    expect(ajv().compile(schema)(manifest)).toBe(true);
  });

  it('отвергает рецепт с именем __proto__', () => {
    // Литерал `{__proto__: …}` в JS назначил бы прототип, а не свойство, — поэтому JSON.parse:
    // именно так имя и приезжает из недоверенного манифеста.
    const manifest = withTools('{"__proto__": {"description": "x", "exec": ["true"]}}');
    const validate = ajv().compile(schema);
    expect(validate(manifest)).toBe(false);
  });

  it('отвергает параметр с именем constructor', () => {
    const manifest = withTools(
      '{"ok": {"description": "x", "exec": ["true"], "params": {"constructor": {"type": "boolean"}}}}',
    );
    const validate = ajv().compile(schema);
    expect(validate(manifest)).toBe(false);
  });

  it('отвергает string без pattern', () => {
    const manifest = withTools('{"ok": {"description": "x", "exec": ["true"], "params": {"p": {"type": "string"}}}}');
    const validate = ajv().compile(schema);
    expect(validate(manifest)).toBe(false);
  });

  it('отвергает path без root', () => {
    const manifest = withTools('{"ok": {"description": "x", "exec": ["true"], "params": {"p": {"type": "path"}}}}');
    const validate = ajv().compile(schema);
    expect(validate(manifest)).toBe(false);
  });

  it('отвергает bidi-override в значении enum', () => {
    const manifest = withTools(
      '{"ok": {"description": "x", "exec": ["true"], "params": {"p": {"type": "enum", "values": ["a\\u202eb"]}}}}',
    );
    const validate = ajv().compile(schema);
    expect(validate(manifest)).toBe(false);
  });

  it('отвергает манифест без defaults', () => {
    const manifest = JSON.parse(VALID_MANIFEST) as Record<string, unknown>;
    delete manifest.defaults;
    const validate = ajv().compile(schema);
    expect(validate(manifest)).toBe(false);
  });
});

describe('кодогенерация типов', () => {
  it('закоммиченный manifest.generated.ts совпадает с текущим выводом генератора', () => {
    const fresh = execFileSync('node', [`${packageRoot}scripts/gen-types.mjs`, '--stdout'], { encoding: 'utf8' });
    const committed = readFileSync(`${packageRoot}src/manifest.generated.ts`, 'utf8');
    expect(committed).toBe(fresh);
  }, 60_000);
});
