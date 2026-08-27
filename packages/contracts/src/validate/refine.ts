import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Document, LineCounter } from 'yaml';
import type { AccessRule, Manifest, Recipe, SandboxProfile } from '../manifest.generated.js';
import type { Diagnostic, ManifestSource } from '../types.js';
import { diagnosticAt, type Segment } from './locate.js';

/**
 * Проверки, которых JSON Schema выразить не может. Вызываются `parseManifest`, а не
 * вызывающим: правило, которое можно пропустить, недоверенный манифест и пропустит (R5).
 *
 * Соответствие «ветка схемы ↔ проверка» держит `branch-checks.ts`.
 */

/** Слот подстановки параметра. Единственная форма, которой манифест выражает «сюда придёт значение». */
const SLOT = '{}';

/**
 * Метасимволы оболочки. `~` здесь же: `~/bin/x` — это раскрытие, а не путь, и рецепт,
 * рассчитывающий на него, ведёт себя по-разному в зависимости от того, кто его запустил.
 *
 * Фигурных скобок в списке **нет** намеренно: слот `{}` — законный синтаксис манифеста, и
 * ловить его здесь значило бы отобрать эту работу у правила «параметр не подставляется в
 * exec», которое единственное умеет объяснить, что именно не так.
 */
const SHELL_META = /[;&|<>$`()\[\]*?!~"'\\\n\r]/;

const countSlots = (text: string): number => text.split(SLOT).length - 1;

/** Все строковые значения профиля песочницы вместе с путями до них. */
function sandboxStrings(profile: SandboxProfile, prefix: readonly Segment[]): Array<{ path: Segment[]; value: string }> {
  const out: Array<{ path: Segment[]; value: string }> = [];
  for (const node of ['read', 'write', 'network'] as const) {
    const rule: AccessRule | undefined = profile[node];
    if (rule === undefined) continue;
    for (const list of ['allow', 'deny'] as const) {
      const values = rule[list];
      if (values === undefined) continue;
      values.forEach((value, index) => out.push({ path: [...prefix, node, list, index], value }));
    }
  }
  return out;
}

function checkExecShape(recipe: Recipe, at: readonly Segment[], report: (path: Segment[], message: string) => void) {
  const binary = recipe.exec[0];
  const path = [...at, 'exec', 0];

  if (SHELL_META.test(binary)) {
    report(path, 'exec[0] содержит метасимвол оболочки: демон запускает бинарь напрямую, оболочки в цепочке нет');
    return;
  }
  // Абсолютный путь, голое имя или относительный путь **вниз** от манифеста. Последнее —
  // форма из `docs/07-contracts.md` (`./scripts/publish.sh`); резолв в абсолютный путь и
  // сверка с binary allowlist демона — уже не дело контракта.
  const relativeDown = binary.startsWith('./') && !binary.split('/').includes('..');
  const bareName = !binary.includes('/');
  if (!isAbsolute(binary) && !bareName && !relativeDown) {
    report(path, 'exec[0] обязан быть абсолютным путём, голым именем или путём вниз от манифеста');
  }
}

function checkNoSubstitution(recipe: Recipe, at: readonly Segment[], report: (path: Segment[], message: string) => void) {
  // И1/И2: параметр попадает в командную строку только через собственный `argv`. Слот в
  // `exec`, `cwd` или профиле означал бы, что недоверенное значение выбирает бинарь,
  // рабочий каталог или границы песочницы.
  recipe.exec.forEach((element, index) => {
    if (countSlots(element) > 0) report([...at, 'exec', index], 'параметр не может подставляться в exec');
  });
  if (recipe.cwd !== undefined && countSlots(recipe.cwd) > 0) {
    report([...at, 'cwd'], 'параметр не может подставляться в cwd');
  }
  if (recipe.sandbox !== undefined) {
    for (const { path, value } of sandboxStrings(recipe.sandbox, [...at, 'sandbox'])) {
      if (countSlots(value) > 0) report(path, 'параметр не может подставляться в профиль песочницы');
    }
  }
}

function checkArgvSlots(recipe: Recipe, at: readonly Segment[], report: (path: Segment[], message: string) => void) {
  for (const [paramName, param] of Object.entries(recipe.params ?? {})) {
    (param.argv ?? []).forEach((element, index) => {
      if (countSlots(element) > 1) {
        report([...at, 'params', paramName, 'argv', index], 'слот {} допустим не более одного раза на элемент argv');
      }
    });
  }
}

function checkDenyNonEmpty(recipe: Recipe, at: readonly Segment[], report: (path: Segment[], message: string) => void) {
  if (recipe.sandbox === undefined) return;
  for (const node of ['read', 'write', 'network'] as const) {
    const deny = recipe.sandbox[node]?.deny;
    if (deny !== undefined && deny.length === 0) {
      report(
        [...at, 'sandbox', node, 'deny'],
        'пустой deny — единственная синтаксическая форма «снять запрет из defaults», и она запрещена',
      );
    }
  }
}

function checkRootConfinement(
  recipe: Recipe,
  at: readonly Segment[],
  source: ManifestSource,
  report: (path: Segment[], message: string) => void,
) {
  const manifestDir = dirname(source.path);
  for (const [paramName, param] of Object.entries(recipe.params ?? {})) {
    if (param.type !== 'path') continue;
    const path = [...at, 'params', paramName, 'root'];
    const resolved = isAbsolute(param.root) ? resolve(param.root) : resolve(manifestDir, param.root);

    if (resolved === resolve('/')) {
      report(path, 'root: "/" не ограничивает ничего');
      continue;
    }
    if (!isAbsolute(param.root)) {
      const outside = relative(manifestDir, resolved);
      if (outside.startsWith('..')) report(path, 'относительный root не может выходить за каталог манифеста');
    }
  }
}

export function refine(
  manifest: Manifest,
  source: ManifestSource,
  doc: Document,
  lineCounter: LineCounter,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const report = (path: Segment[], message: string) =>
    diagnostics.push(diagnosticAt(doc, lineCounter, path, message));

  for (const [recipeName, recipe] of Object.entries(manifest.tools)) {
    const at: Segment[] = ['tools', recipeName];
    checkExecShape(recipe, at, report);
    checkNoSubstitution(recipe, at, report);
    checkArgvSlots(recipe, at, report);
    checkDenyNonEmpty(recipe, at, report);
    checkRootConfinement(recipe, at, source, report);
  }

  return diagnostics;
}
