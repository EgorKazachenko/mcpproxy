import type { Document, LineCounter } from 'yaml';
import { sanitizeDescription } from '../tool.js';
import type { Diagnostic, DiagnosticCode } from '../types.js';

/** Сегмент пути внутрь документа: имя ключа или индекс массива. */
export type Segment = string | number;

const NUMERIC = /^(0|[1-9][0-9]*)$/;

/** `/tools/run_tests/params/pattern` → сегменты пути для `doc.getIn`. */
export function segmentsOf(instancePath: string): Segment[] {
  if (instancePath === '') return [];
  return instancePath
    .slice(1)
    .split('/')
    .map((raw) => raw.replaceAll('~1', '/').replaceAll('~0', '~'))
    .map((segment) => (NUMERIC.test(segment) ? Number(segment) : segment));
}

export const pointerOf = (segments: readonly Segment[]): string => segments.join('.');

/** Координаты узла в исходном тексте. Узел не найден — начало документа, а не выдуманная строка. */
export function positionOf(
  doc: Document,
  lineCounter: LineCounter,
  segments: readonly Segment[],
): { line: number; column: number } {
  const node: unknown = segments.length === 0 ? doc.contents : doc.getIn(segments, true);
  const range = (node as { range?: [number, number, number] } | null)?.range;
  if (range === undefined) return { line: 1, column: 1 };
  const pos = lineCounter.linePos(range[0]);
  return { line: pos.line, column: pos.col };
}

/**
 * Единственный конструктор диагностики манифеста — и санитизация стоит здесь, а не у
 * вызывающих.
 *
 * `Diagnostic.message` объявлен безопасным для отрисовки в **замороженном** типе, а
 * производителей сообщения пять: ajv, `yaml`, `refine`, компилятор паттернов и парсер lock.
 * Пока санитизация стояла у одного из них, гарантия была ложной ровно там, где вектор
 * дешевле: до RE2 надо дойти через валидную схему, а `doc.errors` вклеивает исходную строку
 * манифеста дословно — с ANSI-escape и bidi-override — от одной синтаксической ошибки.
 * Поставленная в конструктор, она не может быть забыта следующим производителем.
 */
export function diagnosticAt(
  doc: Document,
  lineCounter: LineCounter,
  segments: readonly Segment[],
  code: DiagnosticCode,
  message: string,
): Diagnostic {
  return {
    pointer: pointerOf(segments),
    ...positionOf(doc, lineCounter, segments),
    code,
    message: sanitizeDescription(message).text,
  };
}
