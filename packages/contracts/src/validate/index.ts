import type { ErrorObject } from 'ajv';
import type { Document, LineCounter } from 'yaml';
import { canonicalizeJcs } from '../jcs.js';
import type { Manifest } from '../manifest.generated.js';
import type { Diagnostic, ManifestSource, ParseManifestResult, PatternMatcher } from '../types.js';
import { matcherKey } from '../types.js';
import { manifestValidator } from './ajv.js';
import { diagnosticAt, segmentsOf } from './locate.js';
import { compilePattern } from './regex.js';
import { refine } from './refine.js';
import { parseYaml } from './yaml.js';

/**
 * Единственная публичная точка загрузки манифеста (R4). Скомпилированный валидатор ajv
 * наружу не экспортируется: потребитель, получивший его, свободен выключить любую проверку.
 */

function diagnose(error: ErrorObject, doc: Document, lineCounter: LineCounter): Diagnostic {
  const segments = segmentsOf(error.instancePath);
  // Через `diagnosticAt`, а не собственным литералом: это был единственный конструктор
  // диагностики, не проходивший санитизацию, и ключи манифеста попадали в `pointer` сырыми.
  // «Схема ограничивает имена `propertyNames`» — неверный довод: при `allErrors: true` ajv
  // продолжает валидировать значение под плохим ключом, поэтому ключ с ESC и bidi доезжает
  // до указателя вместе со своей же диагностикой об этом ключе.
  return diagnosticAt(doc, lineCounter, segments, 'schema', error.message ?? error.keyword);
}

/**
 * Матчеры едут **рядом** с манифестом, а не внутри него: `Manifest` сгенерирован из схемы с
 * `additionalProperties: false`, поэтому носителем скомпилированного объекта быть не может, —
 * а если бы мог, `Recipe` перестал бы быть JSON-сериализуемым, и `normalizeRecipe` не смог бы
 * подать его в `canonicalizeJcs`.
 */
function buildMatchers(
  manifest: Manifest,
  doc: Document,
  lineCounter: LineCounter,
): { matchers: Map<string, PatternMatcher>; diagnostics: Diagnostic[] } {
  const matchers = new Map<string, PatternMatcher>();
  const diagnostics: Diagnostic[] = [];

  for (const [recipeName, recipe] of Object.entries(manifest.tools)) {
    for (const [paramName, param] of Object.entries(recipe.params ?? {})) {
      if (param.type !== 'string') continue;
      const compiled = compilePattern(param.pattern);
      if (compiled.ok) matchers.set(matcherKey(recipeName, paramName), compiled.matcher);
      else {
        diagnostics.push(
          diagnosticAt(
            doc,
            lineCounter,
            ['tools', recipeName, 'params', paramName, 'pattern'],
            'pattern',
            // `reason` — это `error.message` от RE2, а он эхоит фрагмент паттерна дословно.
            // Санитизацию делает `diagnosticAt`: она стоит в конструкторе, а не здесь, чтобы
            // её нельзя было забыть в следующей точке — производителей сообщения пять.
            `pattern не компилируется движком RE2: ${compiled.reason}`,
          ),
        );
      }
    }
  }

  return { matchers, diagnostics };
}

/**
 * Манифест, прошедший загрузку, обязан быть хэшируемым.
 *
 * Симметрично `parseLockFile`, и по той же причине: `diffLock(lock, manifest)` берёт ДВА
 * аргумента, парсер lock страховал первый, а второй не страховал никто. Замерено, что
 * манифест, который схема и `refine` принимают, роняет `manifestHash` и `diffLock`
 * необработанным `TypeError` — то есть крэшем на стадии `lock_check`, до записи стадийного
 * события, а отказ без следа в аудите контракт называет багом. Два известных вектора:
 * одиночный суррогат в любой строке, объявленной голым `string` (`description`, `exec[]`,
 * `cwd`, `root`, `env.allow[]`, строки песочницы), и `Duration` из четырёхсот цифр, дающая
 * `Infinity` — её схема теперь ограничивает длиной, но проверка ниже закрывает и её, и любой
 * следующий вектор, потому что спрашивает ровно то, что нужно: переживёт ли эта форма
 * канонизацию.
 *
 * Канонизируется **сырой** манифест, а не `normalizeManifest(manifest)`: замерено, что вторая
 * форма стоит 2.2 с CPU на манифесте в 258 КБ, потому что строит эффективный профиль каждого
 * рецепта, чтобы тут же его выбросить.
 *
 * Покрытие при этом не тождественно, и это стоит сказать точно, а не «то же самое»:
 * нормализация переносит строки дословно, поэтому одиночный суррогат видно и здесь, но
 * `timeoutMs` она **вычисляет**, и длительность из четырёхсот цифр канонизируется сырой,
 * а после нормализации даёт `Infinity`. Тот вектор закрыт раньше и в двух местах — пределом
 * цифр в схеме и `checkDuration` по значению, — поэтому до этой проверки он не доходит.
 * Она отвечает за строки; за числа отвечают те двое.
 */
function notHashable(manifest: Manifest): string | null {
  try {
    canonicalizeJcs(manifest);
    return null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `манифест не хэшируется, значит сверка с lock упала бы исключением: ${reason}`;
  }
}

export function parseManifest(yamlText: string, source: ManifestSource): ParseManifestResult {
  const parsed = parseYaml(yamlText, source);
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };

  const validate = manifestValidator();
  if (!validate(parsed.data)) {
    const errors = validate.errors ?? [];
    return { ok: false, diagnostics: errors.map((error) => diagnose(error, parsed.doc, parsed.lineCounter)) };
  }

  const manifest = parsed.data as Manifest;
  const { matchers, diagnostics } = buildMatchers(manifest, parsed.doc, parsed.lineCounter);
  diagnostics.push(...refine(manifest, source, parsed.doc, parsed.lineCounter));
  const hashable = notHashable(manifest);
  if (hashable !== null) {
    diagnostics.push(diagnosticAt(parsed.doc, parsed.lineCounter, [], 'invariant', hashable));
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  return { ok: true, manifest, matchers };
}

export { parseLockFile, type ParseLockResult } from './lock.js';
