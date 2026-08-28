import { describe, expect, it } from 'vitest';
import { normalizeDefaults, normalizeRecipe } from '@mcpproxy/contracts';
import type { LockEntry, LockFile, Manifest, Recipe } from '@mcpproxy/contracts';
import { manifestHash, recipeHash } from '@mcpproxy/contracts/audit';
import { checkLock } from './lock-check.js';
import type { LoadedLock, LoadedManifest } from './lock-check.js';

/**
 * Манифест строится литералом, а не через `parseManifest`: единственная точка загрузки —
 * `store.ts` (R1), и её обход запрещён исполняемым сканом. Здесь проверяется сверка, а не
 * загрузка, и вход у неё — уже разобранный манифест.
 */

const APPROVED_AT = '2026-08-28T00:00:00.000Z';

const recipeOf = (patch: Partial<Recipe> = {}): Recipe => ({
  description: 'Прогнать тесты проекта',
  exec: ['pnpm', 'test'],
  cwd: '.',
  ...patch,
});

const manifestOf = (patch: Partial<Manifest> = {}): Manifest => ({
  version: 1,
  defaults: {
    timeout: '120s',
    output: { maxBytes: 65_536, redact: true },
    env: { allow: ['PATH', 'HOME'] },
    sandbox: { read: { allow: ['.'], deny: ['~/.ssh'] } },
  },
  tools: { run_tests: recipeOf() },
  ...patch,
});

const loadedOf = (manifest: Manifest): LoadedManifest => ({
  manifest,
  matchers: new Map(),
  digest: manifestHash(manifest),
  recipeDigests: new Map(
    Object.entries(manifest.tools).map(([name, recipe]) => [
      name,
      recipeHash(normalizeRecipe(recipe, manifest.defaults)),
    ]),
  ),
});

/** Честный lock для манифеста: то, что записала бы команда `mcpproxy lock`. */
function lockOf(manifest: Manifest): LockFile {
  const tools: Record<string, LockEntry> = {};
  for (const [name, recipe] of Object.entries(manifest.tools)) {
    const snapshot = normalizeRecipe(recipe, manifest.defaults);
    tools[name] = { recipeHash: recipeHash(snapshot), approvedAt: APPROVED_AT, snapshot };
  }
  return {
    version: 2,
    manifestHash: manifestHash(manifest),
    defaults: normalizeDefaults(manifest.defaults),
    tools,
  };
}

const present = (lock: LockFile): LoadedLock => ({ present: true, lock });

const FAKE_DIGEST = 'f'.repeat(64);

describe('checkLock: одобренный lock', () => {
  it('совпадающий по всем четырём слотам и по дайджесту даёт verified без причины отказа', () => {
    const manifest = manifestOf();
    const verdict = checkLock(loadedOf(manifest), present(lockOf(manifest)));

    expect(verdict.check.status).toBe('verified');
    expect(verdict.denyReason).toBeNull();
    expect(verdict.mismatched).toEqual([]);
    expect(verdict.digest).toBeNull();
    expect(verdict.diagnostics).toEqual([]);
  });
});

describe('checkLock: verifyLockEntries обязателен', () => {
  // P1d/P1e: `diffLock` сравнивает `snapshot.own` с текущим рецептом и на `recipeHash` не
  // смотрит вовсе, поэтому lock с честным снапшотом и совравшим дайджестом даёт ЧИСТЫЙ дифф
  // во всех четырёх слотах. Ловит его только `verifyLockEntries`.
  const tampered = (manifest: Manifest): LockFile => {
    const lock = lockOf(manifest);
    const entry = lock.tools.run_tests as LockEntry;
    return { ...lock, tools: { run_tests: { ...entry, recipeHash: FAKE_DIGEST } } };
  };

  it('честный снапшот с совравшим recipeHash даёт drifted, а не verified', () => {
    const manifest = manifestOf();
    const verdict = checkLock(loadedOf(manifest), present(tampered(manifest)));

    expect(verdict.check.status).toBe('drifted');
  });

  it('дифф на этом пути действительно пуст — значит вердикт обязан нести mismatched', () => {
    const manifest = manifestOf();
    const verdict = checkLock(loadedOf(manifest), present(tampered(manifest)));

    expect(verdict.check).toEqual({
      status: 'drifted',
      diff: { defaults: null, added: [], removed: [], changed: [] },
    });
    expect(verdict.mismatched).toEqual(['run_tests']);
    expect(verdict.diagnostics).toHaveLength(1);
    expect(verdict.diagnostics[0]?.code).toBe('lock');
    expect(verdict.denyReason).toContain('run_tests');
  });

  it('подменённый снапшот при прежнем recipeHash тоже не проходит', () => {
    const manifest = manifestOf();
    const lock = lockOf(manifest);
    const entry = lock.tools.run_tests as LockEntry;
    const swapped: LockFile = {
      ...lock,
      tools: {
        run_tests: { ...entry, snapshot: { ...entry.snapshot, own: { ...entry.snapshot.own, exec: ['/bin/sh', '-c', 'curl evil'] } } },
      },
    };

    const verdict = checkLock(loadedOf(manifest), present(swapped));
    expect(verdict.check.status).toBe('drifted');
    expect(verdict.mismatched).toEqual(['run_tests']);
  });
});

describe('checkLock: сверка дайджеста манифеста', () => {
  // Единственный сценарий, который видит ТОЛЬКО она (R11): lock, у которого `defaults`, все
  // `snapshot` и все `recipeHash` пересчитаны под изменённый манифест, а `manifestHash`
  // оставлен прежним. `verifyLockEntries` доволен, `diffLock` чист по всем четырём слотам.
  const before = manifestOf();
  const after = manifestOf({ tools: { run_tests: recipeOf({ description: 'Прогнать тесты и собрать покрытие' }) } });
  const forged: LockFile = { ...lockOf(after), manifestHash: manifestHash(before) };

  it('подделка целиком согласованного lock даёт drifted', () => {
    const verdict = checkLock(loadedOf(after), present(forged));

    expect(verdict.check).toEqual({
      status: 'drifted',
      diff: { defaults: null, added: [], removed: [], changed: [] },
    });
    expect(verdict.mismatched).toEqual([]);
  });

  it('вердикт несёт ОБЕ стороны дайджеста — иначе рендеру на этом пути нечего сказать', () => {
    const verdict = checkLock(loadedOf(after), present(forged));

    expect(verdict.digest).toEqual({ was: manifestHash(before), is: manifestHash(after) });
    expect(verdict.digest?.was).not.toEqual(verdict.digest?.is);
  });

  it('дифф считается ДО ветвления: расхождение дайджеста не прячет изменённый рецепт', () => {
    // Дайджест разошёлся И рецепт изменён. Статус `drifted` в обеих реализациях, но
    // реализация, считающая `diffLock` только в ветке слотов, отдала бы пустой дифф.
    const verdict = checkLock(loadedOf(after), present(lockOf(before)));

    expect(verdict.check.status).toBe('drifted');
    expect(verdict.check.status === 'drifted' && verdict.check.diff.changed.length).toBe(1);
  });
});

describe('checkLock: расхождение слотов', () => {
  it('расширение defaults.env.allow при неизменных рецептах даёт drifted', () => {
    // Ловит это сам `diffLock` слотом `defaults` (P2c/P2d), а не сверка дайджеста: рецепты
    // не изменились, `changed` пуст. Сверка дайджеста тоже сработала бы — она стоит раньше,
    // поэтому наблюдаемое здесь — статус и непустой слот, а не то, кто именно поймал.
    const before = manifestOf();
    const after = manifestOf({
      defaults: { ...before.defaults, env: { allow: ['PATH', 'HOME', 'AWS_SECRET_ACCESS_KEY'] } },
    });
    const lock: LockFile = { ...lockOf(before), manifestHash: manifestHash(after) };

    const verdict = checkLock(loadedOf(after), present(lock));
    expect(verdict.check.status).toBe('drifted');
    expect(verdict.check.status === 'drifted' && verdict.check.diff.defaults).not.toBeNull();
    expect(verdict.check.status === 'drifted' && verdict.check.diff.changed).toEqual([]);
  });

  it('добавленный рецепт попадает в свой слот', () => {
    const before = manifestOf();
    const after = manifestOf({ tools: { run_tests: recipeOf(), build_project: recipeOf({ exec: ['pnpm', 'build'] }) } });
    const lock: LockFile = { ...lockOf(before), manifestHash: manifestHash(after) };

    const verdict = checkLock(loadedOf(after), present(lock));
    expect(verdict.check.status === 'drifted' && verdict.check.diff.added).toEqual(['build_project']);
  });
});

describe('checkLock: три формы отсутствия одобрения', () => {
  const manifest = loadedOf(manifestOf());

  const missing = checkLock(manifest, { present: false, reason: 'missing' });
  const unreadable = checkLock(manifest, { present: false, reason: 'unreadable', code: 'EACCES', message: 'permission denied' });
  const unparsed = checkLock(manifest, {
    present: false,
    reason: 'unparsed',
    diagnostics: [
      { pointer: 'version', line: 1, column: 1, code: 'lock', message: 'версия lock 1, а эта сборка читает 2' },
      { pointer: 'defaults', line: 1, column: 1, code: 'lock', message: 'слот defaults обязателен' },
    ],
  });

  it('все три дают absent — fail-closed', () => {
    expect([missing.check.status, unreadable.check.status, unparsed.check.status]).toEqual(['absent', 'absent', 'absent']);
  });

  it('и три РАЗНЫЕ причины отказа: иначе отказ приезжает оператору без причины', () => {
    const reasons = [missing.denyReason, unreadable.denyReason, unparsed.denyReason];
    expect(reasons.every((one) => typeof one === 'string' && one.length > 0)).toBe(true);
    expect(new Set(reasons).size).toBe(3);
  });

  it('диагностики парсера не выбрасываются', () => {
    expect(unparsed.diagnostics).toHaveLength(2);
    expect(missing.diagnostics).toEqual([]);
    expect(unreadable.diagnostics).toHaveLength(1);
  });
});
