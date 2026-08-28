import { MCP_PROTOCOL_VERSION } from '@mcpproxy/contracts';

/**
 * Множество поддерживаемых ревизий живёт ЗДЕСЬ, а не в замороженных контрактах.
 *
 * Так решил E0, оставив выбор E4: контракт объявляет одну предпочитаемую ревизию
 * (`MCP_PROTOCOL_VERSION`), а список того, на что мы готовы договориться, — свойство
 * реализации поверхности и меняется без бампа контракта и без ревизии семи эпиков.
 *
 * Порядок значим: первая — предпочитаемая, она же ответ клиенту, чью ревизию мы не знаем.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [MCP_PROTOCOL_VERSION, '2025-06-18'];

export interface Negotiation {
  readonly version: string;
  readonly agreed: boolean;
}

/**
 * Согласование по спеке MCP: знаем ревизию клиента — отвечаем ею; не знаем — отвечаем своей
 * предпочитаемой, и решение продолжать остаётся за клиентом.
 *
 * Согласованное значение потом едет в `AuditEvent.protocolVersion` каждого события вызова.
 * Записать вместо него константу сборки контракт называет ложным утверждением в
 * доказательстве, а не потерей поля, — поэтому оно протаскивается через IPC до самого события.
 */
export function negotiate(requested: unknown): Negotiation {
  const preferred = SUPPORTED_PROTOCOL_VERSIONS[0] as string;
  if (typeof requested !== 'string') return { version: preferred, agreed: false };
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? { version: requested, agreed: true }
    : { version: preferred, agreed: false };
}
