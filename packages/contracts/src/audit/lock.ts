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
