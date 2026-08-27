import { LineCounter, parseDocument, type Document } from 'yaml';
import type { Diagnostic, DiagnosticCode, ManifestSource } from '../types.js';
import { MANIFEST_MAX_BYTES } from '../types.js';

export type YamlResult =
  | { ok: true; data: unknown; doc: Document; lineCounter: LineCounter }
  | { ok: false; diagnostics: Diagnostic[] };

const at = (code: DiagnosticCode, message: string, line = 1, column = 1): Diagnostic =>
  ({ pointer: '', line, column, code, message });

/**
 * Разбор недоверенного YAML. Дефолты `yaml@2.9.0` уже отбивают алиас-бомбу, дубли ключей
 * и глубокую вложенность (замер Ф3) — здесь закрываются три оставшихся зазора.
 */
export function parseYaml(text: string, source: ManifestSource): YamlResult {
  // 1. Лимит размера — ДО разбора. `maxBytes` может только понижать потолок: манифест
  //    недоверенный, и вызывающий не должен уметь его поднять.
  const limit = Math.min(MANIFEST_MAX_BYTES, source.maxBytes ?? MANIFEST_MAX_BYTES);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > limit) {
    return { ok: false, diagnostics: [at('size-limit', `манифест больше лимита: ${bytes} байт при потолке ${limit}`)] };
  }

  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });

  // 2. Директива `%YAML`. Замер Ф3-бис: `%YAML 1.1` возвращает слияние по `<<`, булев
  //    разбор `no`/`yes`/`on` и восьмеричные литералы — `sandbox.network.allow: [no]`
  //    превращается в `[false]`. Передача `{version: '1.2'}` директиву НЕ перебивает,
  //    поэтому единственная работающая мера — отказать документу целиком.
  if (doc.directives?.yaml.explicit === true) {
    return { ok: false, diagnostics: [at('yaml', 'директива %YAML запрещена: версию разбора выбирает загрузчик, а не манифест')] };
  }

  if (doc.errors.length > 0) {
    return {
      ok: false,
      diagnostics: doc.errors.map((error) => {
        const pos = lineCounter.linePos(error.pos[0]);
        return at('yaml', `${error.code}: ${error.message}`, pos.line, pos.col);
      }),
    };
  }

  // 3. `TAG_RESOLVE_FAILED` — предупреждение, а не ошибка: `!!js/function` деградирует в
  //    строку и разбор продолжается. Неизвестный тег в недоверенном манифесте — отказ.
  if (doc.warnings.length > 0) {
    return {
      ok: false,
      diagnostics: doc.warnings.map((warning) => {
        const pos = lineCounter.linePos(warning.pos[0]);
        return at('yaml', `${warning.code}: ${warning.message}`, pos.line, pos.col);
      }),
    };
  }

  let data: unknown;
  try {
    data = doc.toJS();
  } catch (error) {
    return { ok: false, diagnostics: [at('yaml', error instanceof Error ? error.message : String(error))] };
  }

  return { ok: true, data, doc, lineCounter };
}
