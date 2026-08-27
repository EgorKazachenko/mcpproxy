import type { ErrorObject } from 'ajv';
import type { Document, LineCounter } from 'yaml';
import type { Manifest } from '../manifest.generated.js';
import type { Diagnostic, ManifestSource, ParseManifestResult, PatternMatcher } from '../types.js';
import { matcherKey } from '../types.js';
import { manifestValidator } from './ajv.js';
import { compilePattern } from './regex.js';
import { parseYaml } from './yaml.js';

/**
 * Единственная публичная точка загрузки манифеста (R4). Скомпилированный валидатор ajv
 * наружу не экспортируется: потребитель, получивший его, свободен выключить любую проверку.
 */

const NUMERIC = /^(0|[1-9][0-9]*)$/;

/** `/tools/run_tests/params/pattern` → сегменты пути для `doc.getIn`. */
function segmentsOf(instancePath: string): Array<string | number> {
  if (instancePath === '') return [];
  return instancePath
    .slice(1)
    .split('/')
    .map((raw) => raw.replaceAll('~1', '/').replaceAll('~0', '~'))
    .map((segment) => (NUMERIC.test(segment) ? Number(segment) : segment));
}

const pointerOf = (segments: ReadonlyArray<string | number>): string => segments.join('.');

/** Координаты узла в исходном тексте. Узел не найден — начало документа, а не выдуманная строка. */
function positionOf(
  doc: Document,
  lineCounter: LineCounter,
  segments: ReadonlyArray<string | number>,
): { line: number; column: number } {
  const node: unknown = segments.length === 0 ? doc.contents : doc.getIn(segments, true);
  const range = (node as { range?: [number, number, number] } | null)?.range;
  if (range === undefined) return { line: 1, column: 1 };
  const pos = lineCounter.linePos(range[0]);
  return { line: pos.line, column: pos.col };
}

function diagnose(error: ErrorObject, doc: Document, lineCounter: LineCounter): Diagnostic {
  const segments = segmentsOf(error.instancePath);
  return { pointer: pointerOf(segments), ...positionOf(doc, lineCounter, segments), message: error.message ?? error.keyword };
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
      const result = compilePattern(param.pattern);
      const segments = ['tools', recipeName, 'params', paramName, 'pattern'];
      if (result.ok) matchers.set(matcherKey(recipeName, paramName), result.matcher);
      else {
        diagnostics.push({
          pointer: pointerOf(segments),
          ...positionOf(doc, lineCounter, segments),
          message: `pattern не компилируется движком RE2: ${result.reason}`,
        });
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
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  return { ok: true, manifest, matchers };
}
