import { canonicalizeJcs } from '../jcs.js';
import type { NormalizedRecipe } from '../lock.js';
import { normalizeManifest } from '../lock.js';
import type { Manifest } from '../manifest.generated.js';
import { sha256Hex } from './chain.js';

/**
 * Два оставшихся дайджеста пакета. Кодировка та же, что у `chain.self`: строчный hex,
 * 64 символа, без префикса `sha256:`.
 *
 *     recipeHash   = sha256(utf8(canonicalizeJcs(normalized.own)))
 *     manifestHash = sha256(utf8(canonicalizeJcs(normalizeManifest(manifest))))
 *
 * Живут здесь, а не в корне: им нужен `node:crypto`. Правило размещения — из Task 8, и
 * Task 9 не исключение.
 */

/** Хэш по **собственному** блоку. Эффективный профиль лежит в снапшоте ради диффа и не хэшируется. */
export const recipeHash = (normalized: NormalizedRecipe): string => sha256Hex(canonicalizeJcs(normalized.own));

/**
 * Хэш манифеста целиком.
 *
 * Он нужен потому, что `defaults.env.allow: [..., "AWS_SECRET_ACCESS_KEY"]` или
 * опустошённый `defaults.sandbox.read.deny` не меняют ни одного объекта `Recipe`: все
 * пер-рецептные хэши совпадают, `lock_check` зелёный, а И4 и атака A10 сняты молча.
 */
export const manifestHash = (manifest: Manifest): string => sha256Hex(canonicalizeJcs(normalizeManifest(manifest)));

/**
 * Сверка двух копий одобренного рецепта внутри одного файла.
 *
 * Lock несёт и `recipeHash`, и `snapshot`, а `diffLock` смотрит только во второй: решение
 * «дрейф или нет» принимается сравнением `snapshot.own` с манифестом. Значит файл, у
 * которого записанный дайджест противоречит собственному снапшоту, давал бы чистый дифф во
 * всех четырёх слотах — то есть «одобрено» по подменённому снапшоту. Проверка делает две
 * копии проверяемым инвариантом, а не соглашением.
 *
 * Живёт здесь, а не в `./validate`: ей нужен `node:crypto`, а правило размещения одно.
 */
export function verifyLockEntries(lock: {
  readonly tools: Readonly<Record<string, { readonly recipeHash: string; readonly snapshot: NormalizedRecipe }>>;
}): { ok: true } | { ok: false; mismatched: readonly string[] } {
  const mismatched = Object.entries(lock.tools)
    .filter(([, entry]) => recipeHash(entry.snapshot) !== entry.recipeHash)
    .map(([name]) => name)
    .sort();
  return mismatched.length === 0 ? { ok: true } : { ok: false, mismatched };
}
