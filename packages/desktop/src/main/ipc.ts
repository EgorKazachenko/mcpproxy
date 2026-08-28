import { ipcMain } from 'electron';
import { UI_CHANNEL, type UiReply, type UiRequest } from '../shared/channel.js';
import { parseUiRequest } from '../shared/parse.js';
import { denied, type Result, type UiErrorCode } from '../shared/result.js';

/**
 * Факты об отправителе — структурным типом, а не типом фрейма Electron.
 *
 * Так каждую ветку можно проверить литералом, не подделывая событие: настоящий фрейм для
 * проверки ветвления не нужен, а подделать его дорого и хрупко.
 */
export interface SenderFacts {
  readonly detached: boolean;
  readonly parent: unknown;
  readonly origin: string;
}

/**
 * Причина отказа отправителю или `null`, если он в порядке.
 *
 * Четыре причины разделены: «фрейма нет», «фрейм отцеплен», «сообщение из вложенного фрейма»
 * и «чужой origin» — это четыре независимые атаки, и общий код лишил бы тест возможности
 * сказать, какая защита исчезла.
 *
 * `allowedOrigins` параметром, а не константой: в разработке рендерер грузится с адреса
 * dev-сервера, и сверка с единственным значением отклоняла бы там каждое сообщение.
 */
export function senderRejection(
  frame: SenderFacts | null,
  allowedOrigins: ReadonlySet<string>,
): UiErrorCode | null {
  if (frame === null) return 'sender-absent';
  if (frame.detached) return 'sender-detached';
  if (frame.parent !== null) return 'sender-subframe';
  if (!allowedOrigins.has(frame.origin)) return 'sender-origin';
  return null;
}

const MESSAGES: Readonly<Record<UiErrorCode, string>> = {
  'sender-absent': 'фрейм отправителя недоступен',
  'sender-detached': 'фрейм отправителя отцеплен',
  'sender-subframe': 'сообщение пришло из вложенного фрейма',
  'sender-origin': 'origin отправителя не разрешён',
  'bad-payload': 'полезная нагрузка не прошла разбор',
};

/**
 * Обёртка привилегированного обработчика.
 *
 * `event.senderFrame` читается **первым оператором**, до любого `await`: геттер ленивый и
 * заново резолвит фрейм в момент обращения, поэтому асинхронная обёртка-валидатор ровно его и
 * обнуляет. Типы Electron перевели его в допускающий `null` именно из-за этого.
 *
 * Возврат допускает промис, чтобы ран 2 мог добавить экспорт лога с асинхронным диалогом
 * сохранения, не переписывая охрану. Это безопасно: фрейм прочитан до вызова обработчика.
 */
export function guarded(
  run: (request: UiRequest) => Result<UiReply> | Promise<Result<UiReply>>,
  allowedOrigins: ReadonlySet<string>,
): (event: Electron.IpcMainInvokeEvent, payload: unknown) => Result<UiReply> | Promise<Result<UiReply>> {
  return (event, payload) => {
    const frame = event.senderFrame;
    const rejection = senderRejection(frame, allowedOrigins);
    if (rejection !== null) return denied(rejection, MESSAGES[rejection]);

    const request = parseUiRequest(payload);
    if (!request.ok) return request;

    return run(request.value);
  };
}

/** Единственное место регистрации привилегированных обработчиков. */
export function registerIpc(
  run: (request: UiRequest) => Result<UiReply> | Promise<Result<UiReply>>,
  allowedOrigins: ReadonlySet<string>,
): void {
  ipcMain.handle(UI_CHANNEL, guarded(run, allowedOrigins));
}
