import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asRecipeName, normalizeRecipe } from '@mcpproxy/contracts';
import type { Defaults, Recipe } from '@mcpproxy/contracts';
import { buildEnv } from './env.js';
import { EXEC_STAGES, collapseOutput, measure } from './events.js';
import type { ExecEvent } from './events.js';
import { buildProfile } from './profile.js';
import { createSandbox, newCommandId } from './sandbox.js';
import type { Sandbox, StreamOutcome } from './sandbox.js';

const IS_MACOS = process.platform === 'darwin';

const DEFAULTS: Defaults = {
  timeout: '30s',
  output: { maxBytes: 65_536, redact: true },
  env: { allow: ['E3_EVENT_SECRET'] },
  sandbox: { read: { deny: [] }, write: { allow: [] }, network: { allow: [] } },
};

const SECRET_VALUE = 'значение-которое-не-должно-утечь';

describe('collapseOutput (R20)', () => {
  const stream = (bytes: number, truncated: boolean): StreamOutcome => ({ text: '', bytes, truncated });

  it('байты — сумма, обрезанность — дизъюнкция', () => {
    // Событие несёт ОДНУ пару `{bytes, truncated}` (`event.ts:100`), а потоков два. Взяв
    // только stdout, событие молчало бы про stderr — а секрет, вылезший за потолок, с
    // равной вероятностью вылезает во второй поток.
    expect(collapseOutput(stream(10, false), stream(5, false))).toEqual({ bytes: 15, truncated: false });
    expect(collapseOutput(stream(10, true), stream(5, false))).toEqual({ bytes: 15, truncated: true });
    expect(collapseOutput(stream(10, false), stream(5, true))).toEqual({ bytes: 15, truncated: true });
  });
});

describe('measure (R35)', () => {
  it('меряет монотонными часами и отдаёт целые микросекунды', () => {
    const { value, durationUs } = measure(() => {
      let sum = 0;
      for (let i = 0; i < 200_000; i += 1) sum += i;
      return sum;
    });
    expect(value).toBeGreaterThan(0);
    expect(Number.isInteger(durationUs)).toBe(true);
    expect(durationUs).toBeGreaterThan(0);
  });
});

/**
 * Бюджет ≤50 мс p95 (R38) — **серией и с осмысленным порогом**.
 *
 * `overheadMs` (`event.ts:156`) делает `Math.round(total / 1000)`, а обе стадии — чистые
 * функции на десятки микросекунд: утверждение по нему не может покраснеть в принципе. Но и
 * `p95 < 50_000` мкс не годится — порог, втрое-тысячекратно превышающий ожидаемое, тоже
 * неспособен упасть.
 *
 * Пять миллисекунд — десятая доля бюджета и всё ещё на порядок выше измеренного: порог ловит
 * регрессию, а не шум.
 */
describe('бюджет оверхеда стадий E3 (R38)', () => {
  it('p95 суммы build_env и build_profile укладывается в пять миллисекунд', () => {
    const recipe: Recipe = {
      description: 'x',
      exec: ['/bin/true'],
      sandbox: { write: { allow: ['/tmp/a', '/tmp/b'] }, read: { deny: ['~/.ssh', '~/.aws'] } },
    };
    const { effective } = normalizeRecipe(recipe, DEFAULTS);

    const durations = Array.from({ length: 100 }, () => {
      const env = measure(() => buildEnv(effective.env.allow, process.env, {}));
      const profile = measure(() => buildProfile(effective.sandbox, '/tmp/recipe'));
      return env.durationUs + profile.durationUs;
    }).sort((a, b) => a - b);

    const p95 = durations[Math.floor(durations.length * 0.95)] ?? 0;
    expect(p95).toBeLessThan(5_000);
  });

  it('стоимость самой песочницы в бюджет НЕ входит, и это записано, а не подразумевается', () => {
    // Генерация SBPL и запуск `sandbox-exec` лежат внутри стадии `spawn`, из бюджета
    // исключённой (`event.ts:149`), а `initialize` не входит вовсе. Метрика меряет НАШ
    // оверхед, а не полную цену песочницы, и на слайд идёт с этой оговоркой.
    expect(EXEC_STAGES).toEqual(['build_env', 'build_profile', 'spawn', 'violation']);
  });
});

/**
 * Изоляция вендора (R1). ADR-0002 требует её дословно — «Research preview: API может
 * меняться. Изолируем за своим интерфейсом `Sandbox`».
 *
 * Обход графа **специфаеров импорта**, а не поиск подстроки в тексте: упоминание вендора в
 * комментарии не является протечкой типа, а реализация, спрятавшая тип и переписавшая
 * комментарий, прошла бы текстовую проверку.
 */
describe('изоляция вендора в графе деклараций (R1)', () => {
  const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
  const entry = resolve(packageRoot, 'dist', 'index.d.ts');

  const specifiersOf = (source: string): string[] =>
    [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)]
      .map((match) => match[1])
      .filter((one): one is string => one !== undefined);

  const walk = (): { files: string[]; bare: string[] } => {
    const seen = new Set<string>();
    const bare = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.pop();
      if (file === undefined || seen.has(file) || !existsSync(file)) continue;
      seen.add(file);
      for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
        if (!specifier.startsWith('.')) {
          bare.add(specifier);
          continue;
        }
        queue.push(resolve(dirname(file), specifier.replace(/\.js$/, '.d.ts')));
      }
    }
    return { files: [...seen], bare: [...bare] };
  };

  it('граф действительно обойдён — иначе всё последующее вакуумно', () => {
    // Без этого утверждения на чистом клоне (где `dist/` нет) обход вернул бы пустое
    // множество, и отрицание ниже было бы зелёным ровно тогда, когда проверять нечего.
    expect(existsSync(entry)).toBe(true);
    expect(walk().files.length).toBeGreaterThan(3);
  });

  it('ни один тип из @anthropic-ai/sandbox-runtime не виден из публичного входа', () => {
    const { bare } = walk();
    expect(bare.filter((one) => one.includes('sandbox-runtime'))).toEqual([]);
  });

  it('а вот в модулях режимов вендор ЕСТЬ — иначе проверка выше ничего не значила бы', () => {
    // Граница проходит по достижимости из входа, а не по отсутствию вендора в пакете. Если
    // бы его не было нигде, отрицание выше держалось бы ни на чём.
    const seatbelt = resolve(packageRoot, 'dist', 'exec', 'modes', 'seatbelt.d.ts');
    expect(existsSync(seatbelt)).toBe(true);
    expect(specifiersOf(readFileSync(seatbelt, 'utf8')).some((one) => one.includes('sandbox-runtime'))).toBe(true);
    expect(walk().files).not.toContain(seatbelt);
  });
});

describe.skipIf(!IS_MACOS)('порядок появления полей в событиях (R32, R33, R34)', () => {
  let sandbox: Sandbox;
  let fixture: string;
  let events: ExecEvent[];

  const at = (stage: string): ExecEvent => {
    const found = events.find((one) => one.stage === stage);
    if (found === undefined) throw new Error(`нет события стадии ${stage}`);
    return found;
  };

  beforeAll(async () => {
    process.env['E3_EVENT_SECRET'] = SECRET_VALUE;
    sandbox = createSandbox('seatbelt');
    fixture = mkdtempSync(join(tmpdir(), 'e3-events-'));
    writeFileSync(join(fixture, 'secret.txt'), 'верхний секрет');

    const recipe: Recipe = {
      description: 'x',
      exec: ['/bin/sh'],
      env: { allow: ['E3_EVENT_SECRET'] },
      sandbox: { read: { deny: ['./secret.txt'] } },
    };
    const { effective } = normalizeRecipe(recipe, DEFAULTS);
    events = [];

    await sandbox.run(
      {
        recipeName: asRecipeName('events'),
        command: ['/bin/sh', '-c', `cat '${join(fixture, 'secret.txt')}' 2>/dev/null; echo done`],
        recipeCwd: fixture,
        effective,
        commandId: newCommandId(),
      },
      () => undefined,
      (event) => events.push(event),
    );
  });

  afterAll(async () => {
    await sandbox.dispose();
    rmSync(fixture, { recursive: true, force: true });
    delete process.env['E3_EVENT_SECRET'];
  });

  it('событие есть на каждой из четырёх стадий E3', () => {
    for (const stage of EXEC_STAGES) expect(events.map((one) => one.stage)).toContain(stage);
  });

  it('sandbox не появляется раньше build_profile', () => {
    expect(Object.keys(at('build_env'))).not.toContain('sandbox');
  });

  it('env — только имена, значение секрета не сериализуется (R25)', () => {
    expect(at('build_env').env?.allowed).toEqual(['E3_EVENT_SECRET']);
    expect(JSON.stringify(at('build_env'))).not.toContain(SECRET_VALUE);
  });

  /**
   * Необязательное поле **отсутствует ключом**, а не приезжает с `null` (R34): JCS
   * различает их побайтово, и оба варианта попадают внутрь хэша цепочки.
   */
  it('violations отсутствуют ключом на build_profile и присутствуют на violation', () => {
    const profile = at('build_profile').sandbox;
    expect(profile).toBeDefined();
    expect(profile !== undefined && 'violations' in profile).toBe(false);
    expect(at('violation').sandbox?.violations).toHaveLength(1);
  });

  /**
   * `sandbox.mode` приезжает уже на `build_profile` — вынужденное исключение: в замороженном
   * типе `mode` обязателен всегда, когда присутствует `sandbox` (`event.ts:92-93`). Таблица
   * в комментарии `event.ts` относит его к `spawn`, но комментарий проигрывает типу, а режим
   * на этой стадии уже известен — его выбрал вызывающий (R4).
   */
  it('mode едет вместе с sandbox на каждой стадии, где sandbox есть', () => {
    for (const event of events) {
      if (event.sandbox === undefined) continue;
      expect(event.sandbox.mode).toBe('seatbelt');
    }
  });

  it('profile в событии — СЫРОЙ SandboxProfile манифеста, а не резолвнутая политика (R36)', () => {
    // Резолвнутые пути уехали бы в модалку E5 как манифестные, и человек согласовывал бы не
    // то, что написано в рецепте.
    expect(at('build_profile').sandbox?.profile?.read?.deny).toEqual(['./secret.txt']);
  });

  it('durationUs — целое число микросекунд на каждой стадии', () => {
    for (const event of events) {
      expect(Number.isInteger(event.durationUs)).toBe(true);
      expect(event.durationUs).toBeGreaterThanOrEqual(0);
    }
  });
});
