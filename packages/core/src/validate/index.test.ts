import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asRecipeName, matcherKey, type PatternMatcher, type Recipe } from '@mcpproxy/contracts';
import { argsHash } from '@mcpproxy/contracts/audit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateCall, type CallResult } from './index.js';
import { prepareRecipe, type PreparedRecipe } from './prepare.js';

const NAME = asRecipeName('analyze_logs');
const strict: PatternMatcher = { test: (value: string): boolean => /^[\w./-]{0,64}$/u.test(value) };

let base = '';
let root = '';
let prepared: PreparedRecipe;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'e2-facade-'));
  root = join(base, 'logs');
  mkdirSync(root);
  writeFileSync(join(root, 'a.log'), 'x');
  // NFD-имя записано escape'ами: NFC- и NFD-литералы визуально неотличимы.
  writeFileSync(join(root, 'cafe\u0301.log'), 'x');

  const recipe: Recipe = {
    description: 'опись',
    exec: ['/usr/bin/wc'],
    cwd: './work',
    params: {
      pattern: { type: 'string', pattern: '^[\\w./-]{0,64}$' },
      file: { type: 'path', root, argv: ['--file={}'] },
    },
  };
  const result = prepareRecipe(NAME, recipe, new Map([[matcherKey(NAME, 'pattern'), strict]]), base);
  if (!result.ok) throw new Error(`фикстура не подготовилась: ${result.problems.join('; ')}`);
  prepared = result.prepared;
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

const hashOf = (result: Extract<CallResult, { ok: true }>): string => argsHash(NAME, result.params);

describe('validateCall — измерение стадий (R23)', () => {
  it('timings содержат отказавшую стадию, а не обрываются перед ней', () => {
    // Утверждается ИМЯ стадии, а не длина: без неё E4 нечем заполнить `durationUs`
    // обязательного ядра события.
    const result = validateCall(prepared, { pattern: 'плохое значение; rm' });
    expect(result.ok).toBe(false);
    expect(result.timings.map((one) => one.stage)).toEqual(['validate']);
  });

  it('успешный вызов измеряет все три стадии по порядку', () => {
    const result = validateCall(prepared, { file: 'a.log' });
    expect(result.ok).toBe(true);
    expect(result.timings.map((one) => one.stage)).toEqual(['validate', 'resolve_paths', 'build_argv']);
  });

  it('длительность — целое неотрицательное число микросекунд', () => {
    // Утверждается форма, а не величина: конкретная величина флакает на нагрузке. Бюджет
    // ≤50 мс p95 здесь НЕ проверяется — оверхед определён относительно прямого вызова того же
    // скрипта, а скрипта на этой стадии ещё нет. Замер — E8/E9.
    const result = validateCall(prepared, { file: 'a.log' });
    for (const timing of result.timings) {
      expect(Number.isInteger(timing.durationUs), timing.stage).toBe(true);
      expect(timing.durationUs, timing.stage).toBeGreaterThanOrEqual(0);
    }

    // Позитивный контроль: без него `durationUs: 0` константой проходит оба утверждения
    // выше, то есть измерение можно выкинуть целиком при 97/97 зелёных. `resolve_paths`
    // делает два `realpath`; замерено 200 прогонов — минимум 26 мкс, ноль не встретился ни
    // разу. Утверждается «больше нуля», а не величина: величина флакает под нагрузкой.
    const byStage = (stage: string): number =>
      result.timings.find((one) => one.stage === stage)?.durationUs ?? -1;
    expect(byStage('resolve_paths')).toBeGreaterThan(0);
    expect(result.timings.reduce((sum, one) => sum + one.durationUs, 0)).toBeGreaterThan(0);
  });
});

describe('validateCall — cwd появляется со стадии резолва (R18, шаг 6)', () => {
  it('отказ на resolve_paths несёт cwd; отказ на validate его НЕ имеет', () => {
    // Утверждается `'cwd' in result`, а не сравнение с `null`: сравнение зелено и при
    // `cwd: undefined`, которое как раз и запрещено `exactOptionalPropertyTypes`.
    const onResolve = validateCall(prepared, { file: 'missing.log' });
    expect(onResolve.ok).toBe(false);
    expect('cwd' in onResolve).toBe(true);
    expect(onResolve.ok ? null : onResolve.cwd).toBe(join(base, 'work'));

    const onValidate = validateCall(prepared, { pattern: 'плохое; rm' });
    expect(onValidate.ok).toBe(false);
    expect('cwd' in onValidate).toBe(false);
  });

  it('cwd вычислен подготовкой и здесь не пересчитывается', () => {
    const result = validateCall(prepared, { file: 'a.log' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cwd).toBe(prepared.cwd);
  });
});

describe('validateCall — все отказы наружу, argv только в успехе', () => {
  it('стадия отдаёт все свои отказы, а не первый', () => {
    const result = validateCall(prepared, { aaa: 1, bbb: 2 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denials.map((one) => one.code)).toEqual(['unknown-param', 'unknown-param']);
  });

  it('в ветке отказа поля argv нет вовсе', () => {
    const result = validateCall(prepared, { file: 'missing.log' });
    expect('argv' in result).toBe(false);
  });
});

describe('validateCall — сквозная связка argv и argsHash (R31, R17)', () => {
  it('argv равен резолвнутому пути байт в байт, а argsHash от него не бросает', () => {
    // Три утверждения сразу, потому что шов между argv и хэшом ломается именно на проводке,
    // а не внутри стадии. Любая нормализация в цепочке роняет первое.
    const nfd = 'cafe\u0301.log';
    const relative = validateCall(prepared, { file: nfd });
    expect(relative.ok).toBe(true);
    if (!relative.ok) return;

    expect(relative.argv.at(-1)).toBe(`--file=${realpathSync(join(root, nfd))}`);
    expect(() => hashOf(relative)).not.toThrow();

    const absolute = validateCall(prepared, { file: join(root, nfd) });
    expect(absolute.ok).toBe(true);
    if (!absolute.ok) return;
    // Одним вызовом их делает `realpath`, а не нормализация.
    expect(hashOf(relative)).toBe(hashOf(absolute));
  });

  it('params наружу — это значения ПОСЛЕ резолва, а не сырой запрос', () => {
    const result = validateCall(prepared, { file: 'a.log' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.params['file']).toBe(realpathSync(join(root, 'a.log')));
    expect(result.params['file']).not.toBe('a.log');
  });

  it('exec стоит первым и в него ничего не подставлено', () => {
    const result = validateCall(prepared, { file: 'a.log' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.argv[0]).toBe('/usr/bin/wc');
  });
});

// ── Уровня типа: ветка отказа замкнута и поля `argv` в ней нет.

type FailureBranch = Extract<CallResult, { ok: false }>;
type FailureExtraKeys = Exclude<keyof FailureBranch, 'ok' | 'denials' | 'cwd' | 'timings'>;
const _failureClosed: [FailureExtraKeys] extends [never] ? true : FailureExtraKeys = true;
void _failureClosed;

type SuccessBranch = Extract<CallResult, { ok: true }>;
type SuccessExtraKeys = Exclude<keyof SuccessBranch, 'ok' | 'argv' | 'cwd' | 'params' | 'timings'>;
const _successClosed: [SuccessExtraKeys] extends [never] ? true : SuccessExtraKeys = true;
void _successClosed;

// Появится `argv` в ветке отказа — директива станет неиспользованной, и сборка упадёт здесь.
const _noArgvOnFailure: FailureBranch = {
  ok: false,
  denials: [{ stage: 'validate', code: 'wrong-type', paramName: 'p', reason: 'x' }],
  timings: [],
  // @ts-expect-error — форма, из которой E4 не может собрать argv на отказе
  argv: [],
};
void _noArgvOnFailure;
