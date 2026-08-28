import { denied, ok, type Result } from './result.js';
import {
  SPEED_MAX,
  SPEED_MIN,
  TRACKS,
  type PlayerCommand,
  type TrackId,
} from './playerCommand.js';
import type { UiRequest } from './channel.js';

/**
 * Мелкая копия на объект с нулевым прототипом.
 *
 * Типы здесь не защита: они стираются, а объект из недоверенного содержимого проносит
 * подконтрольный атакующему прототип через мост даже при включённой contextIsolation
 * (CVE-2026-70610). Читать поля можно только через `Object.hasOwn`.
 *
 * Мелкой копии хватает ровно потому, что обе полезные нагрузки плоские. Вложенный объект
 * сохранил бы свой прототип, и тест это фиксирует, чтобы третье сообщение не проехало
 * границу на прежней гарантии.
 */
export function sanitize(value: unknown): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>;
  if (typeof value !== 'object' || value === null) return out;
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(value, key)) out[key] = (value as Record<string, unknown>)[key];
  }
  return out;
}

const isTrack = (value: unknown): value is TrackId =>
  typeof value === 'string' && (TRACKS as readonly string[]).includes(value);

function parsePlayerCommand(raw: Record<string, unknown>): Result<PlayerCommand> {
  const kind = raw['kind'];
  switch (kind) {
    case 'step':
    case 'pause':
    case 'reset':
      return ok({ kind });
    case 'play': {
      const speed = raw['speed'];
      // WHY: неограниченное число из рендерера уезжает прямо в таймер, и модель угроз, где
      // рендерер считается компрометируемым, покупала бы главному процессу занятый цикл.
      if (typeof speed !== 'number' || !Number.isFinite(speed)) {
        return denied('bad-payload', 'скорость не является конечным числом');
      }
      if (speed < SPEED_MIN || speed > SPEED_MAX) {
        return denied('bad-payload', `скорость вне диапазона ${SPEED_MIN}…${SPEED_MAX}`);
      }
      return ok({ kind, speed });
    }
    case 'select-track': {
      const track = raw['track'];
      if (!isTrack(track)) return denied('bad-payload', 'неизвестная дорожка');
      return ok({ kind, track });
    }
    default:
      return denied('bad-payload', 'неизвестная команда проигрывателя');
  }
}

/**
 * Разбирает **весь** союз запроса, а не только команду проигрывателя: `hello` пересекает ту
 * же границу, и оставить один из вариантов без разбора значит оставить в ней дыру.
 */
export function parseUiRequest(payload: unknown): Result<UiRequest> {
  const raw = sanitize(payload);
  const kind = raw['kind'];

  if (kind === 'hello') {
    // WHY: у `hello` полезной нагрузки нет, и её отсутствие проверяется. Лишнее поле означает
    // отправителя, который считает форму иначе, — на границе безопасности это отказ.
    if (Object.keys(raw).length !== 1) return denied('bad-payload', 'у hello нет полей');
    return ok({ kind });
  }

  if (kind === 'player-command') {
    const command = parsePlayerCommand(sanitize(raw['command']));
    return command.ok ? ok({ kind, command: command.value }) : command;
  }

  return denied('bad-payload', 'неизвестный вид запроса');
}
