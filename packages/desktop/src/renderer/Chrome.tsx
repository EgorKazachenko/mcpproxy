import { sandboxLabel } from '@mcpproxy/design';
import type { PlayerState, TrackId } from '../shared/playerCommand.js';
import { STRINGS } from './strings.js';

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
  onCommand: (command: { kind: 'step' } | { kind: 'pause' } | { kind: 'reset' } | { kind: 'select-track'; track: TrackId }) => void;
}) {
  const track = state?.track ?? 'seatbelt';

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

      <button className="btn-secondary" type="button" onClick={() => onCommand({ kind: 'step' })}>
        {STRINGS.player.step}
      </button>
      <button className="btn-secondary" type="button" onClick={() => onCommand({ kind: 'reset' })}>
        {STRINGS.player.reset}
      </button>
      {state !== null && <span className="eyebrow">{STRINGS.player.position(state.position, state.total)}</span>}
    </header>
  );
}
