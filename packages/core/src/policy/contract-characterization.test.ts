import { describe, expect, it } from 'vitest';
import {
  DURATION_MAX_MS,
  OUTPUT_MAX_BYTES_DEFAULT,
  RESERVED_RECIPE_NAMES,
  durationToMs,
  isRecipeName,
  normalizeRecipe,
} from '@mcpproxy/contracts';
import type { Defaults, Recipe } from '@mcpproxy/contracts';

/**
 * Характеризация трёх поведений `@mcpproxy/contracts`, на которые E1 опирается (R22).
 *
 * Коммит `0903753` лёг после последнего прогона гейтов E0 и после всех вейверов, то есть
 * клампинг в `normalizeRecipe` не закреплён ни одним тестом-потребителем. E1 — первый
 * настоящий потребитель этих функций: `checkLock` строит вердикт на `diffLock`, а тот зовёт
 * `normalizeRecipe` на каждом рецепте. Снятие клампинга не уронило бы ни одного теста
 * `contracts` и приехало бы сюда молчаливым ослаблением политики.
 *
 * Утверждения ниже намеренно не сверяют форму с самой собой: значения записаны литералами.
 */

const defaultsOf = (patch: Partial<Defaults> = {}): Defaults => ({
  timeout: '120s',
  output: { maxBytes: 1000, redact: true },
  env: { allow: ['PATH', 'HOME'] },
  sandbox: { read: { allow: ['.'], deny: ['~/.ssh'] } },
  ...patch,
});

const recipeOf = (patch: Partial<Recipe> = {}): Recipe => ({
  description: 'рецепт',
  exec: ['pnpm', 'test'],
  ...patch,
});

describe('normalizeRecipe: redact включается и не выключается', () => {
  it('`false` рецепта против `true` базы даёт `true`', () => {
    const normalized = normalizeRecipe(recipeOf({ output: { redact: false } }), defaultsOf());
    expect(normalized.effective.output.redact).toBe(true);
  });

  it('`true` рецепта против `false` базы даёт `true` — включить можно', () => {
    const base = defaultsOf({ output: { maxBytes: 1000, redact: false } });
    expect(normalizeRecipe(recipeOf({ output: { redact: true } }), base).effective.output.redact).toBe(true);
  });

  it('собственный блок хранит объявленное, а не эффективное', () => {
    const normalized = normalizeRecipe(recipeOf({ output: { redact: false } }), defaultsOf());
    expect(normalized.own.output).toEqual({ maxBytes: null, redact: false });
  });
});

describe('normalizeRecipe: maxBytes берётся минимумом', () => {
  it('рецепт не может поднять потолок базы', () => {
    const normalized = normalizeRecipe(recipeOf({ output: { maxBytes: 999_999 } }), defaultsOf());
    expect(normalized.effective.output.maxBytes).toBe(1000);
  });

  it('рецепт может опустить потолок базы', () => {
    const normalized = normalizeRecipe(recipeOf({ output: { maxBytes: 10 } }), defaultsOf());
    expect(normalized.effective.output.maxBytes).toBe(10);
  });

  it('молчание базы даёт не отсутствие потолка, а умолчание пакета', () => {
    const base = defaultsOf({ output: {} });
    const normalized = normalizeRecipe(recipeOf({ output: { maxBytes: 999_999 } }), base);
    expect(base.output.maxBytes).toBeUndefined();
    expect(normalized.effective.output.maxBytes).toBe(OUTPUT_MAX_BYTES_DEFAULT);
  });
});

describe('normalizeRecipe: env.allow пересекается с базой', () => {
  it('имя, которого нет в базе, не появляется в эффективном профиле', () => {
    const normalized = normalizeRecipe(recipeOf({ env: { allow: ['PATH', 'AWS_SECRET_ACCESS_KEY'] } }), defaultsOf());
    expect(normalized.effective.env.allow).toEqual(['PATH']);
  });

  it('собственный блок при этом хранит объявленное целиком', () => {
    const normalized = normalizeRecipe(recipeOf({ env: { allow: ['PATH', 'AWS_SECRET_ACCESS_KEY'] } }), defaultsOf());
    expect(normalized.own.env).toEqual({ allow: ['PATH', 'AWS_SECRET_ACCESS_KEY'] });
  });

  it('молчание рецепта оставляет базу целиком', () => {
    expect(normalizeRecipe(recipeOf(), defaultsOf()).effective.env.allow).toEqual(['PATH', 'HOME']);
  });
});

describe('durationToMs: граница DURATION_MAX_MS', () => {
  it('константа равна максимуму таймера платформы', () => {
    expect(DURATION_MAX_MS).toBe(2_147_483_647);
  });

  it('ровно на границе разбирается', () => {
    expect(durationToMs('2147483647ms')).toBe(DURATION_MAX_MS);
  });

  it('на единицу выше разбирается — предел значения держит не разбор', () => {
    expect(durationToMs('2147483648ms')).toBe(2_147_483_648);
  });

  it('одиннадцать цифр не разбираются вовсе', () => {
    expect(() => durationToMs('99999999999ms')).toThrow(TypeError);
  });
});

describe('isRecipeName: зарезервированные имена', () => {
  // Имена строятся из СТРОК, а не ключами объектного литерала: `{ __proto__: … }` задаёт
  // прототип, а не ключ, и проба, написанная так, проверяла бы не то, что утверждает.
  const reserved = ['__proto__', 'constructor', 'prototype'];

  it('список контракта совпадает с проверяемым здесь', () => {
    expect([...RESERVED_RECIPE_NAMES].sort()).toEqual([...reserved].sort());
  });

  for (const name of reserved) {
    it(`отвергает ${name}`, () => {
      expect(isRecipeName(name)).toBe(false);
    });
  }

  it('законное имя принимает', () => {
    expect(isRecipeName('run_tests')).toBe(true);
  });

  it('отвергает имя, не подходящее паттерну', () => {
    expect(isRecipeName('Bad-Name')).toBe(false);
  });
});
