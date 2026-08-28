import type { UiEvent, UiReply, UiRequest } from '../shared/channel.js';
import type { Result } from '../shared/result.js';

/**
 * Мост, выставленный preload. Другого пути к главному процессу у рендерера нет: `ipcRenderer`
 * наружу не отдан ни целиком, ни отдельным методом.
 */
export interface Bridge {
  readonly send: (request: UiRequest) => Promise<Result<UiReply>>;
  readonly onEvent: (listener: (event: UiEvent) => void) => () => void;
}

declare global {
  interface Window {
    readonly mcpproxy: Bridge;
  }
}

export const bridge = (): Bridge => window.mcpproxy;
