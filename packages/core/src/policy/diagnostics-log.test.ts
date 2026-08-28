import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '@mcpproxy/contracts';
import { parseLockFile } from '@mcpproxy/contracts/validate';
import { toLogRecords } from './diagnostics-log.js';

const ZERO_WIDTH = String.fromCodePoint(0x200b);

describe('toLogRecords', () => {
  it('две враждебные записи, чьи имена схлопывает санитизация, получают РАЗНЫЕ ключи', () => {
    // `tools.a<U+200B>b` и законный `tools.ab` дают один и тот же указатель, а координат у
    // диагностик lock нет вовсе: обе несут `line: 1, column: 1`. Развести их может только
    // порядковый номер в пределах разбора.
    const collapsed: Diagnostic[] = [
      { pointer: 'tools.ab', line: 1, column: 1, code: 'lock', message: 'не имя рецепта: ab' },
      { pointer: 'tools.ab', line: 1, column: 1, code: 'lock', message: 'запись lock обязана быть объектом' },
    ];

    const records = toLogRecords(collapsed, 'lock');
    expect(new Set(records.map((one) => one.key)).size).toBe(2);
  });

  it('ключ различает и происхождение: манифест и lock не смешиваются', () => {
    const one: Diagnostic[] = [{ pointer: '', line: 1, column: 1, code: 'lock', message: 'что-то' }];

    expect(toLogRecords(one, 'lock')[0]?.key).not.toBe(toLogRecords(one, 'manifest')[0]?.key);
  });

  it('поля диагностики переносятся дословно', () => {
    const one: Diagnostic = { pointer: 'tools.x', line: 12, column: 3, code: 'schema', message: 'текст' };
    const [record] = toLogRecords([one], 'manifest');

    expect(record).toMatchObject({ pointer: 'tools.x', line: 12, column: 3, code: 'schema', message: 'текст' });
  });

  it('на настоящей пачке из parseLockFile ключи уникальны', () => {
    // Имена в lock подобраны так, чтобы санитизация указателя схлопнула их в один.
    const hostile = `{"version":2,"manifestHash":"${'a'.repeat(64)}","defaults":{},"tools":{"a${ZERO_WIDTH}b":1,"ab":2}}`;
    const parsed = parseLockFile(hostile);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;

    const records = toLogRecords(parsed.diagnostics, 'lock');
    expect(records.length).toBeGreaterThan(1);
    expect(new Set(records.map((one) => one.key)).size).toBe(records.length);
  });
});
