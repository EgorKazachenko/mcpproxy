/**
 * Фрейминг шим↔демон: JSON, по одному значению на строку, UTF-8.
 *
 * Выбран line-delimited, а не length-prefixed, по одной причине: `JSON.stringify` экранирует
 * перевод строки внутри строкового литерала, поэтому разделитель не может встретиться внутри
 * кадра, и разбор не нуждается в состоянии сложнее «до ближайшего \n».
 *
 * Потолок кадра — не оптимизация, а граница доверия: по сокету приходит произвольный JSON, и
 * без потолка отправитель занимает память демона одной незакрытой строкой. Превышение —
 * **разрыв соединения**, а не пропуск кадра: остаток буфера уже не синхронизирован, и попытка
 * досинхронизироваться по следующему \n разбирала бы хвост чужого кадра как целый.
 */
export const FRAME_MAX_BYTES = 1_048_576;

export type FrameOutcome =
  | { readonly kind: 'frame'; readonly value: unknown }
  | { readonly kind: 'malformed'; readonly text: string }
  | { readonly kind: 'oversized' };

export interface FrameDecoder {
  push(chunk: Buffer<ArrayBufferLike>): readonly FrameOutcome[];
}

export function createFrameDecoder(maxBytes: number = FRAME_MAX_BYTES): FrameDecoder {
  // `Buffer<ArrayBufferLike>`, а не голый `Buffer`: `Buffer.concat` возвращает именно его,
  // и голая аннотация сузила бы тип до `Buffer<ArrayBuffer>`, которому конкатенация не подходит.
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let dead = false;

  return {
    push(chunk: Buffer<ArrayBufferLike>): readonly FrameOutcome[] {
      if (dead) return [];
      const out: FrameOutcome[] = [];
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

      for (;;) {
        const at = buffer.indexOf(0x0a);
        if (at === -1) break;
        const line = buffer.subarray(0, at);
        buffer = buffer.subarray(at + 1);
        if (line.length > maxBytes) {
          dead = true;
          return [...out, { kind: 'oversized' }];
        }
        const text = line.toString('utf8').trim();
        if (text === '') continue;
        try {
          out.push({ kind: 'frame', value: JSON.parse(text) });
        } catch (error) {
          out.push({ kind: 'malformed', text: (error as Error).message });
        }
      }

      // Незавершённый хвост считается вместе с уже накопленным: иначе потолок обходится
      // отправкой мегабайта без единого перевода строки.
      if (buffer.length > maxBytes) {
        dead = true;
        out.push({ kind: 'oversized' });
      }
      return out;
    },
  };
}

export function encodeFrame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
