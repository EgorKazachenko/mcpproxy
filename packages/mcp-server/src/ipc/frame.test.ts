import { describe, expect, it } from 'vitest';
import { createFrameDecoder, encodeFrame } from './frame.js';

const chunk = (text: string): Buffer<ArrayBufferLike> => Buffer.from(text, 'utf8');

describe('фрейминг — по значению на строку', () => {
  it('целый кадр разбирается', () => {
    const decoder = createFrameDecoder();
    expect(decoder.push(chunk('{"kind":"list","id":1}\n'))).toEqual([{ kind: 'frame', value: { kind: 'list', id: 1 } }]);
  });

  it('кадр, разрезанный по границам чанков, собирается', () => {
    const decoder = createFrameDecoder();
    expect(decoder.push(chunk('{"kind":"li'))).toEqual([]);
    expect(decoder.push(chunk('st","id":7}\n'))).toEqual([{ kind: 'frame', value: { kind: 'list', id: 7 } }]);
  });

  it('несколько кадров в одном чанке разбираются по порядку', () => {
    const decoder = createFrameDecoder();
    const out = decoder.push(chunk('{"a":1}\n{"a":2}\n'));
    expect(out).toEqual([
      { kind: 'frame', value: { a: 1 } },
      { kind: 'frame', value: { a: 2 } },
    ]);
  });

  it('перевод строки внутри строкового литерала не рвёт кадр', () => {
    // Ровно то свойство, ради которого выбран line-delimited: JSON.stringify экранирует \n.
    const decoder = createFrameDecoder();
    const out = decoder.push(chunk(encodeFrame({ text: 'первая\nвторая' })));
    expect(out).toEqual([{ kind: 'frame', value: { text: 'первая\nвторая' } }]);
  });

  it('битый JSON даёт malformed, а поток продолжается', () => {
    const decoder = createFrameDecoder();
    const out = decoder.push(chunk('{нет\n{"a":1}\n'));
    expect(out[0]?.kind).toBe('malformed');
    expect(out[1]).toEqual({ kind: 'frame', value: { a: 1 } });
  });

  it('кадр сверх потолка обрывает разбор, а не пропускается', () => {
    const decoder = createFrameDecoder(16);
    const out = decoder.push(chunk(`${'x'.repeat(64)}\n{"a":1}\n`));
    expect(out).toEqual([{ kind: 'oversized' }]);
  });

  it('незакрытый хвост сверх потолка тоже ловится — иначе потолок обходится без \\n', () => {
    const decoder = createFrameDecoder(16);
    expect(decoder.push(chunk('y'.repeat(64)))).toEqual([{ kind: 'oversized' }]);
  });

  it('после превышения декодер молчит: досинхронизироваться по чужому \\n нельзя', () => {
    const decoder = createFrameDecoder(16);
    decoder.push(chunk('z'.repeat(64)));
    expect(decoder.push(chunk('{"a":1}\n'))).toEqual([]);
  });
});
