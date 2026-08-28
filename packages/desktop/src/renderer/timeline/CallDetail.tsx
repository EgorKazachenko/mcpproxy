import { riskLabel, sandboxLabel, stageLabel, verdictLabel, verdictRole } from '@mcpproxy/design';
import type { Call } from '../../shared/call.js';
import { STRINGS } from '../strings.js';
import { commandView, stagePresence } from './commandView.js';
import { MachineText } from './MachineText.js';
import { StageList } from './StageList.js';

/**
 * Последнее непустое значение поля по стадиям вызова.
 *
 * Дженерик, а не `string | undefined`: прежняя сигнатура стирала союз, и каждое обращение
 * сужалось обратно утверждением (`risk as 'low' | 'medium' | 'high'`). Утверждение — это
 * обещание компилятору, а не проверка: расширь контракт седьмым тиром, и на экране появится
 * пустая ячейка вместо ошибки сборки, причём в месте, которое никто не читал.
 */
const lastOf = <T,>(call: Call, pick: (event: Call['stages'][number]) => T | undefined): T | undefined =>
  call.stages.reduce<T | undefined>((found, event) => pick(event) ?? found, undefined);

/**
 * Панель деталей.
 *
 * Причина отказа — отдельный заметный блок, а не строка в конце: требование просит точную
 * причину, а перечисление несостоявшихся стадий по площади больше неё.
 */
export function CallDetail({ call, onFilter }: { call: Call | null; onFilter: (value: string) => void }) {
  if (call === null) {
    return (
      <div className="empty">
        <b>{STRINGS.detail.notSelectedHead}</b>
        {STRINGS.detail.notSelectedBody}
      </div>
    );
  }

  const command = commandView(call);
  const absent = stagePresence(call).filter((p) => !p.present);
  const denied = call.stages.find((event) => event.denyReason !== undefined && event.denyReason !== null);
  const cwd = lastOf(call, (event) => event.cwd);
  const env = lastOf(call, (event) => event.env?.allowed.join(' '));
  const sandbox = lastOf(call, (event) => event.sandbox?.mode);
  const risk = lastOf(call, (event) => event.risk?.tier);
  const overhead = call.stages.find((event) => event.duration !== undefined)?.duration?.overheadMs;

  return (
    <div className="detail-scroll">
      <div className="dsec">
        <span className="eyebrow">{STRINGS.detail.callSection}</span>
        <dl className="kv">
          <dt>{STRINGS.detail.tool}</dt>
          <dd>
            <button className="chipfilter" type="button" onClick={() => onFilter(call.toolName)}>
              {call.toolName}
            </button>
          </dd>
          <dt>{STRINGS.detail.verdict}</dt>
          <dd>
            <span className={`badge badge--${verdictRole[call.verdict]}`}>{verdictLabel[call.verdict]}</span>
          </dd>
          {risk !== undefined && (
            <>
              <dt>{STRINGS.detail.risk}</dt>
              <dd>{riskLabel[risk]}</dd>
            </>
          )}
          {cwd !== undefined && (
            <>
              <dt>{STRINGS.detail.cwd}</dt>
              <dd>
                <button className="chipfilter" type="button" onClick={() => onFilter(cwd)}>
                  {cwd}
                </button>
              </dd>
            </>
          )}
          {env !== undefined && (
            <>
              <dt>{STRINGS.detail.env}</dt>
              <dd className="mono">{env}</dd>
            </>
          )}
          {sandbox !== undefined && (
            <>
              <dt>{STRINGS.detail.sandbox}</dt>
              <dd>
                <span className={`badge badge--${sandbox === 'none' ? 'danger' : 'ok'}`}>
                  {sandboxLabel[sandbox]}
                </span>
              </dd>
            </>
          )}
        </dl>
      </div>

      {denied?.denyReason != null && (
        <div className="denybox">
          <span className="deny-verb">{STRINGS.detail.deniedAt(stageLabel[denied.stage])}</span>
          <span className="deny-why">
            <MachineText text={denied.denyReason} />
          </span>
          <span className="deny-note">{STRINGS.detail.deniedNote}</span>
        </div>
      )}

      <div className="dsec">
        <span className="eyebrow">{STRINGS.detail.commandSection}</span>
        {command.kind === 'built' ? (
          <>
            <div className="argvbox">
              {command.argv.map((element, index) => (
                <span key={index} className={`arg${command.fromParams.includes(index) ? ' arg-param' : ''}`}>
                  {element}{' '}
                </span>
              ))}
            </div>
            {command.fromParams.length > 0 && <p className="argv-legend">{STRINGS.detail.fromParams}</p>}
          </>
        ) : (
          <p className="argv-none">{STRINGS.detail.notBuilt(stageLabel[command.stoppedAt])}</p>
        )}
      </div>

      <div className="dsec">
        <span className="eyebrow">{STRINGS.detail.stagesSection}</span>
        <StageList stages={call.stages} />
        {absent.length > 0 && (
          <p className="stage-absent">
            {STRINGS.detail.absent(absent.map((p) => stageLabel[p.stage]).join(', '))}
          </p>
        )}
        {overhead !== undefined && (
          <div className="overhead">
            <b>{overhead}</b>
            <span>{STRINGS.detail.overhead}</span>
          </div>
        )}
      </div>
    </div>
  );
}
