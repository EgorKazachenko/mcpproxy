import { MCP_PROTOCOL_VERSION } from '@mcpproxy/contracts';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_PROTOCOL_VERSIONS, negotiate } from './protocol.js';

describe('negotiate — множество живёт в E4, а не в замороженном контракте', () => {
  it('предпочитаемая ревизия — та, что объявляет контракт', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS[0]).toBe(MCP_PROTOCOL_VERSION);
  });

  it('известная ревизия клиента возвращается ему же', () => {
    expect(negotiate('2025-06-18')).toEqual({ version: '2025-06-18', agreed: true });
  });

  it('неизвестная ревизия даёт нашу предпочитаемую и пометку «не договорились»', () => {
    expect(negotiate('2019-01-01')).toEqual({ version: MCP_PROTOCOL_VERSION, agreed: false });
  });

  it('отсутствие ревизии не роняет согласование', () => {
    expect(negotiate(undefined).version).toBe(MCP_PROTOCOL_VERSION);
    expect(negotiate(42).agreed).toBe(false);
  });
});
