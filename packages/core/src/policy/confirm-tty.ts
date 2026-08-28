import { once } from 'node:events';
import { createInterface } from 'node:readline/promises';
import type { ApprovalDecision } from '@mcpproxy/contracts';
import type { LockApprovalRequest, LockApprovalVerdict } from './approve.js';

/**
 * Два входа команды: разбор `--expect` и чтение ответа человека.
 *
 * Живут в модуле под тестом, а не в `bin/*.mjs`: на них держится весь гейт, и непроверяемый
 * скрипт запуска — неподходящее для них место.
 */

const DIGEST = /^[0-9a-f]{64}$/;

/**
 * Разбор `--expect`: **три** исхода, а не два.
 *
 * `mcpproxy lock` — отдельный процесс от демона, поэтому связать «дайджест, на котором демон
 * отказал» с «манифестом, который команда подписывает», может только значение, переживающее
 * границу процесса (R15a).
 *
 * Прежняя редакция возвращала `null` и на «флага нет», и на «флаг есть, значения нет», а
 * `runLockCommand` на `null` проверку пропускает — то есть **allow-on-input-error на средстве
 * защиты**. Достижимо одной незакавыченной пустой переменной: `mcpproxy-lock --expect $DIGEST`
 * при незаданном `DIGEST` молча снимал ограничение и подписывал тот манифест, который на диске
 * СЕЙЧАС, вместо того чтобы отказаться подписывать не тот, ради которого команду позвали.
 * Всегда отказывать — fail-closed; молча снять ограничение — нет.
 */
export type ExpectArgument =
  | { readonly kind: 'absent' }
  | { readonly kind: 'digest'; readonly digest: string }
  | { readonly kind: 'invalid'; readonly reason: string };

export function parseExpect(argv: readonly string[]): ExpectArgument {
  const validate = (raw: string): ExpectArgument =>
    DIGEST.test(raw)
      ? { kind: 'digest', digest: raw }
      : { kind: 'invalid', reason: `значение --expect не дайджест манифеста (64 строчных hex): ${raw}` };

  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === undefined) continue;
    if (argument.startsWith('--expect=')) return validate(argument.slice('--expect='.length));
    if (argument === '--expect') {
      const value = argv[i + 1];
      return value === undefined || value.startsWith('--')
        ? { kind: 'invalid', reason: 'флаг --expect задан без значения' }
        : validate(value);
    }
  }
  return { kind: 'absent' };
}

/** Утвердительные ответы. Всё остальное, включая пустую строку, — отказ: fail-closed. */
const AFFIRMATIVE: readonly string[] = ['y', 'yes', 'д', 'да'];

export function decisionOf(answer: string): ApprovalDecision {
  return AFFIRMATIVE.includes(answer.trim().toLowerCase()) ? 'approved' : 'denied';
}

export interface TtyDeps {
  readonly print: (text: string) => void;
  readonly ask: (question: string) => Promise<string>;
  readonly now: () => string;
}

/**
 * Вопрос, который завершается и на конце потока.
 *
 * `rl.question` на закрытом stdin не резолвится **никогда**: измерено на Node 22 — команда
 * печатает весь дифф, затем `Warning: Detected unsettled top-level await`, и процесс выходит с
 * кодом 13, минуя и `finally`, и весь документированный контракт кодов выхода. То есть любой
 * неинтерактивный запуск (CI, пайп, `< /dev/null`) не отказывал, а исчезал.
 *
 * Гонка с событием `close` доводит EOF до пустой строки, а её `decisionOf` уже считает отказом.
 * Это не проверка «мы в headless?» (её R17 запрещает как поверхность без потребителя) — это
 * обработка конца потока.
 */
/**
 * Ответ человека ИЛИ конец потока, что наступит раньше.
 *
 * Вынесено отдельной функцией, чтобы семантику можно было закрепить тестом без настоящего
 * терминала: измерено, что `rl.question` на закрытом stdin не резолвится никогда, и команда
 * выходила с кодом 13 мимо всего документированного контракта. Пустая строка — уже отказ
 * (`decisionOf`), поэтому EOF доезжает как fail-closed.
 */
export const answerOrEof = (answer: Promise<string>, closed: Promise<unknown>): Promise<string> =>
  Promise.race([answer, closed.then(() => '')]);

const nodeAsk = async (question: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await answerOrEof(rl.question(question), once(rl, 'close'));
  } finally {
    rl.close();
  }
};

const defaultTtyDeps: TtyDeps = {
  print: (text) => process.stdout.write(`${text}\n`),
  ask: nodeAsk,
  now: () => new Date().toISOString(),
};

/**
 * Показать и спросить.
 *
 * Вердикт наследует `manifestHash` **из запроса**, а не читает его заново: он обязан быть
 * привязан ровно к тому манифесту, который человеку показали.
 */
export async function confirmTty(
  request: LockApprovalRequest,
  rendered: string,
  deps: Partial<TtyDeps> = {},
): Promise<LockApprovalVerdict> {
  const resolved: TtyDeps = { ...defaultTtyDeps, ...deps };
  resolved.print(rendered);
  const answer = await resolved.ask('Записать это в mcpproxy.lock? [y/N] ');

  return { manifestHash: request.manifestHash, decision: decisionOf(answer), decidedAt: resolved.now() };
}
