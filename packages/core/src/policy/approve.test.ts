import { describe, expect, it } from 'vitest';
import { CHANGED_YAML, LOCK_PATH, MANIFEST_PATH, MANIFEST_YAML, lockTextFor, memoryDisk, started } from './policy.fixture.js';
import { requestFor, verdictApplicability } from './approve.js';
import type { LockApprovalVerdict } from './approve.js';
import type { StartedStore } from './store.js';

const REQUESTED_AT = '2026-08-28T00:00:00.000Z';

/** Store, чей lock одобрен и совпадает с манифестом. */
async function approved(): Promise<{ store: StartedStore; disk: ReturnType<typeof memoryDisk> }> {
  const disk = memoryDisk();
  const store = await started(disk);
  disk.write(LOCK_PATH, lockTextFor(store.current().manifest.manifest));
  await store.reloadLock();
  return { store, disk };
}

describe('requestFor', () => {
  it('на verified спрашивать не о чем', async () => {
    const { store } = await approved();
    expect(requestFor(store.current(), REQUESTED_AT)).toBeNull();
  });

  it('файла нет — ветвь first со списком рецептов, а не беззвучная запись', async () => {
    const store = await started(memoryDisk());
    const request = requestFor(store.current(), REQUESTED_AT);

    expect(request?.kind).toBe('first');
    expect(request?.kind === 'first' && request.recipes).toEqual(['run_tests']);
    expect(request?.manifestHash).toBe(store.current().manifest.digest);
  });

  it('битый lock — ветвь unusable с диагностиками, а не drift с пустым диффом', async () => {
    // Подстановка пустого диффа столкнулась бы с веткой «дрифт есть, показать нечего», и
    // человек получил бы текст про подделку на ошибке разбора.
    const stale = JSON.stringify({ version: 1, manifestHash: 'a'.repeat(64), tools: {} });
    const store = await started(memoryDisk({ [MANIFEST_PATH]: MANIFEST_YAML, [LOCK_PATH]: stale }));
    const request = requestFor(store.current(), REQUESTED_AT);

    expect(request?.kind).toBe('unusable');
    expect(request?.kind === 'unusable' && request.reason).toBe('unparsed');
    expect(request?.kind === 'unusable' && request.diagnostics.length).toBe(2);
  });

  it('нечитаемый lock отличается от неразобранного и там же', async () => {
    const disk = memoryDisk();
    disk.fail(LOCK_PATH, 'EACCES');
    const store = await started(disk);
    const request = requestFor(store.current(), REQUESTED_AT);

    expect(request?.kind === 'unusable' && request.reason).toBe('unreadable');
  });

  it('дрифт несёт дифф, mismatched и обе стороны дайджеста', async () => {
    const { store, disk } = await approved();
    disk.write(MANIFEST_PATH, CHANGED_YAML);
    await store.reloadManifest();

    const request = requestFor(store.current(), REQUESTED_AT);
    expect(request?.kind).toBe('drift');
    expect(request?.kind === 'drift' && request.diff.changed).toHaveLength(1);
    expect(request?.kind === 'drift' && request.mismatched).toEqual([]);
    expect(request?.kind === 'drift' && request.digest).not.toBeNull();
  });
});

describe('verdictApplicability', () => {
  const verdictOf = (patch: Partial<LockApprovalVerdict>): LockApprovalVerdict => ({
    manifestHash: 'a'.repeat(64),
    decision: 'approved',
    decidedAt: REQUESTED_AT,
    ...patch,
  });

  it('вердикт на тот же дайджест действует', async () => {
    const store = await started(memoryDisk());
    const manifest = store.current().manifest;

    expect(verdictApplicability(verdictOf({ manifestHash: manifest.digest }), manifest)).toBe('applies');
  });

  it('вердикт, выданный на прежний дайджест, не пропускает изменившийся манифест', async () => {
    // Окно CVE-2025-54136: человек читает дифф в T₀, атакующий правит манифест в T₁.
    const disk = memoryDisk();
    const store = await started(disk);
    const shown = store.current().manifest.digest;

    disk.write(MANIFEST_PATH, CHANGED_YAML);
    await store.reloadManifest();

    expect(verdictApplicability(verdictOf({ manifestHash: shown }), store.current().manifest)).toBe('stale');
  });

  it('отказ человека и устаревание — разные исходы', async () => {
    const store = await started(memoryDisk());
    const manifest = store.current().manifest;

    const denied = verdictApplicability(verdictOf({ manifestHash: manifest.digest, decision: 'denied' }), manifest);
    const stale = verdictApplicability(verdictOf({ manifestHash: 'b'.repeat(64) }), manifest);

    expect(denied).toBe('denied');
    expect(stale).toBe('stale');
    expect(denied).not.toBe(stale);
  });
});
