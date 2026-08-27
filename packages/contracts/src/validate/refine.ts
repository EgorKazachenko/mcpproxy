import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Document, LineCounter } from 'yaml';
import { DURATION_MAX_MS, durationToMs, OUTPUT_MAX_BYTES_DEFAULT } from '../lock.js';
import type { AccessRule, Defaults, Manifest, Recipe, SandboxProfile } from '../manifest.generated.js';
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

/**
 * Профильная половина правила «параметр никуда не подставляется». Вынесена отдельно, потому
 * что ветка `SandboxProfile` инстанцируется ДВАЖДЫ — и в `Recipe.sandbox`, и в
 * `Defaults.sandbox`, — а `branch-checks.ts` вешает проверку на ветку, а не на рецепт.
 * Пока она обходила только рецепты, `defaults.sandbox.write.allow: ["{}/out"]` проходил
 * загрузку, хотя инвариант в `07-contracts.md` сформулирован без оговорки.
 */
function checkProfileNoSubstitution(
  profile: SandboxProfile,
  at: readonly Segment[],
  report: (path: Segment[], message: string) => void,
) {
  for (const { path, value } of sandboxStrings(profile, at)) {
    if (countSlots(value) > 0) report(path, 'параметр не может подставляться в профиль песочницы');
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
  if (recipe.sandbox !== undefined) checkProfileNoSubstitution(recipe.sandbox, [...at, 'sandbox'], report);
}

/**
 * `defaults.env.allow` — потолок, а не значение по умолчанию.
 *
 * Рецептный `env` сливается заменой по листу, поэтому без этого правила рецепт мог бы выдать
 * себе переменную, которой в `defaults` нет: `env: {allow: ["PATH", "AWS_SECRET_ACCESS_KEY"]}`
 * был бы валидным манифестом. Сравнить с `sandbox.*.deny`, где запрет из `defaults` сделан
 * принципиально неснимаемым (объединение плюс отказ на пустом `deny`), — для `env`
 * симметричного правила не было ни в схеме, ни здесь. Сужение остаётся рецепту: подмножество
 * законно, надмножество — нет.
 */
function checkEnvCeiling(
  recipe: Recipe,
  ceiling: readonly string[],
  at: readonly Segment[],
  report: (path: Segment[], message: string) => void,
) {
  const allow = recipe.env?.allow;
  if (allow === undefined) return;
  allow.forEach((name, index) => {
    if (!ceiling.includes(name)) {
      report([...at, 'env', 'allow', index], `рецепт не может вводить переменную, которой нет в defaults.env.allow: ${name}`);
    }
  });
}

/**
 * `defaults.output` — пол, а не значение по умолчанию.
 *
 * Тот же довод, что и у `checkEnvCeiling`, и сильнее: `output` сливается заменой скаляров, то
 * есть `redact: false` в рецепте даёт `effective.output.redact === false` — секрет доезжает
 * до модели и до лога, — а `maxBytes` рецепта поднимает потолок вывода. Схема ограничивает
 * `maxBytes` только `minimum: 1`. Сравнить с `sandbox.*.deny`, который принципиально неснимаем,
 * и с молчанием `defaults.output`, которому этот же контракт назначил пессимистичные значения:
 * без правила ниже принцип «молчание делает вызов опаснее» соблюдался бы для молчания и не
 * соблюдался для явного ослабления. Оба поля стали достижимыми вместе с рецептным `output`.
 *
 * Сужение рецепту остаётся: включить редакцию, когда в `defaults` она выключена, и опустить
 * потолок — законно.
 */
function checkOutputFloor(
  recipe: Recipe,
  base: Defaults['output'],
  at: readonly Segment[],
  report: (path: Segment[], message: string) => void,
) {
  const own = recipe.output;
  if (own === undefined) return;
  if (own.redact === false && (base.redact ?? true)) {
    report([...at, 'output', 'redact'], 'рецепт не может снять редакцию вывода, включённую в defaults');
  }
  const ceiling = base.maxBytes ?? OUTPUT_MAX_BYTES_DEFAULT;
  if (own.maxBytes !== undefined && own.maxBytes > ceiling) {
    report(
      [...at, 'output', 'maxBytes'],
      `рецепт не может поднять потолок вывода выше defaults: ${own.maxBytes} при ${ceiling}`,
    );
  }
}

/**
 * Длительность обязана быть исполнимой.
 *
 * Схема ограничивает `Duration` девятью цифрами — этого хватает, чтобы значение осталось
 * безопасным целым, но не хватает, чтобы оно осталось таймером: `999999999h` — законные девять
 * цифр и 3.6·10¹⁵ мс, а выше `DURATION_MAX_MS` Node клампит таймаут к 1 мс. Манифест,
 * просящий «почти никогда не прерывать», получил бы прерывание немедленно — молча.
 */
function checkDuration(value: string | undefined, path: Segment[], report: (path: Segment[], message: string) => void) {
  if (value === undefined) return;
  let ms: number;
  try {
    ms = durationToMs(value);
  } catch {
    // Сюда попасть можно, только если паттерн схемы и регулярка `durationToMs` разошлись:
    // до `refine` документ уже прошёл валидацию. Но связка между двумя файлами ничем не
    // держится, а `parseManifest` обязан возвращать диагностику, а не бросать, — поэтому
    // расхождение читается как отказ загрузки, а не как крэш на пути решения.
    report(path, `не длительность: ${value}`);
    return;
  }
  if (ms > DURATION_MAX_MS) {
    report(path, `длительность больше максимума таймера платформы: ${ms} мс при ${DURATION_MAX_MS}`);
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
      // Ровно `..` либо `../…`, а не любое начало с двух точек: `root: "./..cache"` даёт
      // `relative` = `"..cache"` — это законный ПОДкаталог, и `startsWith('..')` объявлял бы
      // его выходом за пределы. Дефект односторонний (ложный отказ), но отказ загрузки на
      // легитимном манифесте люди чинят обходом правила.
      const outside = relative(manifestDir, resolved);
      if (outside === '..' || outside.startsWith(`..${sep}`)) {
        report(path, 'относительный root не может выходить за каталог манифеста');
      }
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
    diagnostics.push(diagnosticAt(doc, lineCounter, path, 'invariant', message));

  // Уровень `defaults`: та же ветка `SandboxProfile`, то же правило. Пустой `defaults.deny`
  // при этом остаётся законным — там он означает «запретов нет», а не «снять запрет».
  checkProfileNoSubstitution(manifest.defaults.sandbox, ['defaults', 'sandbox'], report);
  checkDuration(manifest.defaults.timeout, ['defaults', 'timeout'], report);

  for (const [recipeName, recipe] of Object.entries(manifest.tools)) {
    const at: Segment[] = ['tools', recipeName];
    checkExecShape(recipe, at, report);
    checkNoSubstitution(recipe, at, report);
    checkArgvSlots(recipe, at, report);
    checkDenyNonEmpty(recipe, at, report);
    checkRootConfinement(recipe, at, source, report);
    checkEnvCeiling(recipe, manifest.defaults.env.allow, at, report);
    checkOutputFloor(recipe, manifest.defaults.output, at, report);
    checkDuration(recipe.timeout, [...at, 'timeout'], report);
  }

  return diagnostics;
}
