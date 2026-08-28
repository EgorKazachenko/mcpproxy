import { realpathSync } from 'node:fs';
import { basename, isAbsolute, resolve, sep } from 'node:path';
import { confinementOf } from '@mcpproxy/core';

/**
 * Стадия `build_argv`, атака A4 — PATH hijack.
 *
 * `07-contracts.md:134` описывает форму `exec[0]` («абсолютный путь, голое имя или путь вниз
 * от манифеста, без метасимволов оболочки») и называет резолв в абсолютный путь со сверкой с
 * allowlist «делом демона». До E4 это дело не принадлежало никому: E2 записала A4 вне своего
 * объёма и отдала сюда, чтобы атака не оказалась ничьей.
 *
 * **Голое имя не резолвится через `PATH` ни при каких условиях.** Резолв через `PATH` и есть
 * та самая атака: подсунуть свой `pnpm` раньше настоящего. Голое имя разрешается только
 * сверкой с allowlist по базовому имени, и только если совпадение ровно одно.
 */
export interface BinaryPolicy {
  /** Абсолютные пути, разрешённые как `exec[0]`. Пустой список запрещает и голое имя, и абсолютный путь. */
  readonly allowlist: readonly string[];
  /** Каталог манифеста: корень, вниз от которого разрешён относительный путь. */
  readonly manifestDir: string;
}

export type BinaryResolution =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly code: 'binary-unresolved' | 'binary-not-allowed'; readonly text: string };

/**
 * Метасимволы оболочки. Демон спавнит `spawn(argv[])` без shell (И1), то есть исполнить их
 * некому — но `exec[0]` с ними означает манифест, написанный в расчёте на оболочку, и принять
 * его молча значит принять расхождение между тем, что написано, и тем, что произойдёт.
 */
const SHELL_METACHARACTERS = /[;&|`$(){}<>\n\r*?[\]!~"'\\]/u;

interface ResolveDeps {
  readonly realpath: (path: string) => string;
}

const DEFAULT_DEPS: ResolveDeps = { realpath: realpathSync };

export function resolveBinary(
  exec0: string,
  policy: BinaryPolicy,
  deps: ResolveDeps = DEFAULT_DEPS,
): BinaryResolution {
  if (exec0 === '') return { ok: false, code: 'binary-unresolved', text: 'exec[0] пуст' };
  if (SHELL_METACHARACTERS.test(exec0)) {
    return { ok: false, code: 'binary-unresolved', text: 'exec[0] содержит метасимвол оболочки' };
  }

  const allowed = new Set(policy.allowlist);

  if (isAbsolute(exec0)) {
    const real = canonical(exec0, deps);
    if (real === null) return { ok: false, code: 'binary-unresolved', text: 'exec[0] не резолвится' };
    // Сверка ПОСЛЕ realpath: иначе симлинк, лежащий по разрешённому пути и указывающий
    // наружу, проходил бы список, разрешающий его же цель.
    if (!allowed.has(real)) return { ok: false, code: 'binary-not-allowed', text: 'exec[0] вне binary allowlist' };
    return { ok: true, path: real };
  }

  if (exec0.includes(sep)) {
    const candidate = resolve(policy.manifestDir, exec0);
    const real = canonical(candidate, deps);
    if (real === null) return { ok: false, code: 'binary-unresolved', text: 'exec[0] не резолвится' };
    const root = canonical(policy.manifestDir, deps);
    if (root === null) return { ok: false, code: 'binary-unresolved', text: 'каталог манифеста не резолвится' };
    // Путь ВНИЗ от манифеста разрешён сам по себе: он приехал тем же файлом, что и манифест,
    // и уже накрыт его хэшем в lock. Путь вверх — нет, даже если он есть в allowlist:
    // относительная форма, уходящая вверх, ровно то, что список и должен ловить.
    if (confinementOf(root, real) === 'outside') {
      return { ok: false, code: 'binary-not-allowed', text: 'exec[0] выходит за каталог манифеста' };
    }
    return { ok: true, path: real };
  }

  const matches = policy.allowlist.filter((one) => basename(one) === exec0);
  if (matches.length === 0) {
    return { ok: false, code: 'binary-not-allowed', text: 'голое имя не названо в binary allowlist' };
  }
  if (matches.length > 1) {
    // Разрешать первое совпадение значило бы поставить исход в зависимость от порядка строк
    // в конфиге — то есть от того, чего автор списка не считает значимым.
    return { ok: false, code: 'binary-not-allowed', text: 'голое имя неоднозначно в binary allowlist' };
  }
  const only = matches[0] as string;
  const real = canonical(only, deps);
  if (real === null) return { ok: false, code: 'binary-unresolved', text: 'запись allowlist не резолвится' };
  if (!allowed.has(real) && real !== only) {
    return { ok: false, code: 'binary-not-allowed', text: 'запись allowlist — симлинк наружу списка' };
  }
  return { ok: true, path: real };
}

function canonical(path: string, deps: ResolveDeps): string | null {
  try {
    return deps.realpath(path);
  } catch {
    return null;
  }
}
