import { createInterface } from 'node:readline/promises';
import type { ApprovalDecision } from '@mcpproxy/contracts';
import type { LockApprovalRequest, LockApprovalVerdict } from './approve.js';

/**
 * Два входа команды: разбор `--expect` и чтение ответа человека.
 *
 * Живут в модуле под тестом, а не в `bin/*.mjs`: на них держится весь гейт, и непроверяемый
 * скрипт запуска — неподходящее для них место.
 */

/**
 * Ожидаемый дайджест манифеста — межпроцессная половина R15a.
 *
 * `mcpproxy lock` — отдельный процесс от демона, поэтому связать «дайджест, на котором демон
 * отказал» с «манифестом, который команда подписывает», может только значение, переживающее
 * границу процесса.
 *
 * Принимаются обе формы, `--expect abc` и `--expect=abc`. Флаг без значения даёт `null`:
 * «ожидания нет» — то же, что и «флага нет», и это безопаснее, чем принять пустую строку за
 * дайджест, которому ничто не равно.
 */
export function parseExpect(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === undefined) continue;
    if (argument.startsWith('--expect=')) {
      const value = argument.slice('--expect='.length);
      return value === '' ? null : value;
    }
    if (argument === '--expect') {
      const value = argv[i + 1];
      return value === undefined || value.startsWith('--') ? null : value;
    }
  }
  return null;
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

const nodeAsk = async (question: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
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
