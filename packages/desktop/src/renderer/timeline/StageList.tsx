import { stageLabel, violationRole } from '@mcpproxy/design';
import type { ChainedEvent } from '@mcpproxy/contracts';
import { STRINGS } from '../strings.js';
import { MachineText } from './MachineText.js';
import { stageDetail } from './stageDetail.js';

/** Ноль здесь означает «длительности нет», а не «прошло мгновенно» — отсюда прочерк. */
const duration = (us: number): string => {
  if (us === 0) return STRINGS.detail.noDuration;
  return us >= 1_000_000
    ? `${(us / 1_000_000).toFixed(1)} ${STRINGS.detail.seconds}`
    : `${(us / 1000).toFixed(1)} ${STRINGS.detail.milliseconds}`;
};

const ICON: Readonly<Record<string, string>> = { ok: '✓', warn: '⊘', danger: '✕' };

/**
 * Роль строки стадии.
 *
 * `build_profile` спрашивает про **профиль**, а не про режим: `sandbox.mode` по таблице
 * контракта впервые появляется на `spawn`, поэтому прежняя проверка `mode === 'none'` не
 * срабатывала никогда и небезопасный прогон получал зелёную галочку.
 *
 * У `violation` роль берётся из `violationRole(type, action)`, а не пишется плоским `warn`:
 * `R24` и есть про то, что отбитое нарушение и прошедшее насквозь — разные новости, и
 * плоский янтарь красил успешную утечку так же, как отбитую попытку.
 */
const roleOf = (event: ChainedEvent): string => {
  if (event.stage === 'build_profile') return event.sandbox?.profile === undefined ? 'danger' : 'ok';
  if (event.stage === 'violation') {
    const violation = event.sandbox?.violations?.[0];
    return violation === undefined ? 'warn' : violationRole(violation.type, violation.action);
  }
  if (event.verdict === 'denied') return 'warn';
  if (event.verdict === 'error') return 'danger';
  return 'ok';
};

export function StageList({ stages }: { stages: readonly ChainedEvent[] }) {
  return (
    <div className="stages">
      {stages.map((event, index) => (
        <div key={`${event.spanId}-${index}`} className={`stage role-${roleOf(event)}`}>
          {/* WHY: сетка стадии четырёхколоночная — иконка, имя, длительность, деталь. Без
              ячейки иконки деталь попадает в узкую колонку длительности и ломается на
              четыре строки; это нашёл запуск, а не тайпчек. */}
          <span className="stage-icon" aria-hidden="true">
            {ICON[roleOf(event)]}
          </span>
          <span className="stage-name">{stageLabel[event.stage]}</span>
          <span className="stage-ms">{duration(event.durationUs)}</span>
          <span className="stage-detail">
            <MachineText text={stageDetail(event)} />
          </span>
        </div>
      ))}
    </div>
  );
}
