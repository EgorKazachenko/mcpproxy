import { STRINGS } from '../strings.js';

/**
 * Состояние загрузки таймлайна (`R22`).
 *
 * Геометрия повторяет наполненное тело бокс в бокс — те же `.call`, `.call-top`, `.call-line`
 * и `.groupbar`, что рисует `CallList`, и те же `.dsec`, что рисует `CallDetail`. Скелет,
 * который ниже наполненной строки, даёт скачок вёрстки ровно в тот момент, когда человек уже
 * начал читать: разница высот прыгает под курсором. Ширины взяты из замороженного макета.
 *
 * Скелет — не «нет данных». Пустое состояние утверждает, что вызовов не было; до ответа main
 * это неизвестно, и рисовать там `Вызовов пока не было` значит утверждать факт вместо ожидания.
 */

const ROWS = 5;

/** Полоса-заглушка. Ширина — геометрия макета, а не значение дизайн-системы. */
const Bar = ({ width }: { width: string }) => <span className="skel" style={{ width }} />;

const Line = ({ width }: { width: string }) => (
  <div className="skel-line">
    <Bar width={width} />
  </div>
);

/**
 * Список вызовов во время загрузки.
 *
 * `role="listbox"` здесь нет намеренно: списка вариантов пока не существует, и объявлять
 * пустой listbox значит сообщать скринридеру о выборе, которого нет. Ожидание объявляет
 * `aria-busy` на области, а словами — надпись в шапке панели.
 */
export function CallListSkeleton() {
  return (
    <div className="pane-scroll" aria-busy="true">
      {Array.from({ length: ROWS }, (_, index) => (
        <div className="call" key={index} aria-hidden="true">
          <span className="call-top">
            <span className="call-name mono">
              <Bar width="132px" />
            </span>
            <span className="badge badge--muted">
              <Bar width="56px" />
            </span>
            <span className="call-time">
              <Bar width="44px" />
            </span>
          </span>

          <span className="call-line">
            <span className="call-icon" />
            <Bar width="64%" />
          </span>

          <span className="groupbar">
            <span className="grp" style={{ flex: 1 }}>
              <i className="g-skip" style={{ flex: 1 }} />
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Панель деталей во время загрузки.
 *
 * Секции названы по-настоящему, а полосами закрыты только значения: заголовки известны до
 * данных, и прятать их значило бы показать меньше, чем известно. Пустого состояния «вызов не
 * выбран» здесь быть не может — выбирать пока не из чего.
 */
export function CallDetailSkeleton() {
  return (
    <div className="detail-scroll" aria-busy="true">
      <div className="dsec">
        <span className="eyebrow">{STRINGS.detail.callSection}</span>
        <Line width="60%" />
        <Line width="44%" />
        <Line width="52%" />
      </div>

      <div className="dsec">
        <span className="eyebrow">{STRINGS.detail.commandSection}</span>
        <div className="argvbox">
          <Bar width="70%" />
        </div>
      </div>

      <div className="dsec">
        <span className="eyebrow">{STRINGS.detail.stagesSection}</span>
        <Line width="82%" />
        <Line width="76%" />
        <Line width="80%" />
        <Line width="68%" />
        <Line width="74%" />
      </div>
    </div>
  );
}
