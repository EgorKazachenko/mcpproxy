import type { WebContents } from 'electron';
import { UI_CHANNEL, type UiEvent } from '../shared/channel.js';

/**
 * Единственный владелец исходящего направления.
 *
 * Без него `webContents.send` расползается по модулям-производителям, и ни один тип не
 * говорит, куда уходят события. Производители получают отправку аргументом — так же, как
 * проигрыватель получает приёмник.
 *
 * Реестр окон, а не одно окно: второе окно придёт вместе с апрувами, и адресация появится
 * здесь, не трогая производителей.
 */
export interface Dispatch {
  readonly register: (contents: WebContents) => void;
  readonly send: (event: UiEvent) => void;
}

export function createDispatch(): Dispatch {
  const targets = new Set<WebContents>();

  const register = (contents: WebContents): void => {
    targets.add(contents);
    contents.once('destroyed', () => targets.delete(contents));
  };

  const send = (event: UiEvent): void => {
    for (const contents of targets) {
      if (!contents.isDestroyed()) contents.send(UI_CHANNEL, event);
    }
  };

  return { register, send };
}
