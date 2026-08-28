import type { ChainedEvent } from '@mcpproxy/contracts';
import { denied, ok, type Result } from '../shared/result.js';

/**
 * Разбор JSONL-трейса.
 *
 * Битая строка отдаётся диагностикой в конверте, а не броском: трейс приходит с диска, и
 * упасть на нём означает, что приложение не запустилось вовсе.
 *
 * Разбор терпим к незнакомой версии схемы: контракт объявляет, что читатель обязан отрисовать
 * неизвестное значение как «форма новее меня», а не упасть. Здесь это выражается просто —
 * поле `schema` не проверяется на равенство.
 */
export function readTrace(text: string): Result<readonly ChainedEvent[]> {
  const events: ChainedEvent[] = [];
  const lines = text.split('\n');

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return denied('bad-payload', `строка ${index + 1}: не JSON`);
    }

    if (typeof parsed !== 'object' || parsed === null) {
      return denied('bad-payload', `строка ${index + 1}: не объект`);
    }
    if (!Object.hasOwn(parsed, 'chain') || !Object.hasOwn(parsed, 'stage')) {
      return denied('bad-payload', `строка ${index + 1}: не запись аудита`);
    }

    events.push(parsed as ChainedEvent);
  }

  return ok(events);
}
