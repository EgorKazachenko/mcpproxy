/**
 * Дорожка трейса: один и тот же вызов, прогнанный в двух режимах песочницы.
 *
 * Не `traceId` из контракта: тот идентифицирует **вызов**, и свёртка сворачивает по нему.
 * Ключевать дорожки им означало бы слить оба прогона в один вызов из двадцати шести стадий.
 */
export type TrackId = 'seatbelt' | 'none';

export type PlayerCommand =
  | { readonly kind: 'step' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'play'; readonly speed: number }
  | { readonly kind: 'reset' }
  | { readonly kind: 'select-track'; readonly track: TrackId };

export interface PlayerState {
  readonly track: TrackId;
  readonly position: number;
  readonly total: number;
  readonly playing: boolean;
}

export const TRACKS: readonly TrackId[] = ['seatbelt', 'none'];

/** Границы скорости. Неограниченное число из рендерера уезжает прямо в таймер. */
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 8;
