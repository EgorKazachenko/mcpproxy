import { describe, expect, it } from 'vitest';
import { recipeHash } from '../audit/lock.js';
import { normalizeDefaults, normalizeRecipe, type LockFile } from '../lock.js';
import type { Defaults, Recipe } from '../manifest.generated.js';
import { parseLockFile } from './lock.js';

const DEFAULTS: Defaults = {
  timeout: '120s',
  output: { maxBytes: 65536, redact: true },
  env: { allow: ['PATH'] },
  sandbox: { read: { deny: ['~/.ssh'], allow: ['.'] } },
};

const PUBLISH: Recipe = {
  description: 'Опубликовать релиз',
  exec: ['./scripts/publish.sh'],
  annotations: { readOnlyHint: false, destructiveHint: true },
};

const normalized = normalizeRecipe(PUBLISH, DEFAULTS);

const CURRENT: LockFile = {
  version: 2,
  manifestHash: 'a'.repeat(64),
  defaults: normalizeDefaults(DEFAULTS),
  tools: {
    publish_release: { recipeHash: recipeHash(normalized), approvedAt: '2026-08-27T10:00:00Z', snapshot: normalized },
  },
};

/**
 * Форма ревизии 1 — та, что была задокументирована ДО этого диффа: поле называлось `hash`,
 * снапшота и слота `defaults` не существовало. Именно её обязан отбить парсер, а не уронить
 * `diffLock` необработанным исключением на стадии `lock_check`.
 */
const LEGACY_V1 = JSON.stringify({
  version: 1,
  manifestHash: 'a'.repeat(64),
  tools: { publish_release: { hash: 'b'.repeat(64), approvedAt: '2026-08-27T10:00:00Z' } },
});

describe('parseLockFile', () => {
  it('разбирает файл текущей ревизии', () => {
    const result = parseLockFile(JSON.stringify(CURRENT));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.diagnostics.map((one) => one.message).join('\n'));
    expect(Object.keys(result.lock.tools)).toEqual(['publish_release']);
    expect(result.lock.version).toBe(2);
  });

  it('отбивает lock прежней формы диагностикой, а не исключением на пути решения', () => {
    const result = parseLockFile(LEGACY_V1);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('файл ревизии 1 не должен разбираться');
    const pointers = result.diagnostics.map((one) => one.pointer);
    // Версия названа отдельно: у человека старый lock, а не сломанный файл, и сообщение
    // обязано это различать.
    expect(pointers).toContain('version');
    expect(pointers).toContain('defaults');
    expect(pointers).toContain('tools.publish_release.recipeHash');
    expect(pointers).toContain('tools.publish_release.snapshot');
  });

  it('не разобранный JSON — диагностика, а не бросок', () => {
    const result = parseLockFile('{ это не json');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('мусор не должен разбираться');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe('schema');
  });

  it('отвергает дайджест не той формы', () => {
    const broken = { ...CURRENT, manifestHash: 'sha256:' + 'a'.repeat(64) };
    const result = parseLockFile(JSON.stringify(broken));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('префикс sha256: не входит в кодировку');
    expect(result.diagnostics.map((one) => one.pointer)).toContain('manifestHash');
  });

  it('снапшот без собственного блока не проходит — иначе diffLock строит «было» из undefined', () => {
    const broken = {
      ...CURRENT,
      tools: { publish_release: { ...CURRENT.tools.publish_release, snapshot: { effective: {} } } },
    };
    const result = parseLockFile(JSON.stringify(broken));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('снапшот без own не форма');
    expect(result.diagnostics.map((one) => one.pointer)).toContain('tools.publish_release.snapshot.own');
  });
});
