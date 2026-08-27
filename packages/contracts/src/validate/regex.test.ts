import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import type { Manifest } from '../manifest.generated.js';
import { matcherKey, type ManifestSource } from '../types.js';
import { AJV_OPTIONS } from './ajv.js';
import { parseManifest } from './index.js';
import { compilePattern, RE2_ENGINE } from './regex.js';

const SOURCE: ManifestSource = { path: '/proj/mcpproxy.yaml' };

const FIXTURE = `version: 1
defaults:
  timeout: 120s
  output: { maxBytes: 65536, redact: true }
  env: { allow: ["PATH"] }
  sandbox:
    read: { deny: ["~/.ssh"], allow: ["."] }
tools:
  run_tests:
    description: "x"
    exec: ["pnpm", "test"]
    params:
      pattern:
        type: string
        pattern: "^[\\\\w./-]{0,64}$"
      update_snapshots:
        type: boolean
  publish_release:
    description: "y"
    exec: ["./scripts/publish.sh"]
    params:
      tag:
        type: string
        pattern: "^v\\\\d+\\\\.\\\\d+\\\\.\\\\d+$"
      channel:
        type: enum
        values: ["stable", "beta"]
      notes:
        type: path
        root: "./notes"
`;

/** Сколько параметров с `pattern` объявляет манифест — считается по нему, а не вписывается числом. */
function countStringParams(manifest: Manifest): number {
  return Object.values(manifest.tools)
    .flatMap((recipe) => Object.values(recipe.params ?? {}))
    .filter((param) => param.type === 'string').length;
}

describe('compilePattern', () => {
  it('принимает паттерны, которые объявляют наши же доки', () => {
    expect(compilePattern('^[\\w./-]{0,64}$').ok).toBe(true);
    expect(compilePattern('^v\\d+\\.\\d+\\.\\d+$').ok).toBe(true);
  });

  it('отвергает lookahead и обратную ссылку — синтаксис, которого в RE2 нет', () => {
    expect(compilePattern('^(?=.*a)b$')).toMatchObject({ ok: false });
    expect(compilePattern('(a)\\1')).toMatchObject({ ok: false });
  });

  it('не выставляет наружу source и flags', () => {
    // Иначе потребитель соберёт `new RegExp(matcher.source)` и вернёт ровно тот вектор,
    // который закрыт здесь только на загрузке (R29).
    const compiled = compilePattern('^a+$');
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(Object.keys(compiled.matcher)).toEqual(['test']);
    expect((compiled.matcher as { source?: unknown }).source).toBeUndefined();
    expect((compiled.matcher as { flags?: unknown }).flags).toBeUndefined();
  });
});

describe('движок, отданный ajv', () => {
  it('это RE2, а не встроенный RegExp', () => {
    // Прямое утверждение о том, что именно уезжает в `code.regExp`: встроенный движок
    // lookahead компилирует молча, RE2 — бросает.
    expect(() => RE2_ENGINE('^(?=.*a)b$', 'u')).toThrow(/invalid perl operator/);
    expect(RE2_ENGINE('^v\\d+$', 'u').test('v12')).toBe(true);
  });

  it('и он действительно проведён в ajv, а не только объявлен рядом', () => {
    // Единственное наблюдаемое следствие проводки: схема с lookahead перестаёт компилироваться.
    // Со встроенным движком она компилируется молча, поэтому без этого утверждения удаление
    // `code.regExp` не краснело бы ничем — паритет движков на нашей схеме разницы не даёт.
    expect(() => new Ajv2020(AJV_OPTIONS).compile({ type: 'string', pattern: '^(?=.*a)b$' })).toThrow(
      /invalid perl operator/,
    );
    expect(new Ajv2020(AJV_OPTIONS).compile({ type: 'string', pattern: '^v\\d+$' })('v12')).toBe(true);
  });

  it('паритет: схема компилируется, валидное проходит, невалидное отвергается', () => {
    // Ф10. С подключённым RE2 наша собственная схема обязана остаться компилируемой —
    // именно поэтому SafeText задан категориями, а не отрицательным просмотром вперёд.
    const ok = parseManifest(FIXTURE, SOURCE);
    expect(ok.ok).toBe(true);

    const poisoned = FIXTURE.replace('"stable", "beta"', '"sta\\u202eble", "beta"');
    expect(parseManifest(poisoned, SOURCE).ok).toBe(false);
  });
});

describe('карта матчеров', () => {
  it('покрывает каждый параметр с pattern и только их', () => {
    const result = parseManifest(FIXTURE, SOURCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Промах в карте иначе неотличим от «у параметра паттерна нет», а запасной путь
    // у потребителя в этом месте — `new RegExp`.
    expect(result.matchers.size).toBe(countStringParams(result.manifest));
    expect([...result.matchers.keys()].sort()).toEqual(
      [matcherKey('publish_release', 'tag'), matcherKey('run_tests', 'pattern')].sort(),
    );
  });

  it('ключуется функцией, а не конкатенацией на стороне вызывающего', () => {
    const result = parseManifest(FIXTURE, SOURCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(matcherKey('publish_release', 'tag')).toBe('tools.publish_release.params.tag');
    expect(result.matchers.get(matcherKey('publish_release', 'tag'))?.test('v1.0.0')).toBe(true);
    expect(result.matchers.get(matcherKey('publish_release', 'tag'))?.test('1.0.0')).toBe(false);
  });
});

describe('слабый, но законный паттерн — предпосылка гейта канонизируемости в E2', () => {
  it('^.{0,64}$ компилируется RE2 и пропускает одиночный суррогат', () => {
    // Весь довод R28 эпика E2 («вердикт не должен зависеть от того, насколько строг автор
    // манифеста») стоит на этом факте, а проверялся он там эмуляцией: `core` не имеет права
    // зависеть от `re2` (белый список R1). Здесь движок настоящий, поэтому предпосылка
    // закрепляется по адресу — иначе она однажды перестанет быть верной молча.
    const weak = compilePattern('^.{0,64}$');
    expect(weak.ok).toBe(true);
    if (!weak.ok) return;
    expect(weak.matcher.test('обычное значение')).toBe(true);
    expect(weak.matcher.test('ab\uD800c')).toBe(true);

    // Обратная сторона: строгий паттерн демо-манифеста его отбивает — и именно поэтому
    // полагаться на паттерн нельзя, а гейт обязан стоять до него.
    const strict = compilePattern('^[\\w./-]{0,64}$');
    expect(strict.ok).toBe(true);
    if (!strict.ok) return;
    expect(strict.matcher.test('ab\uD800c')).toBe(false);
  });
});
