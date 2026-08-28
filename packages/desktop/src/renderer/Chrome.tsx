import { useState } from 'react';
import { sandboxLabel } from '@mcpproxy/design';
import { SPEED_MAX, type PlayerCommand, type PlayerState, type TrackId } from '../shared/playerCommand.js';
import { STRINGS } from './strings.js';

/**
 * Скорости проигрывателя, по которым ходит одна кнопка.
 *
 * Кнопка, а не поле ввода: на сцене нужен один клик и видимое текущее значение, а диапазон
 * `SPEED_MIN…SPEED_MAX` охраняет граница IPC — из рендерера произвольное число не уедет.
 */
const SPEEDS: readonly number[] = [1, 2, 4];

const TRACK_MODE: Readonly<Record<TrackId, 'none' | 'seatbelt'>> = { none: 'none', seatbelt: 'seatbelt' };

/**
 * Верхняя полоса: знак продукта, переключатель режима и управление проигрывателем.
 *
 * Переключатель отправляет команду проигрывателю, а не подменяет выделение в списке: подмена
 * выглядела бы так же, но доказывала бы другое — сценарий S5 держится на том, что команда и
 * её параметры одни и те же.
 */
export function Chrome({
  state,
  onCommand,
}: {
  state: PlayerState | null;
  onCommand: (command: PlayerCommand) => void;
}) {
  const track = state?.track ?? 'seatbelt';

  // WHY: скорость — состояние ОРГАНА управления, а не проигрывателя: `PlayerState` её не
  // несёт, и добавлять её туда ради подписи кнопки значило бы расширять сообщение границы
  // ради рендера. Кнопка помнит, что нажали последним, и отправляет это вместе с `play`.
  const [speed, setSpeed] = useState<number>(SPEEDS[0] ?? 1);
  const playing = state?.playing ?? false;

  return (
    <header className="chrome">
      <span className="logo">
        <span className="mark" />
        {STRINGS.app.name}
      </span>

      <span className="spacer" />

      <span className="eyebrow">{STRINGS.app.sandboxEyebrow}</span>
      <div className="modeswitch" role="group" aria-label={STRINGS.app.sandboxEyebrow}>
        {(['none', 'seatbelt'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            data-mode={mode}
            aria-pressed={TRACK_MODE[track] === mode}
            onClick={() => onCommand({ kind: 'select-track', track: mode })}
          >
            {sandboxLabel[mode]}
          </button>
        ))}
      </div>

      {/* Пауза и скорость были реализованы в проигрывателе и провалидированы на границе, но
          из интерфейса недостижимы: в шапке стояли только «Шаг» и «Сброс», а `R12` называет
          непрерывное воспроизведение планом Б на случай, если ядро упадёт на сцене.

          WHY первым и первичным: показ ведётся непрерывным прогоном, а не покадрово. Пока
          «Шаг» стоял первым и обе кнопки были вторичными, орган, которым сценарий ЗАПУСКАЮТ,
          ничем не отличался от органа, которым его листают, — и читался как «жать сюда
          двадцать шесть раз». «Шаг» остаётся: он нужен, когда по стадии задают вопрос. */}
      <button
        className="btn-primary"
        type="button"
        aria-pressed={playing}
        onClick={() => onCommand(playing ? { kind: 'pause' } : { kind: 'play', speed })}
      >
        {playing ? STRINGS.player.pause : STRINGS.player.play}
      </button>
      <button className="btn-secondary" type="button" onClick={() => onCommand({ kind: 'step' })}>
        {STRINGS.player.step}
      </button>
      <button
        className="btn-secondary"
        type="button"
        aria-label={STRINGS.player.speedLabel}
        onClick={() => {
          const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] ?? 1;
          setSpeed(next);
          if (playing) onCommand({ kind: 'play', speed: Math.min(next, SPEED_MAX) });
        }}
      >
        {STRINGS.player.speed(speed)}
      </button>
      <button className="btn-secondary" type="button" onClick={() => onCommand({ kind: 'reset' })}>
        {STRINGS.player.reset}
      </button>
      {state !== null && <span className="eyebrow">{STRINGS.player.position(state.position, state.total)}</span>}
    </header>
  );
}
