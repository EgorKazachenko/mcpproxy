import { useEffect, useMemo, useState } from 'react';
import type { ChainedEvent } from '@mcpproxy/contracts';
import { foldCalls } from '../shared/call.js';
import type { PlayerCommand, PlayerState } from '../shared/playerCommand.js';
import { bridge } from './bridge.js';
import { Chrome } from './Chrome.js';
import { Nav, type Screen } from './Nav.js';
import { STRINGS } from './strings.js';
import { CallDetail } from './timeline/CallDetail.js';
import { CallList } from './timeline/CallList.js';
import { CallDetailSkeleton, CallListSkeleton } from './timeline/Skeleton.js';

/**
 * Состояние выбора и фильтра живёт здесь, а не в панелях.
 *
 * Без общего состояния клик по полю в правой панели не может изменить левую, и требование про
 * фильтрацию осталось бы рисунком.
 */
export function App() {
  const [events, setEvents] = useState<readonly ChainedEvent[]>([]);
  const [state, setState] = useState<PlayerState | null>(null);
  const [screen, setScreen] = useState<Screen>('timeline');
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);

  // WHY (R22): «ещё ничего не слышали от main», а не «идёт сетевой запрос». Пустое состояние
  // утверждает, что вызовов не было; до первого ответа это неизвестно, и показывать его там
  // значит утверждать факт вместо ожидания.
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const off = bridge().onEvent((event) => {
      // Любое сообщение из main — уже ответ: дальше состояние экрана определяют данные.
      setLoading(false);
      switch (event.kind) {
        case 'trace-event':
          setEvents((previous) => [...previous, event.event]);
          return;
        case 'player-state':
          setState(event.state);
          return;
        case 'trace-reset':
          // WHY: обе команды делают накопленное недействительным, и без явного сообщения
          // рендереру пришлось бы выводить сброс из гонки состояния с событиями.
          setEvents([]);
          setSelected(null);
          return;
      }
    });

    // WHY: подписка происходит позже, чем main начинает работу. Без этого запроса первая
    // отрисовка показала бы пустой список при непустом трейсе.
    // WHY: скелет снимается на ЛЮБОМ исходе, включая отказной конверт и упавший канал.
    // Ожидание, из которого нет выхода, — это бесконечный скелет: он показывает движение там,
    // где ничего уже не произойдёт, и врёт заметнее, чем пустое состояние.
    void bridge()
      .send({ kind: 'hello' })
      .then((reply) => {
        if (reply.ok && reply.value.kind === 'state') setState(reply.value.state);
      })
      .finally(() => setLoading(false));

    return off;
  }, []);

  const calls = useMemo(() => {
    const folded = foldCalls(events);
    return filter === null
      ? folded
      : folded.filter((call) => call.toolName.includes(filter) || call.traceId.includes(filter));
  }, [events, filter]);

  const current = calls.find((call) => call.traceId === selected) ?? null;
  const command = (next: PlayerCommand): void => void bridge().send({ kind: 'player-command', command: next });

  return (
    <>
      {state?.track === 'none' && <div className="unsandboxed-banner">{STRINGS.app.unsandboxedBanner}</div>}

      <Chrome state={state} onCommand={command} />

      <div className="body">
        <Nav active={screen} onSelect={setScreen} />

        {screen === 'timeline' ? (
          <div className="main">
            <section className="pane pane-list" aria-label={STRINGS.calls.head}>
              <div className="pane-head">
                <h2>{STRINGS.calls.head}</h2>
                <span className="spacer" />
                {filter !== null && (
                  <button className="badge badge--muted" type="button" onClick={() => setFilter(null)}>
                    {filter}
                  </button>
                )}
                <span className="eyebrow">
                  {loading ? STRINGS.calls.loading : STRINGS.calls.perSession(calls.length)}
                </span>
              </div>
              {loading ? (
                <CallListSkeleton />
              ) : (
                <CallList calls={calls} selected={selected} onSelect={setSelected} />
              )}
            </section>

            <section className="pane pane-detail" aria-label={STRINGS.detail.head}>
              <div className="pane-head">
                <h2>{STRINGS.detail.head}</h2>
              </div>
              {loading ? <CallDetailSkeleton /> : <CallDetail call={current} onFilter={setFilter} />}
            </section>
          </div>
        ) : (
          <div className="main">
            <div className="empty">
              <b>{STRINGS.nav.laterHead}</b>
              {STRINGS.nav.laterBody}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
