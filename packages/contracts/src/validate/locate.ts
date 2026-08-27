import type { Document, LineCounter } from 'yaml';
import type { Diagnostic } from '../types.js';

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

export function diagnosticAt(
  doc: Document,
  lineCounter: LineCounter,
  segments: readonly Segment[],
  message: string,
): Diagnostic {
  return { pointer: pointerOf(segments), ...positionOf(doc, lineCounter, segments), message };
}
