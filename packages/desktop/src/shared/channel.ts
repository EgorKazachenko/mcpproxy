import type { ChainedEvent } from '@mcpproxy/contracts';
import type { PlayerCommand, PlayerState, TrackId } from './playerCommand.js';

export const UI_CHANNEL = 'mcpproxy.ui/1';

/**
 * Рендерер → main.
 *
 * Размеченный союз с одним содержательным вариантом уже сейчас: ран 2 добавит сюда вердикт
 * апрува и запрос экспорта лога, и форма не поменяется.
 *
 * Имя `IpcRequest` здесь не используется намеренно — оно занято границей shim и демона
 * (`@mcpproxy/contracts`), а два разных периметра безопасности не могут называться одинаково.
 */
export type UiRequest =
  | { readonly kind: 'player-command'; readonly command: PlayerCommand }
  | { readonly kind: 'hello' };

/**
 * Ответ обработчика. Общий размеченный тип, а не отдельный на каждый вариант запроса: охрана
 * параметризована одним типом результата, и без этого `hello` пришлось бы вести отдельным
 * каналом ради одной формы ответа.
 */
export type UiReply =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'state'; readonly state: PlayerState };

/**
 * main → рендерер.
 *
 * `trace-reset` отправляется первым после сброса и после смены дорожки: обе команды делают
 * накопленный рендерером массив недействительным, и без явного сообщения рендереру пришлось
 * бы **выводить** сброс из гонки состояния с событиями.
 */
export type UiEvent =
  | { readonly kind: 'trace-event'; readonly event: ChainedEvent }
  | { readonly kind: 'player-state'; readonly state: PlayerState }
  | { readonly kind: 'trace-reset'; readonly track: TrackId };
