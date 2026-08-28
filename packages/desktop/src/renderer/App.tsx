import { useEffect, useMemo, useState } from 'react';
import type { ChainedEvent } from '@mcpproxy/contracts';
import { foldCalls } from '../shared/call.js';
import type { PlayerCommand, PlayerState } from '../shared/playerCommand.js';
import { bridge } from './bridge.js';
import { Chrome } from './Chrome.js';
import { Nav, type Screen } from './Nav.js';
import { STRINGS } from './strings.js';
import { callLine } from './timeline/callLine.js';
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

  // WHY: единственная поверхность, на которой рендерер может сказать «главный процесс отказал».
  // Молчаливый отказ на границе IPC неотличим от «данных просто нет» — а часть отказов там
  // охранные (чужой origin, отсоединённый фрейм), и терять их особенно нельзя.
  const [fault, setFault] = useState<string | null>(null);

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
        else if (!reply.ok) setFault(reply.error.message);
      })
      .catch((cause: unknown) => setFault(String(cause)))
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

  /**
   * `R48` говорит про режим ВЫЗОВА, а не про выбранную дорожку проигрывателя, и это не
   * придирка: лог начинается с событий, которые лежат до метки любой дорожки, поэтому при
   * обычном пошаговом прохождении baseline-прогон показывается при `track === 'seatbelt'`.
   * Привязанный к дорожке баннер в этот момент не показывался вовсе — ровно там, где он и
   * нужен. Данные на экране знают правду; состояние проигрывателя её только предполагает.
   */
  const unsandboxed = calls.some((call) => callLine(call).sandbox === 'none');

  // WHY: отправка команды — не «выстрелил и забыл». Отказной конверт и упавший канал
  // выглядели бы как «кнопка не нажалась», и на сцене это неотличимо от зависшего приложения.
  // Другого места сообщить об этом у рендерера нет: сети у него нет по CSP, лога — тоже.
  const command = (next: PlayerCommand): void => {
    void bridge()
      .send({ kind: 'player-command', command: next })
      .then((reply) => setFault(reply.ok ? null : reply.error.message))
      .catch((cause: unknown) => setFault(String(cause)));
  };

  return (
    <>
      {unsandboxed && <div className="unsandboxed-banner">{STRINGS.app.unsandboxedBanner}</div>}
      {fault !== null && (
        <div className="fault-banner" role="alert">
          {STRINGS.app.faultBanner(fault)}
        </div>
      )}

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
