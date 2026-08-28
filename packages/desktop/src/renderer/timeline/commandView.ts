import { stageOrder, type Stage } from '@mcpproxy/contracts';
import type { Call } from '../../shared/call.js';

/**
 * Команда вызова так, как её показывает панель деталей.
 *
 * Аргумент — `Call`, а не событие: `argv` впервые появляется на `build_argv`, и на любом
 * более раннем событии УСПЕШНОГО вызова функция вернула бы «команда не собиралась».
 */
export type CommandView =
  | { readonly kind: 'built'; readonly argv: readonly string[]; readonly fromParams: readonly number[] }
  | { readonly kind: 'not-built'; readonly stoppedAt: Stage };

export function commandView(call: Call): CommandView {
  const built = call.stages.find((event) => Object.hasOwn(event, 'argv'));

  if (built === undefined || built.argv === undefined) {
    const last = call.stages[call.stages.length - 1];
    return { kind: 'not-built', stoppedAt: last?.stage ?? 'received' };
  }

  // WHY: контрактное поле необязательно, а здесь оно всегда массив. Свёртка отсутствия в
  // пустоту допустима ровно потому, что для подсветки «нет подстановок» и «нет поля» — одно
  // и то же; в других местах такая подмена была бы дефектом.
  return { kind: 'built', argv: built.argv, fromParams: built.argvFromParams ?? [] };
}

export interface StagePresence {
  readonly stage: Stage;
  readonly present: boolean;
}

/**
 * Какие стадии были, а каких не было.
 *
 * Пользователь обязан отличать «прошло мгновенно» от «до стадии не дошло»: первое даёт
 * событие с нулевой длительностью, второе — отсутствие события вовсе.
 */
export function stagePresence(call: Call): readonly StagePresence[] {
  return stageOrder.map((stage) => ({ stage, present: call.reached.has(stage) }));
}
