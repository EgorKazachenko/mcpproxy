import type { Diagnostic, DiagnosticCode } from '@mcpproxy/contracts';

/**
 * Диагностики загрузки — в структурный лог демона, и **не** в цепочку аудита (R2): у события
 * аудита нет стадии `manifest_load`, и `Stage` для этого не расширяется.
 *
 * Ключ записи строится **не по одному `pointer`**. Указатель лоссовый и не уникален: ключ с
 * невидимыми символами приезжает без них, поэтому `tools.a<U+200B>b` и законный `tools.ab`
 * дают один и тот же указатель, — и по нему диагностики враждебного ключа приписались бы
 * невиновному рецепту. Для манифеста хватило бы тройки `pointer` + `line` + `column`, **а для
 * lock не хватает и её**: все его диагностики несут `line: 1, column: 1`
 * (`packages/contracts/src/validate/lock.ts:62`), а `pointer` у них — это `tools.${имя}`,
 * пропущенный через санитизацию.
 *
 * Развести две враждебные записи может только порядковый номер в пределах разбора — из одной
 * диагностики его не вычислить. Поэтому функция берёт **пачку**, а не запись.
 */

export interface DiagnosticRecord {
  readonly key: string;
  readonly pointer: string;
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

export function toLogRecords(
  diagnostics: readonly Diagnostic[],
  origin: 'manifest' | 'lock',
): readonly DiagnosticRecord[] {
  return diagnostics.map((one, index) => ({
    key: `${origin}#${index}@${one.line}:${one.column}:${one.pointer}`,
    pointer: one.pointer,
    code: one.code,
    message: one.message,
    line: one.line,
    column: one.column,
  }));
}
