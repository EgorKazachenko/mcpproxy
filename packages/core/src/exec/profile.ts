import { homedir } from 'node:os';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { canonicalizeJcs } from '@mcpproxy/contracts';
import type { NormalizedAccess, NormalizedSandbox, SandboxProfile } from '@mcpproxy/contracts';
import { sha256Hex } from '@mcpproxy/contracts/audit';
import { isWeakened } from './netpolicy.js';

/**
 * Профиль песочницы: чистое преобразование `NormalizedSandbox` → резолвнутая политика.
 * Ни ФС, ни процессов, ни сети — только `os.homedir()` и арифметика путей.
 */

export interface ResolvedSandboxPolicy {
  readonly read: { readonly allow: readonly string[]; readonly deny: readonly string[] };
  readonly write: { readonly allow: readonly string[]; readonly deny: readonly string[] };
  /**
   * Обязательные запреты этого вызова — **та же самая** посчитанная величина, что уехала в
   * `write.deny`, а не вторая, собранная независимо.
   *
   * Поле есть потому, что список нужен ДВАЖДЫ: в принуждении (`write.deny` профиля) и в
   * классификации (бейдж `mandatory-deny` из S6). Считая его в двух местах по независимо
   * собранным входам, мы получили бы бейдж, который расходится с реальной политикой молча —
   * а тест классификации строит `mandatoryPaths` руками и такого расхождения не увидит.
   */
  readonly mandatory: readonly string[];
  /** Рецепт с голой `*` в `network.allow` или с шаблоном, который вендор считает широким (R14). */
  readonly weakened: boolean;
}

/**
 * Файлы, запись в которые — исполнение кода при следующем запуске оболочки или git.
 * Копия `DANGEROUS_FILES` из `sandbox-utils.js:10`; наружу пакета список не экспортирован
 * (`index.d.ts`, 19 строк), поэтому копия неизбежна — а копия без детектора дрейфа
 * устаревает молча. Детектор — `modes/seatbelt.test.ts`, тест «детектор дрейфа:
 * вендорский набор обязательных запретов не изменился», рядом с `RECORDED_VENDOR_DENIALS` (R10).
 */
export const MANDATORY_DENY_FILES: readonly string[] = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
] as const;

/**
 * Каталоги, чьё содержимое исполняется или конфигурирует исполнение. Копия
 * `getDangerousDirectories()` (`sandbox-utils.js:31`): `.git` из списка исключён самим
 * вендором — он нужен записываемым для обычных git-операций, — и вместо него закрываются
 * два конкретных пути внутри, `.git/hooks` и `.git/config`.
 */
export const MANDATORY_DENY_DIRECTORIES: readonly string[] = [
  '.vscode',
  '.idea',
  '.claude/commands',
  '.claude/agents',
] as const;

/**
 * Пути внутри `.git`. `.git/config` здесь **обязателен** (R9): `core.pager`,
 * `core.sshCommand` и алиасы — такой же вектор исполнения кода, как и хуки, и вендор
 * закрывает его лишь при `allowGitConfig: false`, то есть по умолчанию — но якорем на своём
 * cwd, а не на нашем (проба П3b).
 */
export const MANDATORY_DENY_GIT_PATHS: readonly string[] = ['.git/hooks', '.git/config'] as const;

/**
 * Разворачивание `~` и относительных путей (R8).
 *
 * Нерезолвнутый `~/.ssh` не закрывает ничего, а строка в профиле выглядит так, будто
 * закрывает: `denyRead: ["~/.ssh"]` уезжает в srt дословно, `normalizePathForSandbox`
 * развернёт тильду сам — но относительный путь он развернёт от cwd **демона**, а не рецепта,
 * и вот это уже молча промахивается мимо цели.
 *
 * Поэтому резолвим сами и от `recipeCwd`, а не полагаемся на вендора.
 */
export function resolveProfilePath(pattern: string, recipeCwd: string): string {
  if (pattern === '~') return homedir();
  if (pattern.startsWith('~/')) return resolvePath(homedir(), pattern.slice(2));
  if (isAbsolute(pattern)) return pattern;
  return resolvePath(recipeCwd, pattern);
}

/**
 * Обязательные запреты записи, якорённые на **каждом** корне `write.allow` (R9).
 *
 * Почему не `cwd` рецепта: запись — allow-only, поэтому запрет имеет смысл только внутри
 * разрешённого. Рецепт с `write.allow: ["~/work/repo"]` при другом `cwd` иначе получил бы
 * незащищённый `~/work/repo/.git/hooks`.
 *
 * Почему глоб на поддерево, а не литерал в корне: литерал оставляет
 * `<корень>/sub/.git/hooks/pre-commit` записываемым — это S6 ровно на уровень глубже.
 * Глобстар-слеш у вендора компилируется в необязательную группу «любые каталоги»
 * (`sandbox-utils.js:756`), то есть покрывает и
 * сам корень, и любую глубину под ним; а `denyGlobRegex` дополнительно расширяет запрет на
 * всё, что лежит под совпадением.
 */
export function mandatoryDenyGlobs(writeRoots: readonly string[]): string[] {
  const globs = new Set<string>();
  for (const root of writeRoots) {
    const base = root.endsWith('/') ? root.slice(0, -1) : root;
    for (const name of MANDATORY_DENY_FILES) globs.add(`${base}/**/${name}`);
    for (const name of MANDATORY_DENY_DIRECTORIES) globs.add(`${base}/**/${name}`);
    for (const name of MANDATORY_DENY_GIT_PATHS) globs.add(`${base}/**/${name}`);
  }
  return [...globs];
}

const resolveAll = (paths: readonly string[], recipeCwd: string): string[] =>
  paths.map((one) => resolveProfilePath(one, recipeCwd));

const resolveAccess = (access: NormalizedAccess, recipeCwd: string): { allow: string[]; deny: string[] } => ({
  allow: resolveAll(access.allow, recipeCwd),
  deny: resolveAll(access.deny, recipeCwd),
});

/**
 * Вход — **лист** `NormalizedSandbox`, а не агрегат `NormalizedRecipe`: R5 и §1 требуют
 * `effective`, никогда `own`, и передача целого рецепта оставила бы это правилом ревью
 * вместо ошибки компиляции.
 *
 * Корни для якоря обязательных запретов выводятся **здесь, из `write.allow`**, а не
 * приходят параметром. Отдельный параметр обещал бы вызывающему свободу анкерить запреты
 * шире — свободу, которой не пользуется ни один вызывающий, — и одновременно давал бы
 * возможность передать корни, не совпадающие с разрешённой записью: профиль тогда получил
 * бы глобы, якорёные там, где писать всё равно нельзя, то есть защиту, которая ничего не
 * защищает. R9 говорит «каждый корень `write.allow`», и подпись теперь говорит то же.
 *
 * Сети в результате нет намеренно: её принуждает `updateConfig` под семафором (D11), и
 * поле `network` здесь только соблазняло бы записать её ещё и в `customConfig`, где она
 * не действует вовсе (проба П5).
 */
export function buildProfile(sandbox: NormalizedSandbox, recipeCwd: string): ResolvedSandboxPolicy {
  const read = resolveAccess(sandbox.read, recipeCwd);
  const write = resolveAccess(sandbox.write, recipeCwd);
  const mandatory = mandatoryDenyGlobs(write.allow);

  return {
    read: { allow: read.allow, deny: read.deny },
    write: { allow: write.allow, deny: [...write.deny, ...mandatory] },
    mandatory,
    weakened: isWeakened(sandbox.network.allow),
  };
}

/**
 * Конверсия для события (R36): `sandbox.profile` в `AuditEvent` — **сырой** `SandboxProfile`
 * из манифеста, а не `NormalizedSandbox`.
 *
 * Типы не взаимозаменяемы и приведением не связываются: у `SandboxProfile`
 * (`manifest.generated.ts:56`) `allow`/`deny` необязательны и массивы изменяемы, у
 * `NormalizedSandbox` (`lock.ts:60`) обязательны и `readonly`. Поэтому явная сборка, а не
 * каст, — иначе событие понесло бы замороженные массивы под изменяемым типом.
 */
export function toSandboxProfile(sandbox: NormalizedSandbox): SandboxProfile {
  return {
    read: { allow: [...sandbox.read.allow], deny: [...sandbox.read.deny] },
    write: { allow: [...sandbox.write.allow], deny: [...sandbox.write.deny] },
    network: { allow: [...sandbox.network.allow], deny: [...sandbox.network.deny] },
  };
}

/**
 * Хэш JCS применённой политики — **вместе с доменными списками** (R47).
 *
 * Без сетевой части два вызова с `network.allow: []` и `["*"]` дали бы один хэш, и материал
 * для сверки согласия в E5 оказался бы бесполезен ровно там, где решение человека важнее
 * всего.
 *
 * Формулировка узкая намеренно: хэш доказывает тождество **нашего входа**, а не итоговой
 * политики. srt при обёртке доливает `getDefaultWritePaths()`, mandatory-deny и пути
 * учётных данных, поэтому исполненный набор всегда шире манифестного — это записано в
 * `docs/10-honest-limitations.md`.
 */
export function policyHash(
  policy: ResolvedSandboxPolicy,
  net: { readonly allowedDomains: readonly string[]; readonly deniedDomains: readonly string[] },
): string {
  return sha256Hex(
    canonicalizeJcs({
      read: { allow: [...policy.read.allow], deny: [...policy.read.deny] },
      write: { allow: [...policy.write.allow], deny: [...policy.write.deny] },
      network: { allowedDomains: [...net.allowedDomains], deniedDomains: [...net.deniedDomains] },
    }),
  );
}
