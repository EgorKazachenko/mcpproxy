import type { ErrorObject } from 'ajv';
import type { Document, LineCounter } from 'yaml';
import type { Manifest } from '../manifest.generated.js';
import { sanitizeDescription } from '../tool.js';
import type { Diagnostic, ManifestSource, ParseManifestResult, PatternMatcher } from '../types.js';
import { matcherKey } from '../types.js';
import { manifestValidator } from './ajv.js';
import { diagnosticAt, pointerOf, positionOf, segmentsOf } from './locate.js';
import { compilePattern } from './regex.js';
import { refine } from './refine.js';
import { parseYaml } from './yaml.js';

/**
 * Единственная публичная точка загрузки манифеста (R4). Скомпилированный валидатор ajv
 * наружу не экспортируется: потребитель, получивший его, свободен выключить любую проверку.
 */

function diagnose(error: ErrorObject, doc: Document, lineCounter: LineCounter): Diagnostic {
  const segments = segmentsOf(error.instancePath);
  return {
    pointer: pointerOf(segments),
    ...positionOf(doc, lineCounter, segments),
    code: 'schema',
    message: error.message ?? error.keyword,
  };
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
            // Паттерн пришёл из недоверенного манифеста, а диагностику рисуют человеку и
            // пишут в лог, поэтому bidi-override и ANSI-escape доехали бы до глаз и до
            // терминала. Инструмент для этого в пакете уже есть — он и применяется.
            `pattern не компилируется движком RE2: ${sanitizeDescription(compiled.reason).text}`,
          ),
        );
      }
    }
  }

  return { matchers, diagnostics };
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
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  return { ok: true, manifest, matchers };
}

export { parseLockFile, type ParseLockResult } from './lock.js';
