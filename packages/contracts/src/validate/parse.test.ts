import { describe, expect, it } from 'vitest';
import { MANIFEST_MAX_BYTES, matcherKey, type ManifestSource } from '../types.js';
import { parseManifest } from './index.js';

const SOURCE: ManifestSource = { path: '/proj/mcpproxy.yaml' };

const HEAD = `version: 1
defaults:
  timeout: 120s
  output:
    maxBytes: 65536
    redact: true
  env:
    allow: ["PATH", "HOME"]
  sandbox:
    read: { deny: ["~/.ssh"], allow: ["."] }
    write: { allow: [] }
    network: { allow: [] }
tools:
`;

const VALID = `${HEAD}  publish_release:
    description: "Опубликовать релиз"
    exec: ["./scripts/publish.sh"]
    params:
      tag:
        type: string
        pattern: "^v\\\\d+\\\\.\\\\d+\\\\.\\\\d+$"
        required: true
        argv: ["{}"]
`;

/** Валидный манифест с одним рецептом, чьё тело подменяется под конкретный кейс. */
const withRecipe = (body: string): string => `${HEAD}${body}`;

describe('parseManifest — успешный разбор', () => {
  it('грузит валидный манифест', () => {
    const result = parseManifest(VALID, SOURCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.manifest.tools)).toEqual(['publish_release']);
    expect(result.manifest.version).toBe(1);
  });

  it('отдаёт скомпилированный матчер рядом с манифестом, а не внутри него', () => {
    const result = parseManifest(VALID, SOURCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const matcher = result.matchers.get(matcherKey('publish_release', 'tag'));
    expect(matcher).toBeDefined();
    expect(matcher?.test('v1.2.3')).toBe(true);
    expect(matcher?.test('release-1')).toBe(false);

    // Рецепт остаётся JSON-сериализуемым: иначе Task 9 не сможет подать его в canonicalizeJcs.
    expect(() => JSON.stringify(result.manifest)).not.toThrow();
  });
});

describe('parseManifest — схема', () => {
  it('одна диагностика на союз параметров, а не восемь', () => {
    const result = parseManifest(
      withRecipe(`  run_tests:
    description: "x"
    exec: ["true"]
    params:
      pattern:
        type: string
`),
      SOURCE,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      pointer: 'tools.run_tests.params.pattern',
      message: "must have required property 'pattern'",
    });
    expect(result.diagnostics[0]?.line).toBeGreaterThan(1);
  });

  it('отвергает path без root', () => {
    const result = parseManifest(
      withRecipe(`  analyze_logs:
    description: "x"
    exec: ["./s.sh"]
    params:
      file:
        type: path
`),
      SOURCE,
    );
    expect(result.ok).toBe(false);
  });

  it('отвергает неизвестный type', () => {
    const result = parseManifest(
      withRecipe(`  x:
    description: "x"
    exec: ["true"]
    params:
      p:
        type: sudo
`),
      SOURCE,
    );
    expect(result.ok).toBe(false);
  });

  it('отвергает рецепт с именем __proto__', () => {
    // yaml@2 кладёт __proto__ собственным свойством, а не подменяет прототип, — поэтому
    // propertyNames его видит. Утверждение фиксирует обе половины: и что имя доезжает до
    // валидатора, и что валидатор его отвергает.
    const result = parseManifest(
      withRecipe(`  __proto__:
    description: "x"
    exec: ["true"]
`),
      SOURCE,
    );
    expect(result.ok).toBe(false);
  });

  it('отвергает рецепт с именем constructor', () => {
    const result = parseManifest(
      withRecipe(`  constructor:
    description: "x"
    exec: ["true"]
`),
      SOURCE,
    );
    expect(result.ok).toBe(false);
  });
});

describe('parseManifest — враждебный YAML', () => {
  it('отвергает директиву %YAML 1.1', () => {
    // Без отказа `%YAML 1.1` возвращает булев разбор: sandbox.network.allow: [no] → [false].
    const result = parseManifest(`%YAML 1.1\n---\n${VALID}`, SOURCE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]?.message).toContain('%YAML');
  });

  it('отвергает дубли ключей', () => {
    const result = parseManifest(`${VALID}version: 1\n`, SOURCE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]?.message).toContain('DUPLICATE_KEY');
  });

  it('отвергает алиас-бомбу', () => {
    const bomb = [
      'version: 1',
      'a: &a ["x","x","x","x","x","x","x","x","x"]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]',
      'e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]',
      'f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]',
      'g: &g [*f,*f,*f,*f,*f,*f,*f,*f,*f]',
      'h: [*g,*g,*g,*g,*g,*g,*g,*g,*g]',
      '',
    ].join('\n');
    const result = parseManifest(bomb, SOURCE);
    expect(result.ok).toBe(false);
  });

  it('отвергает неизвестный тег', () => {
    // Тег не исполняется — он деградирует в строку с предупреждением TAG_RESOLVE_FAILED,
    // то есть без этого отказа манифест грузился бы молча.
    const result = parseManifest(`${VALID}extra: !!js/function "function(){}"\n`, SOURCE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]?.message).toContain('TAG_RESOLVE_FAILED');
  });

  it('отвергает второй документ в том же тексте', () => {
    const result = parseManifest(`${VALID}---\nversion: 1\n`, SOURCE);
    expect(result.ok).toBe(false);
  });
});

describe('parseManifest — лимит размера', () => {
  const limit = Buffer.byteLength(VALID, 'utf8') + 1;
  const source = (maxBytes: number): ManifestSource => ({ path: SOURCE.path, maxBytes });

  it('на байт меньше лимита — грузится', () => {
    expect(parseManifest(VALID, source(limit)).ok).toBe(true);
  });

  it('ровно на лимите — грузится', () => {
    expect(parseManifest(`${VALID} `, source(limit)).ok).toBe(true);
  });

  it('на байт больше лимита — отказ', () => {
    const result = parseManifest(`${VALID}  `, source(limit));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]?.message).toContain('лимита');
  });

  it('maxBytes может только понижать потолок, но не поднимать', () => {
    const huge = `${VALID}# ${'x'.repeat(MANIFEST_MAX_BYTES)}\n`;
    const result = parseManifest(huge, source(MANIFEST_MAX_BYTES * 10));
    expect(result.ok).toBe(false);
  });
});

describe('parseManifest — RE2 на загрузке', () => {
  const withPattern = (pattern: string): string =>
    withRecipe(`  x:
    description: "x"
    exec: ["true"]
    params:
      p:
        type: string
        pattern: "${pattern}"
`);

  it('отвергает lookahead — синтаксис, которого в RE2 нет', () => {
    const result = parseManifest(withPattern('^(?=.*a)b$'), SOURCE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]).toMatchObject({ pointer: 'tools.x.params.p.pattern' });
    expect(result.diagnostics[0]?.message).toContain('RE2');
  });

  it('не бэктрекит на вложенном квантификаторе', () => {
    const result = parseManifest(withPattern('^(a+)+$'), SOURCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const matcher = result.matchers.get(matcherKey('x', 'p'));

    const started = process.hrtime.bigint();
    expect(matcher?.test(`${'a'.repeat(64)}b`)).toBe(false);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    // Запас пять порядков: 0.009 мс против геологического времени у встроенного RegExp (Ф1/Ф2),
    // поэтому порог не флакает.
    expect(elapsedMs).toBeLessThan(50);
  });
});
