import { contextBridge, ipcRenderer } from 'electron';
import { UI_CHANNEL, type UiEvent, type UiReply, type UiRequest } from '../shared/channel.js';
import type { Result } from '../shared/result.js';

declare const MCPPROXY_OBSERVE: boolean;

/**
 * Мост наружу: один замороженный объект с именованными методами.
 *
 * `ipcRenderer` через него не проходит ни целиком, ни отдельным методом — отдать его наружу
 * это классический способ обойти весь остальной хардненинг с той стороны.
 *
 * Входящее направление сужается так же строго, как исходящее: `ipcRenderer.on` отдаёт
 * слушателю событие, несущее отправителя и порты, и передать его в рендерер значило бы
 * обойти границу с другой стороны моста. Наружу уходит только полезная нагрузка.
 */
contextBridge.exposeInMainWorld(
  'mcpproxy',
  Object.freeze({
    send: (request: UiRequest): Promise<Result<UiReply>> => ipcRenderer.invoke(UI_CHANNEL, request),
    onEvent: (listener: (event: UiEvent) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: UiEvent): void => listener(payload);
      ipcRenderer.on(UI_CHANNEL, handler);
      return () => {
        ipcRenderer.off(UI_CHANNEL, handler);
      };
    },
  }),
);

/**
 * Наблюдение за фактически применёнными флагами — только под флагом сборки.
 *
 * Читается `process.sandboxed`, а не настройки окна: публичного API для чтения применённых
 * `webPreferences` у `WebContents` нет вовсе. Замена строго сильнее — она показывает эффект
 * флага в самом процессе рендерера, а не то, что запрошено при создании, поэтому ослабление
 * на месте вызова видно даже при верной фабрике.
 *
 * Изнутри главного мира страницы этого не увидеть: при `contextIsolation` и
 * `nodeIntegration: false` узловых глобалей там нет **независимо** от песочницы.
 */
if (MCPPROXY_OBSERVE) {
  contextBridge.exposeInMainWorld(
    '__mcpproxyObserve',
    Object.freeze({
      sandboxed: process.sandboxed === true,
      contextIsolated: process.contextIsolated === true,
    }),
  );
}
