import { describe, expect, it } from 'vitest';
import type { LockDiff } from '@mcpproxy/contracts';
import { SIZE_LIMIT_CODE, isEmptyDiff } from './shapes.js';

const EMPTY: LockDiff = { defaults: null, added: [], removed: [], changed: [] };

describe('isEmptyDiff', () => {
  it('пуст только когда пусты ВСЕ четыре слота', () => {
    expect(isEmptyDiff(EMPTY)).toBe(true);
  });

  // Каждый слот проверяется отдельно: условие из четырёх конъюнктов, и выпадение любого из них
  // отправило бы человека не в ту ветку рендера — «lock подделан» вместо обычного диффа.
  it('непустой слот added делает дифф непустым', () => {
    expect(isEmptyDiff({ ...EMPTY, added: ['run_tests'] })).toBe(false);
  });

  it('непустой слот removed — тоже', () => {
    expect(isEmptyDiff({ ...EMPTY, removed: ['run_tests'] })).toBe(false);
  });

  it('непустой слот changed — тоже', () => {
    const changed = [{ name: 'run_tests', was: {}, is: {} }] as unknown as LockDiff['changed'];
    expect(isEmptyDiff({ ...EMPTY, changed })).toBe(false);
  });

  it('заполненный слот defaults — тоже', () => {
    const defaults = { was: {}, is: {} } as unknown as LockDiff['defaults'];
    expect(isEmptyDiff({ ...EMPTY, defaults })).toBe(false);
  });
});

describe('SIZE_LIMIT_CODE', () => {
  it('отличим от кодов errno, чтобы «слишком большой» не читался как «нет прав»', () => {
    expect(SIZE_LIMIT_CODE).toBe('ERR_SIZE_LIMIT');
    expect(['EACCES', 'ENOENT', 'EPERM']).not.toContain(SIZE_LIMIT_CODE);
  });
});
