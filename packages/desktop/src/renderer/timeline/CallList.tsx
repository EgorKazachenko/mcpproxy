import { sandboxLabel, verdictLabel, verdictRole } from '@mcpproxy/design';
import type { Call } from '../../shared/call.js';
import { STRINGS } from '../strings.js';
import { callLine, groupBar } from './callLine.js';

const ICON: Readonly<Record<string, string>> = {
  ok: '✓',
  warn: '⊘',
  danger: '✕',
  info: '⋯',
  human: '◆',
  muted: '·',
};

const timeOf = (iso: string): string => iso.slice(11, 19);

/**
 * Список вызовов.
 *
 * Строка несёт бейдж режима песочницы: без него два соседних вызова сценария S5 отличаются
 * одним словом, и зал не видит, что режимы разные. Рядом с цветом стоит иконка — янтарь и
 * красный это ровно та пара, которую путают протанопы и дейтеранопы, а на проекторе они
 * сближаются ещё сильнее.
 */
export function CallList({
  calls,
  selected,
  onSelect,
}: {
  calls: readonly Call[];
  selected: string | null;
  onSelect: (traceId: string) => void;
}) {
  if (calls.length === 0) {
    return (
      <div className="empty">
        <b>{STRINGS.calls.emptyHead}</b>
        {STRINGS.calls.emptyBody}
      </div>
    );
  }

  return (
    <div className="pane-scroll" role="listbox">
      {calls.map((call) => {
        const line = callLine(call);
        return (
          <button
            key={call.traceId}
            type="button"
            className={`call role-${line.role}`}
            role="option"
            aria-selected={call.traceId === selected}
            onClick={() => onSelect(call.traceId)}
          >
            <span className="call-top">
              <span className="call-name mono">{call.toolName}</span>
              <span className={`badge badge--${line.verdictMuted ? 'muted' : verdictRole[call.verdict]}`}>
                {verdictLabel[call.verdict]}
              </span>
              {line.sandbox !== undefined && (
                <span className={`badge badge--${line.sandbox === 'none' ? 'danger' : 'ok'}`}>
                  {sandboxLabel[line.sandbox]}
                </span>
              )}
              <span className="call-time">{timeOf(call.startedAt)}</span>
            </span>

            <span className={`call-line role-${line.role}`}>
              <span className="call-icon" aria-hidden="true">
                {ICON[line.role]}
              </span>
              {/* Слово диспозиции и тире — из макета: тире держит два куска строки вместе,
                  когда остаток усечён многоточием, и без него слово сливается с остатком. */}
              <b>{line.rest === '' ? STRINGS.outcome[line.outcome] : STRINGS.calls.verb(STRINGS.outcome[line.outcome])}</b>
              {line.rest !== '' && <span>{line.rest}</span>}
            </span>

            <span className="groupbar" aria-hidden="true">
              {groupBar(call).map((bar) => (
                <span key={bar.group} className="grp" style={{ flex: bar.total }}>
                  {bar.reached > 0 && <i className={`g-${bar.role}`} style={{ flex: bar.reached }} />}
                  {bar.reached < bar.total && <i className="g-skip" style={{ flex: bar.total - bar.reached }} />}
                </span>
              ))}
            </span>
          </button>
        );
      })}
    </div>
  );
}
